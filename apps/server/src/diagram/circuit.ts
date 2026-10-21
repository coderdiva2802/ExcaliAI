// ─────────────────────────────────────────────────────────
// Electric circuits.
//
// The model describes the circuit's STRUCTURE (components in
// order around the loop, parallel branches) plus source voltage
// and resistances.  Code draws standard symbols on a clean
// rectangular loop and — when asked — computes total resistance,
// the current, and every component's voltage and current with
// Ohm's law and the series/parallel rules.  Meter readings are
// always computed, never taken from the model.
// ─────────────────────────────────────────────────────────

import type { CircuitItem, CircuitParallel, CircuitPart, DiagramSpec } from "./spec.js";
import { emptyBody, type Body, type Pt } from "./layout.js";
import { fmt } from "./mathExpr.js";
import { measureBlock } from "./textMetrics.js";
import { circlePath, clampStep, text } from "./layoutQuant.js";

type CircuitBlock = NonNullable<DiagramSpec["circuit"]>;
const isParallel = (i: CircuitItem): i is CircuitParallel => "parallel" in i;

// ── Electrical model ───────────────────────────────────

/** Resistance in ohms; undefined = unknown or non-ohmic (diode, motor…). */
export function resistanceOf(p: CircuitPart): number | undefined {
  switch (p.type) {
    case "resistor":
    case "bulb": return p.value;
    case "switch": return p.open ? Infinity : 0;
    case "ammeter":
    case "fuse": return 0;
    case "voltmeter":
    case "capacitor": return Infinity; // ideal voltmeter; capacitor in steady-state DC
    default: return undefined;
  }
}

export function seriesResistance(items: CircuitItem[]): number | undefined {
  let total = 0;
  for (const it of items) {
    const r = isParallel(it) ? parallelResistance(it.parallel) : resistanceOf(it);
    if (r === undefined) return undefined;
    total += r;
  }
  return total;
}

export function parallelResistance(branches: CircuitItem[][]): number | undefined {
  let g = 0;
  for (const b of branches) {
    const r = seriesResistance(b);
    if (r === undefined) return undefined;
    g += r === 0 ? Infinity : r === Infinity ? 0 : 1 / r;
  }
  return g === Infinity ? 0 : g === 0 ? Infinity : 1 / g;
}

export interface Reading { current?: number; voltage?: number }

function solveSeries(items: CircuitItem[], V: number, I: number, out: Map<CircuitPart, Reading>): void {
  const rs = items.map((it) => (isParallel(it) ? parallelResistance(it.parallel)! : resistanceOf(it)!));
  const open = rs.filter((r) => r === Infinity).length;
  items.forEach((it, k) => {
    let v: number | undefined;
    if (I > 0) v = I * rs[k];
    else v = rs[k] === Infinity ? (open === 1 ? V : undefined) : 0; // open circuit: the whole voltage sits across the gap
    if (isParallel(it)) solveParallel(it.parallel, v ?? 0, out);
    else out.set(it, { current: I, voltage: v });
  });
}

function solveParallel(branches: CircuitItem[][], V: number, out: Map<CircuitPart, Reading>): void {
  for (const b of branches) {
    const r = seriesResistance(b)!;
    solveSeries(b, V, r === Infinity ? 0 : V / r, out);
  }
}

export interface CircuitSolution { total: number; current: number; readings: Map<CircuitPart, Reading> }

/** Solve the circuit, or explain why it can't be solved. */
export function solveCircuit(c: CircuitBlock): CircuitSolution | { reason: string } {
  if (c.source.type === "ac") return { reason: "values are not computed for AC circuits" };
  if (c.source.voltage === undefined) return { reason: "no source voltage was given" };
  const parts = flatten(c.items);
  const unknown = parts.find((p) => resistanceOf(p) === undefined);
  if (unknown) {
    return {
      reason: ["resistor", "bulb"].includes(unknown.type)
        ? `${unknown.label ?? unknown.type} has no resistance value`
        : `the circuit contains a ${unknown.type}, which does not obey Ohm's law`,
    };
  }
  const total = seriesResistance(c.items)!;
  if (total === 0) return { reason: "the circuit is a short circuit (zero resistance)" };
  const current = total === Infinity ? 0 : c.source.voltage / total;
  const readings = new Map<CircuitPart, Reading>();
  solveSeries(c.items, c.source.voltage, current, readings);
  return { total, current, readings };
}

export function flatten(items: CircuitItem[]): CircuitPart[] {
  return items.flatMap((it) => (isParallel(it) ? it.parallel.flatMap(flatten) : [it]));
}

function depth(items: CircuitItem[]): number {
  return Math.max(0, ...items.map((it) => (isParallel(it) ? 1 + Math.max(...it.parallel.map(depth)) : 0)));
}

// ── Validation / repair ────────────────────────────────

/** A voltmeter in series is a classic mistake: connect it across the component before it instead. */
function fixVoltmeters(items: CircuitItem[], issues: string[]): CircuitItem[] {
  const out: CircuitItem[] = [];
  for (const it of items) {
    if (isParallel(it)) {
      out.push({ parallel: it.parallel.map((b) => (b.length === 1 ? b : fixVoltmeters(b, issues))) });
      continue;
    }
    const prev = out[out.length - 1];
    if (it.type === "voltmeter" && items.length > 1 && prev && !isParallel(prev)) {
      issues.push(`voltmeter ${it.label ?? ""} was in series → connected in parallel across ${prev.label ?? prev.type}`.replace("  ", " "));
      out[out.length - 1] = { parallel: [[prev], [it]] };
      continue;
    }
    out.push(it);
  }
  return out;
}

export function validateCircuit(spec: DiagramSpec, issues: string[], critical: string[]): DiagramSpec {
  const c = spec.circuit;
  if (!c) { critical.push('kind "circuit" needs a "circuit" block'); return spec; }
  if (depth(c.items) > 2) { critical.push("parallel branches are nested too deeply (max 2 levels)"); return spec; }
  const items = fixVoltmeters(c.items, issues);
  const parts = flatten(items);
  if (parts.length > 14) critical.push(`too many components (${parts.length}); keep a circuit to ≤ 14`);
  const shorted = (list: CircuitItem[]): boolean =>
    list.some((it) => isParallel(it) && (it.parallel.some((b) => seriesResistance(b) === 0 && b.every((p) => !isParallel(p) && p.type === "ammeter")) || it.parallel.some(shorted)));
  if (shorted(items)) critical.push("an ammeter alone in a parallel branch short-circuits it — ammeters go in series");
  const next = { ...c, items };
  if (c.showCalculations) {
    const sol = solveCircuit(next);
    if ("reason" in sol) issues.push(`calculations skipped: ${sol.reason}`);
  }
  return { ...spec, circuit: next };
}

// ── Layout ─────────────────────────────────────────────

const SLOT = 104;
const PAR_PAD = 46;
const BOTTOM_GAP = 150;

function itemWidth(it: CircuitItem): number {
  return isParallel(it) ? Math.max(...it.parallel.map(seriesWidth)) + 2 * PAR_PAD : SLOT;
}
const seriesWidth = (items: CircuitItem[]) => items.reduce((s, it) => s + itemWidth(it), 0);

function seriesHeight(items: CircuitItem[], gap: number): number {
  return Math.max(0, ...items.map((it) => (isParallel(it) ? parallelOffsets(it, gap).height : 0)));
}
function parallelOffsets(p: CircuitParallel, gap: number): { offsets: number[]; height: number } {
  const offsets: number[] = [];
  let y = 0;
  p.parallel.forEach((b, k) => {
    offsets.push(y);
    y += seriesHeight(b, gap) + (k < p.parallel.length - 1 ? gap : 0);
  });
  return { offsets, height: y };
}

const ohms = (r: number) => `${fmt(Number(r.toPrecision(3)))} Ω`;
const volts = (v: number) => `${fmt(Number(v.toPrecision(3)))} V`;
const amps = (i: number) => `${fmt(Number(i.toPrecision(3)))} A`;

const DEFAULT_NAMES: Partial<Record<CircuitPart["type"], string>> = {
  bulb: "Bulb", switch: "Switch", capacitor: "Capacitor", ammeter: "Ammeter", voltmeter: "Voltmeter",
  diode: "Diode", led: "LED", fuse: "Fuse", motor: "Motor", buzzer: "Buzzer",
};

export function layoutCircuit(spec: DiagramSpec, maxStep: number): Body {
  const body = emptyBody();
  const c = spec.circuit!;
  const sol = c.showCalculations ? solveCircuit(c) : undefined;
  const solved = sol && !("reason" in sol) ? sol : undefined;
  const gap = solved ? 124 : 104;
  const wire = (id: string, pts: Pt[]) => body.paths.push({ id, points: pts, role: "ink", strokeWidth: 2, step: 1 });
  let n = 0;
  const uid = (p: string) => `${p}${n++}`;

  const drawPart = (p: CircuitPart, x: number, y: number) => {
    const s = clampStep(p.step, maxStep);
    const cx = x + SLOT / 2;
    const ink = (pts: Pt[], extra: Partial<Body["paths"][number]> = {}) =>
      body.paths.push({ id: uid("x-sym"), points: pts, role: "ink", strokeWidth: 2, step: s, ...extra });
    const leads = (half: number) => {
      ink([[x, y], [cx - half, y]]);
      ink([[cx + half, y], [x + SLOT, y]]);
    };
    const letter = (ch: string) => body.texts.push(text(uid("x-symt"), ch, cx, y - 12, { align: "center", fontSize: 18, tone: "body", step: s }));
    let top = y - 18; // top of the symbol, for the name label
    switch (p.type) {
      case "resistor":
        leads(24);
        if (c.standard === "ansi") {
          const zz: Pt[] = [[cx - 24, y]];
          for (let k = 1; k < 8; k++) zz.push([cx - 24 + k * 6, y + (k % 2 ? -9 : 9)]);
          zz.push([cx + 24, y]);
          ink(zz);
        } else {
          ink([[cx - 24, y - 9], [cx + 24, y - 9], [cx + 24, y + 9], [cx - 24, y + 9], [cx - 24, y - 9]], { closed: true });
        }
        break;
      case "bulb":
        leads(17);
        ink(circlePath(cx, y, 17, 32), { closed: true, smooth: true });
        ink([[cx - 12, y - 12], [cx + 12, y + 12]]);
        ink([[cx - 12, y + 12], [cx + 12, y - 12]]);
        break;
      case "switch":
        leads(20);
        body.paths.push({ id: uid("x-sym"), points: circlePath(cx - 20, y, 3.5, 12), closed: true, smooth: true, role: "ink", fill: "muted", strokeWidth: 2, step: s });
        body.paths.push({ id: uid("x-sym"), points: circlePath(cx + 20, y, 3.5, 12), closed: true, smooth: true, role: "ink", fill: "muted", strokeWidth: 2, step: s });
        ink([[cx - 20, y], p.open ? [cx + 15, y - 19] : [cx + 20, y]]);
        top = y - 24;
        break;
      case "capacitor":
        leads(6);
        ink([[cx - 6, y - 17], [cx - 6, y + 17]], { strokeWidth: 3 });
        ink([[cx + 6, y - 17], [cx + 6, y + 17]], { strokeWidth: 3 });
        break;
      case "ammeter":
      case "voltmeter":
      case "motor":
        leads(17);
        ink(circlePath(cx, y, 17, 32), { closed: true, smooth: true });
        letter(p.type === "ammeter" ? "A" : p.type === "voltmeter" ? "V" : "M");
        break;
      case "diode":
      case "led":
        leads(11);
        ink([[cx - 11, y - 12], [cx - 11, y + 12], [cx + 11, y], [cx - 11, y - 12]], { closed: true });
        ink([[cx + 11, y - 12], [cx + 11, y + 12]]);
        if (p.type === "led") {
          ink([[cx + 1, y - 15], [cx + 9, y - 25]], { strokeWidth: 1.5, arrowEnd: true });
          ink([[cx + 9, y - 12], [cx + 17, y - 22]], { strokeWidth: 1.5, arrowEnd: true });
          top = y - 28;
        }
        break;
      case "fuse":
        leads(22);
        ink([[cx - 22, y - 7], [cx + 22, y - 7], [cx + 22, y + 7], [cx - 22, y + 7], [cx - 22, y - 7]], { closed: true });
        ink([[cx - 22, y], [cx + 22, y]], { strokeWidth: 1.5 });
        break;
      case "buzzer": {
        leads(17);
        const arc: Pt[] = [];
        for (let k = 0; k <= 12; k++) arc.push([cx - 17 * Math.cos((Math.PI * k) / 12), y - 17 * Math.sin((Math.PI * k) / 12)]);
        ink([...arc, [cx - 17, y]], { closed: true, smooth: false });
        break;
      }
    }
    const reading = solved?.readings.get(p);
    const name = p.label ?? DEFAULT_NAMES[p.type];
    if (name) body.texts.push(text(uid("x-cname"), name, cx, top - 26, { align: "center", fontSize: 15, tone: "body", step: s }));
    const below: string[] = [];
    if ((p.type === "resistor" || p.type === "bulb") && p.value !== undefined) below.push(ohms(p.value));
    if (p.type === "switch") below.push(p.open ? "open" : "closed");
    if (reading) {
      if (p.type === "ammeter") below.push(`reads ${amps(reading.current ?? 0)}`);
      else if (p.type === "voltmeter") below.push(`reads ${volts(reading.voltage ?? 0)}`);
      else if (p.type === "resistor" || p.type === "bulb") below.push(`${volts(reading.voltage ?? 0)}, ${amps(reading.current ?? 0)}`);
    }
    if (below.length) body.texts.push(text(uid("x-cval"), below.join("\n"), cx, y + 22, { align: "center", fontSize: 14, tone: reading ? "accent" : "muted", step: Math.max(s, solved ? maxStep : s) }));
  };

  const drawSeries = (items: CircuitItem[], x0: number, y: number): number => {
    let x = x0;
    for (const it of items) {
      if (isParallel(it)) drawParallel(it, x, y);
      else drawPart(it, x, y);
      x += itemWidth(it);
    }
    return x;
  };

  const drawParallel = (p: CircuitParallel, x0: number, y: number) => {
    const W = itemWidth(p);
    const { offsets } = parallelOffsets(p, gap);
    const last = y + offsets[offsets.length - 1];
    wire(uid("x-wire"), [[x0, y], [x0, last]]);
    wire(uid("x-wire"), [[x0 + W, y], [x0 + W, last]]);
    p.parallel.forEach((b, k) => {
      const yk = y + offsets[k];
      const bw = seriesWidth(b);
      const start = x0 + (W - bw) / 2;
      wire(uid("x-wire"), [[x0, yk], [start, yk]]);
      drawSeries(b, start, yk);
      wire(uid("x-wire"), [[start + bw, yk], [x0 + W, yk]]);
      if (k < p.parallel.length - 1) {
        for (const jx of [x0, x0 + W]) body.paths.push({ id: uid("x-junc"), points: circlePath(jx, yk, 4, 12), closed: true, smooth: true, role: "ink", fill: "muted", strokeWidth: 2, step: 1 });
      }
    });
  };

  // Main loop: components along the top, source centred on the bottom wire.
  const inner = seriesWidth(c.items);
  const W = Math.max(300, inner + 60);
  const H = Math.max(170, seriesHeight(c.items, gap) + BOTTOM_GAP);
  const x0 = (W - inner) / 2;
  wire("x-wtop0", [[0, 0], [x0, 0]]);
  const end = drawSeries(c.items, x0, 0);
  wire("x-wtop1", [[end, 0], [W, 0]]);
  wire("x-wright", [[W, 0], [W, H]]);
  wire("x-wleft", [[0, H], [0, 0]]);

  // Source.
  const cx = W / 2;
  const half = c.source.type === "ac" ? 19 : c.source.type === "cell" ? 5 : 16;
  wire("x-wbot0", [[0, H], [cx - half, H]]);
  wire("x-wbot1", [[cx + half, H], [W, H]]);
  const plate = (x: number, long: boolean) =>
    body.paths.push({ id: uid("x-src"), points: [[x, H - (long ? 17 : 9)], [x, H + (long ? 17 : 9)]], role: "ink", strokeWidth: long ? 2 : 4.5, step: 1 });
  if (c.source.type === "ac") {
    body.paths.push({ id: "x-src-ac", points: circlePath(cx, H, 19, 32), closed: true, smooth: true, role: "ink", strokeWidth: 2, step: 1 });
    const wave: Pt[] = [];
    for (let k = 0; k <= 16; k++) wave.push([cx - 11 + (22 * k) / 16, H - 7 * Math.sin((2 * Math.PI * k) / 16)]);
    body.paths.push({ id: "x-src-wave", points: wave, smooth: true, role: "ink", strokeWidth: 2, step: 1 });
  } else if (c.source.type === "cell") {
    plate(cx - 5, true);
    plate(cx + 5, false);
  } else {
    plate(cx - 16, true);
    plate(cx - 6, false);
    plate(cx + 6, true);
    plate(cx + 16, false);
    body.paths.push({ id: "x-src-link", points: [[cx - 6, H], [cx + 6, H]], role: "ink", strokeWidth: 2, dashed: true, step: 1 });
  }
  if (c.source.type !== "ac") {
    body.texts.push(text("x-src-plus", "+", cx - half - 14, H - 34, { fontSize: 18, tone: "body" }));
    body.texts.push(text("x-src-minus", "−", cx + half + 4, H - 34, { fontSize: 18, tone: "body" }));
  }
  const srcLabel = [c.source.label, c.source.voltage !== undefined ? volts(c.source.voltage) : undefined].filter(Boolean).join(" · ");
  if (srcLabel) body.texts.push(text("x-src-l", srcLabel, cx, H + 24, { align: "center", fontSize: 15, tone: "body" }));

  // Conventional current direction (out of +, around the loop) and computed results.
  if (solved) {
    body.paths.push({ id: "x-iarrow", points: [[0, H * 0.62], [0, H * 0.38]], role: "warning", strokeWidth: 3, arrowEnd: true, step: maxStep });
    body.texts.push(text("x-iarrowl", `I = ${amps(solved.current)}`, -18 - measureBlock(`I = ${amps(solved.current)}`, 15, 200).width, H / 2 - 10, { fontSize: 15, tone: "warning", step: maxStep }));
    const V = c.source.voltage!;
    const lines = solved.current === 0
      ? ["The circuit is open, so no current flows (I = 0 A)."]
      : [
          `Total resistance R = ${ohms(solved.total)}`,
          `Current I = V ÷ R = ${volts(V)} ÷ ${ohms(solved.total)} = ${amps(solved.current)}`,
        ];
    body.texts.push(text("x-calc", lines.join("\n"), W / 2, H + 56, { align: "center", fontSize: 16, tone: "accent", step: maxStep, w: Math.max(420, W) }));
  }
  return body;
}
