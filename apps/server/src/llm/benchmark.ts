// ─────────────────────────────────────────────────────────
// Route benchmark — runs the REAL planner + designer agents
// (same prompts, schemas and semantic validation as
// production) through one route at a time.
//
//   npm run ai:benchmark -w apps/server -- openrouter:nvidia/nemotron-3-super-120b-a12b:free mistral:mistral-small-latest
//
// ⚠️ Spends real quota (≈2–4 requests per route). Paid OpenRouter
// models are refused unless OPENROUTER_ALLOW_PAID=true.
// ─────────────────────────────────────────────────────────

import { AIGateway } from "./gateway.js";
import { providersFor } from "./providers/index.js";
import { createOpenRouterProvider, verifyOpenRouterModels } from "./providers/openrouter.js";
import type { AIProvider, ProviderId } from "./types.js";
import { PlannerAgent } from "../agent/PlannerAgent.js";
import { VisualPlannerAgent } from "../agent/VisualPlannerAgent.js";
import { buildPlannerContext, newMemory, viewCanvas } from "../agent/memory.js";
import { layoutDiagram } from "../diagram/layout.js";

const QUESTION = process.env.BENCH_QUESTION || "Explain binary search";

function resolve(spec: string): AIProvider | null {
  const [provider, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (provider === "openrouter") return createOpenRouterProvider(model);
  return providersFor(provider as ProviderId, "planner").find((p) => !model || p.model === model) ?? null;
}

const specs = process.argv.slice(2);
if (!specs.length) {
  console.log("usage: ai:benchmark <provider:model> [...]");
  process.exit(1);
}
await verifyOpenRouterModels(specs.filter((s) => s.startsWith("openrouter:")).map((s) => s.slice("openrouter:".length)));

for (const spec of specs) {
  const route = resolve(spec);
  if (!route) {
    console.log(`\n✗ ${spec}: not configured / refused`);
    continue;
  }
  const memory = newMemory("benchmark001");
  const view = viewCanvas([]);
  const started = Date.now();
  try {
    const planner = new PlannerAgent(new AIGateway("planner", [route], 90_000, 2, false));
    const { plan, meta: pm } = await planner.plan(memory, buildPlannerContext(memory, view), QUESTION);
    const designer = new VisualPlannerAgent(new AIGateway("designer", [route], 120_000, 2, false));
    const { spec: diagram, repairs, meta: dm } = await designer.design({ plan, memory });
    const placed = layoutDiagram(diagram, plan.steps.length);
    console.log(
      `\n✓ ${spec}\n   planner ${(pm.ms / 1000).toFixed(1)}s  intent=${plan.intent} kind=${plan.visualKind} steps=${plan.steps.length}` +
        `\n   designer ${(dm.ms / 1000).toFixed(1)}s  kind=${diagram.kind} nodes=${diagram.nodes.length} edges=${diagram.edges.length} frames=${diagram.frames?.length ?? 0} repairs=${repairs.length}` +
        `\n   layout ${placed.width}×${placed.height}  total ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
  } catch (err) {
    console.log(`\n✗ ${spec}: ${(err as Error).message.slice(0, 200)}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
}
