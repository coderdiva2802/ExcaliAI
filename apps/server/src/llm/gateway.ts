// ─────────────────────────────────────────────────────────
// AI Gateway — the only entry point agents use.
//
//   Agent → AIGateway → router (ordered routes) → provider → model
//
// Per request it walks the task's routes in order:
//   • skips routes in cool-down (quota, auth, invalid model)
//   • retries transient failures (timeout, 5xx, network, short
//     rate limits) on the same route with bounded backoff
//   • falls back to the next route on retryable failures
//   • stops immediately on cancellation
// generateStructured() additionally extracts + schema-validates
// JSON, gives the same model ONE correction attempt, then
// falls back — invalid output never leaves the gateway.
// Requests are sequential: providers are never called in
// parallel, so quota is never spent twice.
// ─────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import { config } from "../config.js";
import { LLMError, classifyError } from "./errors.js";
import { MAX_INLINE_WAIT_MS, providerHealth } from "./health.js";
import { extractJSON } from "./json.js";
import { MockProvider } from "./mock.js";
import { routeFor } from "./router.js";
import type { AIProvider, AIRequest, AIResponseMeta, AITask } from "./types.js";

export type { AIRequest, AIResponseMeta, AITask, ChatMessage } from "./types.js";

export interface StructuredResult<T> {
  data: T;
  meta: AIResponseMeta;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new LLMError("aborted", "Request cancelled"));
    }, { once: true });
  });

/** Small TTL cache for repeatable structured requests (identical prompt → identical answer). */
class ResponseCache {
  private map = new Map<string, { value: unknown; meta: AIResponseMeta; expires: number }>();
  constructor(private ttlMs = 30 * 60_000, private max = 200) {}
  get(key: string) {
    const hit = this.map.get(key);
    if (!hit || hit.expires < Date.now()) return undefined;
    return hit;
  }
  set(key: string, value: unknown, meta: AIResponseMeta) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { value, meta, expires: Date.now() + this.ttlMs });
  }
}
const cache = new ResponseCache();

export class AIGateway {
  constructor(
    readonly task: AITask,
    private routes: AIProvider[],
    private timeoutMs: number,
    private maxAttemptsPerRoute = 2,
    /** Disable the shared response cache (benchmarks, tests). */
    private cacheEnabled = true
  ) {}

  get isDemo(): boolean {
    return this.routes.every((r) => r instanceof MockProvider);
  }

  /** Healthy routes first, in configured order; if all are cooling down, try the soonest-recovering. */
  private candidates(): AIProvider[] {
    const healthy = this.routes.filter((r) => providerHealth.isAvailable(r.name));
    if (healthy.length) return healthy;
    return [...this.routes].sort((a, b) => providerHealth.retryIn(a.name) - providerHealth.retryIn(b.name)).slice(0, 1);
  }

  /** One attempt with an explicit, always-cleared timeout. */
  private async attempt(route: AIProvider, req: AIRequest): Promise<{ text: string; ms: number }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal;
    const started = Date.now();
    try {
      const text = await route.complete({ ...req, signal });
      return { text, ms: Date.now() - started };
    } catch (raw) {
      if (timeout.signal.aborted && !req.signal?.aborted) {
        throw new LLMError("timeout", `Timed out after ${this.timeoutMs}ms`, route.name);
      }
      throw classifyError(raw, route.name, req.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Core loop shared by text and structured generation. `accept` turns raw
   * text into a value or returns a correction message for one retry.
   */
  private async run<T>(
    req: AIRequest,
    accept: (text: string) => { ok: true; value: T } | { ok: false; problem: string }
  ): Promise<{ value: T; meta: AIResponseMeta }> {
    let lastError: LLMError | undefined;
    const chain = this.candidates();

    for (let ri = 0; ri < chain.length; ri++) {
      const route = chain[ri];
      // Re-check: an earlier failure in this request may have cooled this route down
      // (e.g. an invalid key disables every model of that provider).
      if (chain.length > 1 && !providerHealth.isAvailable(route.name)) continue;
      if (lastError) console.warn(`[AI] task=${this.task} falling back to ${route.name}`);
      let messages = req.messages;
      for (let attempt = 1; attempt <= this.maxAttemptsPerRoute; attempt++) {
        if (req.signal?.aborted) throw new LLMError("aborted", "Request cancelled", route.name);
        try {
          const { text, ms } = await this.attempt(route, { ...req, messages });
          providerHealth.markSuccess(route.name, ms);
          const result = accept(text);
          const meta: AIResponseMeta = { task: this.task, provider: route.provider, model: route.model, ms };
          if (result.ok) {
            console.log(`[AI] task=${this.task} route=${route.name} ${(ms / 1000).toFixed(1)}s ok`);
            return { value: result.value, meta };
          }
          // The model answered but the output is unusable: one correction, then fall back.
          providerHealth.markInvalidOutput(route.name);
          lastError = new LLMError("invalid_output", result.problem, route.name);
          console.warn(`[AI] task=${this.task} route=${route.name} invalid output (${result.problem.slice(0, 160)})`);
          messages = [...req.messages, { role: "user", content: `Your previous reply was rejected: ${result.problem}\nReturn ONLY corrected JSON.` }];
        } catch (err) {
          const e = err as LLMError;
          if (e.kind === "aborted") throw e;
          lastError = e;
          const cooldown = providerHealth.markFailure(route.name, e);
          console.warn(`[AI] task=${this.task} route=${route.name} failed: ${e.kind}${cooldown ? ` → cooling down ${Math.round(cooldown / 1000)}s` : ""}`);
          if (cooldown || !e.transient || attempt === this.maxAttemptsPerRoute) break;
          const backoff = Math.min(e.retryAfterMs ?? 800 * 2 ** (attempt - 1), MAX_INLINE_WAIT_MS);
          await sleep(backoff, req.signal);
        }
      }
    }
    throw lastError ?? new LLMError("unknown", "No AI provider available");
  }

  /** Plain text completion. */
  async generateText(req: Omit<AIRequest, "task" | "json">): Promise<{ text: string; meta: AIResponseMeta }> {
    const { value, meta } = await this.run({ ...req, task: this.task, json: false }, (text) => ({ ok: true, value: text }));
    return { text: value, meta };
  }

  /**
   * JSON completion validated against a zod schema. Only schema-valid data is
   * returned; malformed output triggers a correction, then provider fallback.
   */
  async generateStructured<T>(
    req: Omit<AIRequest, "task" | "json">,
    schema: ZodType<T, ZodTypeDef, unknown>,
    opts: { cache?: boolean } = {}
  ): Promise<StructuredResult<T>> {
    const full: AIRequest = { ...req, task: this.task, json: true };
    const key = opts.cache && this.cacheEnabled
      ? createHash("sha256").update(JSON.stringify([this.task, full.system, full.messages, full.temperature])).digest("hex")
      : undefined;
    if (key) {
      const hit = cache.get(key);
      if (hit) {
        console.log(`[AI] task=${this.task} cache hit`);
        return { data: hit.value as T, meta: { ...hit.meta, ms: 0 } };
      }
    }

    const { value, meta } = await this.run<T>(full, (text) => {
      let raw: unknown;
      try {
        raw = extractJSON(text);
      } catch (err) {
        return { ok: false, problem: (err as Error).message };
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, problem: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
      }
      return { ok: true, value: parsed.data };
    });
    if (key) cache.set(key, value, meta);
    return { data: value, meta };
  }
}

export function createGateway(task: AITask): AIGateway {
  const timeout = task === "designer" ? config.llm.designerTimeoutMs : config.llm.plannerTimeoutMs;
  return new AIGateway(task, routeFor(task), timeout);
}
