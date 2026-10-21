// ─────────────────────────────────────────────────────────
// AI provider abstraction — shared types.
//
// Agents talk to an AIGateway (llm/gateway.ts); the gateway
// asks the router (llm/router.ts) for an ordered list of
// AIProviders for the task and walks it with retries,
// fallback and health tracking.  Nothing outside llm/ knows
// which provider or model produced a response.
// ─────────────────────────────────────────────────────────

export type ProviderId = "gemini" | "groq" | "mistral" | "openrouter" | "ollama" | "demo" | "fixtures";

/**
 * LLM-backed tasks in the pipeline.  (Layout, canvas compilation and
 * validation are deterministic code — no model is involved.)
 *   planner  — context analysis, intent + reference resolution, explanation plan
 *   designer — visual planning: a semantic DiagramSpec
 */
export type AITask = "planner" | "designer";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIRequest {
  task: AITask;
  system: string;
  messages: ChatMessage[];
  /** Ask the provider for a JSON object (JSON mode where supported). */
  json: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AIResponseMeta {
  task: AITask;
  provider: ProviderId;
  model: string;
  ms: number;
}

export interface AIProvider {
  /** Unique route id, "provider:model". */
  readonly name: string;
  readonly provider: ProviderId;
  readonly model: string;
  /** One raw completion attempt. Throws on failure; never retries itself. */
  complete(req: AIRequest): Promise<string>;
}

/** HTTP failure from a provider, with a sanitized message and retry hint. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** Remove anything that looks like a credential from text before it is logged or thrown. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|gsk|AIza|sk-or-v1)[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}
