// ─────────────────────────────────────────────────────────
// Text measurement estimates for layout.
//
// The server cannot measure real glyphs, so widths are
// estimated per character class for Excalifont (the font the
// client renders labels with) and rounded up.  Estimates are
// deliberately slightly generous so Excalidraw never has to
// re-wrap a label and grow its container (which would cause
// overlaps the layout engine didn't plan for).
// ─────────────────────────────────────────────────────────

export const LINE_HEIGHT = 1.25; // Excalifont metrics line height

const NARROW = new Set("iljtfrI.,:;'!|()[]{} ".split(""));
const WIDE = new Set("mwMW@%&".split(""));

function charWidthEm(ch: string): number {
  if (NARROW.has(ch)) return 0.36;
  if (WIDE.has(ch)) return 0.92;
  if (ch >= "A" && ch <= "Z") return 0.7;
  if (ch >= "0" && ch <= "9") return 0.6;
  if (ch.charCodeAt(0) > 0x2000) return 1.0; // symbols, arrows, emoji
  return 0.58;
}

export function measureLine(line: string, fontSize: number): number {
  let em = 0;
  for (const ch of line) em += charWidthEm(ch);
  return Math.ceil(em * fontSize);
}

/** Greedy word-wrap. Hard newlines are preserved; overlong words are split. */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      // Split words that cannot fit on any line.
      while (measureLine(word, fontSize) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measureLine(word.slice(0, cut), fontSize) > maxWidth) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (measureLine(candidate, fontSize) <= maxWidth) line = candidate;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export interface TextBlock {
  lines: string[];
  text: string;
  width: number;
  height: number;
  fontSize: number;
}

export function measureBlock(text: string, fontSize: number, maxWidth: number): TextBlock {
  const lines = wrapText(text, maxWidth, fontSize);
  const width = Math.max(0, ...lines.map((l) => measureLine(l, fontSize)));
  return {
    lines,
    text: lines.join("\n"),
    width,
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
    fontSize,
  };
}

/** Rough rendered size of a KaTeX display formula. */
export function estimateFormulaSize(latex: string, fontSize: number): { width: number; height: number } {
  const visible = latex
    .replace(/\\(left|right|displaystyle|limits|,|;|!|quad|qquad)/g, "")
    .replace(/\\[a-zA-Z]+/g, "x") // each command renders roughly one glyph
    .replace(/[{}^_]/g, "");
  const tall = /\\(frac|sum|int|prod|sqrt|binom|over|lim|begin)/.test(latex);
  const width = Math.min(760, Math.max(80, Math.ceil(visible.length * fontSize * 0.62) + 40));
  const height = Math.ceil(fontSize * (tall ? 2.8 : 1.8)) + 24;
  return { width, height };
}

/** Rendered size of a code overlay (14px mono, 1.7 line height, 16/20px padding). */
export function estimateCodeSize(code: string): { width: number; height: number } {
  const CHAR_W = 8.5;
  const LINE_H = 14 * 1.7;
  const lines = code.replace(/\t/g, "  ").split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.min(600, Math.max(260, Math.ceil(longest * CHAR_W) + 48));
  const charsPerLine = Math.max(10, Math.floor((width - 40) / CHAR_W));
  const visualLines = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
  return { width, height: Math.ceil(visualLines * LINE_H) + 40 };
}
