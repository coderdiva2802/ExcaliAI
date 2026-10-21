// ─────────────────────────────────────────────────────────
// Sketch self-tests (offline): SVG reading, label/leader
// extraction, part matching, freehand composition, the
// Sketcher's source order and reuse rules, and the review routes.
//
//   npm run test:sketches -w apps/server
// ─────────────────────────────────────────────────────────

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import { config } from "../config.js";
import type { AIGateway } from "../llm/gateway.js";
import { DiagramSpecSchema, type DiagramSpec } from "../diagram/spec.js";
import { validateSpec } from "../diagram/validate.js";
import { layoutDiagram } from "../diagram/layout.js";
import { sketchRoutes } from "../routes/sketches.js";
import { extractSketch } from "./extract.js";
import { composeFreehand, FreehandSchema } from "./freehand.js";
import { matchParts, subjectKey } from "./match.js";
import { Sketcher } from "./Sketcher.js";
import { candidateRank } from "./sources.js";
import { FileSketchStore, registerSketch, useSketchStore } from "./store.js";
import { parsePathData, parseXml, readSvg, SvgError } from "./svg.js";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.log(`  ✗ ${msg}`); }
};
const near = (a: number[], b: number[], tol = 1.5) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

// ── SVG reading ────────────────────────────────────────
console.log("SVG reader");
{
  const [sq] = parsePathData("M10 10 h10 v10 h-10 z");
  check(sq.closed && sq.points.length === 4 && near(sq.points[2], [20, 20]), "relative h/v and close");
  const [arc] = parsePathData("M0 0 a5 5 0 011 1");
  check(arc.curved && near(arc.points.at(-1)!, [1, 1], 0.01), "compact arc flags (\"011\") parsed");
  const two = parsePathData("M0 0 L10 0 L10 10 Z M20 20 l5 0 l0 5 z");
  check(two.length === 2 && near(two[1].points[0], [20, 20]), "subpaths split; relative move after close");
  const curve = parsePathData("M0 0 C 0 10 10 10 10 0");
  check(curve[0].points.length > 4 && curve[0].curved, "cubic curves are sampled");

  const refused = (() => { try { parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><svg/>'); return false; } catch (e) { return e instanceof SvgError; } })();
  check(refused, "entity declarations are refused");
  const notSvg = (() => { try { parseXml("<html><body/></html>"); return false; } catch (e) { return e instanceof SvgError; } })();
  check(notSvg, "non-SVG documents are refused");

  const doc = readSvg(`<svg xmlns="http://www.w3.org/2000/svg" font-size="10">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#abcdef"/></linearGradient></defs>
    <script>alert(1)</script>
    <g transform="translate(100 50) scale(2)"><rect width="10" height="5" style="fill:url(#g)"/></g>
    <switch transform="translate(10 10)"><text systemLanguage="de">Fenster</text><text systemLanguage="en">Window</text><text>Default</text></switch>
    <text x="0" y="40">Two<tspan x="0" y="52">lines</tspan></text>
    <image href="https://example.com/x.png" width="10" height="10"/>
  </svg>`);
  check(doc.shapes.length === 1 && doc.shapes[0].fill === "#abcdef", "gradient fill → its first stop colour; scripts and images ignored");
  check(near(doc.shapes[0].points[2], [120, 60]), "nested transforms applied");
  check(doc.texts.length === 2 && doc.texts[0].lines[0] === "Window", "<switch> picks the English variant");
  check(doc.texts[1].lines.join("|") === "Two|lines", "tspans with x/y become lines");
}

// ── Labels and leader lines ────────────────────────────
console.log("Label extraction");
const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" font-size="14">
  <defs><marker id="dot"><circle r="2"/></marker></defs>
  <rect width="400" height="300" fill="#ffffff"/>
  <ellipse cx="200" cy="150" rx="120" ry="80" fill="#ffcc99" stroke="#663300"/>
  <g transform="translate(200 150)"><circle r="30" fill="#cc6666"/></g>
  <path d="M150 120 l20 0 l0 20 z" fill="#99ccff"/>
  <g stroke="#000" fill="none">
    <path d="M330 60 L230 150" marker-end="url(#dot)"/>
    <line x1="60" y1="40" x2="155" y2="125"/>
  </g>
  <text x="335" y="60">Core</text>
  <switch><text systemLanguage="de" x="5" y="40">Fenster</text><text systemLanguage="en" x="5" y="40">Window (opening)</text></switch>
  <text x="200" y="215" text-anchor="middle">Shell</text>
  <text x="10" y="290">Figure 1</text>
</svg>`;
{
  const r = extractSketch(readSvg(SAMPLE))!;
  check(r !== null, "sample SVG yields a sketch");
  const ids = r.template.parts.map((p) => p.id).sort();
  check(ids.join(",") === "core,shell,window", `parts from labels: ${ids.join(", ")}`);
  check(r.unplaced.includes("Figure 1"), "a caption in empty space is not a part (page background ignored)");
  const core = r.template.parts.find((p) => p.id === "core")!;
  // Drawing bbox 80..320 × 70..230 → scale 2, offset 20.
  check(near(core.anchor, [320, 180]), `leader anchor at the marker end (${core.anchor})`);
  const win = r.template.parts.find((p) => p.id === "window")!;
  check(near(win.anchor, [170, 130]) && win.detail === "opening", "plain leader: far end is the anchor; \"(…)\" becomes detail");
  check(r.template.paths.length === 3, `leaders and backdrop removed from the drawing (${r.template.paths.length} paths)`);
  check(r.template.paths[0].fillColor === "#ffcc99" && r.template.paths[0].strokeColor === "#663300", "fill and stroke colours kept");
  check(r.template.paths[1].strokeColor === "#cc6666", "unstroked shapes outlined in their fill colour");
}

// ── Matching ───────────────────────────────────────────
console.log("Part matching");
{
  check(subjectKey("structure_of_the_human_ear") === "ear" && subjectKey("human_ear") === "ear", "subject keys ignore filler words");
  check(subjectKey("kidney_nephron") === subjectKey("nephron_kidney"), "subject keys are order-independent");
  const parts = [
    { id: "semicircular_canals", name: "Semicircular canals", anchor: [0, 0] as [number, number] },
    { id: "malleus", name: "Malleus", detail: "hammer", anchor: [0, 0] as [number, number] },
    { id: "tympanic_membrane", name: "Tympanic membrane", anchor: [0, 0] as [number, number] },
  ];
  const m = matchParts([{ part: "semicircular_canal" }, { part: "hammer" }, { part: "eardrum" }], parts);
  check(m.get(0) === "semicircular_canals", "plural/singular match");
  check(m.get(1) === "malleus", "matches the detail (\"hammer\")");
  check(!m.has(2), "no false match for a synonym the tokens can't know (left to the LLM)");
}

{
  const ranked = ["File:Anatomy of the Human Ear blank.svg", "File:Anatomy of the Human Ear cs.svg", "File:Anatomy of the Human Ear.svg", "File:Ear-mr.svg"]
    .sort((a, b) => candidateRank(a) - candidateRank(b));
  check(ranked[0] === "File:Anatomy of the Human Ear.svg", "the original ranks before translations (\"Ear\" is not a language code)");
  check(ranked.at(-1) === "File:Anatomy of the Human Ear blank.svg", "unlabelled copies rank last");
}

// ── Freehand ───────────────────────────────────────────
console.log("Freehand composition");
const FREEHAND = {
  title: "Kidney",
  shapes: [
    { part: "cortex", type: "blob", cx: 50, cy: 50, rx: 30, ry: 40, colour: "brown" },
    { part: "medulla", type: "ellipse", cx: 52, cy: 50, rx: 18, ry: 26, colour: "red" },
    { part: "ureter", type: "tube", points: [[60, 55], [70, 75], [72, 98]], width: 4, colour: "yellow" },
    { type: "line", points: [[40, 40], [45, 45]] },
  ],
  parts: [
    { id: "cortex", name: "Cortex" },
    { id: "medulla", name: "Medulla" },
    { id: "ureter", name: "Ureter" },
  ],
};
{
  const r = composeFreehand(FreehandSchema.parse(FREEHAND), ["cortex", "medulla", "ureter"]);
  check(r.problems.length === 0 && r.parts.length === 3 && r.paths.length === 4, "valid freehand sketch composes cleanly");
  const med = r.parts.find((p) => p.id === "medulla")!;
  check(near(med.anchor, [15 + 52 * 4.6, 15 + 50 * 4.6], 2), "anchor at the centre of the part's shape");
  const off = composeFreehand(FreehandSchema.parse({ ...FREEHAND, parts: FREEHAND.parts.map((p) => (p.id === "ureter" ? { ...p, at: [90, 5] } : p)) }), []);
  const onTube = composeFreehand(FreehandSchema.parse({ ...FREEHAND, parts: FREEHAND.parts.map((p) => (p.id === "ureter" ? { ...p, at: [65, 65] } : p)) }), []);
  const ureter = (r: typeof off) => r.parts.find((p) => p.id === "ureter")!.anchor;
  check(!near(ureter(off), ureter(onTube), 1) && near(ureter(onTube), [15 + 65 * 4.6, 15 + 65 * 4.6], 2), "an explicit anchor on the shape is kept");
  check(near(ureter(off), [15 + 70 * 4.6, 15 + 75 * 4.6], 4), "an explicit anchor off the part's shape snaps onto it");
  const bad = composeFreehand(FreehandSchema.parse({ ...FREEHAND, parts: [...FREEHAND.parts, { id: "renal_artery", name: "Renal artery" }] }), ["renal_artery"]);
  check(bad.problems.some((p) => p.includes("renal_artery")), "a part without a shape is reported for repair");
}

// ── Sketcher: source order, drafts, reuse ──────────────
console.log("Sketcher");
const meta = { task: "designer" as const, provider: "demo" as const, model: "stub", ms: 0 };
function stub(reply: (system: string, content: string) => unknown) {
  let calls = 0;
  return {
    get calls() { return calls; },
    gw: {
      generateStructured: async <T>(req: { system: string; messages: Array<{ content: string }> }, schema: ZodType<T, ZodTypeDef, unknown>) => {
        calls++;
        return { data: schema.parse(reply(req.system, req.messages.at(-1)!.content)), meta };
      },
    } as unknown as AIGateway,
  };
}
const spec = (template: string, labels: Array<{ part: string; text?: string }>): DiagramSpec =>
  validateSpec(DiagramSpecSchema.parse({ title: template, kind: "labelled_diagram", labelled: { template, labels } }), 2).spec;

await (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "excaliai-sketch-"));
  const local = path.join(dir, "resources");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(local);
  writeFileSync(path.join(local, "test_organ.svg"), SAMPLE);
  writeFileSync(path.join(local, "test_organ.json"), JSON.stringify({ title: "Test organ", aliases: ["organ_x"], author: "Me", license: "CC0" }));
  Object.assign(config.sketch, { dir: local, online: false, freehand: true });
  useSketchStore(new FileSketchStore(path.join(dir, "store")));

  const designer = stub(() => FREEHAND);
  const mapper = stub((_s, content) => ({ pairs: content.includes("Hole") ? [{ requested: "Hole", part: "Window" }] : [] }));
  const sk = new Sketcher(designer.gw, mapper.gw);
  const signal = new AbortController().signal;

  // Pending spec: validation needs labels to sketch from.
  const empty = validateSpec(DiagramSpecSchema.parse({ title: "X", kind: "labelled_diagram", labelled: { template: "zebra_stripes", labels: [] } }), 2);
  check(empty.critical.some((c) => c.includes("list the parts")), "unknown template without labels asks for the parts");
  check(spec("organ_x", [{ part: "core" }]).labelled?.labels.length === 1, "unknown template with labels passes validation (pending sketch)");

  // 1. Local folder (alias match), label matching incl. one LLM call for a synonym.
  const a = await sk.prepare(spec("organ_x", [{ part: "core", text: "Core" }, { part: "hole", text: "Hole" }, { part: "spleen" }]), { lessonId: "lessonAAA1", signal });
  check(a.sketch?.source.kind === "local" && a.sketch.status === "approved", "local folder sketch used first (approved)");
  check(a.spec.labelled?.labels.map((l) => l.part).join(",") === "core,window", `labels mapped: ${a.spec.labelled?.labels.map((l) => l.part)}`);
  check(a.spec.labelled?.labels[1].text === "Hole", "the designer's wording is kept on the label");
  check(designer.calls === 0 && mapper.calls === 1, "no designer call; one small matching call");
  const placed = layoutDiagram(validateSpec(a.spec, 2).spec, 2);
  check(placed.texts.some((t) => t.text.includes("Me") && t.text.includes("CC0")), "credit line drawn under the sketch");

  // 2. Nothing local or online → freehand draft, reused only in its lesson.
  const b = await sk.prepare(spec("kidney", [{ part: "cortex" }, { part: "medulla" }, { part: "ureter" }]), { lessonId: "lessonAAA1", signal });
  check(b.sketch?.source.kind === "ai" && b.sketch.status === "draft" && designer.calls === 1, "freehand AI sketch as a draft");
  await sk.prepare(spec("human_kidney", [{ part: "cortex" }]), { lessonId: "lessonAAA1", signal });
  check(designer.calls === 1, "same lesson reuses its draft (\"human_kidney\" = \"kidney\")");
  const c = await sk.prepare(spec("kidney", [{ part: "cortex" }]), { lessonId: "lessonBBB2", signal });
  check(designer.calls === 2 && c.sketch?.id !== b.sketch?.id, "another lesson does not reuse an unapproved draft");

  // 3. Review routes: only the creating lesson; approval makes it shared.
  const app = Fastify();
  await app.register(sketchRoutes());
  const post = (id: string, action: string, lessonId: string) => app.inject({ method: "POST", url: `/api/sketches/${id}/${action}`, payload: { lessonId } });
  check((await post(b.sketch!.id, "approve", "lessonBBB2")).statusCode === 403, "another lesson can't approve a draft");
  check((await post(b.sketch!.id, "approve", "lessonAAA1")).statusCode === 200, "the creating lesson approves it");
  await sk.prepare(spec("kidney", [{ part: "cortex" }]), { lessonId: "lessonCCC3", signal });
  check(designer.calls === 2, "an approved sketch is reused by every lesson");
  check((await post(c.sketch!.id, "reject", "lessonBBB2")).statusCode === 200, "a bad draft can be rejected");
  const list = (await app.inject({ method: "GET", url: "/api/sketches" })).json() as Array<{ id: string }>;
  check(!list.some((s) => s.id === c.sketch!.id) && list.some((s) => s.id === b.sketch!.id), "rejected sketch removed from the library");
  check((await post("not-an-id", "approve", "lessonAAA1")).statusCode === 400, "malformed ids rejected");
  await app.close();

  // 4. An edit after a restart: the stored sketch id is reloaded.
  registerSketch({ ...b.sketch!, id: "sk_zzzzzzzzzzzz" }); // unrelated registry noise
  const again = await new Sketcher(designer.gw, mapper.gw).prepare(b.spec, { lessonId: "lessonAAA1", signal });
  check(again.sketch?.id === b.sketch!.id && designer.calls === 2, "a diagram's own sketch id is reused for edits");
})();

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sketch checks passed.");
