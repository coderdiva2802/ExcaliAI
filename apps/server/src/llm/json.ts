// ─────────────────────────────────────────────────────────
// Robust JSON extraction from LLM text.
//
// Even in JSON mode, models occasionally wrap output in code
// fences, prepend reasoning (<think>…</think>), or append
// commentary.  This extracts the first balanced JSON object.
// It never evaluates code.
// ─────────────────────────────────────────────────────────

import { LLMError } from "./errors.js";

export function extractJSON(raw: string): unknown {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  const start = text.indexOf("{");
  if (start === -1) throw new LLMError("invalid_output", "No JSON object found in model output");

  // Scan for the matching closing brace, respecting strings/escapes.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Common model slip: trailing commas.
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
          } catch {
            throw new LLMError("invalid_output", "Model output contained malformed JSON");
          }
        }
      }
    }
  }
  throw new LLMError("invalid_output", "Model output contained truncated JSON");
}
