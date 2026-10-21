// ─────────────────────────────────────────────────────────
// SVG → plain geometry.
//
// A small, defensive SVG reader for labelled reference diagrams:
// it flattens every shape (paths, rects, circles, ellipses,
// lines, polylines, polygons, <use>) into point lists in the
// root coordinate space, resolves inherited styles, transforms,
// gradients (→ their first stop colour) and <switch> language
// variants (English first), and collects <text> labels with an
// estimated bounding box.
//
// It never executes anything: scripts, external references,
// images and foreignObject are ignored, DOCTYPE entity
// declarations are refused, and sizes are capped.
// ─────────────────────────────────────────────────────────

import type { Pt } from "../diagram/layout.js";

export const MAX_SVG_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 40_000;
const MAX_SHAPES = 4_000;
const MAX_USE_DEPTH = 6;

// ── XML ────────────────────────────────────────────────

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Direct character data (concatenated). */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export class SvgError extends Error {}

/** Minimal XML parser (elements, attributes, text, CDATA). Throws SvgError on unsafe or broken input. */
export function parseXml(source: string): XNode {
  if (source.length > MAX_SVG_BYTES) throw new SvgError("SVG too large");
  if (/<!ENTITY/i.test(source)) throw new SvgError("SVG declares entities");
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([^\s>]+)\s*>|<([A-Za-z_][^\s/>]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
  const attr = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(source))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      const name = local(m[2]);
      // Close up to the matching element (tolerates small nesting slips).
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
    } else if (m[3] !== undefined) {
      if (++count > MAX_NODES) throw new SvgError("SVG has too many elements");
      const node: XNode = { name: local(m[3]), attrs: {}, children: [], text: "" };
      let a: RegExpExecArray | null;
      attr.lastIndex = 0;
      while ((a = attr.exec(m[4] ?? ""))) node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  const svg = findFirst(root, "svg");
  if (!svg) throw new SvgError("not an SVG document");
  return svg;
}
const local = (name: string) => name.slice(name.lastIndexOf(":") + 1);
function findFirst(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return undefined;
}

// ── Colours ────────────────────────────────────────────

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", gray: "#808080", grey: "#808080", silver: "#c0c0c0",
  maroon: "#800000", olive: "#808000", navy: "#000080", purple: "#800080", teal: "#008080", orange: "#ffa500", pink: "#ffc0cb",
  brown: "#a52a2a", tan: "#d2b48c", beige: "#f5f5dc", salmon: "#fa8072", gold: "#ffd700", khaki: "#f0e68c", coral: "#ff7f50",
  crimson: "#dc143c", darkred: "#8b0000", lightblue: "#add8e6", lightgreen: "#90ee90", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", dimgray: "#696969", dimgrey: "#696969", violet: "#ee82ee", indigo: "#4b0082",
  lightpink: "#ffb6c1", hotpink: "#ff69b4", peachpuff: "#ffdab9", wheat: "#f5deb3", ivory: "#fffff0", lavender: "#e6e6fa",
  skyblue: "#87ceeb", steelblue: "#4682b4", darkblue: "#00008b", darkgreen: "#006400", forestgreen: "#228b22", firebrick: "#b22222",
  sienna: "#a0522d", chocolate: "#d2691e", peru: "#cd853f", orchid: "#da70d6", plum: "#dda0dd", thistle: "#d8bfd8",
  mistyrose: "#ffe4e1", linen: "#faf0e6", snow: "#fffafa", whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", rosybrown: "#bc8f8f",
};
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** CSS colour → "#rrggbb", null for none/transparent, undefined for unparseable. */
export function parseColor(value: string | undefined, gradients: Map<string, string>, current = "#000000"): string | null | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "transparent") return null;
  if (v === "currentcolor") return current;
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(v);
  if (url) return gradients.get(url[1]) ?? null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/.exec(v);
  if (rgb) return "#" + rgb.slice(1, 4).map((c) => hex2(c.endsWith("%") ? (parseFloat(c) * 255) / 100 : parseFloat(c))).join("");
  return NAMED[v];
}

// ── Transforms ─────────────────────────────────────────

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const nums = (s: string) => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

export function parseTransform(value: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!value) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(value))) {
    const a = nums(t[2]);
    let n: Matrix = IDENTITY;
    switch (t[1]) {
      case "matrix": if (a.length === 6) n = a as Matrix; break;
      case "translate": n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case "scale": n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        n = mul(mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX": n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

// ── Path data ──────────────────────────────────────────

export interface SubPath { points: Pt[]; closed: boolean; curved: boolean }

/** Flatten SVG path data into polylines (curves sampled by length). */
export function parsePathData(d: string): SubPath[] {
  const out: SubPath[] = [];
  const tokens = d.match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = "";
  let cur: Pt = [0, 0], start: Pt = [0, 0], lastCtrl: Pt | null = null, lastQ: Pt | null = null;
  let sub: SubPath | null = null;
  const num = () => Number(tokens[i++]);
  const hasNum = () => i < tokens.length && !/^[a-z]$/i.test(tokens[i]);
  const begin = (p: Pt) => {
    if (sub && sub.points.length > 1) out.push(sub);
    sub = { points: [p], closed: false, curved: false };
  };
  const lineTo = (p: Pt) => { if (!sub) begin(cur); sub!.points.push(p); };
  const samples = (len: number) => Math.max(4, Math.min(32, Math.ceil(len / 6)));
  const cubic = (p1: Pt, p2: Pt, p3: Pt) => {
    const p0 = cur;
    const n = samples(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      lineTo([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
    sub!.curved = true;
  };
  const quad = (p1: Pt, p2: Pt) => {
    const p0 = cur;
    const n = samples(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      lineTo([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
    sub!.curved = true;
  };
  const arcTo = (rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, p: Pt) => {
    const [x1, y1] = cur, [x2, y2] = p;
    if (!rx || !ry || (x1 === x2 && y1 === y2)) return lineTo(p);
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
    const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.min(48, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 6)));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      lineTo([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
    }
    sub!.curved = true;
  };

  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const R = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === "Z") {
      const open = sub as SubPath | null; // assigned inside closures, so TS can't narrow `sub`
      if (open) { open.closed = true; if (open.points.length > 1) out.push(open); sub = null; }
      cur = start;
      lastCtrl = lastQ = null;
      continue;
    }
    if (!hasNum()) { i++; continue; } // malformed: skip a stray token
    switch (C) {
      case "M": {
        cur = R(num(), num()); start = cur; begin(cur);
        cmd = rel ? "l" : "L"; // further pairs are line-tos
        lastCtrl = lastQ = null;
        break;
      }
      case "L": { const p = R(num(), num()); lineTo(p); cur = p; lastCtrl = lastQ = null; break; }
      case "H": { const x = num(); const p: Pt = [rel ? cur[0] + x : x, cur[1]]; lineTo(p); cur = p; lastCtrl = lastQ = null; break; }
      case "V": { const y = num(); const p: Pt = [cur[0], rel ? cur[1] + y : y]; lineTo(p); cur = p; lastCtrl = lastQ = null; break; }
      case "C": {
        const p1 = R(num(), num()), p2 = R(num(), num()), p3 = R(num(), num());
        cubic(p1, p2, p3); cur = p3; lastCtrl = p2; lastQ = null; break;
      }
      case "S": {
        const p1: Pt = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const p2 = R(num(), num()), p3 = R(num(), num());
        cubic(p1, p2, p3); cur = p3; lastCtrl = p2; lastQ = null; break;
      }
      case "Q": { const p1 = R(num(), num()), p2 = R(num(), num()); quad(p1, p2); cur = p2; lastQ = p1; lastCtrl = null; break; }
      case "T": {
        const p1: Pt = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p2 = R(num(), num()); quad(p1, p2); cur = p2; lastQ = p1; lastCtrl = null; break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num();
        // Flags may be written without separators ("a5 5 0 011 1"): read single digits.
        const flag = () => { const t = tokens[i]; if (t.length > 1 && /^[01]/.test(t)) { tokens[i] = t.slice(1); return t[0] === "1"; } i++; return t === "1"; };
        const large = flag(), sweep = flag();
        const p = R(num(), num());
        arcTo(rx, ry, rot, large, sweep, p); cur = p; lastCtrl = lastQ = null; break;
      }
      default: i++;
    }
    if (out.length > MAX_SHAPES) break;
  }
  const last = sub as SubPath | null;
  if (last && last.points.length > 1) out.push(last);
  return out.filter((s) => s.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
}

// ── Document walk ──────────────────────────────────────

export interface SvgShape {
  points: Pt[];
  closed: boolean;
  curved: boolean;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** 0–1, element opacity × fill/stroke opacity. */
  opacity: number;
  markerStart: boolean;
  markerEnd: boolean;
  /** Index of the source element (subpaths of one element share it). */
  element: number;
}

export interface SvgText {
  lines: string[];
  /** Estimated bounding box in root coordinates. */
  box: { x: number; y: number; w: number; h: number };
  fontSize: number;
}

export interface SvgDoc {
  title?: string;
  shapes: SvgShape[];
  texts: SvgText[];
}

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  opacity: number;
  fontSize: number;
  textAnchor: string;
  color: string;
  markerStart: boolean;
  markerEnd: boolean;
}

const SKIP = new Set(["defs", "symbol", "marker", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "title", "desc",
  "metadata", "style", "script", "foreignObject", "image", "filter", "namedview", "font", "font-face", "cursor", "view", "animate", "set"]);

function parseCss(css: string): Array<{ selector: string; decls: Record<string, string> }> {
  const rules: Array<{ selector: string; decls: Record<string, string> }> = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, "")))) {
    const decls = declarations(m[2]);
    for (const sel of m[1].split(",")) rules.push({ selector: sel.trim(), decls });
  }
  return rules;
}
function declarations(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const k = part.indexOf(":");
    if (k > 0) out[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).replace(/!important/, "").trim();
  }
  return out;
}

function langMatches(node: XNode): boolean {
  const langs = node.attrs.systemLanguage;
  if (langs === undefined) return true;
  return langs.split(",").some((l) => /^en(\b|-|_)/i.test(l.trim()));
}

/** Parse an SVG document into flattened shapes and text labels (root coordinates). */
export function readSvg(source: string): SvgDoc {
  const svg = parseXml(source);

  // Gradients → their first stop colour (follows xlink:href chains).
  const byId = new Map<string, XNode>();
  const index = (n: XNode) => { if (n.attrs.id) byId.set(n.attrs.id, n); n.children.forEach(index); };
  index(svg);
  const gradients = new Map<string, string>();
  const stopColor = (g: XNode, depth = 0): string | undefined => {
    const stop = g.children.find((c) => c.name === "stop");
    if (stop) {
      const st = { ...stop.attrs, ...declarations(stop.attrs.style ?? "") };
      const c = parseColor(st["stop-color"] ?? "black", new Map());
      return c ?? undefined;
    }
    const href = (g.attrs["xlink:href"] ?? g.attrs.href ?? "").replace(/^#/, "");
    const next = href ? byId.get(href) : undefined;
    return next && depth < 5 ? stopColor(next, depth + 1) : undefined;
  };
  for (const [id, n] of byId) if (n.name === "linearGradient" || n.name === "radialGradient") {
    const c = stopColor(n);
    if (c) gradients.set(id, c);
  }

  // Simple CSS: .class, #id and element selectors.
  const css = parseCss(collect(svg, "style").map((s) => s.text).join("\n"));
  const cssFor = (n: XNode): Record<string, string> => {
    const out: Record<string, string> = {};
    const classes = (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
    for (const r of css) {
      const s = r.selector;
      if (s === n.name || (s.startsWith(".") && classes.includes(s.slice(1))) || (s.startsWith("#") && s.slice(1) === n.attrs.id)) Object.assign(out, r.decls);
    }
    return out;
  };

  const shapes: SvgShape[] = [];
  const texts: SvgText[] = [];
  let element = 0;

  const styleOf = (n: XNode, parent: Style): Style => {
    const a = { ...n.attrs, ...cssFor(n), ...declarations(n.attrs.style ?? "") };
    const num = (v: string | undefined, d: number) => { const x = parseFloat(v ?? ""); return Number.isFinite(x) ? x : d; };
    const marker = (v: string | undefined, inherited: boolean) => (v === undefined ? inherited : /url\(/.test(v));
    return {
      fill: a.fill ?? parent.fill,
      stroke: a.stroke ?? parent.stroke,
      strokeWidth: num(a["stroke-width"], parent.strokeWidth),
      fillOpacity: num(a["fill-opacity"], parent.fillOpacity),
      strokeOpacity: num(a["stroke-opacity"], parent.strokeOpacity),
      opacity: parent.opacity * num(a.opacity, 1),
      fontSize: num(a["font-size"], parent.fontSize),
      textAnchor: a["text-anchor"] ?? parent.textAnchor,
      color: a.color ?? parent.color,
      markerStart: marker(a["marker-start"] ?? a.marker, parent.markerStart),
      markerEnd: marker(a["marker-end"] ?? a.marker, parent.markerEnd),
    };
  };
  const hidden = (n: XNode) => {
    const a = { ...n.attrs, ...declarations(n.attrs.style ?? "") };
    return a.display === "none" || a.visibility === "hidden";
  };

  const addShape = (subs: SubPath[], m: Matrix, st: Style, forceOpen = false) => {
    if (shapes.length > MAX_SHAPES) return;
    const color = parseColor(st.color, gradients) ?? "#000000";
    const fill = forceOpen ? null : parseColor(st.fill, gradients, color);
    const stroke = parseColor(st.stroke, gradients, color) ?? null;
    const fillC = fill === undefined ? null : fill;
    const strokeC = stroke === undefined ? null : stroke;
    if (fillC === null && strokeC === null) { element++; return; }
    for (const s of subs) {
      shapes.push({
        points: s.points.map((p) => apply(m, p)),
        closed: s.closed,
        curved: s.curved,
        fill: fillC,
        stroke: strokeC,
        strokeWidth: st.strokeWidth * scaleOf(m),
        opacity: st.opacity * (fillC ? st.fillOpacity : st.strokeOpacity),
        markerStart: st.markerStart,
        markerEnd: st.markerEnd,
        element,
      });
    }
    element++;
  };

  const ellipsePts = (cx: number, cy: number, rx: number, ry: number): Pt[] => {
    const n = Math.max(16, Math.min(64, Math.ceil(((rx + ry) * Math.PI) / 6)));
    const pts: Pt[] = [];
    for (let k = 0; k <= n; k++) pts.push([cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)]);
    return pts;
  };

  const textOf = (n: XNode, m: Matrix, st: Style) => {
    const f = (v: string | undefined) => nums(v ?? "")[0];
    const lines: Array<{ text: string; x: number; y: number }> = [];
    let x = f(n.attrs.x) ?? 0, y = f(n.attrs.y) ?? 0;
    if (n.attrs.dx) x += f(n.attrs.dx) ?? 0;
    if (n.attrs.dy) y += f(n.attrs.dy) ?? 0;
    let line = { text: n.text, x, y };
    lines.push(line);
    for (const c of n.children) {
      if (c.name !== "tspan" || hidden(c) || !langMatches(c)) continue;
      const tx = f(c.attrs.x), ty = f(c.attrs.y), dy = f(c.attrs.dy), dx = f(c.attrs.dx);
      if (tx !== undefined || ty !== undefined || (dy !== undefined && dy !== 0)) {
        x = tx ?? x; y = (ty ?? y) + (dy ?? 0);
        line = { text: "", x: x + (dx ?? 0), y };
        lines.push(line);
      }
      line.text += (line.text ? " " : "") + [c.text, ...c.children.map((g) => g.text)].join("");
    }
    const kept = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
    if (!kept.length) return;
    const fs = st.fontSize * scaleOf(m);
    const boxes = kept.map((l) => {
      const w = l.text.length * st.fontSize * 0.56;
      const left = st.textAnchor === "middle" ? l.x - w / 2 : st.textAnchor === "end" ? l.x - w : l.x;
      const corners = [apply(m, [left, l.y - st.fontSize * 0.8]), apply(m, [left + w, l.y + st.fontSize * 0.2])];
      return corners;
    });
    const xs = boxes.flat().map((p) => p[0]), ys = boxes.flat().map((p) => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    texts.push({ lines: kept.map((l) => l.text), box, fontSize: fs });
  };

  const walk = (n: XNode, m: Matrix, parent: Style, depth: number) => {
    if (SKIP.has(n.name) || hidden(n) || !langMatches(n)) return;
    const st = styleOf(n, parent);
    const mm = mul(m, parseTransform(n.attrs.transform));
    const a = n.attrs;
    const f = (k: string, d = 0) => { const v = parseFloat(a[k] ?? ""); return Number.isFinite(v) ? v : d; };
    switch (n.name) {
      case "svg":
      case "g":
      case "a": {
        const inner = n.name === "svg" && depth > 0 ? mul(mm, [1, 0, 0, 1, f("x"), f("y")]) : mm;
        for (const c of n.children) walk(c, inner, st, depth + 1);
        return;
      }
      case "switch": {
        // SVG semantics: render the first child whose conditions match (English, or no language).
        const pick = n.children.find((c) => !SKIP.has(c.name) && langMatches(c));
        if (pick) walk(pick, mm, st, depth + 1);
        return;
      }
      case "use": {
        if (depth > 40) return;
        const href = (a["xlink:href"] ?? a.href ?? "").replace(/^#/, "");
        const target = byId.get(href);
        const useDepth = (parent as Style & { useDepth?: number }).useDepth ?? 0;
        if (!target || useDepth >= MAX_USE_DEPTH) return;
        const inner = mul(mm, [1, 0, 0, 1, f("x"), f("y")]);
        const next = Object.assign({ ...st }, { useDepth: useDepth + 1 });
        if (target.name === "symbol") for (const c of target.children) walk(c, inner, next, depth + 1);
        else walk(target, inner, next, depth + 1);
        return;
      }
      case "path": if (a.d) addShape(parsePathData(a.d), mm, st); return;
      case "rect": {
        const [x, y, w, h] = [f("x"), f("y"), f("width"), f("height")];
        if (w > 0 && h > 0) addShape([{ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], closed: true, curved: false }], mm, st);
        return;
      }
      case "circle": { const r = f("r"); if (r > 0) addShape([{ points: ellipsePts(f("cx"), f("cy"), r, r), closed: true, curved: true }], mm, st); return; }
      case "ellipse": {
        const [rx, ry] = [f("rx"), f("ry")];
        if (rx > 0 && ry > 0) addShape([{ points: ellipsePts(f("cx"), f("cy"), rx, ry), closed: true, curved: true }], mm, st);
        return;
      }
      case "line": addShape([{ points: [[f("x1"), f("y1")], [f("x2"), f("y2")]], closed: false, curved: false }], mm, st, true); return;
      case "polyline":
      case "polygon": {
        const v = nums(a.points ?? "");
        const pts: Pt[] = [];
        for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
        if (n.name === "polygon" && pts.length) pts.push(pts[0]);
        if (pts.length > 1) addShape([{ points: pts, closed: n.name === "polygon", curved: false }], mm, st);
        return;
      }
      case "text": textOf(n, mm, st); return;
      default: return;
    }
  };

  const rootStyle: Style = {
    fill: "black", stroke: "none", strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1, opacity: 1,
    fontSize: 16, textAnchor: "start", color: "black", markerStart: false, markerEnd: false,
  };
  // The root's own presentation attributes (font-size etc.) apply to everything below.
  const st = styleOf(svg, rootStyle);
  for (const c of svg.children) walk(c, IDENTITY, st, 1);
  const title = svg.children.find((c) => c.name === "title")?.text.trim() || undefined;
  return { title, shapes, texts };
}

function collect(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    collect(c, name, out);
  }
  return out;
}
