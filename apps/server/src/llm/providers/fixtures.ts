// ─────────────────────────────────────────────────────────
// Dev-only "fixtures" provider: replays the canned planner /
// designer outputs in diagram/fixtures.ts so the complete app
// (pipeline, validation, layout, canvas) can be exercised in a
// browser without spending AI quota.
//
//   AI_PROVIDER_ORDER=fixtures   then ask:  fixture: number_line
//
// Disabled in production.
// ─────────────────────────────────────────────────────────

import { FIXTURES, findFixture } from "../../diagram/fixtures.js";
import type { AIProvider, AIRequest } from "../types.js";

export class FixtureProvider implements AIProvider {
  readonly name = "fixtures:replay";
  readonly provider = "demo" as const;
  readonly model = "fixtures";

  async complete(req: AIRequest): Promise<string> {
    // Match only the current request — the lesson context also mentions earlier fixtures.
    const content = req.messages.map((m) => m.content).join("\n");
    const current =
      req.task === "planner"
        ? /<user_message>([\s\S]*?)<\/user_message>/.exec(content)?.[1] ?? ""
        : /REQUEST:\s*(.+)/.exec(content)?.[1] ?? "";
    const key = findFixture(current);
    if (!key) {
      throw Object.assign(new Error(`fixtures 400: no fixture matches; ask "fixture: <key>" with one of: ${Object.keys(FIXTURES).join(", ")}`), { status: 400 });
    }
    const fx = FIXTURES[key];
    if (req.task === "planner") {
      // resolvedRequest carries the key so the designer call finds the same fixture.
      return JSON.stringify({ needsVisual: true, targetDiagramId: null, ...fx.plan, resolvedRequest: `fixture:${key} ${fx.question}` });
    }
    return JSON.stringify(fx.spec);
  }
}
