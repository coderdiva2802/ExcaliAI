// ─────────────────────────────────────────────────────────
// Narration ↔ diagram consistency.
//
// The planner writes the narration BEFORE the diagram exists,
// so it sometimes describes things that were never drawn
// ("the arrows show…", "the highlighted Reign of Terror
// period…") or states a number the code computed differently.
// This deterministic pass removes only sentences that
//   • point at the picture AND name something not on it, or
//   • mention arrows when the diagram has none, or
//   • state a computed quantity (V, A, Ω, N, g/mol) that
//     contradicts every value of that unit on the diagram.
// Plain explanation is never touched, and every step keeps
// at least one sentence.
// ─────────────────────────────────────────────────────────

import type { CreateAction } from "@excaliai/shared";

export interface NarrationStep { title: string; narration: string }

const VISUAL_CUE =
  /\b(arrows?|box(es)?|nodes?|bars?|cards?|band|highlighted|shaded|marked|labell?ed|shown|see|notice|look at|dashed|dotted|circled|on the (diagram|board|canvas|timeline|map|graph|chart|number line|whiteboard)|in the (diagram|figure|picture))\b/i;
const HYPOTHETICAL = /\b(if|would|could|suppose|imagine|double[ds]?|halve[ds]?|instead|for example|e\.g\.)\b/i;
const STOP = new Set(["the", "this", "that", "these", "those", "here", "there", "now", "next", "first", "then", "each", "every", "notice", "see", "look", "when", "while", "after", "before", "finally", "also", "both", "its", "their", "our", "your", "and", "with", "from", "into"]);
const UNITS: Array<[RegExp, string]> = [[/(?:V|volts?)\b/, "V"], [/(?:A|amps?|amperes?)\b/, "A"], [/(?:Ω|ohms?)/, "Ω"], [/(?:N|newtons?)\b/, "N"], [/g\/mol\b/, "g/mol"]];

const SUBS: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
const normalize = (s: string) => s.replace(/[₀-₉]/g, (c) => SUBS[c]).replace(/−/g, "-").toLowerCase();

function diagramText(creates: CreateAction[]): string {
  return normalize(
    creates
      .map((a) => ("text" in a && typeof a.text === "string" ? a.text : "") + " " + ("label" in a && typeof a.label === "string" ? a.label : "") + " " + ("latex" in a ? a.latex : ""))
      .join(" ")
  );
}

function hasArrows(creates: CreateAction[]): boolean {
  return creates.some((a) => (a.action === "create_arrow" && a.endArrowhead !== "none") || (a.action === "create_path" && Boolean(a.endArrowhead && a.endArrowhead !== "none")));
}

/** Proper-noun phrases and quoted terms in a sentence (sentence-initial filler words excluded). */
function namedThings(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(/["“'‘]([^"”'’]{2,40})["”'’]/g)) out.push(m[1]);
  for (const m of sentence.matchAll(/\b[A-Z][\w’'-]+(?:\s+(?:of|the|de|du|la|and|von|van)?\s*[A-Z][\w’'-]+)*/g)) {
    const words = m[0].split(/\s+/);
    if (words.length === 1 && (m.index === 0 || STOP.has(words[0].toLowerCase()))) continue;
    if (/^[A-Z]{1,2}\d*$/.test(m[0])) continue; // symbols / units: V, A, N, R1
    out.push(m[0]);
  }
  return out;
}

/** A name counts as drawn when any significant word of it appears in the diagram's text. */
function isDrawn(name: string, text: string): boolean {
  const words = normalize(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
  if (!words.length) return true;
  return words.some((w) => text.includes(w));
}

function valuesFor(unit: string, text: string): number[] {
  const re = unit === "g/mol" ? /(-?\d+(?:\.\d+)?)\s*g\/mol/g : new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*${unit === "Ω" ? "Ω" : unit}\\b`, "g");
  return [...text.matchAll(re)].map((m) => parseFloat(m[1]));
}

export function checkNarration(steps: NarrationStep[], creates: CreateAction[]): { steps: NarrationStep[]; dropped: string[] } {
  const text = diagramText(creates);
  const arrows = hasArrows(creates);
  const dropped: string[] = [];
  const rawText = creates.map((a) => ("text" in a && typeof a.text === "string" ? a.text : "") + " " + ("label" in a && typeof a.label === "string" ? a.label : "")).join(" ").replace(/[₀-₉]/g, (c) => SUBS[c]).replace(/−/g, "-");

  const verdict = (sentence: string): string | null => {
    if (/\barrows?\b/i.test(sentence) && !arrows) return "mentions arrows but none are drawn";
    if (VISUAL_CUE.test(sentence)) {
      const missing = namedThings(sentence).filter((n) => !isDrawn(n, text));
      if (missing.length) return `points at "${missing[0]}", which is not on the diagram`;
    }
    if (!HYPOTHETICAL.test(sentence)) {
      for (const [re, unit] of UNITS) {
        const shown = valuesFor(unit, rawText);
        if (!shown.length) continue;
        const said = [...sentence.matchAll(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*${re.source}`, "g"))].map((m) => parseFloat(m[1]));
        const wrong = said.find((v) => !shown.some((s) => Math.abs(s - v) <= Math.max(0.011 * Math.abs(s), 0.006)));
        if (wrong !== undefined) return `states ${wrong} ${unit}, which contradicts the computed values`;
      }
    }
    return null;
  };

  const out = steps.map((step) => {
    const sentences = step.narration.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [step.narration];
    const kept = sentences.filter((s) => {
      const why = verdict(s);
      if (why) dropped.push(`"${s.slice(0, 80)}" — ${why}`);
      return !why;
    });
    // Never leave a step empty — but never keep a flagged claim either: fall back to the step's title.
    return { ...step, narration: kept.length ? kept.join(" ") : `${step.title}.` };
  });
  return { steps: out, dropped };
}
