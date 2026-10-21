// ─────────────────────────────────────────────────────────
// Demo provider — used only when no LLM provider is configured.
// Produces schema-valid planner/designer JSON so the whole
// pipeline (validation, layout, canvas) can be exercised
// offline.  Content is clearly labelled as demo output and
// makes no factual claims about the topic.
// ─────────────────────────────────────────────────────────

import type { AIProvider, AIRequest } from "./types.js";

function lastUserText(req: AIRequest): string {
  const content = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const tagged = content.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/);
  const request = content.match(/REQUEST:\s*(.+)/);
  return (tagged?.[1] ?? request?.[1] ?? content).trim().slice(0, 60) || "your topic";
}

export class MockProvider implements AIProvider {
  readonly name = "demo:canned";
  readonly provider = "demo" as const;
  readonly model = "canned";

  async complete(req: AIRequest): Promise<string> {
    await new Promise((r) => setTimeout(r, 300));
    const topic = lastUserText(req);
    if (req.task === "planner") {
      return JSON.stringify({
        intent: "new_topic",
        topic,
        resolvedRequest: `Give an overview of ${topic}`,
        targetDiagramId: null,
        clarificationQuestion: null,
        needsVisual: true,
        visualKind: "mindmap",
        steps: [
          { title: "Demo mode", narration: "No AI provider is configured, so this is a placeholder lesson structure rather than a real explanation." },
          { title: "How lessons look", narration: "With an API key configured, each step is explained here while the matching part of the diagram is drawn." },
          { title: "Next step", narration: "Add GEMINI_API_KEY or GROQ_API_KEY to .env and restart the server for real lessons." },
        ],
        summary: `Demo overview for "${topic}".`,
        concepts: [],
        caveats: [],
      });
    }
    return JSON.stringify({
      title: `${topic} (demo)`,
      kind: "mindmap",
      nodes: [
        { id: "root", label: topic, step: 1 },
        { id: "what", label: "What it is", parent: "root", step: 2 },
        { id: "how", label: "How it works", parent: "root", step: 2 },
        { id: "example", label: "An example", parent: "root", step: 3 },
        { id: "why", label: "Why it matters", parent: "root", step: 3 },
      ],
      edges: [],
      takeaways: ["Demo mode: configure an AI provider for real content"],
    });
  }
}
