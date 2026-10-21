// ─────────────────────────────────────────────────────────
// Provider health registry (in-process, per "provider:model").
//
// Quota / auth / invalid-model failures put a route into a
// cool-down so every agent in every request skips it until it
// can plausibly work again (e.g. a daily quota reset), instead
// of paying for a guaranteed failure each time.
// ─────────────────────────────────────────────────────────

import type { LLMError } from "./errors.js";

export type HealthStatus = "healthy" | "rate_limited" | "quota_exhausted" | "unavailable";

interface Entry {
  status: HealthStatus;
  until: number;
  reason?: string;
  successes: number;
  failures: number;
  invalidOutputs: number;
  avgMs?: number;
}

const DEFAULT_COOLDOWN_MS: Partial<Record<LLMError["kind"], number>> = {
  quota: 15 * 60_000,
  auth: 60 * 60_000,
  bad_request: 15 * 60_000, // e.g. model removed / not available on this key
};
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;
/** Per-minute limits shorter than this are waited out in-request instead of skipping the route. */
export const MAX_INLINE_WAIT_MS = 12_000;

class ProviderHealth {
  private entries = new Map<string, Entry>();

  private entry(name: string): Entry {
    let e = this.entries.get(name);
    if (!e) {
      e = { status: "healthy", until: 0, successes: 0, failures: 0, invalidOutputs: 0 };
      this.entries.set(name, e);
    }
    if (e.status !== "healthy" && Date.now() >= e.until) {
      e.status = "healthy";
      e.reason = undefined;
    }
    return e;
  }

  register(name: string): void {
    this.entry(name);
  }

  isAvailable(name: string): boolean {
    return this.entry(name).status === "healthy";
  }

  /** Milliseconds until a cooling-down route may be tried again (0 if available). */
  retryIn(name: string): number {
    const e = this.entry(name);
    return e.status === "healthy" ? 0 : Math.max(0, e.until - Date.now());
  }

  markSuccess(name: string, ms: number): void {
    const e = this.entry(name);
    e.successes++;
    e.avgMs = e.avgMs === undefined ? ms : Math.round(e.avgMs * 0.7 + ms * 0.3);
  }

  markInvalidOutput(name: string): void {
    this.entry(name).invalidOutputs++;
  }

  /**
   * Record a failure; returns the cool-down applied (ms) or undefined when the route stays usable.
   * Account-level failures (bad key, no credits, account-wide cap) cool down every route of that provider.
   */
  markFailure(name: string, err: LLMError): number | undefined {
    const cooldown = this.applyFailure(name, err);
    if (cooldown && err.scope === "provider") {
      const prefix = name.slice(0, name.indexOf(":") + 1);
      for (const other of this.entries.keys()) if (other !== name && other.startsWith(prefix)) this.applyFailure(other, err, false);
    }
    return cooldown;
  }

  private applyFailure(name: string, err: LLMError, count = true): number | undefined {
    const e = this.entry(name);
    if (count) e.failures++;
    let cooldown: number | undefined;
    if (err.kind === "quota") cooldown = Math.min(err.retryAfterMs ?? DEFAULT_COOLDOWN_MS.quota!, MAX_COOLDOWN_MS);
    else if (err.kind === "rate_limit" && (err.retryAfterMs ?? 0) > MAX_INLINE_WAIT_MS) cooldown = Math.min(err.retryAfterMs!, MAX_COOLDOWN_MS);
    else cooldown = DEFAULT_COOLDOWN_MS[err.kind];
    if (cooldown) {
      e.status = err.kind === "quota" ? "quota_exhausted" : err.kind === "rate_limit" ? "rate_limited" : "unavailable";
      e.until = Date.now() + cooldown;
      e.reason = err.kind;
    }
    return cooldown;
  }

  /** Disable a route up front (e.g. startup verification found it is not free / not available). */
  disable(name: string, reason: string, ms = MAX_COOLDOWN_MS * 4): void {
    const e = this.entry(name);
    e.status = "unavailable";
    e.until = Date.now() + ms;
    e.reason = reason;
  }

  /** Safe, credential-free snapshot for logs and the health endpoint. */
  snapshot() {
    return [...this.entries.entries()].map(([name, _]) => {
      const e = this.entry(name);
      return {
        route: name,
        status: e.status,
        ...(e.status !== "healthy" ? { reason: e.reason, retryInSec: Math.ceil((e.until - Date.now()) / 1000) } : {}),
        successes: e.successes,
        failures: e.failures,
        invalidOutputs: e.invalidOutputs,
        ...(e.avgMs !== undefined ? { avgMs: e.avgMs } : {}),
      };
    });
  }

  /** Test helper. */
  reset(): void {
    this.entries.clear();
  }
}

export const providerHealth = new ProviderHealth();
