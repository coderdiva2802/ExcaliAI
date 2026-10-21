// ─────────────────────────────────────────────────────────
// Semantic validation + repair for the quantitative kinds.
//
// The model supplies data; code checks it and computes every
// derived value that could be wrong (jump sizes, percentages,
// angle measures, intersections).  Unparseable data is dropped
// with a recorded issue; missing essentials are `critical`.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec } from "./spec.js";
import { ExprError, compileExpression, fmt, intersections } from "./mathExpr.js";
import { parseYear } from "./dates.js";
import { validateVectors } from "./vectors.js";
import { validateCircuit } from "./circuit.js";
import { validateChemistry } from "./chemistry.js";
import { validateAtom } from "./atom.js";
import { validateLabelled } from "./templates.js";
import { validateMap } from "./geo.js";

const NUMERIC_LABEL = /^\s*[+\-−]?\s*\d+(\.\d+)?\s*°?\s*$/;
const parseNumericLabel = (label: string) => parseFloat(label.replace(/[−\s°]/g, (c) => (c === "−" ? "-" : "")));

export function signed(n: number): string {
  return n >= 0 ? `+${fmt(n)}` : fmt(n);
}

export function validateQuant(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  switch (spec.kind) {
    case "number_line": {
      const nl = spec.numberLine;
      if (!nl) { critical.push('kind "number_line" needs a "numberLine" block with min and max'); return spec; }
      let { min, max } = nl;
      if (min > max) [min, max] = [max, min];
      // Expand the range to include every value the student must see.
      const values = [
        ...(nl.points ?? []).map((p) => p.value),
        ...(nl.jumps ?? []).flatMap((j) => [j.from, j.to]),
        ...(nl.intervals ?? []).flatMap((i) => [i.from, i.to]).filter((v): v is number => v !== undefined),
      ];
      const lo = Math.min(min, ...values);
      const hi = Math.max(max, ...values);
      if (lo < min || hi > max) issues.push(`number line range expanded to ${fmt(lo)}..${fmt(hi)} to include all values`);
      if (hi === lo) { critical.push("number line range is empty"); return spec; }
      if ((hi - lo) / (nl.step ?? 1) > 60) issues.push("number line step too small for the range → auto ticks");
      // Points that merely repeat the tick labels (a dot on every integer) clutter the line: drop them.
      let points = nl.points;
      const plain = (points ?? []).filter((p) => !p.label || p.label.trim() === fmt(p.value) || p.label.trim() === String(p.value));
      if (points && points.length > 4 && plain.length === points.length && points.every((p) => Number.isInteger(p.value))) {
        issues.push(`${points.length} unlabelled points just repeat the tick marks → dropped`);
        points = [];
      }
      // Jump labels are facts: compute them.
      const jumps = (nl.jumps ?? []).map((j) => {
        const delta = j.to - j.from;
        const computed = signed(delta);
        if (j.label && NUMERIC_LABEL.test(j.label) && Math.abs(parseNumericLabel(j.label) - delta) > 1e-9) {
          issues.push(`jump label "${j.label}" contradicts ${fmt(j.from)}→${fmt(j.to)} → corrected to ${computed}`);
          return { ...j, label: computed };
        }
        return { ...j, label: j.label && !NUMERIC_LABEL.test(j.label) ? j.label : computed };
      });
      return { ...spec, numberLine: { ...nl, min: lo, max: hi, jumps, points } };
    }

    case "coordinate_plane": {
      const plot = spec.plot;
      if (!plot) { critical.push('kind "coordinate_plane" needs a "plot" block'); return spec; }
      const functions = plot.functions.filter((f) => {
        try {
          compileExpression(f.expr);
          return true;
        } catch (err) {
          issues.push(`function "${f.expr}" is not valid math (${err instanceof ExprError ? err.message : "parse error"}) → dropped`);
          return false;
        }
      });
      if (!functions.length && !plot.points?.length && !plot.segments?.length) {
        critical.push("the plot has no valid functions, points or segments");
      }
      let { xMin, xMax } = plot;
      if (xMin !== undefined && xMax !== undefined && xMin >= xMax) {
        issues.push("xMin ≥ xMax → swapped");
        [xMin, xMax] = [xMax, xMin];
      }
      // Points the model placed "at" an intersection are checked against the computed one.
      let points = plot.points;
      if (functions.length >= 2 && points?.length) {
        const fs = functions.map((f) => compileExpression(f.expr));
        const lo = xMin ?? -10, hi = xMax ?? 10;
        const exact: Array<[number, number]> = [];
        for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) {
          for (const x of intersections(fs[a], fs[b], lo, hi)) exact.push([x, fs[a](x)]);
        }
        const tol = (hi - lo) * 0.08;
        points = points.map((p) => {
          const near = exact.find(([x, y]) => Math.hypot(x - p.x, y - p.y) < tol);
          if (!near) return p;
          const [x, y] = [Math.round(near[0] * 1000) / 1000, Math.round(near[1] * 1000) / 1000];
          if (Math.abs(x - p.x) < 1e-6 && Math.abs(y - p.y) < 1e-6) return p;
          issues.push(`point (${fmt(p.x)}, ${fmt(p.y)}) corrected to the computed intersection (${fmt(x)}, ${fmt(y)})`);
          const coordLabel = !p.label || /^\s*\(?\s*[-−\d.]+\s*,\s*[-−\d.]+\s*\)?\s*$/.test(p.label);
          return { ...p, x, y, label: coordLabel ? `(${fmt(x)}, ${fmt(y)})` : p.label };
        });
      }
      return { ...spec, plot: { ...plot, xMin, xMax, functions, points } };
    }

    case "geometry": {
      const g = spec.geometry;
      if (!g) { critical.push('kind "geometry" needs a "geometry" block with points'); return spec; }
      const ids = new Set(g.points.map((p) => p.id));
      const has = (id: string, what: string) => {
        if (!ids.has(id)) issues.push(`${what} references unknown point "${id}" → dropped`);
        return ids.has(id);
      };
      const byId = new Map(g.points.map((p) => [p.id, p]));
      const angles = (g.angles ?? []).filter((a) => has(a.vertex, "angle") && has(a.from, "angle") && has(a.to, "angle")).map((a) => {
        if (!a.label || !NUMERIC_LABEL.test(a.label)) return a;
        const measure = angleDegrees(byId.get(a.vertex)!, byId.get(a.from)!, byId.get(a.to)!);
        if (Math.abs(parseNumericLabel(a.label) - measure) > 1.5) {
          issues.push(`angle label "${a.label}" contradicts the coordinates (${fmt(measure)}°) → corrected`);
          return { ...a, label: `${fmt(Math.round(measure * 10) / 10)}°` };
        }
        return a;
      });
      return {
        ...spec,
        geometry: {
          ...g,
          segments: (g.segments ?? []).filter((s) => has(s.from, "segment") && has(s.to, "segment")),
          polygons: (g.polygons ?? []).filter((p) => p.vertices.every((v) => has(v, "polygon"))),
          circles: (g.circles ?? []).filter((c) => {
            if (!has(c.center, "circle")) return false;
            if (!c.radius && !(c.through && ids.has(c.through))) {
              issues.push("circle without radius or 'through' point → dropped");
              return false;
            }
            return true;
          }),
          angles,
        },
      };
    }

    case "chart": {
      const c = spec.chart;
      if (!c) { critical.push('kind "chart" needs a "chart" block'); return spec; }
      if (c.type === "scatter") {
        if (!c.points?.length) critical.push("scatter chart needs points");
        return spec;
      }
      const series = (c.series ?? []).filter((s) => s.values.length > 0);
      const n = Math.max(c.categories?.length ?? 0, ...series.map((s) => s.values.length));
      if (!series.length || n === 0) { critical.push(`${c.type} chart needs at least one series with values`); return spec; }
      const categories = Array.from({ length: n }, (_, i) => c.categories?.[i] ?? `${i + 1}`);
      if ((c.categories?.length ?? 0) !== n) issues.push("chart categories did not match the data length → filled");
      const fixed = series.map((s) => {
        if (s.values.length !== n) issues.push(`series "${s.name}" has ${s.values.length} values for ${n} categories → padded with 0`);
        return { ...s, values: Array.from({ length: n }, (_, i) => s.values[i] ?? 0) };
      });
      if (c.type === "pie") {
        const values = fixed[0].values;
        if (fixed.length > 1) issues.push("pie chart uses only the first series");
        if (values.some((v) => v < 0)) { critical.push("pie chart values cannot be negative"); return spec; }
        if (values.reduce((a, b) => a + b, 0) <= 0) { critical.push("pie chart values must sum to more than 0"); return spec; }
        return { ...spec, chart: { ...c, categories, series: [fixed[0]] } };
      }
      return { ...spec, chart: { ...c, categories, series: fixed } };
    }

    case "table": {
      const t = spec.table;
      if (!t) { critical.push('kind "table" needs a "table" block'); return spec; }
      const cols = t.columns.length;
      const rows = t.rows.map((r) => {
        if (r.length !== cols) issues.push(`table row has ${r.length} cells for ${cols} columns → normalized`);
        return Array.from({ length: cols }, (_, i) => r[i] ?? "");
      });
      const highlight = (t.highlight ?? []).filter((h) => h.row >= 0 && h.row < rows.length && h.col >= 0 && h.col < cols);
      return { ...spec, table: { ...t, rows, highlight } };
    }

    case "venn": {
      const v = spec.venn;
      if (!v) { critical.push('kind "venn" needs a "venn" block with 2–3 sets'); return spec; }
      const ids = new Set(v.sets.map((s) => s.id));
      const seen = new Set<string>();
      const regions = v.regions.filter((r) => {
        const key = [...new Set(r.sets)].sort().join("&");
        if (!r.sets.every((id) => ids.has(id))) { issues.push(`venn region references unknown set → dropped`); return false; }
        if (seen.has(key)) { issues.push(`duplicate venn region ${key} → dropped`); return false; }
        seen.add(key);
        return true;
      });
      return { ...spec, venn: { ...v, regions } };
    }

    case "scaled_timeline": {
      const c = spec.chronology;
      if (!c) { critical.push('kind "scaled_timeline" needs a "chronology" block'); return spec; }
      const events = c.events.filter((e) => {
        const ok = parseYear(e.date) !== null;
        if (!ok) issues.push(`event date "${e.date}" is not a recognizable date → dropped`);
        return ok;
      });
      const periods = (c.periods ?? []).filter((p) => {
        const a = parseYear(p.from), b = parseYear(p.to);
        const ok = a !== null && b !== null && b >= a;
        if (!ok) issues.push(`period "${p.label}" has invalid dates → dropped`);
        return ok;
      });
      if (events.length + periods.length < 2) critical.push("a scaled timeline needs at least 2 dated events or periods");
      return { ...spec, chronology: { events, periods } };
    }

    case "vectors": return validateVectors(spec, issues, critical);
    case "circuit": return validateCircuit(spec, issues, critical);
    case "molecule": return validateChemistry(spec, issues, critical);
    case "atom": return validateAtom(spec, issues, critical);
    case "labelled_diagram": return validateLabelled(spec, issues, critical);
    case "map": return validateMap(spec, issues, critical);

    case "cycle":
      if (spec.nodes.length < 3) critical.push("a cycle needs at least 3 stages (nodes)");
      return spec;

    default:
      return spec;
  }
}

/** Interior angle at `vertex` between rays to `a` and `b`, in degrees (0–180). */
export function angleDegrees(vertex: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const v1 = [a.x - vertex.x, a.y - vertex.y];
  const v2 = [b.x - vertex.x, b.y - vertex.y];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const len = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
  return len === 0 ? 0 : (Math.acos(Math.max(-1, Math.min(1, dot / len))) * 180) / Math.PI;
}

/** Which data block each quantitative kind is drawn from. */
export const KIND_BLOCK = {
  number_line: "numberLine",
  coordinate_plane: "plot",
  geometry: "geometry",
  chart: "chart",
  table: "table",
  venn: "venn",
  scaled_timeline: "chronology",
  vectors: "vectors",
  circuit: "circuit",
  molecule: "chemistry",
  atom: "atom",
  labelled_diagram: "labelled",
  map: "map",
} as const satisfies Partial<Record<DiagramSpec["kind"], keyof DiagramSpec>>;

/** True when the spec carries the data block its own kind is drawn from. */
export function hasQuantContent(spec: DiagramSpec): boolean {
  const block = KIND_BLOCK[spec.kind as keyof typeof KIND_BLOCK];
  return Boolean(block && spec[block]);
}

/**
 * Models sometimes pick one kind and fill another kind's data (e.g. kind "timeline"
 * with a "chronology" block and no nodes) — which would render nothing. If the chosen
 * kind has nothing to draw but another data block is present, switch to that block's kind.
 */
export function reconcileKind(spec: DiagramSpec, issues: string[]): DiagramSpec {
  const ownBlock = KIND_BLOCK[spec.kind as keyof typeof KIND_BLOCK];
  const hasOwnContent = ownBlock ? Boolean(spec[ownBlock]) : spec.nodes.length > 0 || Boolean(spec.formulas?.length || spec.code);
  if (hasOwnContent) return spec;
  const match = (Object.entries(KIND_BLOCK) as Array<[DiagramSpec["kind"], keyof DiagramSpec]>).find(([, block]) => spec[block]);
  if (!match) return spec;
  issues.push(`kind "${spec.kind}" had no data to draw but a "${String(match[1])}" block was given → drawn as "${match[0]}"`);
  return { ...spec, kind: match[0] };
}
