// ─────────────────────────────────────────────────────────
// Layouts for the quantitative / spatial diagram kinds.
//
// Every coordinate here is computed from data — scales, ticks,
// curve samples, intersections, angles, percentages, date
// positions.  The model never supplies canvas geometry.
// Coordinates use the canvas convention (y grows downward);
// math coordinates (y up) are flipped explicitly.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec, Role } from "./spec.js";
import { emptyBody, makeBox, clipToShape, type Body, type PlacedBox, type PlacedPath, type PlacedText, type Pt } from "./layout.js";
import { compileExpression, fmt, intersections, niceTicks, sampleFunction } from "./mathExpr.js";
import { measureBlock } from "./textMetrics.js";
import { formatEventDate, formatYear, parseYear } from "./dates.js";
import { angleDegrees } from "./validateQuant.js";

export const SERIES_ROLES: Role[] = ["primary", "danger", "success", "secondary", "warning", "accent"];
export const LABEL_FONT = 16;
export const TICK_FONT = 14;

/** Nice ticks guaranteed to reach past both ends of the data. */
function coverTicks(lo: number, hi: number, target: number): number[] {
  const t = niceTicks(lo, hi, target);
  const step = t.length > 1 ? t[1] - t[0] : 1;
  while (t[0] > lo + 1e-9) t.unshift(Number((t[0] - step).toFixed(10)));
  while (t[t.length - 1] < hi - 1e-9) t.push(Number((t[t.length - 1] + step).toFixed(10)));
  return t;
}

/** "x^2 - 2*x" → "x² − 2·x" for display. */
function prettyExpr(expr: string): string {
  const sup: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return expr
    .replace(/^\s*(y|f\(x\))\s*=\s*/, "")
    .replace(/\^(\d)/g, (_, d: string) => sup[d])
    .replace(/\*/g, "·")
    .replace(/(\S)\s*-\s*/g, "$1 − ")
    .replace(/\s*\+\s*/g, " + ")
    .replace(/sqrt/g, "√")
    .replace(/\bpi\b/g, "π");
}

export const clampStep = (s: number | undefined, max: number) => Math.min(Math.max(1, s ?? 1), Math.max(1, max));

export function text(id: string, value: string, x: number, y: number, opts: Partial<PlacedText> = {}): PlacedText {
  const fontSize = opts.fontSize ?? LABEL_FONT;
  const block = measureBlock(value, fontSize, opts.w ?? 260);
  const align = opts.align ?? "left";
  // For centered text, x is the center.
  const left = align === "center" ? x - block.width / 2 : x;
  return { tone: "body", step: 1, ...opts, id, text: block.text, y, fontSize, align, x: left, w: block.width, h: block.height };
}

export function circlePath(cx: number, cy: number, r: number, segments = 48): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts[pts.length - 1] = pts[0];
  return pts;
}

export function dot(id: string, x: number, y: number, role: Role, step: number, r = 6, hollow = false): PlacedPath {
  return { id, points: circlePath(x, y, r, 16), closed: true, smooth: true, role, fill: hollow ? undefined : role, strokeWidth: 2, step };
}

/**
 * Move labels (by id prefix) off each other and off fixed text (tick labels), trying a few
 * nearby offsets in order. Labels that can't be placed cleanly stay where they were.
 */
export function separateLabels(body: Body, movable: (id: string) => boolean): void {
  type R = { x: number; y: number; w: number; h: number };
  const hit = (a: R, b: R) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 1 && a.y + a.h + 1 > b.y;
  const placed: R[] = body.texts.filter((t) => !movable(t.id)).map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h }));
  const offsets: Array<[number, number]> = [[0, 0], [0, -22], [0, 22], [18, -12], [-18, -12], [0, -44], [0, 44], [28, 10], [-28, 10]];
  for (const t of body.texts.filter((x) => movable(x.id))) {
    const spot = offsets.map(([dx, dy]) => ({ x: t.x + dx, y: t.y + dy, w: t.w, h: t.h })).find((r) => !placed.some((p) => hit(p, r)));
    if (spot) { t.x = spot.x; t.y = spot.y; }
    placed.push({ x: t.x, y: t.y, w: t.w, h: t.h });
  }
}

// ── Number line ────────────────────────────────────────

export function layoutNumberLine(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const nl = spec.numberLine!;
  const { min, max } = nl;
  const span = max - min;
  const step = nl.step && span / nl.step <= 40 ? nl.step : niceTicks(min, max, Math.min(20, Math.max(4, Math.round(span))))[1] - niceTicks(min, max, Math.min(20, Math.max(4, Math.round(span))))[0] || 1;
  const ppu = Math.min(80, Math.max(26, 760 / span));
  const X = (v: number) => (v - min) * ppu;

  // Jump arcs above the axis, in lanes so overlapping jumps don't collide.
  const jumps = nl.jumps ?? [];
  const lanes: Array<Array<[number, number]>> = [];
  const jumpLane = jumps.map((j) => {
    const a = Math.min(j.from, j.to), b = Math.max(j.from, j.to);
    let lane = lanes.findIndex((spans) => spans.every(([s, e]) => b <= s || a >= e));
    if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
    lanes[lane].push([a, b]);
    return lane;
  });
  const arcSpace = jumps.length ? 56 + lanes.length * 30 : 20;
  const axisY = arcSpace + 30;

  // Axis with arrowheads both ways (the line continues).
  body.paths.push({ id: "x-axis", points: [[-30, axisY], [X(max) + 30, axisY]], role: "ink", strokeWidth: 2, arrowEnd: true, arrowStart: true, step: 1 });

  // Ticks + labels.
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first, i = 0; v <= max + 1e-9 && i < 80; v += step, i++) {
    const value = Number(v.toFixed(10));
    const x = X(value);
    const major = value === 0;
    body.paths.push({ id: `x-tick${i}`, points: [[x, axisY - (major ? 12 : 8)], [x, axisY + (major ? 12 : 8)]], role: "ink", strokeWidth: major ? 2.5 : 1.5, step: 1 });
    body.texts.push(text(`x-tl${i}`, fmt(value), x, axisY + 16, { align: "center", fontSize: TICK_FONT, tone: major ? "body" : "muted" }));
  }

  // Intervals (inequalities): thick band on the axis + open/closed endpoints.
  (nl.intervals ?? []).forEach((iv, i) => {
    const role = iv.role ?? "accent";
    const s = clampStep(iv.step, maxStep);
    const x1 = iv.from === undefined ? -30 : X(iv.from);
    const x2 = iv.to === undefined ? X(max) + 30 : X(iv.to);
    body.paths.push({ id: `x-iv${i}`, points: [[x1, axisY], [x2, axisY]], role, strokeWidth: 5, arrowStart: iv.from === undefined, arrowEnd: iv.to === undefined, step: s });
    if (iv.from !== undefined) body.paths.push(dot(`x-ivf${i}`, x1, axisY, role, s, 7, !iv.includeFrom));
    if (iv.to !== undefined) body.paths.push(dot(`x-ivt${i}`, x2, axisY, role, s, 7, !iv.includeTo));
    if (iv.label) body.texts.push(text(`x-ivl${i}`, iv.label, (x1 + x2) / 2, axisY + 44 + i * 22, { align: "center", tone: role, step: s }));
  });

  // Jumps: curved arrows from → to with the (computed) change as label.
  jumps.forEach((j, i) => {
    const s = clampStep(j.step, maxStep);
    const x1 = X(j.from), x2 = X(j.to);
    const h = 24 + jumpLane[i] * 30 + Math.min(18, Math.abs(x2 - x1) * 0.06);
    const role: Role = j.to >= j.from ? "success" : "danger";
    body.paths.push({
      id: `x-jump${i}`,
      points: [[x1, axisY - 8], [(x1 + x2) / 2, axisY - 8 - h], [x2, axisY - 8]],
      smooth: true, role, strokeWidth: 2, arrowEnd: true, step: s,
    });
    body.texts.push(text(`x-jl${i}`, j.label ?? "", (x1 + x2) / 2, axisY - 8 - h - 24, { align: "center", tone: role, step: s }));
  });

  // Points with labels below the tick labels.
  (nl.points ?? []).forEach((p, i) => {
    const s = clampStep(p.step, maxStep);
    const role = p.role ?? "primary";
    body.paths.push(dot(`x-pt${i}`, X(p.value), axisY, role, s, 7));
    if (p.label) body.texts.push(text(`x-ptl${i}`, p.label, X(p.value), axisY + 40 + (nl.intervals?.length ? 22 * nl.intervals.length + 6 : 0), { align: "center", tone: role, step: s }));
  });
  return body;
}

// ── Coordinate plane / function plots ──────────────────

export function layoutPlot(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const plot = spec.plot!;
  const fns = plot.functions.map((f) => ({ ...f, fn: compileExpression(f.expr) }));
  const pts = plot.points ?? [];
  const segs = plot.segments ?? [];

  // X range: given, else from points/segments, else a sensible default.
  const xs = [...pts.map((p) => p.x), ...segs.flatMap((s) => [s.from[0], s.to[0]])];
  let xMin = plot.xMin ?? (xs.length ? Math.min(0, ...xs) - 1 : -10);
  let xMax = plot.xMax ?? (xs.length ? Math.max(0, ...xs) + 1 : 10);
  if (xMax <= xMin) xMax = xMin + 10;
  // Y range: given, else from sampled function values + points (robust to asymptotes).
  let yMin = plot.yMin, yMax = plot.yMax;
  if (yMin === undefined || yMax === undefined) {
    const ys: number[] = [...pts.map((p) => p.y), ...segs.flatMap((s) => [s.from[1], s.to[1]])];
    for (const f of fns) for (let i = 0; i <= 120; i++) {
      const y = f.fn(xMin + ((xMax - xMin) * i) / 120);
      if (Number.isFinite(y)) ys.push(y);
    }
    ys.sort((a, b) => a - b);
    const lo = ys.length ? ys[Math.floor(ys.length * 0.02)] : -10;
    const hi = ys.length ? ys[Math.ceil(ys.length * 0.98) - 1] : 10;
    const pad = Math.max(1, (hi - lo) * 0.1);
    yMin ??= Math.min(0, lo - pad);
    yMax ??= Math.max(0, hi + pad);
  }
  if (yMax <= yMin) yMax = yMin + 10;

  const W = 560, H = 400;
  const PX = (x: number) => ((x - xMin) / (xMax - xMin)) * W;
  const PY = (y: number) => H - ((y - yMin!) / (yMax! - yMin!)) * H;

  // Grid + tick labels.
  const xt = niceTicks(xMin, xMax, 10), yt = niceTicks(yMin, yMax, 8);
  const axisX = Math.min(Math.max(0, yMin), yMax); // y-value where the x-axis sits
  const axisY = Math.min(Math.max(0, xMin), xMax);
  xt.forEach((v, i) => {
    body.paths.push({ id: `x-gx${i}`, points: [[PX(v), 0], [PX(v), H]], role: "muted", strokeWidth: 1, opacity: 35, step: 1 });
    if (v !== 0) body.texts.push(text(`x-xt${i}`, fmt(v), PX(v), PY(axisX) + 6, { align: "center", fontSize: TICK_FONT, tone: "muted" }));
  });
  yt.forEach((v, i) => {
    body.paths.push({ id: `x-gy${i}`, points: [[0, PY(v)], [W, PY(v)]], role: "muted", strokeWidth: 1, opacity: 35, step: 1 });
    if (v !== 0) {
      const label = fmt(v);
      body.texts.push(text(`x-yt${i}`, label, PX(axisY) - 8 - measureBlock(label, TICK_FONT, 80).width, PY(v) - 9, { fontSize: TICK_FONT, tone: "muted" }));
    }
  });
  body.paths.push({ id: "x-xaxis", points: [[-10, PY(axisX)], [W + 16, PY(axisX)]], role: "ink", strokeWidth: 2, arrowEnd: true, step: 1 });
  body.paths.push({ id: "x-yaxis", points: [[PX(axisY), H + 10], [PX(axisY), -16]], role: "ink", strokeWidth: 2, arrowEnd: true, step: 1 });
  body.texts.push(text("x-xl", plot.xLabel ?? "x", W + 22, PY(axisX) - 10, { tone: "body" }));
  body.texts.push(text("x-yl", plot.yLabel ?? "y", PX(axisY) + 10, -38, { tone: "body" }));

  // Functions (sampled, split at discontinuities, clipped to the window).
  fns.forEach((f, i) => {
    const role = f.role ?? SERIES_ROLES[i % SERIES_ROLES.length];
    const s = clampStep(f.step, maxStep);
    const runs = sampleFunction(f.fn, xMin, xMax, yMin!, yMax!);
    runs.forEach((run, k) => {
      body.paths.push({ id: `x-f${i}r${k}`, points: run.map(([x, y]) => [PX(x), PY(y)] as Pt), role, strokeWidth: 2.5, step: s });
    });
    const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), [] as Array<[number, number]>);
    if (longest.length > 2) {
      const k = Math.floor(longest.length * 0.82);
      const p = [PX(longest[k][0]), PY(longest[k][1])];
      const q = [PX(longest[Math.min(k + 2, longest.length - 1)][0]), PY(longest[Math.min(k + 2, longest.length - 1)][1])];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      let nx = -dy / l, ny = dx / l;
      if (ny > 0) { nx = -nx; ny = -ny; } // put the label above the curve
      const label = f.label ?? `y = ${prettyExpr(f.expr)}`;
      const w = measureBlock(label, LABEL_FONT, 260).width;
      const lx = p[0] + nx * 16 + (nx < 0 ? -w : 4);
      body.texts.push(text(`x-fl${i}`, label, Math.min(W - w, Math.max(0, lx)), p[1] + ny * 16 - 20, { tone: role, step: s }));
    }
  });

  // Intersections, computed — never taken from the model.
  if (plot.showIntersections && fns.length >= 2) {
    let n = 0;
    for (let a = 0; a < fns.length; a++) for (let b = a + 1; b < fns.length; b++) {
      for (const x of intersections(fns[a].fn, fns[b].fn, xMin, xMax).slice(0, 4)) {
        const y = fns[a].fn(x);
        if (!Number.isFinite(y) || y < yMin! || y > yMax!) continue;
        body.paths.push(dot(`x-ix${n}`, PX(x), PY(y), "warning", maxStep, 6));
        body.texts.push(text(`x-ixl${n}`, `(${fmt(Math.round(x * 100) / 100)}, ${fmt(Math.round(y * 100) / 100)})`, PX(x) + 8, PY(y) - 28, { tone: "warning", step: maxStep, fontSize: TICK_FONT }));
        n++;
      }
    }
  }

  segs.forEach((sg, i) => {
    const role = sg.role ?? "secondary";
    const s = clampStep(sg.step, maxStep);
    body.paths.push({ id: `x-sg${i}`, points: [[PX(sg.from[0]), PY(sg.from[1])], [PX(sg.to[0]), PY(sg.to[1])]], role, strokeWidth: 2, dashed: sg.dashed, step: s });
    if (sg.label) body.texts.push(text(`x-sgl${i}`, sg.label, (PX(sg.from[0]) + PX(sg.to[0])) / 2 + 8, (PY(sg.from[1]) + PY(sg.to[1])) / 2 - 22, { tone: role, step: s }));
  });
  pts.forEach((p, i) => {
    const role = p.role ?? "accent";
    const s = clampStep(p.step, maxStep);
    if (p.x < xMin || p.x > xMax || p.y < yMin! || p.y > yMax!) return;
    body.paths.push(dot(`x-p${i}`, PX(p.x), PY(p.y), role, s, 6));
    const label = p.label ? `${p.label}` : `(${fmt(p.x)}, ${fmt(p.y)})`;
    body.texts.push(text(`x-pl${i}`, label, PX(p.x) + 10, PY(p.y) - 26, { tone: role, step: s, fontSize: TICK_FONT }));
  });
  // Busy plots: function, intersection, point and segment labels must not sit on each other or on tick labels.
  separateLabels(body, (id) => /^x-(fl|ixl|pl|sgl)\d/.test(id));
  return body;
}

// ── Geometry ───────────────────────────────────────────

export function layoutGeometry(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const g = spec.geometry!;
  const P = new Map(g.points.map((p) => [p.id, p]));
  const radiusOf = (c: NonNullable<typeof g.circles>[number]) => {
    if (c.radius) return c.radius;
    const a = P.get(c.center)!, b = P.get(c.through!)!;
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  // Fit points and circles into ~440px, equal scale on both axes (true shapes).
  const ext: Array<[number, number]> = g.points.map((p) => [p.x, p.y]);
  for (const c of g.circles ?? []) {
    const ctr = P.get(c.center)!, r = radiusOf(c);
    ext.push([ctr.x - r, ctr.y - r], [ctr.x + r, ctr.y + r]);
  }
  const minX = Math.min(...ext.map((e) => e[0])), maxX = Math.max(...ext.map((e) => e[0]));
  const minY = Math.min(...ext.map((e) => e[1])), maxY = Math.max(...ext.map((e) => e[1]));
  const scale = Math.min(140, 440 / Math.max(maxX - minX || 1, maxY - minY || 1));
  const X = (x: number) => (x - minX) * scale;
  const Y = (y: number) => (maxY - y) * scale; // flip: math y-up → canvas y-down
  const centroid: Pt = [X(g.points.reduce((s, p) => s + p.x, 0) / g.points.length), Y(g.points.reduce((s, p) => s + p.y, 0) / g.points.length)];

  (g.polygons ?? []).forEach((poly, i) => {
    const pts = poly.vertices.map((v) => [X(P.get(v)!.x), Y(P.get(v)!.y)] as Pt);
    const role = poly.role ?? "primary";
    const s = clampStep(poly.step, maxStep);
    body.paths.push({ id: `x-poly${i}`, points: [...pts, pts[0]], closed: true, role, fill: role, opacity: 70, strokeWidth: 2, step: s });
    if (poly.label) {
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      body.texts.push(text(`x-polyl${i}`, poly.label, cx, cy - 10, { align: "center", tone: role, step: s }));
    }
  });
  (g.circles ?? []).forEach((c, i) => {
    const ctr = P.get(c.center)!;
    const r = radiusOf(c) * scale;
    const role = c.role ?? "secondary";
    const s = clampStep(c.step, maxStep);
    body.paths.push({ id: `x-circ${i}`, points: circlePath(X(ctr.x), Y(ctr.y), r, 64), closed: true, smooth: true, role, strokeWidth: 2, step: s });
    if (c.label) body.texts.push(text(`x-circl${i}`, c.label, X(ctr.x) + r * 0.72 + 6, Y(ctr.y) - r * 0.72 - 22, { tone: role, step: s }));
  });
  (g.segments ?? []).forEach((sg, i) => {
    const a = P.get(sg.from)!, b = P.get(sg.to)!;
    const role = sg.role ?? "primary";
    const s = clampStep(sg.step, maxStep);
    body.paths.push({ id: `x-seg${i}`, points: [[X(a.x), Y(a.y)], [X(b.x), Y(b.y)]], role, strokeWidth: 2, dashed: sg.dashed, step: s });
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const label = sg.showLength && !sg.label ? fmt(Math.round(len * 100) / 100) : sg.label;
    if (label) {
      // Offset the label perpendicular to the segment, away from the figure's centroid.
      const mx = (X(a.x) + X(b.x)) / 2, my = (Y(a.y) + Y(b.y)) / 2;
      const dx = X(b.x) - X(a.x), dy = Y(b.y) - Y(a.y);
      const l = Math.hypot(dx, dy) || 1;
      let nx = -dy / l, ny = dx / l;
      if ((mx - centroid[0]) * nx + (my - centroid[1]) * ny < 0) { nx = -nx; ny = -ny; }
      body.texts.push(text(`x-segl${i}`, label, mx + nx * 18, my + ny * 18 - 10, { align: "center", tone: role, step: s, fontSize: 15 }));
    }
  });
  (g.angles ?? []).forEach((ang, i) => {
    const v = P.get(ang.vertex)!, a = P.get(ang.from)!, b = P.get(ang.to)!;
    const s = clampStep(ang.step, maxStep);
    const measure = angleDegrees(v, a, b);
    const vx = X(v.x), vy = Y(v.y);
    const a1 = Math.atan2(Y(a.y) - vy, X(a.x) - vx);
    const a2 = Math.atan2(Y(b.y) - vy, X(b.x) - vx);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const r = 26;
    if (Math.abs(measure - 90) < 0.5) {
      // Right-angle square marker.
      const u1: Pt = [Math.cos(a1) * 16, Math.sin(a1) * 16], u2: Pt = [Math.cos(a2) * 16, Math.sin(a2) * 16];
      body.paths.push({ id: `x-ang${i}`, points: [[vx + u1[0], vy + u1[1]], [vx + u1[0] + u2[0], vy + u1[1] + u2[1]], [vx + u2[0], vy + u2[1]]], role: "warning", strokeWidth: 2, step: s });
    } else {
      const arc: Pt[] = [];
      for (let k = 0; k <= 12; k++) {
        const t = a1 + (delta * k) / 12;
        arc.push([vx + r * Math.cos(t), vy + r * Math.sin(t)]);
      }
      body.paths.push({ id: `x-ang${i}`, points: arc, smooth: true, role: "warning", strokeWidth: 2, step: s });
    }
    const label = ang.label ?? (ang.showMeasure ? `${fmt(Math.round(measure * 10) / 10)}°` : undefined);
    if (label) {
      const mid = a1 + delta / 2;
      body.texts.push(text(`x-angl${i}`, label, vx + Math.cos(mid) * 48, vy + Math.sin(mid) * 48 - 10, { align: "center", tone: "warning", step: s, fontSize: 15 }));
    }
  });
  // Vertices last so dots sit on top; labels pushed outward from the centroid.
  g.points.forEach((p, i) => {
    if (p.hidden) return;
    const x = X(p.x), y = Y(p.y);
    body.paths.push(dot(`x-v${i}`, x, y, "ink" as unknown as Role, 1, 4));
    const dx = x - centroid[0], dy = y - centroid[1];
    const l = Math.hypot(dx, dy) || 1;
    body.texts.push(text(`x-vl${i}`, p.label ?? p.id.toUpperCase(), x + (dx / l) * 18, y + (dy / l) * 18 - 11, { align: "center", tone: "body", fontSize: 17 }));
  });
  return body;
}

// ── Charts ─────────────────────────────────────────────

export function layoutChart(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const c = spec.chart!;
  if (c.type === "pie") return layoutPie(spec);

  const series = c.series ?? [];
  const categories = c.categories ?? [];
  const isScatter = c.type === "scatter";
  const H = 300;
  const W = isScatter ? 520 : Math.max(380, categories.length * Math.max(56, series.length * 26 + 22));
  const values = isScatter ? (c.points ?? []).map((p) => p.y) : series.flatMap((s) => s.values);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const yt = coverTicks(lo, hi === lo ? lo + 1 : hi, 6);
  const yMin = Math.min(lo, yt[0]), yMax = Math.max(hi, yt[yt.length - 1]);
  const PY = (v: number) => H - ((v - yMin) / (yMax - yMin || 1)) * H;

  yt.forEach((v, i) => {
    body.paths.push({ id: `x-cg${i}`, points: [[0, PY(v)], [W, PY(v)]], role: "muted", strokeWidth: 1, opacity: 35, step: 1 });
    const label = fmt(v) + (c.unit && i === yt.length - 1 ? ` ${c.unit}` : "");
    body.texts.push(text(`x-cyt${i}`, label, -10 - measureBlock(label, TICK_FONT, 120).width, PY(v) - 9, { fontSize: TICK_FONT, tone: "muted" }));
  });
  body.paths.push({ id: "x-cx", points: [[0, PY(Math.max(0, yMin))], [W, PY(Math.max(0, yMin))]], role: "ink", strokeWidth: 2, step: 1 });
  body.paths.push({ id: "x-cy", points: [[0, H], [0, -10]], role: "ink", strokeWidth: 2, step: 1 });
  if (c.yLabel) body.texts.push(text("x-cyl", c.yLabel, 0, -40, { tone: "body" }));

  if (isScatter) {
    const pts = c.points ?? [];
    const xs = pts.map((p) => p.x);
    const xt = niceTicks(Math.min(...xs), Math.max(...xs), 8);
    const xMin = Math.min(xt[0], ...xs), xMax = Math.max(xt[xt.length - 1], ...xs);
    const PX = (v: number) => ((v - xMin) / (xMax - xMin || 1)) * W;
    xt.forEach((v, i) => body.texts.push(text(`x-cxt${i}`, fmt(v), PX(v), H + 8, { align: "center", fontSize: TICK_FONT, tone: "muted" })));
    pts.forEach((p, i) => {
      body.paths.push(dot(`x-sp${i}`, PX(p.x), PY(p.y), "primary", maxStep > 1 ? 2 : 1, 5));
      if (p.label) body.texts.push(text(`x-spl${i}`, p.label, PX(p.x) + 8, PY(p.y) - 22, { fontSize: TICK_FONT, tone: "primary" }));
    });
  } else {
    const slot = W / categories.length;
    categories.forEach((cat, ci) => {
      body.texts.push(text(`x-cat${ci}`, cat, slot * (ci + 0.5), H + 8, { align: "center", fontSize: TICK_FONT, tone: "body", w: Math.max(50, slot - 8) }));
    });
    series.forEach((s, si) => {
      const role = s.role ?? SERIES_ROLES[si % SERIES_ROLES.length];
      const step = Math.min(maxStep, si + 1);
      if (c.type === "bar") {
        const barW = Math.min(48, (slot - 16) / series.length);
        s.values.forEach((v, ci) => {
          const x = slot * ci + (slot - barW * series.length) / 2 + barW * si;
          const top = PY(Math.max(v, 0)), bottom = PY(Math.min(v, 0));
          body.boxes.push({ id: `x-bar${si}_${ci}`, x, y: top, w: Math.max(4, barW - 4), h: Math.max(2, bottom - top), shape: "rect", label: "", role, step, fontSize: 14 });
          body.texts.push(text(`x-bv${si}_${ci}`, fmt(v), x + barW / 2 - 2, (v >= 0 ? top : bottom) + (v >= 0 ? -20 : 4), { align: "center", fontSize: 13, tone: role, step }));
        });
      } else {
        const pts = s.values.map((v, ci) => [slot * (ci + 0.5), PY(v)] as Pt);
        body.paths.push({ id: `x-line${si}`, points: pts, role, strokeWidth: 2.5, step });
        pts.forEach((p, ci) => {
          body.paths.push(dot(`x-ld${si}_${ci}`, p[0], p[1], role, step, 4));
          body.texts.push(text(`x-lv${si}_${ci}`, fmt(s.values[ci]), p[0], p[1] - 24, { align: "center", fontSize: 13, tone: role, step }));
        });
      }
    });
    if (series.length > 1) legend(body, series.map((s, i) => ({ name: s.name, role: s.role ?? SERIES_ROLES[i % SERIES_ROLES.length] })), W + 30, 0);
  }
  if (c.xLabel) body.texts.push(text("x-cxl", c.xLabel, W / 2, H + 40, { align: "center", tone: "body" }));
  return body;
}

function legend(body: Body, items: Array<{ name: string; role: Role }>, x: number, y: number): void {
  items.forEach((it, i) => {
    body.boxes.push({ id: `x-lg${i}`, x, y: y + i * 28, w: 18, h: 18, shape: "rect", label: "", role: it.role, step: 1, fontSize: 12 });
    body.texts.push(text(`x-lgt${i}`, it.name, x + 26, y + i * 28 - 1, { fontSize: 15, tone: "body" }));
  });
}

function layoutPie(spec: DiagramSpec): Body {
  const body = emptyBody();
  const c = spec.chart!;
  const values = c.series![0].values;
  const cats = c.categories ?? values.map((_, i) => `${i + 1}`);
  const total = values.reduce((a, b) => a + b, 0);
  // Percentages computed here, rounded with largest-remainder so they sum to 100.
  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - floors[i], i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest-- > 0) floors[i]++; });

  const R = 150, cx = R + 10, cy = R + 10;
  let angle = -Math.PI / 2;
  const outside: Array<{ i: number; mid: number; label: string; role: Role }> = [];
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    if (sweep <= 0) return;
    const role = SERIES_ROLES[i % SERIES_ROLES.length];
    const pts: Pt[] = [[cx, cy]];
    const segs = Math.max(2, Math.ceil(sweep / 0.08));
    for (let k = 0; k <= segs; k++) {
      const t = angle + (sweep * k) / segs;
      pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]);
    }
    pts.push([cx, cy]);
    body.paths.push({ id: `x-slice${i}`, points: pts, closed: true, role, fill: role, strokeWidth: 2, step: 1 });
    const mid = angle + sweep / 2;
    const pct = floors[i] === 0 && v > 0 ? "<1" : String(floors[i]);
    const label = `${cats[i]}\n${pct}%`;
    if (sweep > 0.45) {
      body.texts.push(text(`x-slicel${i}`, label, cx + R * 0.62 * Math.cos(mid), cy + R * 0.62 * Math.sin(mid) - 18, { align: "center", fontSize: 14, tone: "body", w: 110 }));
    } else {
      outside.push({ i, mid, label, role });
    }
    angle += sweep;
  });
  // Small slices: labels outside, stacked per side so they never overlap, with leader lines.
  for (const side of [1, -1]) {
    const items = outside
      .filter((o) => (Math.cos(o.mid) >= 0 ? 1 : -1) === side)
      .map((o) => ({ ...o, y: cy + (R + 30) * Math.sin(o.mid) }))
      .sort((a, b) => a.y - b.y);
    for (let k = 1; k < items.length; k++) items[k].y = Math.max(items[k].y, items[k - 1].y + 40);
    for (const o of items) {
      const ex = cx + R * Math.cos(o.mid), ey = cy + R * Math.sin(o.mid);
      const lx = cx + side * (R + 46);
      body.paths.push({ id: `x-slicelead${o.i}`, points: [[ex, ey], [lx - side * 6, o.y + 18]], role: o.role, strokeWidth: 1.5, step: 1 });
      const w = measureBlock(o.label, 14, 110).width;
      body.texts.push(text(`x-slicel${o.i}`, o.label, side > 0 ? lx : lx - w, o.y, { fontSize: 14, tone: o.role, w: 110 }));
    }
  }
  return body;
}

// ── Tables ─────────────────────────────────────────────

export function layoutTable(spec: DiagramSpec): Body {
  const body = emptyBody();
  const t = spec.table!;
  const all = [t.columns, ...t.rows];
  const FONT = 16;
  const colW = t.columns.map((_, c) => Math.max(70, ...all.map((r) => measureBlock(r[c] ?? "", FONT, 200).width + 28)));
  const rowH = all.map((r) => Math.max(44, ...r.map((cell, c) => measureBlock(cell, FONT, colW[c] - 20).height + 20)));
  const roleAt = (r: number, c: number): Role => {
    const h = t.highlight?.find((x) => x.row === r && x.col === c);
    if (h?.role) return h.role;
    return t.rowHeaders && c === 0 ? "secondary" : "muted";
  };
  let y = 0;
  all.forEach((row, r) => {
    let x = 0;
    row.forEach((cell, c) => {
      const header = r === 0;
      const role: Role = header ? "primary" : roleAt(r - 1, c);
      const block = measureBlock(cell || " ", FONT, colW[c] - 20);
      body.boxes.push({ id: `x-cell${r}_${c}`, x, y, w: colW[c], h: rowH[r], shape: "rect", label: block.text, role, step: 1, fontSize: FONT });
      x += colW[c];
    });
    y += rowH[r];
  });
  return body;
}

// ── Venn diagrams ──────────────────────────────────────

export function layoutVenn(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const v = spec.venn!;
  const three = v.sets.length === 3;
  const R = three ? 140 : 150;
  const centers: Pt[] = three ? [[160, 170], [340, 170], [250, 320]] : [[170, 170], [350, 170]];
  // Region anchor points (centers of each lens / crescent), computed for this geometry.
  const anchors: Record<string, Pt> = three
    ? { "0": [100, 130], "1": [400, 130], "2": [250, 400], "0&1": [250, 125], "0&2": [180, 270], "1&2": [320, 270], "0&1&2": [250, 220] }
    : { "0": [100, 170], "1": [420, 170], "0&1": [260, 170] };
  const idx = new Map(v.sets.map((s, i) => [s.id, i]));

  v.sets.forEach((set, i) => {
    const role = set.role ?? SERIES_ROLES[i];
    const [cx, cy] = centers[i];
    body.paths.push({ id: `x-set${i}`, points: circlePath(cx, cy, R, 64), closed: true, smooth: true, role, fill: role, opacity: 45, strokeWidth: 2.5, step: 1 });
    const ly = three && i === 2 ? cy + R + 10 : cy - R - 34;
    body.texts.push(text(`x-setl${i}`, set.label, cx, ly, { align: "center", tone: role, fontSize: 19 }));
  });
  v.regions.forEach((r, i) => {
    const key = [...new Set(r.sets.map((s) => idx.get(s)!))].sort().join("&");
    const anchor = anchors[key];
    if (!anchor || !r.items.length) return;
    const width = key.includes("&") ? 90 : 110;
    const block = measureBlock(r.items.join("\n"), 15, width);
    body.texts.push(text(`x-reg${i}`, r.items.join("\n"), anchor[0], anchor[1] - block.height / 2, { align: "center", fontSize: 15, tone: "body", w: width, step: Math.min(maxStep, 2) }));
  });
  if (v.universe) {
    const xs = centers.map((c) => c[0]), ys = centers.map((c) => c[1]);
    const x0 = Math.min(...xs) - R - 30, x1 = Math.max(...xs) + R + 30, y0 = Math.min(...ys) - R - 60, y1 = Math.max(...ys) + R + (three ? 60 : 30);
    body.paths.push({ id: "x-univ", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], closed: true, role: "muted", strokeWidth: 1.5, step: 1 });
    body.texts.push(text("x-univl", v.universe, x0 + 10, y0 + 8, { tone: "muted", fontSize: 15 }));
  }
  return body;
}

// ── Cycles ─────────────────────────────────────────────

export function layoutCycle(spec: DiagramSpec): Body {
  const body = emptyBody();
  const ROLES: Role[] = ["primary", "accent", "success", "warning", "secondary", "danger"];
  const boxes: PlacedBox[] = spec.nodes.map((n, i) => makeBox(n, "rounded", ROLES[i % ROLES.length], { maxTextW: 150 }));
  const n = boxes.length;
  const maxDim = Math.max(...boxes.map((b) => Math.max(b.w, b.h)));
  const R = Math.max(170, (n * (maxDim + 50)) / (2 * Math.PI));
  boxes.forEach((b, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    b.x = R * Math.cos(a) - b.w / 2;
    b.y = R * Math.sin(a) - b.h / 2;
  });
  body.boxes.push(...boxes);
  boxes.forEach((a, i) => {
    const b = boxes[(i + 1) % n];
    const midAngle = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / n;
    const mid: Pt = [R * 1.04 * Math.cos(midAngle), R * 1.04 * Math.sin(midAngle)];
    body.edges.push({
      id: `x-cyc${i}`,
      from: a.id,
      to: b.id,
      points: [clipToShape(a, mid), mid, clipToShape(b, mid)],
      directed: true,
      curved: true,
      role: "muted",
      step: Math.max(a.step, b.step),
    });
  });
  return body;
}

// ── Scaled timelines ───────────────────────────────────

export function layoutChronology(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const c = spec.chronology!;
  const events = c.events.map((e) => ({ ...e, year: parseYear(e.date)! })).sort((a, b) => a.year - b.year);
  const periods = (c.periods ?? []).map((p) => ({ ...p, a: parseYear(p.from)!, b: parseYear(p.to)! }));
  const years = [...events.map((e) => e.year), ...periods.flatMap((p) => [p.a, p.b])];
  let lo = Math.min(...years), hi = Math.max(...years);
  const pad = Math.max((hi - lo) * 0.06, hi === lo ? 1 : 0);
  lo -= pad;
  hi += pad;
  const span = hi - lo;
  const L = 900;
  const X = (y: number) => ((y - lo) / span) * L;

  // Event cards above the axis, stacked in lanes so they never overlap.
  const lanes: Array<Array<[number, number]>> = [];
  const cards = events.map((e, i) => {
    const label = `${e.label}\n${formatEventDate(e.date, e.year)}`;
    const block = measureBlock(label, 15, 160);
    const w = block.width + 24, h = block.height + 16;
    const cx = X(e.year);
    const x0 = cx - w / 2, x1 = cx + w / 2;
    let lane = lanes.findIndex((l) => l.every(([a, b]) => x1 + 12 <= a || x0 - 12 >= b));
    if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
    lanes[lane].push([x0, x1]);
    return { e, i, block, w, h, cx, lane };
  });
  const laneH = Math.max(56, ...cards.map((k) => k.h + 18));
  const axisY = lanes.length * laneH + 40;

  body.paths.push({ id: "x-taxis", points: [[-20, axisY], [L + 20, axisY]], role: "ink", strokeWidth: 2.5, arrowEnd: true, step: 1 });
  niceTicks(lo, hi, 8).forEach((t, i) => {
    body.paths.push({ id: `x-tt${i}`, points: [[X(t), axisY - 6], [X(t), axisY + 6]], role: "ink", strokeWidth: 1.5, step: 1 });
    body.texts.push(text(`x-ttl${i}`, formatYear(t, span), X(t), axisY + 12, { align: "center", fontSize: TICK_FONT, tone: "muted" }));
  });
  for (const k of cards) {
    const s = clampStep(k.e.step, maxStep);
    const role = k.e.role ?? "primary";
    const top = axisY - 30 - (k.lane + 1) * laneH + (laneH - k.h);
    body.paths.push({ id: `x-tlead${k.i}`, points: [[k.cx, axisY], [k.cx, top + k.h]], role: "muted", strokeWidth: 1.5, step: s });
    body.paths.push(dot(`x-tdot${k.i}`, k.cx, axisY, role, s, 6));
    body.boxes.push({ id: `x-tcard${k.i}`, x: k.cx - k.w / 2, y: top, w: k.w, h: k.h, shape: "rounded", label: k.block.text, role, step: s, fontSize: 15 });
  }
  // Periods as bars below the axis, in lanes.
  const pLanes: Array<Array<[number, number]>> = [];
  periods.forEach((p, i) => {
    const x0 = X(p.a), x1 = Math.max(X(p.b), x0 + 40);
    let lane = pLanes.findIndex((l) => l.every(([a, b]) => x1 + 8 <= a || x0 - 8 >= b));
    if (lane === -1) { pLanes.push([]); lane = pLanes.length - 1; }
    pLanes[lane].push([x0, x1]);
    const block = measureBlock(p.label, 14, Math.max(40, x1 - x0 - 12));
    body.boxes.push({
      id: `x-period${i}`, x: x0, y: axisY + 44 + lane * 46, w: x1 - x0, h: Math.max(34, block.height + 12),
      shape: "rect", label: block.text, role: p.role ?? SERIES_ROLES[(i + 2) % SERIES_ROLES.length], step: clampStep(p.step, maxStep), fontSize: 14,
    });
  });
  return body;
}
