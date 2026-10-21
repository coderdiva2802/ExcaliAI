// ─────────────────────────────────────────────────────────
// OpenRouter provider — free models only (by default).
//
// Free-tier protection, three independent layers:
//   1. Configuration: only model ids ending in ":free" (or the
//      "openrouter/free" router) are accepted unless
//      OPENROUTER_ALLOW_PAID=true.
//   2. Startup verification: each configured model is looked
//      up in OpenRouter's live catalog and must have $0 prompt
//      and completion pricing, otherwise it is disabled.
//   3. Every request carries provider.max_price = 0, so
//      OpenRouter itself refuses to route to a paid endpoint.
// ─────────────────────────────────────────────────────────

import { config } from "../../config.js";
import type { AIProvider } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";

export function isFreeModelId(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

interface CatalogModel {
  id: string;
  pricing?: { prompt?: string; completion?: string; request?: string };
  supported_parameters?: string[];
  context_length?: number;
}

let catalog: Map<string, CatalogModel> | null = null;
/** response_format support per model, learned from the catalog at startup. */
const jsonSupport = new Map<string, boolean>();

/** Fetch OpenRouter's public model catalog (no key needed). */
async function loadCatalog(): Promise<Map<string, CatalogModel>> {
  if (catalog) return catalog;
  const response = await fetch(`${config.openrouter.baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`catalog ${response.status}`);
  const data = (await response.json()) as { data: CatalogModel[] };
  catalog = new Map(data.data.map((m) => [m.id, m]));
  return catalog;
}

export interface ModelCheck {
  model: string;
  ok: boolean;
  reason?: string;
  jsonMode?: boolean;
}

/** Verify configured models exist, are free, and note JSON-mode support. */
export async function verifyOpenRouterModels(models: string[]): Promise<ModelCheck[]> {
  let cat: Map<string, CatalogModel>;
  try {
    cat = await loadCatalog();
  } catch (err) {
    // Without the catalog we still have layers 1 and 3; don't disable everything.
    console.warn(`[AI] openrouter: could not load model catalog (${(err as Error).message}); relying on :free ids + max_price=0`);
    return models.map((model) => ({ model, ok: isFreeModelId(model) || config.openrouter.allowPaid }));
  }
  return models.map((model) => {
    if (model === "openrouter/free") return { model, ok: true, jsonMode: false };
    const m = cat.get(model);
    if (!m) return { model, ok: false, reason: "not found in OpenRouter catalog" };
    const free = Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0 && Number(m.pricing?.request ?? 0) === 0;
    if (!free && !config.openrouter.allowPaid) return { model, ok: false, reason: "not a free model (blocked: OPENROUTER_ALLOW_PAID is false)" };
    const jsonMode = m.supported_parameters?.includes("response_format") ?? false;
    jsonSupport.set(model, jsonMode);
    return { model, ok: true, jsonMode };
  });
}

export function createOpenRouterProvider(model: string): AIProvider | null {
  if (!config.openrouter.apiKey) return null;
  if (!isFreeModelId(model) && !config.openrouter.allowPaid) {
    console.warn(`[AI] openrouter: refusing non-free model "${model}" (set OPENROUTER_ALLOW_PAID=true to allow paid models)`);
    return null;
  }
  return new OpenAICompatibleProvider({
    provider: "openrouter",
    model,
    baseUrl: config.openrouter.baseUrl,
    apiKey: config.openrouter.apiKey,
    headers: { "HTTP-Referer": config.openrouter.appUrl, "X-Title": "ExcaliAI" },
    // Models without JSON mode still go through prompt + extractJSON + zod validation.
    supportsJsonMode: () => jsonSupport.get(model) ?? true,
    extraBody: () => ({
      // Hard server-side guarantee: never route to an endpoint that costs money.
      ...(config.openrouter.allowPaid ? {} : { provider: { max_price: { prompt: 0, completion: 0 } } }),
      // Free reasoning models: keep thinking short and out of the response body.
      reasoning: { effort: "low", exclude: true },
    }),
  });
}
