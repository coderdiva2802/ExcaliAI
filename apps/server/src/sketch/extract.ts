// ─────────────────────────────────────────────────────────
// Labelled SVG → sketch (drawing + named parts with anchors).
//
// Reference diagrams already say what each part is: a text
// label joined to the structure by a leader line. We keep the
// drawing, drop the original text and leader lines, and turn
// every label into a named part anchored where its leader
// pointed (the dotted / marker end, or the end farther from
// the text). The labels are then redrawn by our own callout
// layout, so sketches look like the built-in templates.
// ─────────────────────────────────────────────────────────

import type { PlacedPath, Pt } from "../diagram/layout.js";
import type { Template, TemplatePart } from "../diagram/templates.js";
import type { SvgDoc, SvgShape, SvgText } from "./svg.js";

/** Drawing size in canvas units (similar to the built-in templates). */
const BOX_W = 480, BOX_H = 420;
const MAX_PATHS = 180;
const MAX_POINTS = 9_000;
export const MAX_PARTS = 14;

export interface ExtractResult {
  template: Omit<Template, "id" | "title">;
  /** Labels that could not be tied to the drawing (dropped). */
  unplaced: string[];
}

const area = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
};
const bboxOf = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
function distToBox([x, y]: Pt, b: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w)), dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
export function pointInPolygon([x, y]: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let worst = -1, dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const d = len < 1e-6 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > dmax) { dmax = d; worst = i; }
    }
    if (worst > 0 && dmax > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A thin, unfilled, nearly straight stroke — the shape of a leader line (or a bracket). */
function isLeaderLike(s: SvgShape): boolean {
  if (s.fill || !s.stroke || s.closed) return false;
  const b = bboxOf(s.points);
  const span = Math.hypot(b.w, b.h);
  if (span < 4) return false;
  // Path length vs. straight distance: leaders are straight or gently curved.
  let len = 0;
  for (let i = 1; i < s.points.length; i++) len += Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1]);
  const ends = Math.hypot(s.points.at(-1)![0] - s.points[0][0], s.points.at(-1)![1] - s.points[0][1]);
  return ends > 0 && len / ends < 1.6;
}

export function labelText(t: SvgText): { name: string; detail?: string } {
  // Join lines ("Tympanic" + "membrane"), undoing hyphenation at line ends.
  const joined = t.lines.reduce((acc, l) => (acc.endsWith("-") ? acc.slice(0, -1) + l : acc ? `${acc} ${l}` : l), "").replace(/\s+/g, " ").trim();
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(joined);
  const name = (m ? m[1] : joined).replace(/[:;,.\s]+$/, "").trim();
  return m && m[1].trim() ? { name, detail: m[2].trim() } : { name };
}

export const partId = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "part";

/** Turn a parsed SVG into a sketch. Returns null when it has too little usable content. */
export function extractSketch(doc: SvgDoc): ExtractResult | null {
  // Page backgrounds (a filled rectangle behind everything) are neither drawing nor a label's host.
  const extent = bboxOf(doc.shapes.flatMap((s) => s.points));
  const backdrop = new Set<number>();
  doc.shapes.forEach((s, i) => {
    const b = bboxOf(s.points);
    if (s.fill && s.closed && b.w >= extent.w * 0.97 && b.h >= extent.h * 0.97 && (s.fill === "#ffffff" || s.points.length <= 6)) backdrop.add(i);
  });

  const labels = doc.texts.filter((t) => /\p{L}{2,}/u.test(t.lines.join(" ")) && t.lines.join(" ").length <= 80);
  const used = new Set<number>(); // shape indices that are leaders / brackets
  const anchored: Array<{ text: SvgText; anchor: Pt; leader: boolean }> = [];
  const unplaced: string[] = [];

  // 1. Leader lines: one end touches the label, the other points at the part.
  const candidates = doc.shapes.map((s, i) => ({ s, i })).filter(({ s }) => isLeaderLike(s));
  const pairs: Array<{ li: number; ci: number; d: number; anchor: Pt }> = [];
  labels.forEach((t, li) => {
    const tol = Math.max(10, t.fontSize * 1.6);
    for (const { s, i } of candidates) {
      const a = s.points[0], b = s.points.at(-1)!;
      const da = distToBox(a, t.box), db = distToBox(b, t.box);
      const near = Math.min(da, db);
      if (near > tol) continue;
      // The marker (dot / arrow head) sits at the anchor; otherwise the far end is the anchor.
      let anchor = da <= db ? b : a;
      if (s.markerStart && !s.markerEnd) anchor = a;
      if (s.markerEnd && !s.markerStart) anchor = b;
      if (distToBox(anchor, t.box) < 2) continue; // both ends inside the label: not a leader
      pairs.push({ li, ci: i, d: near, anchor });
    }
  });
  pairs.sort((p, q) => p.d - q.d);
  const labelDone = new Set<number>();
  for (const p of pairs) {
    if (labelDone.has(p.li) || used.has(p.ci)) continue;
    labelDone.add(p.li);
    used.add(p.ci);
    anchored.push({ text: labels[p.li], anchor: p.anchor, leader: true });
  }

  // 2. Labels written on the structure itself: anchor at the label's centre if it lies inside a filled shape.
  const filled = doc.shapes.filter((s, i) => s.fill && s.points.length > 2 && !backdrop.has(i));
  labels.forEach((t, li) => {
    if (labelDone.has(li)) return;
    const c: Pt = [t.box.x + t.box.w / 2, t.box.y + t.box.h / 2];
    const host = filled.find((s) => pointInPolygon(c, s.points));
    if (host) anchored.push({ text: t, anchor: c, leader: false });
    else unplaced.push(t.lines.join(" "));
  });

  // 3. Any other leader-like stroke touching a text (brackets, orphan leaders) goes too.
  doc.shapes.forEach((s, i) => {
    if (used.has(i) || !isLeaderLike(s)) return;
    if (labels.some((t) => Math.min(distToBox(s.points[0], t.box), distToBox(s.points.at(-1)!, t.box)) <= Math.max(8, t.fontSize))) used.add(i);
  });

  // 4. The drawing: everything else, in painter's order.
  let drawing = doc.shapes.filter((s, i) => !used.has(i) && !backdrop.has(i) && s.points.length > 1);
  if (drawing.length < 3) return null;
  // Tiny specks don't help a schematic.
  const all = bboxOf(drawing.flatMap((s) => s.points));
  drawing = drawing.filter((s) => {
    const b = bboxOf(s.points);
    return Math.max(b.w, b.h) >= Math.max(all.w, all.h) * 0.004;
  });
  if (drawing.length < 3) return null;

  const bb = bboxOf(drawing.flatMap((s) => s.points));
  if (bb.w < 1 || bb.h < 1) return null;
  const scale = Math.min(BOX_W / bb.w, BOX_H / bb.h);
  const T = ([x, y]: Pt): Pt => [Math.round((20 + (x - bb.x) * scale) * 10) / 10, Math.round((20 + (y - bb.y) * scale) * 10) / 10];

  // Keep the largest shapes when there are too many (stable order).
  if (drawing.length > MAX_PATHS) {
    const ranked = drawing.map((s, i) => ({ i, size: bboxOf(s.points).w * bboxOf(s.points).h + (s.fill ? 0 : 1) })).sort((a, b) => b.size - a.size);
    const keep = new Set(ranked.slice(0, MAX_PATHS).map((r) => r.i));
    drawing = drawing.filter((_, i) => keep.has(i));
  }

  let tol = 0.6;
  let paths: Array<Omit<PlacedPath, "step">> = [];
  for (let pass = 0; pass < 6; pass++) {
    paths = drawing.map((s) => {
      const pts = simplify(s.points.map(T), tol);
      const closed = s.closed && pts.length > 2;
      const fill = s.fill && closed ? s.fill : undefined;
      const sw = s.stroke ? Math.min(16, Math.max(0.5, s.strokeWidth * scale)) : 1;
      return {
        id: "",
        points: pts.slice(0, 2000),
        ...(closed ? { closed: true } : {}),
        smooth: s.curved && pts.length > 5,
        role: "ink" as const,
        // No stroke in the source: outline in the fill colour so the shape reads as a solid area.
        strokeColor: s.stroke ?? fill ?? "#1e1e1e",
        ...(fill ? { fillColor: fill } : {}),
        strokeWidth: Math.round(sw * 10) / 10,
        ...(s.opacity < 0.98 ? { opacity: Math.max(15, Math.round(s.opacity * 100)) } : {}),
      };
    }).filter((p) => p.points.length > 1);
    if (paths.reduce((n, p) => n + p.points.length, 0) <= MAX_POINTS) break;
    tol *= 1.8;
  }

  // 5. Parts: one per label, unique ids, anchors in drawing coordinates (nudged inside the drawing).
  const parts: TemplatePart[] = [];
  const seen = new Set<string>();
  // The source placed its labels around the figure without crossing leaders: keep each label on that side.
  const sideOf = (t: SvgText): TemplatePart["side"] => {
    const u = (t.box.x + t.box.w / 2 - bb.x) / bb.w, v = (t.box.y + t.box.h / 2 - bb.y) / bb.h;
    if (u <= 0.15) return "left";
    if (u >= 0.85) return "right";
    if (v <= 0.15) return "top";
    if (v >= 0.85) return "bottom";
    const edges: Array<[number, TemplatePart["side"]]> = [[u, "left"], [1 - u, "right"], [v, "top"], [1 - v, "bottom"]];
    return edges.sort((a, b) => a[0] - b[0])[0][1];
  };
  for (const { text, anchor, leader } of anchored) {
    const { name, detail } = labelText(text);
    if (!name) continue;
    let id = partId(name);
    if (seen.has(id)) { let k = 2; while (seen.has(`${id}_${k}`)) k++; id = `${id}_${k}`; }
    seen.add(id);
    const [ax, ay] = T(anchor);
    parts.push({ id, name: name.slice(0, 40), ...(detail ? { detail: detail.slice(0, 60) } : {}), ...(leader ? { side: sideOf(text) } : {}), anchor: [Math.min(BOX_W + 25, Math.max(15, ax)), Math.min(BOX_H + 25, Math.max(15, ay))] });
    if (parts.length >= MAX_PARTS) break;
  }
  if (parts.length < 3) return null;
  return { template: { paths, parts }, unplaced };
}
