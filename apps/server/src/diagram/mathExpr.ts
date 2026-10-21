// ─────────────────────────────────────────────────────────
// Safe math-expression engine for plots.
//
// Model output like "y = 2x^2 - 3sin(x)" is parsed into an AST
// by a small recursive-descent parser and evaluated
// numerically.  Nothing is ever passed to eval/Function, and
// only whitelisted functions/constants are accepted, so an
// expression can never execute code.
// ─────────────────────────────────────────────────────────

type Node =
  | { k: "num"; v: number }
  | { k: "var" }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { k: "call"; fn: string; a: Node };

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, "π": Math.PI, e: Math.E };
// Own-property checks only: `"constructor" in {}` is true via the prototype chain.
const isFn = (name: string) => Object.prototype.hasOwnProperty.call(FUNCTIONS, name);
const isConst = (name: string) => Object.prototype.hasOwnProperty.call(CONSTANTS, name);

export class ExprError extends Error {}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const s = src
    .replace(/\*\*/g, "^")
    .replace(/[·×]/g, "*")
    .replace(/[−–]/g, "-")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/\\left|\\right|\\cdot/g, (m) => (m === "\\cdot" ? "*" : ""))
    .replace(/\\(sin|cos|tan|ln|log|sqrt|exp|pi)/g, "$1")
    .replace(/[{]/g, "(")
    .replace(/[}]/g, ")");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^([a-zA-Zπ][a-zA-Z0-9]*)/.exec(s.slice(i));
    if (id) { out.push({ t: "id", v: id[1].toLowerCase() }); i += id[1].length; continue; }
    if ("+-*/^()".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new ExprError(`unexpected character "${c}"`);
  }
  return out;
}

/** Implicit multiplication: 2x, 2(x), x(x+1), )(, 2sin(x), x pi */
function withImplicitMultiplication(out: Tok[]): Tok[] {
  const res: Tok[] = [];
  for (const tok of out) {
    const prev = res[res.length - 1];
    const prevEndsValue = prev && (prev.t === "num" || (prev.t === "id" && !isFn(prev.v)) || (prev.t === "op" && prev.v === ")"));
    const startsValue = tok.t === "num" || tok.t === "id" || (tok.t === "op" && tok.v === "(");
    if (prevEndsValue && startsValue) res.push({ t: "op", v: "*" });
    res.push(tok);
  }
  return res;
}

/** Split identifiers like "xsin" or "2pix" that the tokenizer glued together. */
function splitIdentifiers(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const tok of tokens) {
    if (tok.t !== "id" || isFn(tok.v) || isConst(tok.v) || tok.v === "x") {
      out.push(tok);
      continue;
    }
    // Greedy split into known names (x, constants, functions).
    let rest = tok.v;
    const parts: Tok[] = [];
    while (rest.length) {
      const name = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), "x"]
        .sort((a, b) => b.length - a.length)
        .find((n) => rest.startsWith(n));
      if (!name) throw new ExprError(`unknown name "${tok.v}"`);
      parts.push({ t: "id", v: name });
      rest = rest.slice(name.length);
    }
    out.push(...parts);
  }
  return out;
}

export function parseExpression(source: string): Node {
  // Accept "y = …", "f(x) = …".
  const rhs = source.includes("=") ? source.slice(source.lastIndexOf("=") + 1) : source;
  if (rhs.length > 200) throw new ExprError("expression too long");
  const toks = withImplicitMultiplication(splitIdentifiers(lex(rhs)));
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (v?: string) => {
    const t = toks[pos];
    if (!t || (v && !(t.t === "op" && t.v === v))) throw new ExprError(`expected "${v ?? "value"}"`);
    pos++;
    return t;
  };

  // expr := term (('+'|'-') term)*
  const expr = (): Node => {
    let node = term();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = eat().v as "+" | "-";
      node = { k: "bin", op, a: node, b: term() };
    }
    return node;
  };
  // term := unary (('*'|'/') unary)*
  const term = (): Node => {
    let node = unary();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = eat().v as "*" | "/";
      node = { k: "bin", op, a: node, b: unary() };
    }
    return node;
  };
  // unary := '-' unary | power
  const unary = (): Node => {
    if (peek()?.t === "op" && peek()!.v === "-") { eat(); return { k: "neg", a: unary() }; }
    if (peek()?.t === "op" && peek()!.v === "+") { eat(); return unary(); }
    return power();
  };
  // power := atom ('^' unary)?   (right-associative)
  const power = (): Node => {
    const base = atom();
    if (peek()?.t === "op" && peek()!.v === "^") { eat(); return { k: "bin", op: "^", a: base, b: unary() }; }
    return base;
  };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new ExprError("unexpected end of expression");
    if (t.t === "num") { pos++; return { k: "num", v: t.v }; }
    if (t.t === "op" && t.v === "(") { eat("("); const n = expr(); eat(")"); return n; }
    if (t.t === "id") {
      pos++;
      if (t.v === "x") return { k: "var" };
      if (isConst(t.v)) return { k: "num", v: CONSTANTS[t.v] };
      if (isFn(t.v)) {
        if (peek()?.t === "op" && peek()!.v === "(") { eat("("); const a = expr(); eat(")"); return { k: "call", fn: t.v, a }; }
        return { k: "call", fn: t.v, a: power() }; // sin x
      }
      throw new ExprError(`unknown name "${t.v}"`);
    }
    throw new ExprError(`unexpected "${t.v}"`);
  };

  const tree = expr();
  if (pos !== toks.length) throw new ExprError(`unexpected "${toks[pos].v}"`);
  return tree;
}

export function evaluate(node: Node, x: number): number {
  switch (node.k) {
    case "num": return node.v;
    case "var": return x;
    case "neg": return -evaluate(node.a, x);
    case "call": return FUNCTIONS[node.fn](evaluate(node.a, x));
    case "bin": {
      const a = evaluate(node.a, x);
      const b = evaluate(node.b, x);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
      }
    }
  }
}

/** Compile an expression to a function, or throw ExprError with a helpful message. */
export function compileExpression(source: string): (x: number) => number {
  const tree = parseExpression(source);
  return (x: number) => evaluate(tree, x);
}

/**
 * Sample f over [x0, x1], splitting into separate runs at discontinuities
 * (asymptotes, undefined regions) and clipping to [y0, y1].
 */
export function sampleFunction(
  f: (x: number) => number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  samples = 240
): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  const span = y1 - y0;
  let prevY: number | undefined;
  for (let i = 0; i <= samples; i++) {
    const x = x0 + ((x1 - x0) * i) / samples;
    const y = f(x);
    const valid = Number.isFinite(y) && y >= y0 - span * 0.05 && y <= y1 + span * 0.05;
    const jump = prevY !== undefined && Number.isFinite(y) && Math.abs(y - prevY) > span * 0.5;
    if (!valid || jump) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
    if (valid) run.push([x, Math.min(y1, Math.max(y0, y))]);
    prevY = Number.isFinite(y) ? y : undefined;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** Real intersections of f and g on [x0, x1] by sign changes + bisection. */
export function intersections(f: (x: number) => number, g: (x: number) => number, x0: number, x1: number): number[] {
  const roots: number[] = [];
  const h = (x: number) => f(x) - g(x);
  const N = 400;
  let prevX = x0;
  let prev = h(x0);
  for (let i = 1; i <= N; i++) {
    const x = x0 + ((x1 - x0) * i) / N;
    const v = h(x);
    if (Number.isFinite(prev) && Number.isFinite(v)) {
      if (Math.abs(v) < 1e-12) roots.push(x);
      else if (prev * v < 0 && Math.abs(prev - v) < 1e6) {
        let a = prevX, b = x;
        for (let k = 0; k < 60; k++) {
          const m = (a + b) / 2;
          if (h(a) * h(m) <= 0) b = m; else a = m;
        }
        roots.push((a + b) / 2);
      }
    }
    prevX = x;
    prev = v;
  }
  return roots.filter((r, i) => i === 0 || Math.abs(r - roots[i - 1]) > (x1 - x0) / 1000);
}

/** "Nice" axis ticks (1, 2, 5 × 10^k) covering [min, max] with about `target` intervals. */
export function niceTicks(min: number, max: number, target = 8): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** Compact number formatting for labels (no float noise). */
export function fmt(n: number): string {
  if (Number.isInteger(n)) return n < 0 ? `−${-n}` : String(n);
  const s = Number(n.toPrecision(4)).toString();
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}
