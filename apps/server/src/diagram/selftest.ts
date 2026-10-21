// ─────────────────────────────────────────────────────────
// Deterministic pipeline self-test (no LLM, no network).
//
//   npm run test:diagrams -w apps/server
//
// Feeds representative — and deliberately malformed — specs
// through  zod → semantic repair → layout → compile → gate
// and asserts the output is valid, overlap-free and stable.
// ─────────────────────────────────────────────────────────

import { DiagramSpecSchema } from "./spec.js";
import { validateSpec } from "./validate.js";
import { layoutDiagram } from "./layout.js";
import { compileDiagram, diffDiagram } from "./compiler.js";
import { gateActions } from "./canvasValidate.js";
import { describeSpecChanges, isRemovalRequest, restrictToExisting } from "./specDiff.js";
import { FIXTURES } from "./fixtures.js";
import { KNOWN_MOLECULES, balance, parseFormula, parseSmiles } from "./chemistry.js";
import { GAZETTEER, distanceToCountry, findCountry, viewBox } from "./geo.js";
import { ELEMENTS, ionShells, shellsFor } from "./atom.js";
import { solveCircuit } from "./circuit.js";
import { sumVectors } from "./vectors.js";
import { TEMPLATES, resolveTemplate } from "./templates.js";
import { fixArithmetic, evaluate } from "./arithmetic.js";

const SAMPLES: Record<string, unknown> = {
  binary_search_trace: {
    title: "Binary search for 23",
    kind: "array",
    nodes: [2, 5, 8, 12, 16, 23, 38, 56, 72, 91].map((v, i) => ({ id: `c${i}`, label: v })),
    frames: [
      { caption: "Iteration 1: lo=0, hi=9 → mid=4 (16 < 23)", step: 1, pointers: [{ label: "lo", index: 0 }, { label: "mid", index: 4 }, { label: "hi", index: 9 }] },
      { caption: "Iteration 2: discard left half → mid=7 (56 > 23)", step: 2, pointers: [{ label: "lo", index: 5 }, { label: "mid", index: 7 }, { label: "hi", index: 9 }], ranges: [{ from: 0, to: 4, role: "muted" }] },
      { caption: "Iteration 3: mid=5 → found", step: 3, pointers: [{ label: "lo", index: 5 }, { label: "mid", index: 5 }, { label: "hi", index: 6 }, { label: "bad", index: 42 }], ranges: [{ from: 0, to: 4, role: "muted" }, { from: 7, to: 9, role: "muted" }, { from: 5, to: 5, role: "success" }] },
    ],
    takeaways: ["Each comparison halves the search space", "Worst case: O(log n) comparisons"],
  },
  flowchart_with_loop: {
    title: "Binary search algorithm",
    kind: "flowchart",
    nodes: [
      { id: "start", label: "Start: lo=0, hi=n-1", shape: "pill", step: 1 },
      { id: "check", label: "lo ≤ hi?", shape: "diamond", step: 1 },
      { id: "mid", label: "mid = (lo + hi) / 2", step: 2 },
      { id: "cmp", label: "a[mid] == target?", shape: "diamond", step: 2 },
      { id: "found", label: "Return mid", role: "success", shape: "pill", step: 3 },
      { id: "narrow", label: "Move lo or hi past mid", step: 3 },
      { id: "missing", label: "Return -1", role: "danger", shape: "pill", step: 3 },
    ],
    edges: [
      { from: "start", to: "check" },
      { from: "check", to: "mid", label: "yes" },
      { from: "check", to: "missing", label: "no" },
      { from: "mid", to: "cmp" },
      { from: "cmp", to: "found", label: "yes" },
      { from: "cmp", to: "narrow", label: "no" },
      { from: "narrow", to: "check", label: "repeat" },
      { from: "ghost", to: "check" },
    ],
    annotations: [{ target: "mid", text: "Integer division keeps mid inside the range" }],
    code: { language: "python", code: "def bsearch(a, t):\n    lo, hi = 0, len(a) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if a[mid] == t: return mid\n        if a[mid] < t: lo = mid + 1\n        else: hi = mid - 1\n    return -1" },
  },
  bst: {
    title: "Binary search tree",
    kind: "tree",
    nodes: [
      { id: "8", label: "8" }, { id: "3", label: "3", parent: "8", side: "left" }, { id: "10", label: "10", parent: "8", side: "right" },
      { id: "1", label: "1", parent: "3", side: "left" }, { id: "6", label: "6", parent: "3", side: "right" },
      { id: "14", label: "14", parent: "10", side: "right" }, { id: "13", label: "13", parent: "14", side: "left" },
      { id: "dup", label: "dup", parent: "dup" },
    ],
  },
  tcp_sequence: {
    title: "TCP three-way handshake",
    kind: "sequence",
    nodes: [{ id: "client", label: "Client" }, { id: "server", label: "Server" }],
    edges: [
      { from: "client", to: "server", label: "SYN (seq = x)", step: 1 },
      { from: "server", to: "client", label: "SYN-ACK (seq = y, ack = x+1)", step: 2 },
      { from: "client", to: "server", label: "ACK (ack = y+1)", step: 3 },
    ],
    annotations: [{ target: "server", text: "LISTEN → SYN_RCVD → ESTABLISHED" }],
  },
  comparison: {
    title: "Git merge vs rebase",
    kind: "comparison",
    groups: [{ id: "merge", label: "git merge" }, { id: "rebase", label: "git rebase" }],
    nodes: [
      { id: "m1", label: "Creates a merge commit", group: "merge" },
      { id: "m2", label: "Preserves full history", group: "merge" },
      { id: "r1", label: "Replays commits onto base", group: "rebase" },
      { id: "r2", label: "Linear history", group: "rebase" },
      { id: "r3", label: "Rewrites commit hashes", group: "rebase", role: "warning" },
    ],
  },
  mindmap: {
    title: "Transformer attention",
    kind: "mindmap",
    nodes: [
      { id: "attn", label: "Self-attention" },
      { id: "q", label: "Query", parent: "attn" }, { id: "k", label: "Key", parent: "attn" },
      { id: "v", label: "Value", parent: "attn" }, { id: "soft", label: "Softmax weights", parent: "attn" },
      { id: "scale", label: "Scale by √d_k", parent: "soft" },
    ],
    formulas: [{ latex: "\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V", caption: "Scaled dot-product attention" }],
  },
  osi_layers: {
    title: "TCP/IP model",
    kind: "layers",
    nodes: ["Application", "Transport", "Internet", "Link"].map((l) => ({ id: l, label: l, detail: l === "Transport" ? "TCP / UDP" : undefined })),
  },
  pipeline: {
    title: "ML training pipeline",
    kind: "timeline",
    nodes: ["Collect data", "Clean & label", "Feature engineering", "Train model", "Evaluate", "Deploy"].map((l, i) => ({ id: `s${i}`, label: l, step: Math.ceil((i + 1) / 2) })),
  },
  stack: { title: "Call stack", kind: "stack", nodes: [{ id: "main", label: "main()" }, { id: "f", label: "f(3)" }, { id: "g", label: "g(2)" }] },
  derivation: {
    title: "Quadratic formula",
    kind: "formula",
    formulas: [
      { latex: "ax^2+bx+c=0", caption: "Start", step: 1 },
      { latex: "x^2+\\frac{b}{a}x=-\\frac{c}{a}", caption: "Divide by a", step: 2 },
      { latex: "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}", caption: "Complete the square", step: 3 },
    ],
  },
  // Regression: multi-layer edge that used to cut diagonally through the chart.
  flowchart_long_span: {
    title: "Binary search flowchart",
    kind: "flowchart",
    nodes: [
      { id: "start", label: "Start", shape: "pill" }, { id: "init", label: "Find target in sorted array" },
      { id: "set", label: "Set low=0, high=n-1" }, { id: "loop", label: "low ≤ high?", shape: "diamond" },
      { id: "mid", label: "mid = floor((low+high)/2)" }, { id: "absent", label: "Target absent → return -1", role: "danger" },
      { id: "eq", label: "A[mid] == target?", shape: "diamond" }, { id: "found", label: "Return mid", role: "success" },
      { id: "lt", label: "A[mid] < target?", shape: "diamond" }, { id: "lo", label: "low = mid + 1" },
      { id: "hi", label: "high = mid - 1" }, { id: "cx", label: "Time O(log n), Space O(1)", role: "secondary" },
      { id: "end", label: "End", shape: "pill" },
    ],
    edges: [
      { from: "start", to: "init" }, { from: "init", to: "set" }, { from: "set", to: "loop" },
      { from: "loop", to: "mid", label: "yes" }, { from: "loop", to: "absent", label: "no" },
      { from: "mid", to: "eq" }, { from: "eq", to: "found", label: "yes" }, { from: "eq", to: "lt", label: "no" },
      { from: "lt", to: "lo", label: "yes" }, { from: "lt", to: "hi", label: "no" },
      { from: "lo", to: "loop" }, { from: "hi", to: "loop" },
      { from: "found", to: "cx" }, { from: "absent", to: "cx" }, { from: "cx", to: "end" },
    ],
  },
  // Regression: model-chosen node ids must never collide with generated ids.
  id_collision: {
    title: "Collision check",
    kind: "array",
    nodes: ["idx0", "idx1", "title", "x-title", "ptr0_0"].map((id, i) => ({ id, label: i })),
    frames: [{ caption: "a", pointers: [{ label: "p", index: 0 }] }, { caption: "b", pointers: [{ label: "q", index: 1 }] }],
    takeaways: ["t"],
  },
  malformed: { title: 12345, kind: "Flow Chart", nodes: [{ id: "a", label: "A", role: "neon" }, { id: "a", label: "A again", shape: "hexagon" }, { id: "b", label: "" }], edges: [{ from: "a", to: "zzz" }] },
  empty: { title: "Nothing", kind: "graph", nodes: [] },
};

// Every quantitative fixture is part of the regression set.
for (const [key, fx] of Object.entries(FIXTURES)) SAMPLES[`fixture_${key}`] = fx.spec;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.log(`   ✗ ${msg}`);
  }
};

for (const [name, raw] of Object.entries(SAMPLES)) {
  const parsed = DiagramSpecSchema.safeParse(raw);
  if (!parsed.success) {
    console.log(`✗ ${name}: schema rejected: ${parsed.error.issues[0]?.message}`);
    failures++;
    continue;
  }
  const { spec, issues, critical } = validateSpec(parsed.data, 3);
  if (critical.length) {
    console.log(`• ${name}: critical → ${critical.join("; ")}`);
    check(name === "empty", `${name} unexpectedly critical`);
    continue;
  }
  // Sketched subjects need the Sketcher (a reference SVG or an AI call) — covered by src/sketch/selftest.ts.
  if (spec.kind === "labelled_diagram" && !resolveTemplate(spec.labelled!.template)) {
    console.log(`• ${name}: sketched at run time (see the sketch self-tests)`);
    continue;
  }
  const placed = layoutDiagram(spec, 3);
  const compiled = compileDiagram(placed, "d1", { x: 0, y: 400 });
  const gate = gateActions(compiled.creates, []);
  console.log(
    `✓ ${name}: ${compiled.creates.length} elements, ${placed.width}×${placed.height}, steps [${[...compiled.byStep.keys()]}]` +
      (issues.length ? `\n   repaired: ${issues.join(" | ")}` : "") +
      (gate.warnings.length ? `\n   gate: ${gate.warnings.join(" | ")}` : "")
  );
  check(gate.actions.length === compiled.creates.length, `${name}: gate dropped actions`);
  check(!gate.warnings.some((w) => w.includes("overlapping")), `${name}: overlapping shapes`);
  check(!gate.warnings.some((w) => w.includes("cross unrelated")), `${name}: connector crosses a shape`);
  check(compiled.creates.every((a) => !JSON.stringify(a).includes("null")), `${name}: null in output`);

  // Determinism + diff: recompiling the same spec must keep everything.
  const again = compileDiagram(layoutDiagram(spec, 3), "d1", { x: 0, y: 400 });
  const ids = new Set(compiled.creates.map((a) => a.id));
  const diff = diffDiagram(compiled.creates, again.creates, ids, true);
  check(diff.deletes.length === 0 && diff.keep.size === again.creates.length, `${name}: layout is not deterministic`);
}

// Edit verification: identical specs are detected as no-ops; real edits are described.
{
  const base = DiagramSpecSchema.parse(SAMPLES.tcp_sequence);
  const same = DiagramSpecSchema.parse({ ...(SAMPLES.tcp_sequence as object), nodes: [{ id: "c", label: "Client" }, { id: "s", label: "Server" }] });
  check(describeSpecChanges(base, base).length === 0, "identical spec should be a no-op");
  check(describeSpecChanges(base, { ...same, edges: base.edges }).length === 0, "id-only renames should count as unchanged");
  const trimmed = { ...base, edges: base.edges.slice(0, 2) };
  const desc = describeSpecChanges(base, trimmed);
  check(desc.some((d) => d.includes("1 removed")), `removed edge not reported: ${desc.join(" ")}`);
  console.log(`✓ spec diff: ${desc.join(" ")}`);

  // A removal can never add content (regression: "remove node 7" produced a new node "2").
  const bst = DiagramSpecSchema.parse(SAMPLES.bst);
  const hallucinated = { ...bst, nodes: [...bst.nodes.filter((n) => n.id !== "13"), { id: "2", label: "2", parent: "3", side: "left" as const }] };
  const { spec: restricted, stripped } = restrictToExisting(bst, hallucinated);
  check(stripped.join() === "2" && !restricted.nodes.some((n) => n.label === "2"), "removal guard must strip invented nodes");
  check(isRemovalRequest("Remove node 7 from the tree") && !isRemovalRequest("Replace node 7 with 9"), "removal detection");
  console.log(`✓ removal guard: stripped ${stripped.join(", ")}; result: ${describeSpecChanges(bst, restricted).join(" ")}`);
}

// ── Code-computed facts beat model-stated facts ──
{
  const nl = validateSpec(DiagramSpecSchema.parse(FIXTURES.number_line.spec), 3);
  const labels = (nl.spec.numberLine?.jumps ?? []).map((j) => j.label);
  check(labels.join() === "+2,−4", `number-line jump labels are computed (got ${labels.join()})`);

  const tri = validateSpec(DiagramSpecSchema.parse(FIXTURES.triangle.spec), 2);
  const angleLabel = tri.spec.geometry?.angles?.[1]?.label;
  check(angleLabel === "36.9°", `wrong angle label is corrected from the coordinates (got ${angleLabel})`);

  const sd = layoutDiagram(validateSpec(DiagramSpecSchema.parse(FIXTURES.supply_demand.spec), 3).spec, 3);
  const eq = sd.texts.find((t) => t.id.startsWith("x-ixl"))?.text;
  check(eq === "(4, 6)", `supply/demand equilibrium is computed, not guessed (got ${eq})`);

  const roots = layoutDiagram(validateSpec(DiagramSpecSchema.parse(FIXTURES.parabola.spec), 2).spec, 2).texts.filter((t) => t.id.startsWith("x-ixl")).map((t) => t.text);
  check(roots.includes("(−1, 0)") && roots.includes("(3, 0)"), `quadratic roots computed (got ${roots.join(" ")})`);

  const pie = layoutDiagram(validateSpec(DiagramSpecSchema.parse(FIXTURES.pie_chart.spec), 1).spec, 1);
  const pct = pie.texts.filter((t) => t.id.startsWith("x-slicel")).map((t) => (t.text.includes("<1") ? 0 : parseInt(t.text.split("\n")[1], 10)));
  check(pct.reduce((a, b) => a + b, 0) === 100, `pie percentages are computed and sum to 100 (got ${pct.join("+")})`);

  const ww1 = layoutDiagram(validateSpec(DiagramSpecSchema.parse(FIXTURES.ww1_timeline.spec), 3).spec, 3);
  const cards = ww1.boxes.filter((b) => b.id.startsWith("x-tcard")).map((b) => b.label.replace(/\s+/g, " "));
  check(cards.some((c) => c.includes("28 Jul 1914")) && cards.some((c) => c.includes("11 Nov 1918")) && !cards.some((c) => /1915|1919/.test(c)), `timeline shows real dates, never rounded years (got ${cards.join(" | ")})`);
  const pieLabels = pie.texts.filter((t) => t.id.startsWith("x-slicel")).map((t) => t.text.replace(/\s+/g, " "));
  check(pieLabels.some((l) => l.includes("<1%")) && !pieLabels.some((l) => / 0%/.test(l)), `tiny non-zero slices read "<1%" (got ${pieLabels.join(" | ")})`);
  const bars = layoutDiagram(validateSpec(DiagramSpecSchema.parse(FIXTURES.bar_chart.spec), 1).spec, 1);
  const topTick = Math.max(...bars.texts.filter((t) => t.id.startsWith("x-cyt")).map((t) => parseFloat(t.text)));
  check(topTick >= 146, `chart axis reaches past the largest value (top tick ${topTick})`);

  const snapped = validateSpec(DiagramSpecSchema.parse({ title: "s", kind: "coordinate_plane", plot: { xMin: -3, xMax: 5, functions: [{ expr: "x^2" }, { expr: "2x + 3" }], points: [{ x: 3.2, y: 9.5, label: "(3.2, 9.5)" }] } }), 1);
  const sp = snapped.spec.plot?.points?.[0];
  check(sp?.x === 3 && sp?.y === 9 && sp?.label === "(3, 9)", `a slightly-wrong intersection point is snapped to the computed one (got ${JSON.stringify(sp)})`);

  // Regression (live): kind "timeline" with a chronology block and no nodes rendered an empty diagram.
  const mismatch = validateSpec(DiagramSpecSchema.parse({ title: "French Revolution", kind: "timeline", nodes: [], chronology: { events: [{ date: "1789-07-14", label: "Bastille" }, { date: "1799-11-09", label: "Coup" }] } }), 1);
  check(mismatch.spec.kind === "scaled_timeline" && mismatch.critical.length === 0, `kind/data mismatch is reconciled (got ${mismatch.spec.kind}, ${mismatch.critical.join(";")})`);
  const empty = validateSpec(DiagramSpecSchema.parse({ title: "e", kind: "timeline", nodes: [] }), 1);
  check(empty.critical.length > 0, "a box-kind diagram with no nodes and no data is rejected, not drawn empty");

  const bad = validateSpec(DiagramSpecSchema.parse({ title: "x", kind: "coordinate_plane", plot: { functions: [{ expr: "constructor" }, { expr: "x; alert(1)" }] } }), 1);
  check(bad.critical.length > 0, "a plot with only unsafe/invalid expressions is rejected");

  const tl = validateSpec(DiagramSpecSchema.parse({ title: "t", kind: "scaled_timeline", chronology: { events: [{ date: "sometime", label: "a" }, { date: 1990, label: "b" }] } }), 1);
  check(tl.critical.length > 0 && tl.issues.some((i) => i.includes("sometime")), "unparseable dates are dropped and an under-filled timeline is rejected");
}

// ── Earlier-phase fixes ──
{
  // A colour-only edit updates the shape in place instead of deleting and redrawing it.
  const base = validateSpec(DiagramSpecSchema.parse(SAMPLES.bst), 3).spec;
  const recolored = { ...base, nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, role: "success" as const } : n)) };
  const before = compileDiagram(layoutDiagram(base, 3), "d1", { x: 0, y: 0 });
  const after = compileDiagram(layoutDiagram(recolored, 3), "d1", { x: 0, y: 0 });
  const d = diffDiagram(before.creates, after.creates, new Set(before.creates.map((a) => a.id)), true);
  check(d.updates.length === 1 && d.deletes.length === 0 && d.keep.size === after.creates.length, `colour-only edit → 1 in-place update, nothing redrawn (got ${d.updates.length} updates, ${d.deletes.length} deletes)`);

  // Busy plots: no label sits on another label or on a tick label.
  const busy = layoutDiagram(validateSpec(DiagramSpecSchema.parse({
    title: "busy", kind: "coordinate_plane",
    plot: { xMin: -4, xMax: 4, functions: [{ expr: "x^2" }, { expr: "2x + 1" }, { expr: "-x + 2" }], showIntersections: true, points: [{ x: 1, y: 1, label: "A" }, { x: 0, y: 1, label: "B" }, { x: 1, y: 3, label: "C" }] },
  }), 1).spec, 1);
  const labels = busy.texts.filter((t) => /^x-(fl|ixl|pl|sgl|xt|yt)\d/.test(t.id));
  let clashes = 0;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    if (/^x-(xt|yt)/.test(a.id) && /^x-(xt|yt)/.test(b.id)) continue;
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) clashes++;
  }
  check(clashes === 0, `busy plot labels don't overlap (${clashes} clash(es))`);

  // A dot on every integer of a number line is clutter; labelled points are kept.
  const dots = validateSpec(DiagramSpecSchema.parse({ title: "n", kind: "number_line", numberLine: { min: -5, max: 5, points: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })) } }), 1);
  check(dots.spec.numberLine?.points?.length === 0, "redundant integer dots are dropped");
  const kept = validateSpec(DiagramSpecSchema.parse(FIXTURES.number_line.spec), 3);
  check(kept.spec.numberLine?.points?.length === 1, "a labelled point is kept");
  console.log("✓ in-place updates, plot label separation, number-line clutter");
}

// ── Phase B: reference data is checked against independent sources ──
{
  // Every dictionary molecule: SMILES parses and matches its stated formula (my data entry, verified by OpenChemLib).
  for (const [name, [smiles, display]] of Object.entries(KNOWN_MOLECULES)) {
    const parsed = parseSmiles(smiles);
    const stated = parseFormula(display);
    const same = parsed && stated && JSON.stringify(Object.entries(parsed.counts).sort()) === JSON.stringify(Object.entries(stated).sort());
    check(Boolean(same), `molecule dictionary: ${name} (${smiles}) should be ${display}, OpenChemLib says ${parsed?.formula}`);
  }
  check(parseSmiles("nonsense(((") === null, "invalid SMILES is rejected");
  check(JSON.stringify(balance([{ C: 1, H: 4 }, { O: 2 }], [{ C: 1, O: 2 }, { H: 2, O: 1 }])) === "[1,2,1,2]", "methane combustion balances to 1,2,1,2");
  check(JSON.stringify(balance([{ Fe: 1 }, { O: 2 }], [{ Fe: 2, O: 3 }])) === "[4,3,2]", "iron oxidation balances to 4,3,2");
  const comb = validateSpec(DiagramSpecSchema.parse(FIXTURES.combustion.spec), 2).spec.chemistry!.molecules.map((m) => m.coefficient ?? 1);
  check(comb.join() === "1,2,1,2", `unbalanced fixture is corrected (got ${comb.join()})`);
  const eth = validateSpec(DiagramSpecSchema.parse(FIXTURES.ethanol.spec), 1);
  check(eth.issues.some((i) => i.includes("contradicts")), "a wrong stated formula is flagged");
  const wrongSmiles = validateSpec(DiagramSpecSchema.parse({ title: "w", kind: "molecule", chemistry: { molecules: [{ name: "benzene", smiles: "CCCCCC" }] } }), 1);
  check(wrongSmiles.spec.chemistry?.molecules[0].smiles === "c1ccccc1", "a known molecule's wrong SMILES is replaced by the verified one");
  const impossible = validateSpec(DiagramSpecSchema.parse({ title: "x", kind: "molecule", chemistry: { molecules: [{ name: "water", role: "reactant" }, { name: "methane", role: "product" }] } }), 1);
  check(impossible.critical.length > 0, "an impossible reaction (water → methane) is rejected");

  // Every gazetteer city lies in (or within 0.5° of) its country's real outline.
  for (const [city, lat, lon, country] of GAZETTEER) {
    const c = findCountry(country);
    check(Boolean(c), `gazetteer: country "${country}" for ${city} exists in the map data`);
    if (c) {
      const d = distanceToCountry([lon, lat], c);
      check(d <= 0.5, `gazetteer: ${city} (${lat}, ${lon}) is ${d.toFixed(2)}° outside ${country}`);
    }
  }
  check(findCountry("USA")?.name === "United States of America" && findCountry("Ivory Coast")?.name === "Côte d'Ivoire", "country aliases resolve");
  const map = validateSpec(DiagramSpecSchema.parse({ title: "m", kind: "map", map: { markers: [{ label: "Fake town", lat: 48.8, lon: 2.3, country: "Japan" }, { label: "Paris", lat: 10, lon: 10 }] } }), 1);
  check(map.spec.map?.markers?.length === 1 && map.spec.map.markers[0].lat === 48.86, "a marker outside its claimed country is dropped; known cities use real coordinates");

  // Atoms: shells for every element 1–36 add up to Z; ions.
  ELEMENTS.forEach(([sym], i) => check(shellsFor(i + 1).reduce((a, b) => a + b, 0) === i + 1, `shells for ${sym} sum to Z`));
  check(shellsFor(11).join() === "2,8,1" && shellsFor(24).join() === "2,8,13,1" && shellsFor(29).join() === "2,8,18,1", "Na, Cr, Cu shells");
  check(ionShells(11, 1).join() === "2,8" && ionShells(17, -1).join() === "2,8,8" && ionShells(26, 2).join() === "2,8,14", "Na⁺, Cl⁻, Fe²⁺ shells");
  const bad = validateSpec(DiagramSpecSchema.parse({ title: "a", kind: "atom", atom: { element: "unobtainium" } }), 1);
  check(bad.critical.length > 0, "unknown element is rejected");

  // Circuits: Ohm's law and series/parallel rules.
  const series = validateSpec(DiagramSpecSchema.parse(FIXTURES.series_circuit.spec), 2).spec.circuit!;
  const s1 = solveCircuit(series);
  check(!("reason" in s1) && s1.total === 6 && s1.current === 2, "series circuit: 4 Ω + 2 Ω = 6 Ω, I = 2 A");
  const par = validateSpec(DiagramSpecSchema.parse(FIXTURES.parallel_circuit.spec), 2);
  const s2 = solveCircuit(par.spec.circuit!);
  check(!("reason" in s2) && Math.abs(s2.total - 6) < 1e-9 && Math.abs(s2.current - 1) < 1e-9, "parallel circuit: 12 Ω ∥ 6 Ω + 2 Ω = 6 Ω, I = 1 A");
  if (!("reason" in s2)) {
    const vm = [...s2.readings.entries()].find(([p]) => p.type === "voltmeter")?.[1];
    check(Math.abs((vm?.voltage ?? 0) - 2) < 1e-9, `voltmeter (moved in parallel across R) reads 2 V (got ${vm?.voltage})`);
  }
  check(par.issues.some((i) => i.includes("voltmeter")), "a voltmeter in series is moved in parallel");
  const open = solveCircuit({ source: { type: "battery", voltage: 9 }, items: [{ type: "switch", open: true }, { type: "resistor", value: 3 }] });
  check(!("reason" in open) && open.current === 0, "an open switch means no current");
  const shorted = validateSpec(DiagramSpecSchema.parse({ title: "s", kind: "circuit", circuit: { source: { voltage: 6 }, items: [{ parallel: [[{ type: "resistor", value: 2 }], [{ type: "ammeter" }]] }] } }), 1);
  check(shorted.critical.length > 0, "an ammeter alone in a parallel branch is rejected (short circuit)");

  // Vectors: resultants are computed; a model-stated net force is corrected.
  const r = sumVectors([{ magnitude: 3, angle: 0 }, { magnitude: 4, angle: 90 }]);
  check(Math.abs(r.magnitude - 5) < 1e-9 && Math.abs(r.angle - 53.13) < 0.01, "3 N + 4 N at right angles = 5 N at 53.13°");
  const incline = validateSpec(DiagramSpecSchema.parse(FIXTURES.incline.spec), 3);
  check(incline.issues.some((i) => i.includes("replaced by the computed resultant 0")), "a wrong stated net force on a slope is corrected to 0");
  const inc = layoutDiagram(incline.spec, 3);
  check(inc.texts.some((t) => t.text.includes("balance")) && !inc.paths.some((p) => p.id === "x-net"), "balanced forces: summary says so and no net arrow is drawn");

  // Labelled diagrams: every part anchor lies within the template's drawing.
  for (const [id, make] of Object.entries(TEMPLATES)) {
    const t = make();
    const xs = t.paths.flatMap((p) => p.points.map((q) => q[0])), ys = t.paths.flatMap((p) => p.points.map((q) => q[1]));
    for (const part of t.parts) {
      const [x, y] = part.anchor;
      check(x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys), `${id}: anchor of ${part.id} is inside the drawing`);
    }
  }
  // DNA: each base's label points at a rung half of that base's colour.
  const helix = TEMPLATES.dna();
  const baseRole: Record<string, string> = { adenine: "danger", thymine: "warning", guanine: "success", cytosine: "primary" };
  for (const [part, role] of Object.entries(baseRole)) {
    const [ax, ay] = helix.parts.find((p) => p.id === part)!.anchor;
    const onRung = helix.paths.some((p) => p.role === role && p.points.length === 2 && p.points[0][0] === ax && ay >= Math.min(p.points[0][1], p.points[1][1]) && ay <= Math.max(p.points[0][1], p.points[1][1]));
    check(onRung, `DNA: the ${part} label points at a ${role} rung`);
  }
  const unknownPart = validateSpec(DiagramSpecSchema.parse(FIXTURES.plant_cell.spec), 1);
  check(unknownPart.issues.some((i) => i.includes('"golgi" is not a part')), "labels for parts a template doesn't have are dropped");
  // Regression (live): a Roman Empire map with region "world" showed the Mediterranean as a speck.
  const roman = validateSpec(DiagramSpecSchema.parse({ title: "r", kind: "map", map: { region: "world", countries: [{ name: "Italy" }, { name: "Egypt" }, { name: "Spain" }], markers: [{ label: "Rome" }, { label: "Alexandria" }] } }), 1).spec;
  const vb = viewBox(roman.map!);
  check(vb[1] - vb[0] < 120 && vb[0] > -40 && vb[1] < 70, `a "world" map of Mediterranean content zooms to it (got lon ${vb[0].toFixed(0)}..${vb[1].toFixed(0)})`);
  const world = viewBox(validateSpec(DiagramSpecSchema.parse({ title: "w", kind: "map", map: { region: "world", countries: [{ name: "Brazil" }, { name: "Japan" }, { name: "Australia" }] } }), 1).spec.map!);
  check(world[1] - world[0] >= 300, "a world map of worldwide content stays a world map");
  // Regression (live): a circuit came with a Python panel full of literal "\n".
  const withCode = validateSpec(DiagramSpecSchema.parse({ title: "c", kind: "circuit", circuit: { source: { voltage: 9 }, items: [{ type: "resistor", value: 3 }] }, code: { language: "python", code: "V = 9\\nR = 3" } }), 1);
  check(!withCode.spec.code, "no code panel on a circuit");
  const escaped = validateSpec(DiagramSpecSchema.parse({ title: "f", kind: "flowchart", nodes: [{ id: "a", label: "A" }], code: { language: "python", code: "x = 1\\ny = 2" } }), 1);
  check(escaped.spec.code?.code === "x = 1\ny = 2", "escaped newlines in code are unescaped");
  console.log("✓ Phase B facts: molecules, places, atoms, circuits, vectors, templates");
}

// ── Worked examples ────────────────────────────────────
console.log("\nWorked examples");
{
  check(evaluate("min(∞, 0 + 5)") === 5 && evaluate("2^3 + √16") === 12 && evaluate("x + 1") === null, "safe evaluator: min/∞/powers/roots; variables rejected");
  const fix = (s: string) => fixArithmetic(s).text;
  check(fix("dist(C) = min(5, 2 + 1) = 4") === "dist(C) = min(5, 2 + 1) = 3", "wrong result in a calculation is corrected");
  check(fix("v = 20 / 4 = 6 m/s") === "v = 20 / 4 = 5 m/s", "corrected before a unit");
  check(fix("1/2 = 40%") === "1/2 = 50%", "percent results compared as percentages");
  for (const ok of ["mid = (0 + 9) / 2 = 4", "1/3 = 0.33", "x = 7 - 3 = 4", "2x + 3 = 7", "y = 3x = 6", "E = 6.02 × 10²³", "F = 5 × 9.8 = 49 N", "Year 2024 = leap"]) {
    check(fix(ok) === ok, `left alone: "${ok}"`);
  }

  const worked = {
    title: "Dijkstra from A",
    problem: "Edges: A–B 2, A–C 5, B–C 1, B–D 2, C–D 3. Start at A.",
    figure: { nodes: [{ id: "A", label: "A" }, { id: "B", label: "B" }, { id: "C", label: "C" }, { id: "D", label: "D" }],
      edges: [{ from: "A", to: "B", label: "2" }, { from: "A", to: "C", label: "5" }, { from: "B", to: "C", label: "1" }, { from: "B", to: "D", label: "2" }, { from: "C", to: "D", label: "3" }, { from: "C", to: "Z", label: "9" }] },
    steps: [
      { title: "Initialise", lines: ["dist(A) = 0, others = ∞"], table: { columns: ["Node", "A", "B", "C", "D"], rows: [["dist", "0", "∞", "∞", "∞"]] }, step: 3 },
      { title: "Visit A", lines: ["dist(B) = min(∞, 0 + 2) = 2", "dist(C) = min(∞, 0 + 5) = 5"], step: 4 },
      { title: "Visit B", lines: ["dist(C) = min(5, 2 + 1) = 4", "dist(D) = min(∞, 2 + 2) = 4"], step: 2 },
      { title: "Visit C", lines: ["dist(D) = min(4, 3 + 3) = 4"] },
      { title: "Visit D", lines: ["No shorter paths: done"] },
    ],
    answer: "A→B = 2, A→C = 3, A→D = 4",
  };
  const v = validateSpec(DiagramSpecSchema.parse({ title: "Dijkstra's algorithm", kind: "flowchart", nodes: [{ id: "s", label: "Start" }, { id: "e", label: "End" }], edges: [{ from: "s", to: "e" }], worked }), 5);
  const w = v.spec.worked!;
  check(w.steps[2].lines[0] === "dist(C) = min(5, 2 + 1) = 3" && v.issues.some((i) => i.startsWith("arithmetic")), "worked example arithmetic corrected and reported");
  check(w.steps.map((s) => s.step).join(",") === "3,4,4,4,5", `worked steps clamped and never go backwards (${w.steps.map((s) => s.step)})`);
  check(w.figure!.edges.length === 5, "figure edges to missing nodes dropped");

  const placed = layoutDiagram(v.spec, 5);
  const ids = new Set([...placed.boxes.map((b) => b.id), ...placed.texts.map((t) => t.id)]);
  check(["x-wk_title", "x-wk_problem", "x-wk_card0", "x-wk_card4", "x-wk_answer", "x-wk_t0_0_0", "wkg_A"].every((id) => ids.has(id)), "panel: title, problem, cards, table cells, answer and figure nodes placed");
  const c0 = placed.boxes.find((b) => b.id === "x-wk_card0")!, c1 = placed.boxes.find((b) => b.id === "x-wk_card1")!;
  check(c0.y === c1.y && c1.x > c0.x, "more than 3 steps → two columns");
  check(placed.boxes.find((b) => b.id === "x-wk_card1")!.step === 4 && placed.texts.find((t) => t.id === "x-wk_l1")!.step === 4, "each card is revealed with its teaching step");
  const main = placed.boxes.find((b) => b.id === "e")!;
  check(c0.x > main.x + main.w, "panel sits beside the main diagram");
  check(placed.edges.filter((e) => e.from?.startsWith("wkg_")).length === 5, "figure edges are drawn");
  const compiled = compileDiagram(placed, "d9", { x: 0, y: 0 });
  const gate = gateActions(compiled.creates, []);
  check(gate.warnings.length === 0 && gate.actions.length === compiled.creates.length, `worked panel passes the canvas gate (${gate.warnings.join("; ")})`);

  // Worked example only (the designer failed): still a valid, drawable diagram.
  const only = validateSpec(DiagramSpecSchema.parse({ title: "Worked example", kind: "flowchart", worked }), 5);
  check(only.critical.length === 0, "a worked example alone is drawable");
  const solo = layoutDiagram(only.spec, 5);
  check(Math.min(...solo.boxes.map((b) => b.x)) < 5, "a lone panel starts at the left edge");
  check(describeSpecChanges(v.spec, { ...v.spec, worked: undefined }).includes("Removed the worked example."), "edits report worked example changes");
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll diagram pipeline checks passed.");
