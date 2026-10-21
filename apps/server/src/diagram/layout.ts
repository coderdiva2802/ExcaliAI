// ─────────────────────────────────────────────────────────
// Layout Engine — deterministic geometry for DiagramSpecs.
//
// Each diagram kind has a dedicated layout algorithm that
// sizes nodes from their (estimated) label size, keeps
// consistent spacing, avoids collisions and routes edges.
// Output coordinates are relative to the diagram's top-left
// corner; the compiler translates them onto the canvas.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec, Role, SpecEdge, SpecNode } from "./spec.js";
import {
  layoutChart,
  layoutChronology,
  layoutCycle,
  layoutGeometry,
  layoutNumberLine,
  layoutPlot,
  layoutTable,
  layoutVenn,
} from "./layoutQuant.js";
import { layoutVectors } from "./vectors.js";
import { layoutCircuit } from "./circuit.js";
import { layoutMolecules } from "./chemistry.js";
import { layoutAtom } from "./atom.js";
import { layoutLabelled } from "./templates.js";
import { layoutMap } from "./geo.js";
import {
  LINE_HEIGHT,
  estimateCodeSize,
  estimateFormulaSize,
  measureBlock,
} from "./textMetrics.js";

// ── Output types ───────────────────────────────────────

export type Pt = [number, number];
export type ShapeKind = "rect" | "rounded" | "ellipse" | "diamond";
export type Tone = "title" | "body" | "muted" | Role;

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: ShapeKind;
  label: string;
  role: Role;
  step: number;
  fontSize: number;
  dashed?: boolean;
}

export interface PlacedEdge {
  id: string;
  /** Bound endpoints (omitted for free-floating arrows, e.g. sequence messages). */
  from?: string;
  to?: string;
  points: Pt[];
  label?: string;
  role?: Role;
  dashed?: boolean;
  directed: boolean;
  /** Smooth curve through the waypoints. */
  curved?: boolean;
  step: number;
}

/** Free-form path: plots, axes, ticks, polygons, arcs, Venn circles, pie slices. */
export interface PlacedPath {
  id: string;
  points: Pt[];
  closed?: boolean;
  smooth?: boolean;
  /** Stroke color role (default: muted). */
  role?: Role | "ink";
  /** Fill role for closed paths. */
  fill?: Role;
  /** Explicit fill colour (light-theme space); overrides `fill`. */
  fillColor?: string;
  /** Explicit stroke colour (light-theme space); overrides `role`. */
  strokeColor?: string;
  opacity?: number;
  strokeWidth?: number;
  dashed?: boolean;
  arrowEnd?: boolean;
  arrowStart?: boolean;
  step: number;
}

export interface PlacedText {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  tone: Tone;
  align: "left" | "center";
  step: number;
}

export interface PlacedLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
  step: number;
}

export interface PlacedOverlay {
  id: string;
  type: "formula" | "code";
  x: number;
  y: number;
  w: number;
  h: number;
  latex?: string;
  code?: string;
  language?: string;
  fontSize?: number;
  step: number;
}

export interface PlacedDiagram {
  paths: PlacedPath[];
  boxes: PlacedBox[];
  edges: PlacedEdge[];
  texts: PlacedText[];
  lines: PlacedLine[];
  overlays: PlacedOverlay[];
  width: number;
  height: number;
}

// ── Design constants ───────────────────────────────────

const NODE_FONT = 18;
const EDGE_FONT = 15;
const TITLE_FONT = 28;
const NOTE_FONT = 15;
const SMALL_FONT = 14;
const PAD_X = 22;
const PAD_Y = 14;
const MIN_W = 110;
const MIN_H = 56;
const GAP_X = 64;
const GAP_Y = 84;
const GAP_Y_LAYERED = 64;
const EDGE_CLEARANCE = 6;
/** Excalidraw wraps arrow labels at max(0.7·length, 11·fontSize). */
const EDGE_LABEL_WRAP = EDGE_FONT * 11;
const ROLE_CYCLE: Role[] = ["primary", "secondary", "accent", "success", "warning"];

// ── Geometry helpers ───────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }

const cx = (b: Rect) => b.x + b.w / 2;
const cy = (b: Rect) => b.y + b.h / 2;

function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    a.x + a.w + margin > b.x &&
    a.y < b.y + b.h + margin &&
    a.y + a.h + margin > b.y
  );
}

/** Point on the boundary of `box` along the ray from its center toward `toward`. */
export function clipToShape(box: PlacedBox, toward: Pt, gap = EDGE_CLEARANCE): Pt {
  const c: Pt = [cx(box), cy(box)];
  const dx = toward[0] - c[0];
  const dy = toward[1] - c[1];
  if (dx === 0 && dy === 0) return c;
  const hw = box.w / 2;
  const hh = box.h / 2;
  let t: number;
  if (box.shape === "ellipse") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (box.shape === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return [c[0] + dx * t + (dx / len) * gap, c[1] + dy * t + (dy / len) * gap];
}

function segmentHitsRect(p1: Pt, p2: Pt, r: Rect, inflate = 8): boolean {
  const x0 = r.x - inflate, y0 = r.y - inflate, x1 = r.x + r.w + inflate, y1 = r.y + r.h + inflate;
  // Liang–Barsky clipping
  let t0 = 0, t1 = 1;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const tests: Array<[number, number]> = [
    [-dx, p1[0] - x0], [dx, x1 - p1[0]], [-dy, p1[1] - y0], [dy, y1 - p1[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t0 < t1;
}

function pathHitsAny(points: Pt[], obstacles: Rect[]): Rect[] {
  const hits: Rect[] = [];
  for (const o of obstacles) {
    for (let i = 0; i < points.length - 1; i++) {
      if (segmentHitsRect(points[i], points[i + 1], o)) {
        hits.push(o);
        break;
      }
    }
  }
  return hits;
}

/**
 * Straight edge between two boxes; if it would cut through another
 * node, reroute through a vertical (or horizontal) lane beside the
 * obstacles.
 */
function routeEdge(a: PlacedBox, b: PlacedBox, all: PlacedBox[], preferVerticalLane = true): Pt[] {
  const straight: Pt[] = [clipToShape(a, [cx(b), cy(b)]), clipToShape(b, [cx(a), cy(a)])];
  const others = all.filter((o) => o.id !== a.id && o.id !== b.id);
  const hits = pathHitsAny(straight, others);
  if (hits.length === 0) return straight;

  if (preferVerticalLane) {
    const right = Math.max(...hits.map((h) => h.x + h.w)) + 28;
    const left = Math.min(...hits.map((h) => h.x)) - 28;
    const mid = (cx(a) + cx(b)) / 2;
    const lane = Math.abs(right - mid) <= Math.abs(mid - left) ? right : left;
    const path: Pt[] = [clipToShape(a, [lane, cy(a)]), [lane, cy(a)], [lane, cy(b)], clipToShape(b, [lane, cy(b)])];
    return pathHitsAny(path, others).length === 0 ? path : straight;
  }
  const below = Math.max(...hits.map((h) => h.y + h.h)) + 28;
  const above = Math.min(...hits.map((h) => h.y)) - 28;
  const mid = (cy(a) + cy(b)) / 2;
  const lane = Math.abs(below - mid) <= Math.abs(mid - above) ? below : above;
  const path: Pt[] = [clipToShape(a, [cx(a), lane]), [cx(a), lane], [cx(b), lane], clipToShape(b, [cx(b), lane])];
  return pathHitsAny(path, others).length === 0 ? path : straight;
}

function edgeLabelSize(label: string | undefined): { w: number; h: number } {
  if (!label) return { w: 0, h: 0 };
  const b = measureBlock(label, EDGE_FONT, EDGE_LABEL_WRAP);
  return { w: b.width, h: b.height };
}

// ── Node sizing ────────────────────────────────────────

function shapeOf(node: SpecNode, fallback: ShapeKind): ShapeKind {
  switch (node.shape) {
    case "box": return "rect";
    case "rounded":
    case "pill": return "rounded";
    case "circle": return "ellipse";
    case "diamond": return "diamond";
    default: return fallback;
  }
}

export function makeBox(node: SpecNode, fallbackShape: ShapeKind, role: Role, opts: { minW?: number; minH?: number; maxTextW?: number } = {}): PlacedBox {
  const shape = shapeOf(node, fallbackShape);
  const label = node.detail ? `${node.label}\n${node.detail}` : node.label;
  const maxTextW = opts.maxTextW ?? (shape === "rect" || shape === "rounded" ? 210 : 150);
  const block = measureBlock(label, NODE_FONT, maxTextW);
  let w: number, h: number;
  if (shape === "ellipse") {
    // Excalidraw's usable label area inside an ellipse is (w/2·√2 − 10).
    w = Math.max(76, (block.width + 22) / 0.707);
    h = Math.max(76, (block.height + 18) / 0.707);
    if (Math.abs(w - h) < 36) w = h = Math.max(w, h);
  } else if (shape === "diamond") {
    // Usable label area inside a diamond is (w/2 − 10) × (h/2 − 10).
    w = Math.max(140, 2 * (block.width + 24));
    h = Math.max(96, 2 * (block.height + 18));
  } else {
    w = Math.max(opts.minW ?? MIN_W, block.width + 2 * PAD_X);
    h = Math.max(opts.minH ?? MIN_H, block.height + 2 * PAD_Y);
  }
  return {
    id: node.id,
    x: 0,
    y: 0,
    w: Math.ceil(w),
    h: Math.ceil(h),
    shape,
    label: block.text,
    role: node.role ?? role,
    step: node.step ?? 1,
    fontSize: NODE_FONT,
  };
}

function hierarchyEdge(parent: PlacedBox, child: PlacedBox, step: number): PlacedEdge {
  return {
    id: `x-h_${parent.id}_${child.id}`,
    from: parent.id,
    to: child.id,
    points: [clipToShape(parent, [cx(child), cy(child)]), clipToShape(child, [cx(parent), cy(parent)])],
    directed: false,
    role: "muted",
    step,
  };
}

function specEdge(e: SpecEdge, i: number, points: Pt[], bound = true): PlacedEdge {
  return {
    id: `x-e${i}_${e.from}_${e.to}`,
    ...(bound ? { from: e.from, to: e.to } : {}),
    points,
    label: e.label,
    role: e.role,
    dashed: e.style === "dashed",
    directed: e.directed !== false,
    step: e.step ?? 1,
  };
}

export interface Body {
  paths: PlacedPath[];
  boxes: PlacedBox[];
  edges: PlacedEdge[];
  texts: PlacedText[];
  lines: PlacedLine[];
  overlays: PlacedOverlay[];
}

export const emptyBody = (): Body => ({ paths: [], boxes: [], edges: [], texts: [], lines: [], overlays: [] });

// ── Layered layout (flowchart, graph) ──────────────────

function layoutLayered(spec: DiagramSpec): Body {
  const dir = spec.direction ?? (spec.kind === "graph" ? "lr" : "tb");
  const fallbackShape: ShapeKind = spec.kind === "graph" ? "ellipse" : "rounded";
  const boxes = spec.nodes.map((n, i) => makeBox(n, fallbackShape, spec.kind === "graph" ? "primary" : i === 0 ? "accent" : "primary"));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const order = new Map(boxes.map((b, i) => [b.id, i]));
  const edges = spec.edges;

  // 1. Cycle breaking (DFS back edges).
  const out = new Map<string, number[]>(boxes.map((b) => [b.id, []]));
  edges.forEach((e, i) => { if (e.from !== e.to) out.get(e.from)!.push(i); });
  const state = new Map<string, number>();
  const back = new Set<number>();
  const visit = (u: string) => {
    state.set(u, 1);
    for (const ei of out.get(u)!) {
      const v = edges[ei].to;
      const s = state.get(v) ?? 0;
      if (s === 1) back.add(ei);
      else if (s === 0) visit(v);
    }
    state.set(u, 2);
  };
  const indeg = new Map(boxes.map((b) => [b.id, 0]));
  edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1));
  for (const b of boxes) if (indeg.get(b.id) === 0 && !state.get(b.id)) visit(b.id);
  for (const b of boxes) if (!state.get(b.id)) visit(b.id);

  // 2. Longest-path layering over forward edges.
  const layer = new Map(boxes.map((b) => [b.id, 0]));
  const fwd = edges.filter((e, i) => !back.has(i) && e.from !== e.to);
  for (let pass = 0; pass < boxes.length; pass++) {
    let changed = false;
    for (const e of fwd) {
      const want = layer.get(e.from)! + 1;
      if (want > layer.get(e.to)!) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  const layers: PlacedBox[][] = [];
  for (const b of boxes) (layers[layer.get(b.id)!] ??= []).push(b);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // 3. Crossing reduction: barycenter sweeps.
  const neighbors = (id: string, up: boolean) =>
    fwd.filter((e) => (up ? e.to === id : e.from === id)).map((e) => (up ? e.from : e.to));
  const pos = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((b, i) => pos.set(b.id, i)));
  reindex();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const li of range) {
      const bary = (b: PlacedBox) => {
        const ns = neighbors(b.id, down);
        return ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : pos.get(b.id)!;
      };
      layers[li].sort((a, b) => bary(a) - bary(b) || order.get(a.id)! - order.get(b.id)!);
      reindex();
    }
  }

  // 4. Coordinates. "main" = layer axis, "cross" = within-layer axis.
  const tb = dir === "tb";
  const mainSize = (b: PlacedBox) => (tb ? b.h : b.w);
  const crossSize = (b: PlacedBox) => (tb ? b.w : b.h);
  const labelOf = (e: SpecEdge) => edgeLabelSize(e.label);
  const crossGap = tb ? GAP_X : 40;

  let mainCursor = 0;
  /** Main-axis extent of each layer and the free gap after it (used for orthogonal routing). */
  const band: Array<{ start: number; end: number; gap: number }> = [];
  layers.forEach((l, li) => {
    const thickness = Math.max(0, ...l.map(mainSize));
    // Gap to the next layer must fit the labels of edges crossing it.
    const outgoing = fwd.filter((e) => layer.get(e.from) === li);
    const labelNeed = Math.max(0, ...outgoing.map((e) => (tb ? labelOf(e).h + 36 : labelOf(e).w + 48)));
    const gap = Math.max(tb ? GAP_Y_LAYERED : GAP_X + 36, labelNeed);
    band.push({ start: mainCursor, end: mainCursor + thickness, gap });
    // Initial packing along the cross axis.
    let c = 0;
    for (const b of l) {
      const main = mainCursor + (thickness - mainSize(b)) / 2;
      if (tb) { b.y = main; b.x = c; } else { b.x = main; b.y = c; }
      c += crossSize(b) + crossGap;
    }
    mainCursor += thickness + gap;
  });

  // Align children under their parents' barycenter, then resolve overlaps.
  const crossCenter = (b: PlacedBox) => (tb ? cx(b) : cy(b));
  const setCrossCenter = (b: PlacedBox, v: number) => {
    if (tb) b.x = v - b.w / 2; else b.y = v - b.h / 2;
  };
  const widest = layers.reduce((m, l) => Math.max(m, l.reduce((s, b) => s + crossSize(b) + crossGap, -crossGap)), 0);
  for (const l of layers) {
    const total = l.reduce((s, b) => s + crossSize(b) + crossGap, -crossGap);
    let c = (widest - total) / 2;
    for (const b of l) { setCrossCenter(b, c + crossSize(b) / 2); c += crossSize(b) + crossGap; }
  }
  for (let iter = 0; iter < 3; iter++) {
    for (let li = 1; li < layers.length; li++) {
      const l = layers[li];
      const desired = l.map((b) => {
        const ps = neighbors(b.id, true).map((id) => byId.get(id)!);
        return ps.length ? ps.reduce((s, p) => s + crossCenter(p), 0) / ps.length : crossCenter(b);
      });
      // Forward pass enforcing minimum gaps.
      const placed: number[] = [];
      l.forEach((b, i) => {
        let v = desired[i];
        if (i > 0) {
          const prev = l[i - 1];
          const min = placed[i - 1] + crossSize(prev) / 2 + crossGap + crossSize(b) / 2;
          v = Math.max(v, min);
        }
        placed.push(v);
      });
      // Re-center the layer on its desired positions.
      const shift = desired.reduce((s, d, i) => s + (d - placed[i]), 0) / l.length;
      l.forEach((b, i) => setCrossCenter(b, placed[i] + shift));
    }
  }

  /**
   * Orthogonal route through the inter-layer gaps (which contain no nodes by
   * construction) and a lane outside every node of the intermediate layers.
   */
  const pt = (main: number, cross: number): Pt => (tb ? [cross, main] : [main, cross]);
  const mainStart = (b: PlacedBox) => (tb ? b.y : b.x);
  // Each routed edge gets its own track inside a gap and its own lane, so
  // parallel connectors never run on top of each other.
  const tracksUsed = new Map<number, number>();
  const track = (li: number) => {
    const k = tracksUsed.get(li) ?? 0;
    tracksUsed.set(li, k + 1);
    const step = Math.min(12, band[li].gap / 6);
    return band[li].end + band[li].gap / 2 + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * step;
  };
  let laneOffset = 0;
  const orthogonal = (a: PlacedBox, b: PlacedBox): Pt[] => {
    const la = layer.get(a.id)!;
    const lb = layer.get(b.id)!;
    const exit = track(la);
    const entry = track(lb - 1);
    const ca = crossCenter(a);
    const cb = crossCenter(b);
    const aOut = mainStart(a) + mainSize(a) + EDGE_CLEARANCE;
    const bIn = mainStart(b) - EDGE_CLEARANCE;
    if (lb === la + 1) return [pt(aOut, ca), pt(exit, ca), pt(exit, cb), pt(bIn, cb)];
    const between = layers.slice(la + 1, lb).flat();
    const hi = Math.max(...between.map((o) => crossCenter(o) + crossSize(o) / 2)) + 30;
    const lo = Math.min(...between.map((o) => crossCenter(o) - crossSize(o) / 2)) - 30;
    const mid = (ca + cb) / 2;
    laneOffset += 18;
    const lane = Math.abs(hi - mid) <= Math.abs(mid - lo) ? hi + laneOffset : lo - laneOffset;
    return [pt(aOut, ca), pt(exit, ca), pt(exit, lane), pt(entry, lane), pt(entry, cb), pt(bIn, cb)];
  };

  // 5. Edges.
  const placedEdges: PlacedEdge[] = [];
  edges.forEach((e, i) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    let points: Pt[];
    if (e.from === e.to) {
      // Self-loop on the outer side.
      const r = a.x + a.w;
      points = tb
        ? [[r + 4, cy(a) - 12], [r + 40, cy(a) - 12], [r + 40, cy(a) + 12], [r + 4, cy(a) + 12]]
        : [[cx(a) - 12, a.y + a.h + 4], [cx(a) - 12, a.y + a.h + 40], [cx(a) + 12, a.y + a.h + 40], [cx(a) + 12, a.y + a.h + 4]];
    } else if (back.has(i)) {
      // Back edge: leave through the free gap after the source layer, run along a
      // lane outside every node of the spanned layers, and enter the target
      // through the free gap before its layer (slightly off-center).
      laneOffset += 22;
      const la = layer.get(e.from)!;
      const lb = layer.get(e.to)!;
      const span = layers.slice(Math.min(la, lb), Math.max(la, lb) + 1).flat();
      const lane = Math.max(...span.map((o) => crossCenter(o) + crossSize(o) / 2)) + 30 + laneOffset;
      const exit = track(la);
      const entry = lb > 0 ? track(lb - 1) : band[lb].start - 40 - laneOffset / 2;
      const ca = crossCenter(a);
      const cb = crossCenter(b) + crossSize(b) / 4;
      points = [
        pt(mainStart(a) + mainSize(a) + EDGE_CLEARANCE, ca),
        pt(exit, ca),
        pt(exit, lane),
        pt(entry, lane),
        pt(entry, cb),
        pt(mainStart(b) - EDGE_CLEARANCE, cb),
      ];
    } else {
      points = routeEdge(a, b, boxes, tb);
      const others = boxes.filter((o) => o !== a && o !== b);
      if (pathHitsAny(points, others).length) points = orthogonal(a, b);
    }
    placedEdges.push(specEdge(e, i, points));
  });

  return { ...emptyBody(), boxes, edges: placedEdges };
}

// ── Tree (top-down tidy layout) ────────────────────────

function layoutTree(spec: DiagramSpec): Body {
  const boxes = spec.nodes.map((n) => makeBox(n, "ellipse", "primary"));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  const children = new Map<string, Array<PlacedBox | null>>();
  for (const n of spec.nodes) children.set(n.id, []);
  for (const n of spec.nodes) if (n.parent) children.get(n.parent)!.push(byId.get(n.id)!);

  // Binary-tree sides: order left before right; reserve a slot for a missing sibling.
  for (const [pid, kids] of children) {
    const real = kids.filter((k): k is PlacedBox => k !== null);
    const sided = real.filter((k) => nodeById.get(k.id)?.side);
    if (sided.length && real.length <= 2) {
      const left = real.find((k) => nodeById.get(k.id)?.side === "left") ?? null;
      const right = real.find((k) => nodeById.get(k.id)?.side === "right") ?? null;
      const unsided = real.filter((k) => !nodeById.get(k.id)?.side);
      children.set(pid, [left ?? unsided.shift() ?? null, right ?? unsided.shift() ?? null]);
    }
  }

  const SIB_GAP = 36;
  const LEVEL_GAP = 70;
  const slotW = Math.max(...boxes.map((b) => b.w));
  const subtreeW = new Map<string, number>();
  const measure = (b: PlacedBox): number => {
    const kids = children.get(b.id)!;
    const kidsW = kids.reduce((s, k) => s + (k ? measure(k) : slotW * 0.6), 0) + SIB_GAP * Math.max(0, kids.length - 1);
    const w = Math.max(b.w, kids.length ? kidsW : 0);
    subtreeW.set(b.id, w);
    return w;
  };
  const depthH: number[] = [];
  const depthOf = new Map<string, number>();
  const assignDepth = (b: PlacedBox, d: number) => {
    depthOf.set(b.id, d);
    depthH[d] = Math.max(depthH[d] ?? 0, b.h);
    for (const k of children.get(b.id)!) if (k) assignDepth(k, d + 1);
  };
  const roots = boxes.filter((b) => !nodeById.get(b.id)?.parent);
  roots.forEach((r) => { measure(r); assignDepth(r, 0); });
  const depthY: number[] = [];
  depthH.reduce((y, h, d) => { depthY[d] = y; return y + h + LEVEL_GAP; }, 0);

  const place = (b: PlacedBox, left: number) => {
    const sw = subtreeW.get(b.id)!;
    const d = depthOf.get(b.id)!;
    b.x = left + (sw - b.w) / 2;
    b.y = depthY[d] + (depthH[d] - b.h) / 2;
    const kids = children.get(b.id)!;
    const kidsW = kids.reduce((s, k) => s + (k ? subtreeW.get(k.id)! : slotW * 0.6), 0) + SIB_GAP * Math.max(0, kids.length - 1);
    let x = left + (sw - kidsW) / 2;
    for (const k of kids) {
      if (k) { place(k, x); x += subtreeW.get(k.id)! + SIB_GAP; }
      else x += slotW * 0.6 + SIB_GAP;
    }
  };
  let left = 0;
  for (const r of roots) { place(r, left); left += subtreeW.get(r.id)! + 80; }

  const edges: PlacedEdge[] = [];
  for (const n of spec.nodes) {
    if (!n.parent) continue;
    edges.push(hierarchyEdge(byId.get(n.parent)!, byId.get(n.id)!, n.step ?? 1));
  }
  spec.edges.forEach((e, i) => edges.push(specEdge(e, i, routeEdge(byId.get(e.from)!, byId.get(e.to)!, boxes))));
  return { ...emptyBody(), boxes, edges };
}

// ── Mindmap (center + two horizontal trees) ────────────

function layoutMindmap(spec: DiagramSpec): Body {
  const root = spec.nodes.find((n) => !n.parent) ?? spec.nodes[0];
  const boxes = spec.nodes.map((n) => {
    const depthRole: Role = n.id === root.id ? "accent" : n.parent === root.id ? "primary" : "muted";
    return makeBox(n, n.id === root.id ? "ellipse" : "rounded", depthRole);
  });
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const kids = new Map<string, PlacedBox[]>(spec.nodes.map((n) => [n.id, []]));
  for (const n of spec.nodes) if (n.parent && n.id !== root.id) kids.get(n.parent)!.push(byId.get(n.id)!);

  const V_GAP = 22;
  const H_GAP = 76;
  const subH = new Map<string, number>();
  const measure = (b: PlacedBox): number => {
    const ks = kids.get(b.id)!;
    const kh = ks.reduce((s, k) => s + measure(k), 0) + V_GAP * Math.max(0, ks.length - 1);
    const h = Math.max(b.h, kh);
    subH.set(b.id, h);
    return h;
  };
  const rootBox = byId.get(root.id)!;
  rootBox.x = -rootBox.w / 2;
  rootBox.y = -rootBox.h / 2;
  const first = kids.get(root.id)!;
  const right = first.slice(0, Math.ceil(first.length / 2));
  const leftSide = first.slice(Math.ceil(first.length / 2));

  const placeSide = (list: PlacedBox[], side: 1 | -1) => {
    list.forEach(measure);
    const total = list.reduce((s, k) => s + subH.get(k.id)!, 0) + V_GAP * Math.max(0, list.length - 1);
    let y = -total / 2;
    const place = (b: PlacedBox, parent: PlacedBox, top: number) => {
      const h = subH.get(b.id)!;
      b.y = top + (h - b.h) / 2;
      b.x = side === 1 ? parent.x + parent.w + H_GAP : parent.x - H_GAP - b.w;
      const ks = kids.get(b.id)!;
      const kh = ks.reduce((s, k) => s + subH.get(k.id)!, 0) + V_GAP * Math.max(0, ks.length - 1);
      let ky = top + (h - kh) / 2;
      for (const k of ks) { place(k, b, ky); ky += subH.get(k.id)! + V_GAP; }
    };
    for (const k of list) { place(k, rootBox, y); y += subH.get(k.id)! + V_GAP; }
  };
  placeSide(right, 1);
  placeSide(leftSide, -1);

  const edges: PlacedEdge[] = [];
  for (const n of spec.nodes) {
    if (!n.parent || n.id === root.id) continue;
    edges.push(hierarchyEdge(byId.get(n.parent)!, byId.get(n.id)!, n.step ?? 1));
  }
  spec.edges.forEach((e, i) => edges.push(specEdge(e, i, routeEdge(byId.get(e.from)!, byId.get(e.to)!, boxes))));
  return { ...emptyBody(), boxes, edges };
}

// ── Sequence diagram ───────────────────────────────────

function layoutSequence(spec: DiagramSpec): Body {
  const boxes = spec.nodes.map((n, i) => makeBox(n, "rect", ROLE_CYCLE[i % ROLE_CYCLE.length], { minW: 140 }));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const maxLabel = Math.max(0, ...spec.edges.map((e) => edgeLabelSize(e.label).w));
  const spacing = Math.max(240, Math.max(...boxes.map((b) => b.w)) + 70, maxLabel + 90);
  const headH = Math.max(...boxes.map((b) => b.h));
  boxes.forEach((b, i) => {
    b.x = i * spacing - b.w / 2;
    b.y = (headH - b.h) / 2;
  });

  const edges: PlacedEdge[] = [];
  let y = headH + 56;
  spec.edges.forEach((e, i) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const label = edgeLabelSize(e.label);
    let points: Pt[];
    if (a === b) {
      points = [[cx(a), y], [cx(a) + 64, y], [cx(a) + 64, y + 30], [cx(a) + 4, y + 30]];
      y += 30;
    } else {
      const dir = cx(b) > cx(a) ? 1 : -1;
      points = [[cx(a) + dir * 4, y], [cx(b) - dir * 4, y]];
    }
    edges.push(specEdge(e, i, points, false));
    y += Math.max(64, label.h + 40);
  });

  const lines: PlacedLine[] = boxes.map((b) => ({
    id: `x-life_${b.id}`,
    x1: cx(b),
    y1: b.y + b.h + 4,
    x2: cx(b),
    y2: y - 10,
    dashed: true,
    step: b.step,
  }));
  return { ...emptyBody(), boxes, edges, lines };
}

// ── Arrays, stacks, queues, linked lists ───────────────

function layoutList(spec: DiagramSpec): Body {
  const body = emptyBody();
  const kind = spec.kind;
  const vertical = kind === "stack";
  const cellMeasures = spec.nodes.map((n) => measureBlock(n.label, NODE_FONT, 120));
  const cellW = Math.max(kind === "linked_list" ? 84 : 64, ...cellMeasures.map((m) => m.width + 28));
  const cellH = Math.max(vertical ? 50 : 60, ...cellMeasures.map((m) => m.height + 22));
  const linkGap = kind === "linked_list" ? 56 : 0;
  const frames = spec.frames?.length ? spec.frames : [{ caption: undefined, step: 1, pointers: [], ranges: [] }];
  const n = spec.nodes.length;

  const POINTER_ROW = 24;
  let offset = 0; // running y (horizontal kinds) or x (stack)

  frames.forEach((frame, fi) => {
    const suffix = fi === 0 ? "" : `-f${fi}`;
    const step = frame.step ?? spec.nodes[0]?.step ?? 1;
    const roleAt = (i: number): Role => {
      let role: Role = spec.nodes[i].role ?? "primary";
      for (const r of frame.ranges ?? []) if (i >= r.from && i <= r.to && r.role) role = r.role;
      return role;
    };
    const pointersAt = new Map<number, string[]>();
    for (const p of frame.pointers ?? []) pointersAt.set(p.index, [...(pointersAt.get(p.index) ?? []), p.label]);
    if (!spec.frames?.length && kind === "queue" && n > 0) {
      pointersAt.set(0, ["front"]);
      pointersAt.set(n - 1, [...(pointersAt.get(n - 1) ?? []), "rear"]);
    }
    if (!spec.frames?.length && kind === "stack" && n > 0) pointersAt.set(n - 1, ["top"]);
    const maxStack = Math.max(0, ...[...pointersAt.values()].map((v) => v.length));

    if (!vertical) {
      let y = offset;
      if (frame.caption) {
        const cap = measureBlock(frame.caption, 16, 520);
        body.texts.push({ id: `x-cap${suffix || "-f0"}`, text: cap.text, x: 0, y, w: cap.width, h: cap.height, fontSize: 16, tone: "body", align: "left", step });
        y += cap.height + 10;
      }
      const pointerTop = y;
      y += maxStack * POINTER_ROW + (maxStack ? 18 : 0);
      spec.nodes.forEach((node, i) => {
        const x = i * (cellW + linkGap);
        body.boxes.push({
          id: `${node.id}${suffix}`, x, y, w: cellW, h: cellH,
          shape: kind === "linked_list" ? "rounded" : "rect",
          label: cellMeasures[i].text, role: roleAt(i), step, fontSize: NODE_FONT,
        });
        if (kind === "array") {
          const idx = String(i);
          body.texts.push({ id: `x-idx${i}${suffix}`, text: idx, x: x + cellW / 2 - 5, y: y + cellH + 6, w: 10, h: 18, fontSize: SMALL_FONT, tone: "muted", align: "center", step });
        }
        if (kind === "linked_list" && i < n - 1) {
          body.edges.push({
            id: `x-link${i}${suffix}`, from: `${node.id}${suffix}`, to: `${spec.nodes[i + 1].id}${suffix}`,
            points: [[x + cellW + EDGE_CLEARANCE, y + cellH / 2], [x + cellW + linkGap - EDGE_CLEARANCE, y + cellH / 2]],
            directed: true, step,
          });
        }
        const labels = pointersAt.get(i) ?? [];
        labels.forEach((label, k) => {
          const w = measureBlock(label, 15, 200).width;
          const ty = pointerTop + k * POINTER_ROW;
          body.texts.push({ id: `x-ptr${i}_${k}${suffix}`, text: label, x: x + cellW / 2 - w / 2, y: ty, w, h: 19, fontSize: 15, tone: "warning", align: "center", step });
        });
        if (labels.length) {
          const startY = pointerTop + labels.length * POINTER_ROW - 4;
          body.edges.push({
            id: `x-ptrarrow${i}${suffix}`, to: `${node.id}${suffix}`,
            points: [[x + cellW / 2, startY], [x + cellW / 2, y - EDGE_CLEARANCE]],
            directed: true, role: "warning", step,
          });
        }
      });
      offset = y + cellH + (kind === "array" ? 26 : 8) + (fi < frames.length - 1 ? 34 : 0);
    } else {
      // Stack: cells bottom → top, frames side by side.
      const x = offset;
      const labelColW = maxStack ? 64 : 0;
      let headerH = 0;
      if (frame.caption) {
        const cap = measureBlock(frame.caption, 16, cellW + labelColW + 40);
        body.texts.push({ id: `x-cap${suffix || "-f0"}`, text: cap.text, x, y: 0, w: cap.width, h: cap.height, fontSize: 16, tone: "body", align: "left", step });
        headerH = cap.height + 14;
      }
      spec.nodes.forEach((node, i) => {
        const y = headerH + (n - 1 - i) * cellH;
        const bx = x + labelColW;
        body.boxes.push({ id: `${node.id}${suffix}`, x: bx, y, w: cellW, h: cellH, shape: "rect", label: cellMeasures[i].text, role: roleAt(i), step, fontSize: NODE_FONT });
        const labels = pointersAt.get(i) ?? [];
        if (labels.length) {
          const text = labels.join(", ");
          const w = measureBlock(text, 15, 200).width;
          body.texts.push({ id: `x-ptr${i}${suffix}`, text, x: bx - 30 - w, y: y + cellH / 2 - 10, w, h: 19, fontSize: 15, tone: "warning", align: "left", step });
          body.edges.push({ id: `x-ptrarrow${i}${suffix}`, to: `${node.id}${suffix}`, points: [[bx - 26, y + cellH / 2], [bx - EDGE_CLEARANCE, y + cellH / 2]], directed: true, role: "warning", step });
        }
      });
      offset = x + labelColW + cellW + 70;
    }
  });
  return body;
}

// ── Layers (stacked bands) ─────────────────────────────

function layoutLayers(spec: DiagramSpec): Body {
  const blocks = spec.nodes.map((n) => measureBlock(n.detail ? `${n.label}\n${n.detail}` : n.label, NODE_FONT, 420));
  const width = Math.max(380, ...blocks.map((b) => b.width + 64));
  let y = 0;
  const boxes = spec.nodes.map((n, i) => {
    const h = Math.max(58, blocks[i].height + 28);
    const box: PlacedBox = { id: n.id, x: 0, y, w: width, h, shape: "rect", label: blocks[i].text, role: n.role ?? ROLE_CYCLE[i % ROLE_CYCLE.length], step: n.step ?? 1, fontSize: NODE_FONT };
    y += h + 14;
    return box;
  });
  return { ...emptyBody(), boxes };
}

// ── Comparison (columns) ───────────────────────────────

function layoutComparison(spec: DiagramSpec): Body {
  const body = emptyBody();
  const groups = spec.groups ?? [];
  let x = 0;
  groups.forEach((g, gi) => {
    const role = g.role ?? ROLE_CYCLE[gi % ROLE_CYCLE.length];
    const items = spec.nodes.filter((n) => n.group === g.id);
    const header = makeBox({ id: `x-grp_${g.id}`, label: g.label, step: Math.min(...items.map((i) => i.step ?? 1), 1) } as SpecNode, "rect", role, { minW: 200 });
    const itemBoxes = items.map((n) => makeBox(n, "rounded", n.role ?? "muted", { minW: 200 }));
    const colW = Math.max(header.w, ...itemBoxes.map((b) => b.w));
    header.w = colW;
    header.x = x;
    header.y = 0;
    body.boxes.push(header);
    let y = header.h + 26;
    for (const b of itemBoxes) {
      b.w = colW;
      b.x = x;
      b.y = y;
      y += b.h + 16;
      body.boxes.push(b);
    }
    x += colW + 56;
  });
  spec.edges.forEach((e, i) => {
    const a = body.boxes.find((b) => b.id === e.from)!;
    const b = body.boxes.find((bb) => bb.id === e.to)!;
    body.edges.push(specEdge(e, i, routeEdge(a, b, body.boxes)));
  });
  return body;
}

// ── Timeline / pipeline (wrapping rows) ────────────────

function layoutTimeline(spec: DiagramSpec): Body {
  const boxes = spec.nodes.map((n, i) => makeBox(n, "rounded", ROLE_CYCLE[i % ROLE_CYCLE.length], { maxTextW: 170 }));
  const perRow = boxes.length > 5 ? 4 : Math.max(1, boxes.length);
  const autoEdges: SpecEdge[] = spec.edges.length
    ? spec.edges
    : boxes.slice(1).map((b, i) => ({ from: boxes[i].id, to: b.id, step: b.step } as SpecEdge));
  const gap = Math.max(GAP_X + 16, ...autoEdges.map((e) => edgeLabelSize(e.label).w + 44));
  const cellW = Math.max(...boxes.map((b) => b.w));
  const rowH = Math.max(...boxes.map((b) => b.h));
  boxes.forEach((b, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    b.w = cellW;
    b.x = col * (cellW + gap);
    b.y = row * (rowH + 96) + (rowH - b.h) / 2;
  });
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const edges = autoEdges.map((e, i) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const ia = boxes.indexOf(a), ib = boxes.indexOf(b);
    const wraps = Math.floor(ia / perRow) !== Math.floor(ib / perRow) && ib === ia + 1;
    if (wraps) {
      const midY = a.y + a.h + 48;
      return specEdge(e, i, [[cx(a), a.y + a.h + EDGE_CLEARANCE], [cx(a), midY], [cx(b), midY], [cx(b), b.y - EDGE_CLEARANCE]]);
    }
    return specEdge(e, i, routeEdge(a, b, boxes, false));
  });
  return { ...emptyBody(), boxes, edges };
}

// ── Formula derivation ─────────────────────────────────

function layoutFormulas(spec: DiagramSpec): Body {
  const body = emptyBody();
  const formulas = spec.formulas ?? [];
  let y = 0;
  formulas.forEach((f, i) => {
    const size = estimateFormulaSize(f.latex, 30);
    body.overlays.push({ id: `x-formula${i}`, type: "formula", x: 0, y, w: size.width, h: size.height, latex: f.latex, fontSize: 30, step: f.step ?? 1 });
    let bottom = y + size.height;
    if (f.caption) {
      const cap = measureBlock(f.caption, NOTE_FONT, 420);
      body.texts.push({ id: `x-fcap${i}`, text: cap.text, x: size.width + 28, y: y + size.height / 2 - cap.height / 2, w: cap.width, h: cap.height, fontSize: NOTE_FONT, tone: "muted", align: "left", step: f.step ?? 1 });
      bottom = Math.max(bottom, y + size.height / 2 + cap.height / 2);
    }
    if (i < formulas.length - 1) {
      const ax = Math.min(size.width / 2, 120);
      body.edges.push({ id: `x-fderive${i}`, points: [[ax, bottom + 8], [ax, bottom + 48]], directed: true, role: "muted", step: formulas[i + 1].step ?? 1 });
    }
    y = bottom + 56;
  });
  // Formula diagrams may still carry a few nodes (e.g. variable legend) → place below.
  if (spec.nodes.length) {
    const legend = layoutTimeline({ ...spec, edges: [] });
    for (const b of legend.boxes) b.y += y;
    body.boxes.push(...legend.boxes);
  }
  return body;
}

// ── Composition: title, annotations, side column ───────

export function bodyBounds(body: Body): Rect {
  const rects: Rect[] = [
    ...body.boxes,
    ...body.texts,
    ...body.overlays,
    ...body.lines.map((l) => ({ x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1) || 1, h: Math.abs(l.y2 - l.y1) || 1 })),
    ...body.paths.map((p) => {
      const xs = p.points.map((q) => q[0]);
      const ys = p.points.map((q) => q[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
    }),
    ...body.edges.map((e) => {
      const xs = e.points.map((p) => p[0]);
      const ys = e.points.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
    }),
  ];
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function translate(body: Body, dx: number, dy: number): void {
  for (const b of body.boxes) { b.x += dx; b.y += dy; }
  for (const t of body.texts) { t.x += dx; t.y += dy; }
  for (const o of body.overlays) { o.x += dx; o.y += dy; }
  for (const l of body.lines) { l.x1 += dx; l.x2 += dx; l.y1 += dy; l.y2 += dy; }
  for (const p of body.paths) p.points = p.points.map(([x, y]) => [x + dx, y + dy] as Pt);
  for (const e of body.edges) e.points = e.points.map(([x, y]) => [x + dx, y + dy] as Pt);
}

function placeAnnotations(spec: DiagramSpec, body: Body): void {
  const obstacles = (): Rect[] => [...body.boxes, ...body.texts, ...body.overlays];
  for (const [i, a] of (spec.annotations ?? []).entries()) {
    const target = body.boxes.find((b) => b.id === a.target);
    if (!target) continue;
    const block = measureBlock(a.text, NOTE_FONT, 210);
    const w = block.width, h = block.height;
    const candidates: Array<[number, number]> = [
      [target.x + target.w + 16, cy(target) - h / 2],
      [cx(target) - w / 2, target.y + target.h + 12],
      [target.x - 16 - w, cy(target) - h / 2],
      [cx(target) - w / 2, target.y - 12 - h],
      [target.x + target.w + 16, target.y + target.h + 8],
    ];
    const free = candidates.find(([x, y]) => {
      const r = { x, y, w, h };
      return (
        !obstacles().some((o) => rectsOverlap(r, o, 8)) &&
        !body.edges.some((e) => e.points.some((p, k) => k < e.points.length - 1 && segmentHitsRect(p, e.points[k + 1], r, 4))) &&
        !body.lines.some((l) => segmentHitsRect([l.x1, l.y1], [l.x2, l.y2], r, 6))
      );
    });
    const [x, y] = free ?? candidates[0];
    body.texts.push({ id: `x-note${i}`, text: block.text, x, y, w, h, fontSize: NOTE_FONT, tone: "muted", align: "left", step: a.step ?? target.step });
  }
}

/**
 * Worked example panel: the problem, then one card per solving step (its working and, optionally,
 * a compact state table), then the answer. Cards are revealed with their teaching step; more than
 * three steps are laid out in two columns so the panel stays compact.
 */
function layoutWorked(w: NonNullable<DiagramSpec["worked"]>, side: Body, y0: number, maxStep: number): number {
  const CARD_W = 400, GAP = 18, PAD = 14, FONT = 15;
  const cols = w.steps.length > 3 ? 2 : 1;
  const panelW = cols * CARD_W + (cols - 1) * GAP;
  const firstStep = Math.min(maxStep, w.steps[0]?.step ?? 1);
  let y = y0;

  const heading = measureBlock(w.title ?? "Worked example", 20, panelW);
  side.texts.push({ id: "x-wk_title", text: heading.text, x: 0, y, w: heading.width, h: heading.height, fontSize: 20, tone: "title", align: "left", step: firstStep });
  y += heading.height + 8;
  const problem = measureBlock(w.problem, FONT + 1, panelW - 2 * PAD);
  const problemH = problem.height + 2 * PAD;
  side.boxes.push({ id: "x-wk_problem", x: 0, y, w: panelW, h: problemH, shape: "rounded", label: "", role: "primary", step: firstStep, fontSize: NODE_FONT });
  side.texts.push({ id: "x-wk_problem_text", text: problem.text, x: PAD, y: y + PAD, w: problem.width, h: problem.height, fontSize: FONT + 1, tone: "body", align: "left", step: firstStep });
  y += problemH + GAP;

  if (w.figure) {
    // The example's graph on a circle (small example graphs are rarely chains or trees, and a
    // circle keeps every edge — and its weight — clear of the other nodes).
    const f = w.figure;
    const R = 24;
    const sizes = f.nodes.map((n) => Math.max(2 * R, measureBlock(n.label, 16, 120).width + 22));
    const rx = Math.min(panelW / 2 - 60, 70 + 34 * f.nodes.length), ry = Math.min(150, 50 + 22 * f.nodes.length);
    const cx = panelW / 2, cy = y + ry + R;
    const centre = f.nodes.map((_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / f.nodes.length + (f.nodes.length % 2 ? 0 : Math.PI / f.nodes.length);
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt;
    });
    f.nodes.forEach((n, i) => {
      const [x, yy] = centre[i];
      side.boxes.push({ id: `wkg_${n.id}`, x: x - sizes[i] / 2, y: yy - R, w: sizes[i], h: 2 * R, shape: "ellipse", label: n.label, role: "primary", step: firstStep, fontSize: 16 });
    });
    const index = new Map(f.nodes.map((n, i) => [n.id, i]));
    f.edges.forEach((e, k) => {
      const a = index.get(e.from)!, b = index.get(e.to)!;
      const [x1, y1] = centre[a], [x2, y2] = centre[b];
      const d = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      // Start/end on the node outlines (ellipse radii along the edge direction).
      const rim = (i: number) => { const ex = sizes[i] / 2, ey = R; return 1 / Math.sqrt((ux * ux) / (ex * ex) + (uy * uy) / (ey * ey)); };
      side.edges.push({
        id: `wkg_e${k}`, from: `wkg_${e.from}`, to: `wkg_${e.to}`,
        points: [[x1 + ux * rim(a), y1 + uy * rim(a)], [x2 - ux * rim(b), y2 - uy * rim(b)]],
        ...(e.label ? { label: e.label } : {}), directed: f.directed ?? false, step: firstStep,
      });
    });
    y = cy + ry + R + GAP;
  }

  // Measure every card first so the two columns line up row by row.
  const cards = w.steps.map((s, i) => {
    const title = measureBlock(`${i + 1}. ${s.title}`, FONT + 1, CARD_W - 2 * PAD);
    const lines = s.lines.length ? measureBlock(s.lines.join("\n"), FONT, CARD_W - 2 * PAD) : null;
    const table = s.table ? compactTable(s.table, CARD_W - 2 * PAD) : null;
    const h = PAD + title.height + (lines ? 6 + lines.height : 0) + (table ? 10 + table.h : 0) + PAD;
    return { s, i, title, lines, table, h };
  });
  for (let r = 0; r < cards.length; r += cols) {
    const row = cards.slice(r, r + cols);
    const rowH = Math.max(...row.map((c) => c.h));
    row.forEach((c, k) => {
      const x = k * (CARD_W + GAP);
      const st = Math.min(maxStep, c.s.step ?? 1);
      side.boxes.push({ id: `x-wk_card${c.i}`, x, y, w: CARD_W, h: rowH, shape: "rounded", label: "", role: "muted", step: st, fontSize: NODE_FONT });
      let cy = y + PAD;
      side.texts.push({ id: `x-wk_h${c.i}`, text: c.title.text, x: x + PAD, y: cy, w: c.title.width, h: c.title.height, fontSize: FONT + 1, tone: "accent", align: "left", step: st });
      cy += c.title.height;
      if (c.lines) {
        cy += 6;
        side.texts.push({ id: `x-wk_l${c.i}`, text: c.lines.text, x: x + PAD, y: cy, w: c.lines.width, h: c.lines.height, fontSize: FONT, tone: "body", align: "left", step: st });
        cy += c.lines.height;
      }
      if (c.table) {
        cy += 10;
        for (const cell of c.table.cells) {
          side.boxes.push({ id: `x-wk_t${c.i}_${cell.r}_${cell.c}`, x: x + PAD + cell.x, y: cy + cell.y, w: cell.w, h: cell.h, shape: "rect", label: cell.text, role: cell.role, step: st, fontSize: 13 });
        }
      }
    });
    y += rowH + GAP;
  }

  if (w.answer) {
    const answer = measureBlock(`Answer: ${w.answer}`, FONT + 1, panelW - 2 * PAD);
    const h = answer.height + 2 * PAD;
    const st = Math.min(maxStep, w.steps.at(-1)?.step ?? maxStep);
    side.boxes.push({ id: "x-wk_answer", x: 0, y, w: panelW, h, shape: "rounded", label: "", role: "success", step: st, fontSize: NODE_FONT });
    side.texts.push({ id: "x-wk_answer_text", text: answer.text, x: PAD, y: y + PAD, w: answer.width, h: answer.height, fontSize: FONT + 1, tone: "body", align: "left", step: st });
    y += h;
  }
  return y;
}

/** A small table for a worked step (header row highlighted), shrunk to fit the card width. */
function compactTable(t: NonNullable<DiagramSpec["table"]>, maxW: number) {
  const FONT = 13, ROW_H = 28;
  const all = [t.columns, ...t.rows];
  const natural = t.columns.map((_, c) => Math.max(44, ...all.map((r) => measureBlock(r[c] ?? "", FONT, 160).width + 16)));
  const total = natural.reduce((a, b) => a + b, 0);
  const colW = natural.map((w) => (total > maxW ? (w * maxW) / total : w));
  const rowH = all.map((r) => Math.max(ROW_H, ...r.map((cell, c) => measureBlock(cell || " ", FONT, colW[c] - 8).height + 10)));
  const cells: Array<{ r: number; c: number; x: number; y: number; w: number; h: number; text: string; role: Role }> = [];
  let y = 0;
  all.forEach((row, r) => {
    let x = 0;
    t.columns.forEach((_, c) => {
      const hl = r > 0 ? t.highlight?.find((h) => h.row === r - 1 && h.col === c)?.role : undefined;
      const role: Role = r === 0 ? "primary" : hl ?? (t.rowHeaders && c === 0 ? "secondary" : "muted");
      cells.push({ r, c, x, y, w: colW[c], h: rowH[r], text: measureBlock(row[c] || " ", FONT, colW[c] - 8).text, role });
      x += colW[c];
    });
    y += rowH[r];
  });
  return { cells, h: y };
}

function buildSideColumn(spec: DiagramSpec, maxStep: number): Body {
  const side = emptyBody();
  let y = 0;
  if (spec.kind !== "formula") {
    (spec.formulas ?? []).forEach((f, i) => {
      const size = estimateFormulaSize(f.latex, 26);
      side.overlays.push({ id: `x-sformula${i}`, type: "formula", x: 0, y, w: size.width, h: size.height, latex: f.latex, fontSize: 26, step: f.step ?? 1 });
      y += size.height + 8;
      if (f.caption) {
        const cap = measureBlock(f.caption, NOTE_FONT, Math.max(size.width, 280));
        side.texts.push({ id: `x-sfcap${i}`, text: cap.text, x: 4, y, w: cap.width, h: cap.height, fontSize: NOTE_FONT, tone: "muted", align: "left", step: f.step ?? 1 });
        y += cap.height;
      }
      y += 28;
    });
  }
  if (spec.code) {
    const size = estimateCodeSize(spec.code.code);
    side.overlays.push({ id: "x-code", type: "code", x: 0, y, w: size.width, h: size.height, code: spec.code.code, language: spec.code.language, step: spec.code.step ?? 1 });
    y += size.height + 32;
  }
  if (spec.worked) {
    y = layoutWorked(spec.worked, side, y, maxStep);
    y += 32;
  }
  if (spec.takeaways?.length) {
    const CARD_W = 340;
    const heading = measureBlock("Key takeaways", 19, CARD_W - 40);
    const bullets = measureBlock(spec.takeaways.map((t) => `• ${t}`).join("\n"), 16, CARD_W - 40);
    const cardH = 20 + heading.height + 10 + bullets.height + 22;
    side.boxes.push({ id: "x-takeaways_card", x: 0, y, w: CARD_W, h: cardH, shape: "rounded", label: "", role: "muted", step: maxStep, fontSize: NODE_FONT });
    side.texts.push({ id: "x-takeaways_title", text: heading.text, x: 20, y: y + 20, w: heading.width, h: heading.height, fontSize: 19, tone: "body", align: "left", step: maxStep });
    side.texts.push({ id: "x-takeaways_body", text: bullets.text, x: 20, y: y + 20 + heading.height + 10, w: bullets.width, h: bullets.height, fontSize: 16, tone: "body", align: "left", step: maxStep });
  }
  return side;
}

// ── Entry point ────────────────────────────────────────

export function layoutDiagram(spec: DiagramSpec, stepCount: number): PlacedDiagram {
  let body: Body;
  switch (spec.kind) {
    case "tree": body = layoutTree(spec); break;
    case "mindmap": body = layoutMindmap(spec); break;
    case "sequence": body = layoutSequence(spec); break;
    case "array":
    case "linked_list":
    case "stack":
    case "queue": body = layoutList(spec); break;
    case "layers": body = layoutLayers(spec); break;
    case "comparison": body = layoutComparison(spec); break;
    case "timeline": body = layoutTimeline(spec); break;
    case "formula": body = layoutFormulas(spec); break;
    case "number_line": body = layoutNumberLine(spec, stepCount); break;
    case "coordinate_plane": body = layoutPlot(spec, stepCount); break;
    case "geometry": body = layoutGeometry(spec, stepCount); break;
    case "chart": body = layoutChart(spec, stepCount); break;
    case "table": body = layoutTable(spec); break;
    case "venn": body = layoutVenn(spec, stepCount); break;
    case "cycle": body = layoutCycle(spec); break;
    case "scaled_timeline": body = layoutChronology(spec, stepCount); break;
    case "vectors": body = layoutVectors(spec, stepCount); break;
    case "circuit": body = layoutCircuit(spec, stepCount); break;
    case "molecule": body = layoutMolecules(spec, stepCount); break;
    case "atom": body = layoutAtom(spec, stepCount); break;
    case "labelled_diagram": body = layoutLabelled(spec, stepCount); break;
    case "map": body = layoutMap(spec, stepCount); break;
    default: body = spec.nodes.length ? layoutLayered(spec) : emptyBody();
  }

  placeAnnotations(spec, body);

  // Normalize body to start at (0, titleArea).
  const titleBlock = measureBlock(spec.title, TITLE_FONT, 900);
  const titleArea = titleBlock.height + 34;
  const bb = bodyBounds(body);
  translate(body, -bb.x, -bb.y + titleArea);

  // Side column: to the right for normal widths, below for very wide diagrams.
  const maxStep = Math.max(1, stepCount);
  const side = buildSideColumn(spec, maxStep);
  const sideBounds = bodyBounds(side);
  if (sideBounds.w > 0) {
    if (bb.w > 1100) translate(side, 0, titleArea + bb.h + 64);
    else translate(side, bb.w > 0 ? bb.w + 90 : 0, titleArea);
  }

  const texts: PlacedText[] = [
    { id: "x-title", text: titleBlock.text, x: 0, y: 0, w: titleBlock.width, h: Math.ceil(TITLE_FONT * LINE_HEIGHT * titleBlock.lines.length), fontSize: TITLE_FONT, tone: "title", align: "left", step: 1 },
    ...body.texts,
    ...side.texts,
  ];
  const all: Body = {
    paths: [...body.paths, ...side.paths],
    boxes: [...body.boxes, ...side.boxes],
    edges: [...body.edges, ...side.edges],
    texts,
    lines: body.lines,
    overlays: [...body.overlays, ...side.overlays],
  };
  const total = bodyBounds(all);
  const round = (v: number) => Math.round(v);
  for (const b of all.boxes) { b.x = round(b.x); b.y = round(b.y); }
  for (const t of all.texts) { t.x = round(t.x); t.y = round(t.y); }
  for (const o of all.overlays) { o.x = round(o.x); o.y = round(o.y); }
  for (const e of all.edges) e.points = e.points.map(([x, y]) => [round(x), round(y)] as Pt);
  for (const p of all.paths) p.points = p.points.map(([x, y]) => [round(x), round(y)] as Pt);
  return { ...all, width: Math.ceil(total.x + total.w), height: Math.ceil(total.y + total.h) };
}

/** Exposed for the final validator's overlap check. */
export { rectsOverlap };
