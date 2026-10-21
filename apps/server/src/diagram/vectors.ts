// ─────────────────────────────────────────────────────────
// Vectors & forces: free-body diagrams, head-to-tail vector
// addition, and x/y components.
//
// The model supplies magnitudes and directions only.  Arrow
// lengths are drawn to scale, and every derived quantity —
// the net force / resultant, its direction, components — is
// computed here.  A "net force" the model states itself is
// replaced by the computed one.
// ─────────────────────────────────────────────────────────

import type { DiagramSpec, Role } from "./spec.js";
import { emptyBody, type Body, type Pt } from "./layout.js";
import { fmt } from "./mathExpr.js";
import { measureBlock } from "./textMetrics.js";
import { SERIES_ROLES, clampStep, text } from "./layoutQuant.js";

type VectorsBlock = NonNullable<DiagramSpec["vectors"]>;
type Vec = VectorsBlock["vectors"][number];

const RESULTANT_LABEL = /\b(net|resultant|sum|total)\b/i;
/** A trailing number (with unit) after "=" / ":" / a space: "W = 20 N", "Weight 20N" — but not the 1 in "F1". */
const TRAILING_VALUE = /(\s*[=:]\s*|\s+)[-−]?\d+(\.\d+)?\s*[a-zA-Zµ/²]*\s*$/;

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const rad = (deg: number) => (deg * Math.PI) / 180;
const norm = (deg: number) => ((deg % 360) + 360) % 360;

/** Absolute direction in degrees (counter-clockwise from "right") for a vector. */
export function resolveAngle(v: Vec, incline = 0): number | undefined {
  switch (v.direction) {
    case "right": return 0;
    case "up": return 90;
    case "left": return 180;
    case "down": return 270;
    case "up_slope": return norm(incline);
    case "normal": return norm(incline + 90);
    case "down_slope": return norm(incline + 180);
    case "into_slope": return norm(incline + 270);
    default: return v.angle === undefined ? undefined : norm(v.angle);
  }
}

export function sumVectors(vs: Array<{ magnitude: number; angle: number }>): { x: number; y: number; magnitude: number; angle: number } {
  const x = vs.reduce((s, v) => s + v.magnitude * Math.cos(rad(v.angle)), 0);
  const y = vs.reduce((s, v) => s + v.magnitude * Math.sin(rad(v.angle)), 0);
  const magnitude = Math.hypot(x, y);
  return { x, y, magnitude, angle: norm((Math.atan2(y, x) * 180) / Math.PI) };
}

/** "to the right", "upward", "at 36.9° above the +x axis"… */
export function describeDirection(angle: number, incline?: number): string {
  const a = norm(round(angle, 1));
  if (incline && Math.abs(norm(a - incline)) < 0.5) return "up the slope";
  if (incline && Math.abs(norm(a - incline - 180)) < 0.5) return "down the slope";
  const named: Record<number, string> = { 0: "to the right", 90: "upward", 180: "to the left", 270: "downward", 360: "to the right" };
  if (named[a]) return named[a];
  return `at ${fmt(a)}° from the +x direction`;
}

export function validateVectors(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const v = spec.vectors;
  if (!v) { critical.push('kind "vectors" needs a "vectors" block'); return spec; }
  const incline = v.incline;
  let stated: { label: string; magnitude: number; angle?: number } | undefined;
  const vectors: Vec[] = [];
  for (const raw of v.vectors) {
    let vec = { ...raw };
    const cleaned = vec.label.replace(TRAILING_VALUE, "").trim();
    if (cleaned && cleaned !== vec.label) vec.label = cleaned; // values are always shown from `magnitude`
    if (!incline && ["normal", "up_slope", "down_slope", "into_slope"].includes(vec.direction ?? "") && vec.direction !== "normal") {
      issues.push(`vector "${vec.label}" points along a slope but no "incline" was given → slope taken as horizontal`);
    }
    let angle = resolveAngle(vec, incline);
    if (angle === undefined) {
      issues.push(`vector "${vec.label}" has no direction or angle → dropped`);
      continue;
    }
    if (vec.magnitude < 0) {
      issues.push(`vector "${vec.label}" had a negative magnitude → drawn reversed with magnitude ${fmt(-vec.magnitude)}`);
      angle = norm(angle + 180);
      vec = { ...vec, magnitude: -vec.magnitude };
    }
    vec = { ...vec, angle, direction: undefined };
    // A resultant the model computed itself is never drawn as given — it is recomputed below.
    if (RESULTANT_LABEL.test(vec.label) && v.vectors.length > 1) {
      stated = { label: vec.label, magnitude: vec.magnitude, angle };
      continue;
    }
    vectors.push(vec);
  }
  if (!vectors.length) { critical.push("no drawable vectors (each needs a magnitude and a direction or angle)"); return spec; }
  if (v.mode === "addition" && vectors.length < 2) issues.push("vector addition needs at least 2 vectors");

  let showResultant = v.showResultant;
  if (stated) {
    const sum = sumVectors(vectors.map((x) => ({ magnitude: x.magnitude, angle: x.angle! })));
    const maxMag = Math.max(...vectors.map((x) => x.magnitude));
    if (sum.magnitude < 0.01 * maxMag) sum.magnitude = 0;
    const wrongSize = Math.abs(sum.magnitude - stated.magnitude) > Math.max(0.02 * sum.magnitude, 0.01 * maxMag);
    issues.push(
      wrongSize
        ? `stated "${stated.label}" of ${fmt(stated.magnitude)} contradicts the vectors → replaced by the computed resultant ${fmt(round(sum.magnitude))}`
        : `"${stated.label}" is drawn from the computed sum of the other vectors`
    );
    showResultant = true;
  }
  return { ...spec, vectors: { ...v, vectors, showResultant } };
}

// ── Layout ─────────────────────────────────────────────

const LMAX = 170;
const LMIN = 28;

export function layoutVectors(spec: DiagramSpec, maxStep: number): Body {
  const v = spec.vectors!;
  if (v.mode === "addition") return layoutAddition(v, maxStep);
  if (v.mode === "components") return layoutComponents(v, maxStep);
  return layoutFreeBody(v, maxStep);
}

const roleOf = (vec: Vec, i: number): Role => vec.role ?? SERIES_ROLES[i % SERIES_ROLES.length];
const unitOf = (v: VectorsBlock) => (v.unit ? ` ${v.unit}` : "");
/** Math (y-up) → canvas (y-down). */
const C = (p: Pt): Pt => [p[0], -p[1]];

/** Label just beyond an arrow tip, aligned so it never sits on the arrow. */
function tipLabel(body: Body, id: string, label: string, tip: Pt, dir: Pt, role: Role, step: number) {
  const [x, y] = C(tip);
  const dx = dir[0], dy = -dir[1];
  const w = measureBlock(label, 16, 220).width;
  if (Math.abs(dx) > 0.35) {
    const lx = dx > 0 ? x + 10 : x - 10 - w;
    body.texts.push(text(id, label, lx, y - 10 + dy * 12, { tone: role, step }));
  } else {
    body.texts.push(text(id, label, x, dy > 0 ? y + 8 : y - 30, { align: "center", tone: role, step }));
  }
}

function layoutFreeBody(v: VectorsBlock, maxStep: number): Body {
  const body = emptyBody();
  const theta = v.incline ?? 0;
  const hw = 52, hh = 34;
  const rot = (p: Pt): Pt => [p[0] * Math.cos(rad(theta)) - p[1] * Math.sin(rad(theta)), p[0] * Math.sin(rad(theta)) + p[1] * Math.cos(rad(theta))];
  const corners = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(rot);

  // Surface: an incline (ramp triangle with its angle marked) or flat ground under the object.
  const onSurface = v.incline !== undefined || v.vectors.some((x) => x.direction === "normal");
  if (onSurface) {
    const dir: Pt = [Math.cos(rad(theta)), Math.sin(rad(theta))];
    const base = rot([0, -hh]);
    const a: Pt = [base[0] - dir[0] * 230, base[1] - dir[1] * 230];
    const b: Pt = [base[0] + dir[0] * 170, base[1] + dir[1] * 170];
    if (theta > 0.5) {
      const c: Pt = [b[0], a[1]];
      body.paths.push({ id: "x-ramp", points: [a, b, c, a].map(C), closed: true, role: "muted", fill: "muted", strokeWidth: 2, step: 1 });
      const arc: Pt[] = [];
      for (let k = 0; k <= 10; k++) arc.push(C([a[0] + 46 * Math.cos(rad((theta * k) / 10)), a[1] + 46 * Math.sin(rad((theta * k) / 10))]));
      body.paths.push({ id: "x-rampang", points: arc, smooth: true, role: "warning", strokeWidth: 2, step: 1 });
      const mid = rad(theta / 2);
      body.texts.push(text("x-rampangl", `${fmt(theta)}°`, a[0] + 64 * Math.cos(mid), -(a[1] + 64 * Math.sin(mid)) - 10, { tone: "warning", step: 1, fontSize: 15 }));
    } else {
      body.paths.push({ id: "x-ground", points: [C(a), C(b)], role: "muted", strokeWidth: 3, step: 1 });
    }
  }

  body.paths.push({ id: "x-object", points: [...corners, corners[0]].map(C), closed: true, role: "primary", fill: "primary", strokeWidth: 2, step: 1 });
  if (v.object) {
    const label = measureBlock(v.object, 15, 2 * hw - 12);
    body.texts.push(text("x-objectl", label.text, 0, -label.height / 2, { align: "center", fontSize: 15, tone: "body", w: 2 * hw - 12 }));
  }

  const maxMag = Math.max(...v.vectors.map((x) => x.magnitude), 1e-9);
  const unit = unitOf(v);
  const usedAngles: number[] = [];
  v.vectors.forEach((vec, i) => {
    const angle = vec.angle!;
    const s = clampStep(vec.step, maxStep);
    const role = roleOf(vec, i);
    const d: Pt = [Math.cos(rad(angle)), Math.sin(rad(angle))];
    // Start on the object's outline in this direction (d expressed in the object's rotated frame).
    const lx = d[0] * Math.cos(rad(-theta)) - d[1] * Math.sin(rad(-theta));
    const ly = d[0] * Math.sin(rad(-theta)) + d[1] * Math.cos(rad(-theta));
    const t = Math.min(Math.abs(lx) > 1e-9 ? hw / Math.abs(lx) : Infinity, Math.abs(ly) > 1e-9 ? hh / Math.abs(ly) : Infinity);
    // Parallel forces are offset sideways so they don't hide each other.
    const same = usedAngles.filter((a) => Math.abs(norm(a - angle)) < 1).length;
    usedAngles.push(angle);
    const off: Pt = [-d[1] * 16 * same, d[0] * 16 * same];
    const start: Pt = [d[0] * t + off[0], d[1] * t + off[1]];
    const len = vec.magnitude === 0 ? 0 : Math.max(LMIN, (vec.magnitude / maxMag) * LMAX);
    const tip: Pt = [start[0] + d[0] * len, start[1] + d[1] * len];
    body.paths.push({ id: `x-vec${i}`, points: [C(start), C(tip)], role, strokeWidth: 3, arrowEnd: true, step: s });
    tipLabel(body, `x-vecl${i}`, `${vec.label} = ${fmt(round(vec.magnitude))}${unit}`, tip, d, role, s);
  });

  // Net force — always computed, never taken from the model.
  const sum = sumVectors(v.vectors.map((x) => ({ magnitude: x.magnitude, angle: x.angle! })));
  // Given magnitudes are usually rounded (17.32 for 20·cos 30°), so a residue under 1% counts as balanced.
  const balanced = sum.magnitude < 0.01 * maxMag;
  const finalStep = maxStep;
  if (!balanced && v.showResultant) {
    const d: Pt = [Math.cos(rad(sum.angle)), Math.sin(rad(sum.angle))];
    const len = Math.max(LMIN, (sum.magnitude / maxMag) * LMAX);
    const start: Pt = [d[0] * 8, d[1] * 8];
    const tip: Pt = [start[0] + d[0] * len, start[1] + d[1] * len];
    body.paths.push({ id: "x-net", points: [C(start), C(tip)], role: "warning", strokeWidth: 3, dashed: true, arrowEnd: true, step: finalStep });
    tipLabel(body, "x-netl", `Net = ${fmt(round(sum.magnitude))}${unit}`, tip, d, "warning", finalStep);
  }
  const summary = balanced
    ? "Net force = 0 → the forces balance (equilibrium)"
    : `Net force = ${fmt(round(sum.magnitude))}${unit} ${describeDirection(sum.angle, v.incline)}`;
  const bottom = Math.max(...body.paths.flatMap((p) => p.points.map((q) => q[1])), hh) + 44;
  body.texts.push(text("x-netsum", summary, 0, bottom, { align: "center", tone: balanced ? "success" : "warning", step: finalStep, fontSize: 17, w: 480 }));
  return body;
}

function layoutAddition(v: VectorsBlock, maxStep: number): Body {
  const body = emptyBody();
  const unit = unitOf(v);
  // Raw head-to-tail positions, then one uniform scale (true proportions).
  const tips: Pt[] = [[0, 0]];
  for (const vec of v.vectors) {
    const p = tips[tips.length - 1];
    tips.push([p[0] + vec.magnitude * Math.cos(rad(vec.angle!)), p[1] + vec.magnitude * Math.sin(rad(vec.angle!))]);
  }
  const xs = tips.map((p) => p[0]), ys = tips.map((p) => p[1]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9);
  const k = 320 / extent;
  const P = (p: Pt): Pt => C([p[0] * k, p[1] * k]);

  const pts = tips.map(P);
  const centre: Pt = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  /** Unit normal of segment a→b pointing away from the figure's centre. */
  const outward = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l;
    if ((((a[0] + b[0]) / 2 - centre[0]) * nx + ((a[1] + b[1]) / 2 - centre[1]) * ny) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  body.paths.push({ id: "x-origin", points: [[-10, 0], [10, 0]], role: "muted", strokeWidth: 1.5, step: 1 });
  body.paths.push({ id: "x-origin2", points: [[0, -10], [0, 10]], role: "muted", strokeWidth: 1.5, step: 1 });
  v.vectors.forEach((vec, i) => {
    const s = clampStep(vec.step, maxStep);
    const role = roleOf(vec, i);
    const a = P(tips[i]), b = P(tips[i + 1]);
    body.paths.push({ id: `x-vec${i}`, points: [a, b], role, strokeWidth: 3, arrowEnd: true, step: s });
    const [nx, ny] = outward(a, b);
    const label = `${vec.label} = ${fmt(round(vec.magnitude))}${unit}`;
    const w = measureBlock(label, 16, 220).width;
    const mx = (a[0] + b[0]) / 2 + nx * 18, my = (a[1] + b[1]) / 2 + ny * 18;
    body.texts.push(text(`x-vecl${i}`, label, nx < -0.3 ? mx - w : nx > 0.3 ? mx : mx - w / 2, my - 10, { tone: role, step: s }));
  });
  const sum = sumVectors(v.vectors.map((x) => ({ magnitude: x.magnitude, angle: x.angle! })));
  const end = P(tips[tips.length - 1]);
  if (sum.magnitude > 1e-9) {
    body.paths.push({ id: "x-net", points: [[0, 0], end], role: "warning", strokeWidth: 3, dashed: true, arrowEnd: true, step: maxStep });
    const label = `Resultant = ${fmt(round(sum.magnitude))}${unit}, ${describeDirection(sum.angle)}`;
    // The resultant is the chain's closing side: its label goes on the side away from the other vectors.
    const [ox, oy] = outward([0, 0], end);
    const nx = ox, ny = oy;
    const w = measureBlock(label, 16, 260).width;
    const mx = end[0] / 2 + nx * 22, my = end[1] / 2 + ny * 22;
    body.texts.push(text("x-netl", label, nx < -0.3 ? mx - w : nx > 0.3 ? mx : mx - w / 2, my - 10, { tone: "warning", step: maxStep, w: 260 }));
  } else {
    body.texts.push(text("x-netl", "Resultant = 0 (the vectors cancel)", 0, 24, { align: "center", tone: "success", step: maxStep }));
  }
  return body;
}

function layoutComponents(v: VectorsBlock, maxStep: number): Body {
  const body = emptyBody();
  const unit = unitOf(v);
  const vectors = v.vectors.slice(0, 2);
  const maxMag = Math.max(...vectors.map((x) => x.magnitude), 1e-9);
  const k = 260 / maxMag;
  // Axes through the origin, extending just past the vectors in each direction.
  const tipsXY = vectors.map((x) => [x.magnitude * Math.cos(rad(x.angle!)) * k, x.magnitude * Math.sin(rad(x.angle!)) * k]);
  const xl = Math.min(0, ...tipsXY.map((t) => t[0])) - 50, xr = Math.max(0, ...tipsXY.map((t) => t[0])) + 60;
  const yd = Math.min(0, ...tipsXY.map((t) => t[1])) - 50, yu = Math.max(0, ...tipsXY.map((t) => t[1])) + 60;
  body.paths.push({ id: "x-ax", points: [[xl, 0], [xr, 0]], role: "ink", strokeWidth: 1.5, arrowEnd: true, step: 1 });
  body.paths.push({ id: "x-ay", points: [[0, -yd], [0, -yu]], role: "ink", strokeWidth: 1.5, arrowEnd: true, step: 1 });
  body.texts.push(text("x-axl", "x", xr + 8, -10, { tone: "muted" }));
  body.texts.push(text("x-ayl", "y", 8, -yu - 20, { tone: "muted" }));
  vectors.forEach((vec, i) => {
    const s = clampStep(vec.step, maxStep);
    const role = roleOf(vec, i);
    const a = vec.angle!;
    const fx = vec.magnitude * Math.cos(rad(a)), fy = vec.magnitude * Math.sin(rad(a));
    const tip: Pt = [fx * k, fy * k];
    body.paths.push({ id: `x-vec${i}`, points: [[0, 0], C(tip)], role, strokeWidth: 3, arrowEnd: true, step: s });
    tipLabel(body, `x-vecl${i}`, `${vec.label} = ${fmt(round(vec.magnitude))}${unit}`, tip, [Math.cos(rad(a)), Math.sin(rad(a))], role, s);
    const cs = Math.min(maxStep, s + 1);
    if (Math.abs(fx) > 1e-9 && Math.abs(fy) > 1e-9) {
      body.paths.push({ id: `x-vx${i}`, points: [[0, 0], C([tip[0], 0])], role, strokeWidth: 2, dashed: true, arrowEnd: true, step: cs });
      body.paths.push({ id: `x-vy${i}`, points: [C([tip[0], 0]), C(tip)], role, strokeWidth: 2, dashed: true, arrowEnd: true, step: cs });
      const xl = `${vec.label}ₓ = ${fmt(round(fx))}${unit}`;
      const yl = `${vec.label}ᵧ = ${fmt(round(fy))}${unit}`;
      body.texts.push(text(`x-vxl${i}`, xl, tip[0] / 2, fy >= 0 ? 8 : -30, { align: "center", tone: role, step: cs, fontSize: 15 }));
      const yw = measureBlock(yl, 15, 220).width;
      body.texts.push(text(`x-vyl${i}`, yl, fx >= 0 ? tip[0] + 10 : tip[0] - 10 - yw, -tip[1] / 2 - 10, { tone: role, step: cs, fontSize: 15 }));
    }
    // Angle arc from the +x axis.
    const arc: Pt[] = [];
    const sweep = a > 180 ? a - 360 : a;
    for (let j = 0; j <= 12; j++) arc.push(C([44 * Math.cos(rad((sweep * j) / 12)), 44 * Math.sin(rad((sweep * j) / 12))]));
    body.paths.push({ id: `x-vang${i}`, points: arc, smooth: true, role: "warning", strokeWidth: 2, step: s });
    const mid = rad(sweep / 2);
    body.texts.push(text(`x-vangl${i}`, `${fmt(round(Math.abs(sweep), 1))}°`, 66 * Math.cos(mid), -66 * Math.sin(mid) - 10, { align: "center", tone: "warning", step: s, fontSize: 15 }));
  });
  return body;
}
