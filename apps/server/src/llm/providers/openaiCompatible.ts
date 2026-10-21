// ─────────────────────────────────────────────────────────
// OpenAI-compatible chat-completions provider.
//
// Groq, Mistral and OpenRouter all expose the same
// /chat/completions contract, so one implementation (plain
// fetch, no SDK dependency) serves all three; each gets its
// own base URL, headers and request extras.
// ─────────────────────────────────────────────────────────

import { LLMError } from "../errors.js";
import { ProviderHttpError, redact, type AIProvider, type AIRequest, type ProviderId } from "../types.js";

export interface OpenAICompatibleOptions {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** Provider-specific body fields (e.g. OpenRouter price caps). */
  extraBody?: (req: AIRequest) => Record<string, unknown>;
  /** Whether the endpoint accepts response_format: json_object (may be resolved lazily). */
  supportsJsonMode?: boolean | (() => boolean);
}

/** Parse Retry-After (seconds) or X-RateLimit-Reset (epoch ms or seconds) into a delay. */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) {
    const ms = reset > 1e12 ? reset - Date.now() : reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly provider: ProviderId;
  readonly model: string;

  constructor(private opts: OpenAICompatibleOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.name = `${opts.provider}:${opts.model}`;
  }

  private jsonMode(): boolean {
    const s = this.opts.supportsJsonMode;
    return typeof s === "function" ? s() : s !== false;
  }

  async complete(req: AIRequest): Promise<string> {
    const body = {
      model: this.model,
      temperature: req.temperature ?? 0.3,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.json && this.jsonMode() ? { response_format: { type: "json_object" } } : {}),
      ...(this.opts.extraBody?.(req) ?? {}),
    };

    const response = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok) {
      const text = redact((await response.text().catch(() => "")).slice(0, 600));
      throw new ProviderHttpError(response.status, `${this.provider} ${response.status}: ${text}`, retryAfterFromHeaders(response.headers));
    }

    const data = (await response.json()) as {
      error?: { code?: number | string; message?: string };
      choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    // Some gateways (OpenRouter) report upstream failures inside a 200 body.
    if (data.error) {
      const status = typeof data.error.code === "number" ? data.error.code : 502;
      throw new ProviderHttpError(status, `${this.provider} ${status}: ${redact(String(data.error.message ?? "upstream error")).slice(0, 400)}`);
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const text = Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : content ?? "";
    if (!text.trim()) {
      throw new LLMError("invalid_output", `Empty response (finish_reason=${choice?.finish_reason ?? "?"})`, this.name);
    }
    if (choice?.finish_reason === "length" && req.json) {
      throw new LLMError("invalid_output", "Response was truncated at the token limit", this.name);
    }
    return text;
  }
}
