// ─────────────────────────────────────────────────────────
// Mistral provider (La Plateforme, https://api.mistral.ai).
//
// Mistral's chat-completions API is OpenAI-compatible and
// supports JSON mode (response_format: json_object), so it
// reuses the shared implementation instead of adding the SDK
// as a dependency.  Models are configurable per task.
// ─────────────────────────────────────────────────────────

import { config } from "../../config.js";
import type { AIProvider, AITask } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";

export function createMistralProvider(task: AITask): AIProvider | null {
  if (!config.mistral.apiKey) return null;
  return new OpenAICompatibleProvider({
    provider: "mistral",
    model: config.mistral.models[task],
    baseUrl: config.mistral.baseUrl,
    apiKey: config.mistral.apiKey,
    supportsJsonMode: true,
  });
}

/** Check that configured Mistral models exist for this key. Returns unavailable model ids. */
export async function verifyMistralModels(models: string[]): Promise<Array<{ model: string; reason: string }>> {
  if (!config.mistral.apiKey) return [];
  try {
    const response = await fetch(`${config.mistral.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.mistral.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      return models.map((model) => ({ model, reason: "API key rejected" }));
    }
    if (!response.ok) return []; // transient — let runtime handling decide
    const data = (await response.json()) as { data?: Array<{ id: string; aliases?: string[] }> };
    const known = new Set((data.data ?? []).flatMap((m) => [m.id, ...(m.aliases ?? [])]));
    return models.filter((m) => !known.has(m)).map((model) => ({ model, reason: "model not available for this key" }));
  } catch {
    return [];
  }
}
