// ─────────────────────────────────────────────────────────
// Matching requested part names to a sketch's labels.
//
// The designer asks for parts in its own words ("eardrum");
// a reference diagram may call it "Tympanic membrane". A
// deterministic token match handles most cases; the Sketcher
// asks the LLM only for what is still unmatched.
// ─────────────────────────────────────────────────────────

import type { TemplatePart } from "../diagram/templates.js";

const STOP = new Set(["the", "of", "a", "an", "and", "or", "in", "to", "with", "its", "part", "layer", "region", "area", "attached"]);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("es") && !t.endsWith("ses") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** 0–1 similarity between two part names (shared tokens over the smaller set; prefixes count half). */
export function similarity(a: string, b: string): number {
  const ta = [...new Set(tokens(a))], tb = [...new Set(tokens(b))];
  if (!ta.length || !tb.length) return 0;
  let hit = 0;
  for (const x of ta) {
    if (tb.includes(x)) hit += 1;
    else if (tb.some((y) => Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x)))) hit += 0.75;
  }
  return hit / Math.min(ta.length, tb.length) * (Math.min(ta.length, tb.length) / Math.max(ta.length, tb.length)) ** 0.25;
}

export interface Requested { part: string; text?: string }

/**
 * Map each requested label to a distinct sketch part (best score first).
 * Returns requested index → part id; unmatched requests are absent.
 */
export function matchParts(requested: Requested[], parts: TemplatePart[], threshold = 0.6): Map<number, string> {
  const scored: Array<{ r: number; id: string; s: number }> = [];
  requested.forEach((req, r) => {
    const names = [req.part.replace(/_/g, " "), req.text ?? ""].filter(Boolean);
    for (const p of parts) {
      const targets = [p.name, p.id.replace(/_/g, " "), p.detail ?? ""].filter(Boolean);
      let s = 0;
      for (const n of names) for (const t of targets) s = Math.max(s, similarity(n, t) * (t === p.detail ? 0.9 : 1));
      if (s >= threshold) scored.push({ r, id: p.id, s });
    }
  });
  scored.sort((a, b) => b.s - a.s);
  const out = new Map<number, string>();
  const taken = new Set<string>();
  for (const { r, id } of scored) {
    if (out.has(r) || taken.has(id)) continue;
    out.set(r, id);
    taken.add(id);
  }
  return out;
}

/** How well a candidate sketch covers what was asked (used to rank reference diagrams). */
export function coverage(requested: Requested[], parts: TemplatePart[]): number {
  return requested.length ? matchParts(requested, parts).size : 0;
}

// ── Subject keys ───────────────────────────────────────

const KEY_STOP = new Set(["human", "the", "of", "a", "an", "diagram", "anatomy", "anatomical", "structure", "labelled", "labeled",
  "parts", "part", "schematic", "sketch", "drawing", "picture", "simple", "basic", "typical", "label", "labels", "labelling", "labeling"]);

/** Canonical key for a subject ("structure_of_the_human_ear" → "ear"). */
export function subjectKey(slug: string): string {
  const t = tokens(slug.replace(/_/g, " ")).filter((x) => !KEY_STOP.has(x));
  return [...new Set(t)].sort().join("_") || slug.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** Display title for a subject ("human_kidney_anatomy_labels" → "Human kidney"). */
export function subjectTitle(slug: string): string {
  const words = slug.split(/[_\s-]+/).filter((w) => w && (w === "human" || !KEY_STOP.has(w.toLowerCase())));
  const t = (words.length ? words : slug.split(/[_\s-]+/)).join(" ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Words to search for ("human_ear" → "human ear"). */
export const subjectWords = (slug: string) => slug.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
