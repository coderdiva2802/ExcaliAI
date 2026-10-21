// ─────────────────────────────────────────────────────────
// Arithmetic checker for worked examples and narration.
//
// LLMs make arithmetic slips ("2 + 3 = 6") that a student will
// copy. Every "numeric expression = number" in a line is
// evaluated by a small safe parser (numbers, + − × ÷ ^ mod,
// parentheses, min / max / sqrt / abs / floor / ceil, ∞) and a
// wrong result is replaced by the computed one. Anything that
// isn't purely numeric (variables, units inside expressions,
// dates, fractions written in words) is left alone.
// ─────────────────────────────────────────────────────────

const FN1: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round };
const FNN: Record<string, (...x: number[]) => number> = { min: Math.min, max: Math.max };

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "fn"; v: string };

function lex(src: string): Tok[] | null {
  const s = src.replace(/[×·∙]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/\*\*/g, "^").replace(/√/g, " sqrt ").replace(/\bmod\b/g, "%");
  const out: Tok[] = [];
  const re = /\s*(?:(∞|inf(?:inity)?)|(\d+(?:\.\d+)?|\.\d+)|([a-z]+)|([-+*/^%(),]))/giy;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    m = re.exec(s);
    if (!m) return s.slice(i).trim() ? null : out;
    i = re.lastIndex;
    if (m[1]) out.push({ t: "num", v: Infinity });
    else if (m[2]) out.push({ t: "num", v: Number(m[2]) });
    else if (m[3]) {
      const name = m[3].toLowerCase();
      if (!(name in FN1) && !(name in FNN)) return null; // a variable or word: not pure arithmetic
      out.push({ t: "fn", v: name });
    } else if (m[4]) out.push({ t: "op", v: m[4] });
  }
  return out;
}

/** Evaluate a purely numeric expression; null if it isn't one. */
export function evaluate(src: string): number | null {
  const toks = lex(src);
  if (!toks || !toks.length) return null;
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const fail = (): never => { throw new Error("parse"); };
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) { const op = toks[p++].v; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++].v; const r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => (isOp("-") ? (p++, -unary()) : isOp("+") ? (p++, unary()) : power());
  const power = (): number => {
    const b = atom();
    return isOp("^") ? (p++, Math.pow(b, unary())) : b;
  };
  const atom = (): number => {
    const t = toks[p++] ?? fail();
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") { const v = expr(); if (!isOp(")")) fail(); p++; return v; }
    if (t.t === "fn") {
      if (!isOp("(")) { if (t.v === "sqrt") return Math.sqrt(atom()); fail(); }
      p++;
      const args = [expr()];
      while (isOp(",")) { p++; args.push(expr()); }
      if (!isOp(")")) fail();
      p++;
      if (t.v in FNN) return FNN[t.v](...args);
      return args.length === 1 ? FN1[t.v](args[0]) : fail();
    }
    return fail();
  };
  try {
    const v = expr();
    return p === toks.length && !Number.isNaN(v) ? v : null;
  } catch {
    return null;
  }
}

const EXPR_CHARS = /[0-9.\s+\-−–*×·∙/÷^%(),√∞a-z]/i;
const HAS_OP = /[+\-−–*×·∙/÷^%√]|\b(min|max|sqrt|abs|floor|ceil|round|mod)\b/i;

/** The longest purely numeric expression at the END of `s` (must not continue a word or number). */
function trailingExpr(s: string): string | null {
  let best: string | null = null;
  for (let k = s.length - 1; k >= 0; k--) {
    if (!EXPR_CHARS.test(s[k])) break;
    const cand = s.slice(k).trim();
    const before = s[k - 1];
    if (!cand || (before && /[\p{L}\p{N}.)_]/u.test(before))) continue;
    if (/^[0-9.(√∞-]|^(min|max|sqrt|abs|floor|ceil|round)\b/i.test(cand) && evaluate(cand) !== null) best = cand;
  }
  return best;
}

/** A plain number at the START of `s`: its text, value, and whether it reads as a percentage. */
function leadingNumber(s: string): { text: string; value: number; percent: boolean; start: number } | null {
  const m = /^(\s*)(-?(?:\d+(?:\.\d+)?|\.\d+)|∞)(\s*%)?/.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length);
  // The result must be complete: "= 3 + 4" is an expression, "= 3x" a term, "= 3²" a power.
  // (A unit after a space is fine: "= 5 m/s", "= 49 N".)
  if (!m[3] && (/^\s*[+\-−*×·/÷^(]/.test(rest) || /^[\p{L}\p{N}²³⁰-⁹]/u.test(rest))) return null;
  return { text: m[2], value: m[2] === "∞" ? Infinity : Number(m[2]), percent: Boolean(m[3]), start: m[1].length };
}

function format(v: number, like: string): string {
  if (!Number.isFinite(v)) return "∞";
  if (Number.isInteger(v)) return String(v);
  const decimals = Math.min(4, Math.max(2, (like.split(".")[1] ?? "").length));
  return String(Number(v.toFixed(decimals)));
}

export interface ArithmeticFix { from: string; to: string }

/**
 * Check every "numeric expression = number" in a line and correct wrong results.
 * Rounded results (to the shown precision) and integer division (floor/ceil) are accepted.
 */
export function fixArithmetic(line: string): { text: string; fixes: ArithmeticFix[] } {
  const parts = line.split(/(?<![<>!=≤≥])=(?!=)/);
  if (parts.length < 2) return { text: line, fixes: [] };
  const fixes: ArithmeticFix[] = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    const lhs = trailingExpr(parts[i]);
    if (!lhs || !HAS_OP.test(lhs.replace(/^-/, ""))) continue;
    const value = evaluate(lhs);
    const rhs = leadingNumber(parts[i + 1]);
    if (value === null || !rhs) continue;
    const shown = rhs.percent ? rhs.value / 100 : rhs.value;
    if (!Number.isFinite(value) || !Number.isFinite(shown)) {
      if (value === shown) continue;
    } else {
      const decimals = (rhs.text.split(".")[1] ?? "").length + (rhs.percent ? 2 : 0);
      const tol = 0.5 * 10 ** -decimals + 1e-9 * Math.max(1, Math.abs(value));
      if (Math.abs(value - shown) <= tol) continue;
      if (!Number.isInteger(value) && (shown === Math.floor(value) || shown === Math.ceil(value))) continue; // integer division
    }
    const corrected = rhs.percent ? format(value * 100, rhs.text) : format(value, rhs.text);
    const seg = parts[i + 1];
    parts[i + 1] = seg.slice(0, rhs.start) + seg.slice(rhs.start).replace(rhs.text, corrected);
    fixes.push({ from: `${lhs} = ${rhs.text}${rhs.percent ? "%" : ""}`, to: `${corrected}${rhs.percent ? "%" : ""}` });
  }
  return { text: fixes.length ? parts.join("=") : line, fixes };
}
