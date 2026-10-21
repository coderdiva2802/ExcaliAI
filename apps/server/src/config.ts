// ─────────────────────────────────────────────────────────
// Server Configuration
// ─────────────────────────────────────────────────────────
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load from current working directory, then the monorepo root.
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const isPlaceholder = (key: string) => !key || key.startsWith("your-");
const secret = (name: string) => (isPlaceholder(process.env[name]?.trim() || "") ? "" : process.env[name]!.trim());
const list = (value: string | undefined, fallback: string) =>
  (value?.trim() || fallback).split(",").map((s) => s.trim()).filter(Boolean);

/** "fixtures" replays canned lessons for quota-free testing (development only). */
const PROVIDERS = ["mistral", "openrouter", "gemini", "groq", "ollama", "fixtures"] as const;
type ConfiguredProvider = (typeof PROVIDERS)[number];
/**
 * Default order = daily free capacity first:
 *   Mistral (Experiment tier: per-second/-minute limits, large monthly budget)
 *   Groq (per-minute + daily token limits that reset quickly)
 *   OpenRouter free models (50 requests/day without credits)
 *   Gemini free tier (≈20 requests/day per model)
 * Unconfigured providers are skipped automatically.
 */
const DEFAULT_ORDER = "mistral,groq,openrouter,gemini,ollama";
const providerOrder = (value: string | undefined): ConfiguredProvider[] => {
  const parsed = list(value, process.env.AI_PROVIDER_ORDER || DEFAULT_ORDER).map((p) => p.toLowerCase());
  const unknown = parsed.filter((p) => !(PROVIDERS as readonly string[]).includes(p));
  if (unknown.length) console.warn(`[AI] ignoring unknown provider(s) in order: ${unknown.join(", ")}`);
  return [...new Set(parsed.filter((p): p is ConfiguredProvider => (PROVIDERS as readonly string[]).includes(p)))];
};

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  host: process.env.HOST || "0.0.0.0",
  nodeEnv: process.env.NODE_ENV || "development",

  /** Routing policy: ordered provider list per task (AI_PLANNER_ORDER / AI_DESIGNER_ORDER override AI_PROVIDER_ORDER). */
  ai: {
    order: {
      planner: providerOrder(process.env.AI_PLANNER_ORDER),
      designer: providerOrder(process.env.AI_DESIGNER_ORDER),
    },
    /** Send provider/model metadata to the browser (debug panel). Defaults to on in development. */
    exposeMeta: (process.env.AI_EXPOSE_META ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",
  },

  mistral: {
    apiKey: secret("MISTRAL_API_KEY"),
    baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
    models: {
      planner: process.env.MISTRAL_PLANNER_MODEL || "mistral-small-latest",
      designer: process.env.MISTRAL_DESIGNER_MODEL || "mistral-medium-latest",
    },
  },

  openrouter: {
    apiKey: secret("OPENROUTER_API_KEY"),
    baseUrl: "https://openrouter.ai/api/v1",
    appUrl: process.env.OPENROUTER_APP_URL || "http://localhost:5173",
    /** Paid models are refused unless explicitly allowed. */
    allowPaid: process.env.OPENROUTER_ALLOW_PAID === "true",
    /**
     * Free models chosen by benchmarking the real planner/designer prompts on a
     * free-tier key (`npm run ai:benchmark`). 2026-10-06: qwen3.8-27b:free left the
     * catalogue; dots-3-note-preview replaced it (schema-valid, zero repairs on a
     * Phase B question). Different primaries per task spread load across upstream
     * free capacity. Gemma 4 is excluded (throttled upstream on both dates).
     */
    models: {
      planner: list(process.env.OPENROUTER_PLANNER_MODELS, "dots-studio/dots-3-note-preview:free,nvidia/nemotron-3-super-120b-a12b:free"),
      designer: list(process.env.OPENROUTER_DESIGNER_MODELS, "nvidia/nemotron-3-super-120b-a12b:free,dots-studio/dots-3-note-preview:free"),
    },
  },

  groq: {
    apiKey: secret("GROQ_API_KEY"),
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  },

  gemini: {
    apiKey: secret("GEMINI_API_KEY"),
    models: {
      planner: process.env.GEMINI_PLANNER_MODEL || "gemini-3-flash-preview",
      creator: process.env.GEMINI_CREATOR_MODEL || "gemini-3-flash-preview",
    },
  },

  ollama: {
    enabled: process.env.USE_OLLAMA === "true",
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    models: {
      planner: process.env.OLLAMA_PLANNER_MODEL || "llama3",
      creator: process.env.OLLAMA_CREATOR_MODEL || "qwen2.5-coder",
    },
  },

  llm: {
    /** Per-attempt timeouts (ms). */
    plannerTimeoutMs: parseInt(process.env.LLM_PLANNER_TIMEOUT_MS || "90000", 10), // worked examples are long answers
    designerTimeoutMs: parseInt(process.env.LLM_DESIGNER_TIMEOUT_MS || "90000", 10),
  },

  /** Sketching structures that have no built-in template (see src/sketch/). */
  sketch: {
    /** Folder of your own labelled SVGs (+ optional <name>.json with title/aliases/author/license). */
    dir: process.env.SKETCH_DIR || path.resolve(__dirname, "../resources/sketches"),
    /** Search open-licensed online libraries (Wikimedia Commons). */
    online: process.env.SKETCH_ONLINE !== "false",
    /** Only these hosts are ever fetched from. */
    allowHosts: list(process.env.SKETCH_ALLOW_HOSTS, "commons.wikimedia.org,upload.wikimedia.org").map((h) => h.toLowerCase()),
    /** Wikimedia asks API clients to identify themselves. */
    userAgent: process.env.SKETCH_USER_AGENT || "ExcaliAI/0.1 (educational whiteboard tutor)",
    fetchTimeoutMs: parseInt(process.env.SKETCH_FETCH_TIMEOUT_MS || "10000", 10),
    /** Total time spent trying online candidates for one subject. */
    budgetMs: parseInt(process.env.SKETCH_BUDGET_MS || "20000", 10),
    maxCandidates: parseInt(process.env.SKETCH_MAX_CANDIDATES || "5", 10),
    maxDownloadBytes: 1_500_000,
    /** Let the AI sketch from simple shapes when no reference diagram is found. */
    freehand: process.env.SKETCH_FREEHAND !== "false",
  },

  /** Where lessons are persisted when PostgreSQL is not available. */
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, "../.data"),

  cors: {
    origin: (() => {
      const val = process.env.CORS_ORIGIN?.trim();
      if (!val) return "http://localhost:5173";
      if (val === "*") return true;
      if (val.includes(",")) return val.split(",").map((s) => s.trim()).filter(Boolean);
      return val;
    })(),
  },
};

/** True when at least one real LLM provider is configured. */
export function hasLLMProvider(): boolean {
  return Boolean(
    config.mistral.apiKey || config.openrouter.apiKey || config.gemini.apiKey || config.groq.apiKey || config.ollama.enabled
  );
}

export function validateConfig(): void {
  if (!hasLLMProvider()) {
    console.warn(
      `\n⚠️  No LLM provider configured (MISTRAL_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / USE_OLLAMA).\n` +
        `   The server will run in demo mode with canned lessons.\n`
    );
  }
}
