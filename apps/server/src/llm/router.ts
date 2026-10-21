// ─────────────────────────────────────────────────────────
// Model router — the central routing policy.
//
// For each task it produces an ordered list of candidate
// routes ("provider:model") from configuration:
//
//   AI_PLANNER_ORDER / AI_DESIGNER_ORDER  (per task)
//   └─ falls back to AI_PROVIDER_ORDER    (global)
//      └─ falls back to the built-in default (see config.ts)
//
// and each provider's per-task model setting.  Order changes
// never require code changes.  At request time the gateway
// skips routes the health registry has put in cool-down.
// ─────────────────────────────────────────────────────────

import { config, hasLLMProvider } from "../config.js";
import { MockProvider } from "./mock.js";
import { providerHealth } from "./health.js";
import { providersFor } from "./providers/index.js";
import { verifyMistralModels } from "./providers/mistral.js";
import { verifyOpenRouterModels } from "./providers/openrouter.js";
import type { AIProvider, AITask } from "./types.js";

export function routeFor(task: AITask): AIProvider[] {
  if (!hasLLMProvider() && !config.ai.order[task].includes("fixtures")) return [new MockProvider()];
  const route = config.ai.order[task].flatMap((provider) => providersFor(provider, task));
  for (const p of route) providerHealth.register(p.name);
  return route.length ? route : [new MockProvider()];
}

/** Human-readable routing table for startup logs. */
export function describeRoutes(): string {
  return (["planner", "designer"] as const)
    .map((task) => `[AI] route ${task.padEnd(8)}: ${routeFor(task).map((p) => p.name).join(" → ")}`)
    .join("\n");
}

/**
 * One-time startup checks: disable configured models that are not free
 * (OpenRouter) or not available for the key (Mistral), so no request is
 * ever spent on them.
 */
export async function verifyRoutes(): Promise<void> {
  const orModels = [...new Set([...config.openrouter.models.planner, ...config.openrouter.models.designer])];
  if (config.openrouter.apiKey && orModels.length) {
    for (const check of await verifyOpenRouterModels(orModels)) {
      if (!check.ok) {
        providerHealth.disable(`openrouter:${check.model}`, check.reason ?? "failed verification");
        console.warn(`[AI] openrouter:${check.model} disabled — ${check.reason}`);
      }
    }
  }
  const mistralModels = [...new Set(Object.values(config.mistral.models))];
  for (const bad of await verifyMistralModels(mistralModels)) {
    providerHealth.disable(`mistral:${bad.model}`, bad.reason);
    console.warn(`[AI] mistral:${bad.model} disabled — ${bad.reason}`);
  }
}
