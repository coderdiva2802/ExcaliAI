// ─────────────────────────────────────────────────────────
// LLM error classification.
//
// Providers fail in many shapes (HTTP status in a message,
// SDK error objects, fetch TypeErrors, AbortErrors).  Every
// failure is normalized into an LLMError with a `kind` so the
// resilience layer can decide: retry, fall back, or give up.
// ─────────────────────────────────────────────────────────

export type LLMErrorKind =
  | "aborted"      // caller cancelled (client disconnected) — never retry
  | "timeout"      // attempt exceeded its time budget
  | "rate_limit"   // transient 429
  | "quota"        // quota / billing exhausted — skip provider for a while
  | "auth"         // bad / missing key — skip provider for a long while
  | "server"       // 5xx
  | "network"      // connection reset, DNS, etc.
  | "bad_request"  // 4xx other than the above (model not found, bad params)
  | "invalid_output" // response could not be parsed / validated
  | "unknown";

export class LLMError extends Error {
  constructor(
    public readonly kind: LLMErrorKind,
    message: string,
    public readonly provider?: string,
    public readonly retryAfterMs?: number,
    /** "provider" = the whole account is affected (bad key, no credits, account-wide daily cap). */
    public readonly scope: "route" | "provider" = "route"
  ) {
    super(message);
    this.name = "LLMError";
  }

  get transient(): boolean {
    return ["timeout", "rate_limit", "server", "network", "invalid_output"].includes(this.kind);
  }
}

/** Map any thrown value from a provider call into an LLMError. */
export function classifyError(err: unknown, provider: string, callerSignal?: AbortSignal): LLMError {
  if (err instanceof LLMError) return err;
  if (callerSignal?.aborted) return new LLMError("aborted", "Request cancelled", provider);

  const e = err as { name?: string; message?: string; status?: number; code?: string; cause?: { code?: string } };
  const message = String(e?.message ?? err);
  const lower = message.toLowerCase();
  const status = typeof e?.status === "number" ? e.status : extractStatus(message);

  if (e?.name === "TimeoutError" || lower.includes("timed out") || lower.includes("timeout")) {
    return new LLMError("timeout", message, provider);
  }
  if (e?.name === "AbortError") return new LLMError("timeout", message, provider);

  // 402 = payment required / insufficient credits: never retry, never "fall up" to paid.
  if (status === 402) return new LLMError("quota", message, provider, 6 * 3_600_000, "provider");

  if (status === 429 || lower.includes("resource_exhausted") || lower.includes("rate_limit") || lower.includes("rate limit")) {
    // Distinguish "wait a few seconds" (per-minute limits) from "this provider is
    // unusable for hours" (daily caps, or limit: 0 = no access to the model at all).
    const headerRetry = (err as { retryAfterMs?: number })?.retryAfterMs;
    const retryAfter = headerRetry ?? extractRetryAfter(message);
    const noAccess = lower.includes("limit: 0");
    const dailyCap = /per[- ]day|daily|free-models-per-day/.test(lower);
    const exhausted = noAccess || dailyCap || (retryAfter !== undefined && retryAfter > 60_000);
    return new LLMError(
      exhausted ? "quota" : "rate_limit",
      message,
      provider,
      noAccess ? Math.max(retryAfter ?? 0, 3_600_000) : dailyCap ? Math.max(retryAfter ?? 0, 3_600_000) : retryAfter,
      // OpenRouter's free-model daily cap is per account, not per model.
      lower.includes("free-models-per-day") ? "provider" : "route"
    );
  }
  if (status === 401 || status === 403 || lower.includes("api key not valid") || lower.includes("permission_denied")) {
    return new LLMError("auth", message, provider, undefined, "provider");
  }
  if (status !== undefined && status >= 500) return new LLMError("server", message, provider);
  // JSON-mode providers (e.g. Groq "json_validate_failed") reject malformed model output with a 400:
  // the request was fine, the model's answer wasn't — retry / fall back, don't disable the provider.
  if (status === 400 && /json_validate_failed|failed to generate json|invalid json|output_parse_failed/.test(lower)) {
    return new LLMError("invalid_output", message, provider);
  }
  if (status !== undefined && status >= 400) return new LLMError("bad_request", message, provider);

  const code = e?.code || e?.cause?.code || "";
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/.test(code) ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("network")
  ) {
    return new LLMError("network", message, provider);
  }
  return new LLMError("unknown", message, provider);
}

function extractStatus(message: string): number | undefined {
  const m = message.match(/"code"\s*:\s*(\d{3})/) || message.match(/\b(4\d\d|5\d\d)\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Parse "retry in 19h18m52.6s", "try again in 7.88s", "1m30s" or retryDelay "69532s" into ms. */
export function extractRetryAfter(message: string): number | undefined {
  const delay = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (delay) return Math.ceil(parseFloat(delay[1]) * 1000);
  const m = message.match(/(?:retry|try again) in ((?:\d+(?:\.\d+)?[hms])+)/i);
  if (!m) return undefined;
  let ms = 0;
  for (const [, value, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
    ms += parseFloat(value) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
  }
  return Math.ceil(ms);
}

/** A short, user-safe description of why the AI could not respond. */
export function userMessageFor(err: unknown): { message: string; retryable: boolean } {
  const kind = err instanceof LLMError ? err.kind : "unknown";
  switch (kind) {
    case "aborted":
      return { message: "The request was cancelled.", retryable: true };
    case "quota":
    case "rate_limit":
      return {
        message: "The AI service is busy or out of quota right now. Please try again in a minute.",
        retryable: true,
      };
    case "auth":
      return {
        message: "The AI service rejected the server's credentials. Check the API keys in .env.",
        retryable: false,
      };
    case "timeout":
      return { message: "The AI took too long to respond. Please try again.", retryable: true };
    case "network":
    case "server":
      return { message: "Couldn't reach the AI service. Please try again.", retryable: true };
    case "invalid_output":
      return {
        message: "The AI returned an answer I couldn't use safely. Please try rephrasing.",
        retryable: true,
      };
    default:
      return { message: "Something went wrong while preparing the lesson. Please try again.", retryable: true };
  }
}
