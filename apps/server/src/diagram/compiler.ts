// ─────────────────────────────────────────────────────────
// Diagram Compiler — the "canvas generator".
//
// Turns a PlacedDiagram (relative geometry) into concrete DSL
// actions at an absolute canvas origin, grouped by teaching
// step for progressive reveal.  Also decides WHERE a diagram
// goes on the canvas and computes minimal diffs when an
// existing diagram is revised.
//
// Colors: Excalidraw's dark theme renders the canvas through
// `invert(93%) hue-rotate(180deg)`, so colors are authored in
// light-theme space (dark strokes, pastel fills) and appear as
// light strokes on deep fills on screen.
// ─────────────────────────────────────────────────────────

import type { CanvasElement, CreateAction, DSLAction } from "@excaliai/shared";
import type { Role } from "./spec.js";
import type { PlacedDiagram, Tone } from "./layout.js";

export const PALETTE: Record<Role, { stroke: string; fill: string }> = {
  primary: { stroke: "#1971c2", fill: "#d0ebff" },
  secondary: { stroke: "#6741d9", fill: "#e5dbff" },
  accent: { stroke: "#0c8599", fill: "#c5f6fa" },
  success: { stroke: "#2f9e44", fill: "#d3f9d8" },
  warning: { stroke: "#e67700", fill: "#fff3bf" },
  danger: { stroke: "#e03131", fill: "#ffe3e3" },
  muted: { stroke: "#868e96", fill: "#f1f3f5" },
};
const TEXT_DARK = "#1e1e1e"; // renders near-white on the dark canvas
const TEXT_MUTED = "#495057";
const EDGE_DEFAULT = "#495057";

/** Stroke color for a role; "ink" = the default text/line color. */
function strokeOf(role: Role | "ink" | undefined): string {
  if (!role) return EDGE_DEFAULT;
  return role === "ink" ? TEXT_DARK : PALETTE[role].stroke;
}

function toneColor(tone: Tone): string {
  if (tone === "title" || tone === "body") return TEXT_DARK;
  if (tone === "muted") return TEXT_MUTED;
  return PALETTE[tone].stroke;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface CompiledDiagram {
  /** Creation actions per teaching step (1-based), in draw order. */
  byStep: Map<number, CreateAction[]>;
  /** All creation actions, flattened. */
  creates: CreateAction[];
  bbox: Rect;
}

export const elementId = (diagramId: string, localId: string) => `${diagramId}__${localId}`;

export function compileDiagram(placed: PlacedDiagram, diagramId: string, origin: { x: number; y: number }): CompiledDiagram {
  const ox = Math.round(origin.x);
  const oy = Math.round(origin.y);
  const id = (local: string) => elementId(diagramId, local);
  const byStep = new Map<number, CreateAction[]>();
  const push = (step: number, a: CreateAction) => {
    a = canvasGlyphs(a);
    const list = byStep.get(step) ?? [];
    list.push(a);
    byStep.set(step, list);
  };

  // Draw order inside a step: paths (axes, fills, curves) → guides → shapes → text → overlays → connectors.
  for (const p of placed.paths) {
    push(p.step, {
      action: "create_path", id: id(p.id), diagramId,
      points: p.points.map(([x, y]) => [x + ox, y + oy] as [number, number]),
      ...(p.closed ? { closed: true } : {}),
      ...(p.smooth ? { smooth: true } : {}),
      color: p.strokeColor ?? strokeOf(p.role),
      ...(p.fillColor ? { backgroundColor: p.fillColor } : p.fill ? { backgroundColor: (p.fill as string) === "ink" ? TEXT_DARK : PALETTE[p.fill].fill } : {}),
      ...(p.strokeWidth ? { strokeWidth: p.strokeWidth } : {}),
      ...(p.dashed ? { strokeStyle: "dashed" as const } : {}),
      ...(p.opacity !== undefined ? { opacity: p.opacity } : {}),
      ...(p.arrowEnd ? { endArrowhead: "arrow" as const } : {}),
      ...(p.arrowStart ? { startArrowhead: "arrow" as const } : {}),
    });
  }
  for (const l of placed.lines) {
    push(l.step, {
      action: "create_line", id: id(l.id), diagramId,
      startX: l.x1 + ox, startY: l.y1 + oy, endX: l.x2 + ox, endY: l.y2 + oy,
      color: PALETTE.muted.stroke, strokeStyle: l.dashed ? "dashed" : "solid",
    });
  }
  for (const b of placed.boxes) {
    const colors = PALETTE[b.role];
    const base = {
      id: id(b.id), diagramId,
      x: b.x + ox, y: b.y + oy, width: b.w, height: b.h,
      ...(b.label.trim() ? { label: b.label, labelColor: TEXT_DARK, labelFontSize: b.fontSize } : {}),
      strokeColor: colors.stroke,
      backgroundColor: colors.fill,
      ...(b.dashed ? { strokeStyle: "dashed" as const } : {}),
    };
    if (b.shape === "ellipse") push(b.step, { action: "create_circle", ...base });
    else if (b.shape === "diamond") push(b.step, { action: "create_diamond", ...base });
    else push(b.step, { action: "create_rectangle", ...base, rounded: b.shape === "rounded" });
  }
  for (const t of placed.texts) {
    if (!t.text.trim()) continue;
    push(t.step, {
      action: "create_text", id: id(t.id), diagramId,
      // Excalidraw anchors centre-aligned text at its centre, so send the centre: the real (browser-measured)
      // width then stays centred where layout intended, whatever the estimate was.
      text: t.text, x: (t.align === "center" ? t.x + t.w / 2 : t.x) + ox, y: t.y + oy, fontSize: t.fontSize,
      color: toneColor(t.tone), align: t.align, fontFamily: "sketch",
    });
  }
  for (const o of placed.overlays) {
    if (o.type === "formula") {
      push(o.step, { action: "create_formula", id: id(o.id), diagramId, latex: o.latex!, x: o.x + ox, y: o.y + oy, fontSize: o.fontSize, width: o.w, height: o.h });
    } else {
      push(o.step, { action: "create_code", id: id(o.id), diagramId, code: o.code!, language: o.language || "text", x: o.x + ox, y: o.y + oy, width: o.w, height: o.h });
    }
  }
  for (const e of placed.edges) {
    const pts = e.points.map(([x, y]) => [x + ox, y + oy] as [number, number]);
    const first = pts[0];
    const last = pts[pts.length - 1];
    push(e.step, {
      action: "create_arrow", id: id(e.id), diagramId,
      ...(e.from ? { fromId: id(e.from) } : {}),
      ...(e.to ? { toId: id(e.to) } : {}),
      startX: first[0], startY: first[1], endX: last[0], endY: last[1],
      ...(pts.length > 2 ? { waypoints: pts.slice(1, -1) } : {}),
      ...(e.label ? { label: e.label } : {}),
      color: e.role ? PALETTE[e.role].stroke : EDGE_DEFAULT,
      ...(e.dashed ? { strokeStyle: "dashed" as const } : {}),
      endArrowhead: e.directed ? "arrow" : "none",
      ...(e.curved ? { curved: true } : {}),
    });
  }

  const steps = [...byStep.keys()].sort((a, b) => a - b);
  const sorted = new Map(steps.map((s) => [s, byStep.get(s)!]));
  return {
    byStep: sorted,
    creates: steps.flatMap((s) => byStep.get(s)!),
    bbox: { x: ox, y: oy, w: placed.width, h: placed.height },
  };
}

// ── Placement on the canvas ────────────────────────────

const PLACEMENT_MARGIN = 80;

export function boundsOf(elements: CanvasElement[]): Rect | null {
  const rects = elements
    .filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y))
    .map((e) => ({ x: e.x, y: e.y, w: Math.max(1, e.width ?? 1), h: Math.max(1, e.height ?? 1) }));
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlapsAny(r: Rect, elements: CanvasElement[], margin: number): boolean {
  return elements.some((e) => {
    const w = Math.max(1, e.width ?? 1);
    const h = Math.max(1, e.height ?? 1);
    return r.x < e.x + w + margin && r.x + r.w + margin > e.x && r.y < e.y + h + margin && r.y + r.h + margin > e.y;
  });
}

/**
 * Choose an origin for a diagram of size (w, h).
 * Revisions keep their previous origin when that space is free;
 * new diagrams go below everything already on the canvas.
 */
export function chooseOrigin(
  size: { w: number; h: number },
  others: CanvasElement[],
  preferred?: { x: number; y: number }
): { x: number; y: number } {
  if (preferred && !overlapsAny({ ...preferred, ...size }, others, PLACEMENT_MARGIN / 2)) return preferred;
  const b = boundsOf(others);
  if (!b) return preferred ?? { x: 0, y: 0 };
  return { x: preferred?.x ?? b.x, y: b.y + b.h + PLACEMENT_MARGIN + 40 };
}

// ── Diff for revisions ─────────────────────────────────

const UPDATABLE = new Set(["create_rectangle", "create_circle", "create_diamond"]);

/** If two shape creations differ only in label / colours, the in-place update that turns one into the other. */
function inPlaceUpdate(prev: CreateAction, next: CreateAction): DSLAction | null {
  if (prev.action !== next.action || !UPDATABLE.has(next.action)) return null;
  const strip = (a: CreateAction) => {
    const { label, strokeColor, backgroundColor, labelColor, labelFontSize, ...rest } = a as CreateAction & Record<string, unknown>;
    void labelColor;
    void labelFontSize;
    return { rest: JSON.stringify(rest), label: label as string | undefined, strokeColor: strokeColor as string | undefined, backgroundColor: backgroundColor as string | undefined };
  };
  const a = strip(prev), b = strip(next);
  if (a.rest !== b.rest) return null;
  // A label added to a previously empty shape needs a new bound text element: recreate instead.
  if (!a.label && b.label) return null;
  return {
    action: "update_element",
    elementId: next.id,
    ...(a.label !== b.label ? { label: b.label ?? "" } : {}),
    ...(a.strokeColor !== b.strokeColor && b.strokeColor ? { strokeColor: b.strokeColor } : {}),
    ...(a.backgroundColor !== b.backgroundColor && b.backgroundColor ? { backgroundColor: b.backgroundColor } : {}),
  };
}

/**
 * Compare the previous compilation of a diagram with the new one.
 * Elements that are byte-identical (and whose arrow endpoints are
 * also kept) are left untouched on the canvas; shapes whose only
 * change is their label or colour are updated in place; everything
 * else is deleted / (re)created.  `canvasMatches` is false when the
 * user moved or edited the diagram by hand — then nothing is reused.
 */
export function diffDiagram(
  previous: CreateAction[] | undefined,
  next: CreateAction[],
  existingIds: Set<string>,
  canvasMatches: boolean
): { deletes: DSLAction[]; keep: Set<string>; updates: DSLAction[] } {
  const keep = new Set<string>();
  const updates: DSLAction[] = [];
  const prevById = new Map((previous ?? []).map((a) => [a.id, a]));
  if (canvasMatches) {
    for (const a of next) {
      const p = prevById.get(a.id);
      if (!p || !existingIds.has(a.id)) continue;
      if (JSON.stringify(p) === JSON.stringify(a)) {
        keep.add(a.id);
        continue;
      }
      const update = inPlaceUpdate(p, a);
      if (update) {
        keep.add(a.id);
        if (Object.keys(update).length > 2) updates.push(update);
      }
    }
    // An arrow can only be kept if both of its endpoints are kept.
    for (const a of next) {
      if (a.action !== "create_arrow" || !keep.has(a.id)) continue;
      if ((a.fromId && !keep.has(a.fromId)) || (a.toId && !keep.has(a.toId))) keep.delete(a.id);
    }
  }
  const nextIds = new Set(next.map((a) => a.id));
  const deletes: DSLAction[] = [];
  for (const id of prevById.keys()) {
    if (!existingIds.has(id)) continue;
    if (!nextIds.has(id) || !keep.has(id)) deletes.push({ action: "delete_element", elementId: id });
  }
  return { deletes, keep, updates: updates.filter((u) => u.action === "update_element" && keep.has(u.elementId)) };
}

/**
 * The hand-drawn canvas font has no "∞" glyph (it renders as a tiny dot), so canvas text spells it
 * "inf". LaTeX formulas are typeset separately and keep \infty; the lesson notes keep ∞.
 */
function canvasGlyphs<T extends CreateAction>(a: T): T {
  const fix = (s: string) => s.replace(/∞/g, "inf");
  const out = { ...a } as T & { text?: unknown; label?: unknown };
  if (typeof out.text === "string" && out.text.includes("∞")) out.text = fix(out.text);
  if (typeof out.label === "string" && out.label.includes("∞")) out.label = fix(out.label);
  return out;
}
