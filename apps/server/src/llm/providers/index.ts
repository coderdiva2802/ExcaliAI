// ─────────────────────────────────────────────────────────
// Provider factories.  Each returns null when the provider is
// not configured, so the router can simply skip it.
// ─────────────────────────────────────────────────────────

import { GoogleGenAI, type Content } from "@google/genai";
import { config } from "../../config.js";
import { LLMError } from "../errors.js";
import type { AIProvider, AIRequest, AITask, ProviderId } from "../types.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { createMistralProvider } from "./mistral.js";
import { FixtureProvider } from "./fixtures.js";

// ── Gemini (Google GenAI SDK, already a dependency) ────

class GeminiProvider implements AIProvider {
  readonly provider = "gemini" as const;
  readonly name: string;
  private static client: GoogleGenAI | null = null;

  constructor(readonly model: string) {
    this.name = `gemini:${model}`;
    GeminiProvider.client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }

  async complete(req: AIRequest): Promise<string> {
    const contents: Content[] = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const response = await GeminiProvider.client!.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: req.system,
        temperature: req.temperature ?? 0.3,
        abortSignal: req.signal,
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    });
    const text = response.text ?? "";
    if (!text.trim()) throw new LLMError("invalid_output", "Empty response", this.name);
    return text;
  }
}

// ── Ollama (local) ─────────────────────────────────────

class OllamaProvider implements AIProvider {
  readonly provider = "ollama" as const;
  readonly name: string;

  constructor(readonly model: string) {
    this.name = `ollama:${model}`;
  }

  async complete(req: AIRequest): Promise<string> {
    const response = await fetch(`${config.ollama.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        options: { temperature: req.temperature ?? 0.3 },
        ...(req.json ? { format: "json" } : {}),
      }),
      signal: req.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 300)}`), { status: response.status });
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const text = data.message?.content ?? "";
    if (!text.trim()) throw new LLMError("invalid_output", "Empty response", this.name);
    return text;
  }
}

// ── Factory ────────────────────────────────────────────

/** All providers (possibly several models) configured for `provider` and `task`, in preference order. */
export function providersFor(provider: ProviderId, task: AITask): AIProvider[] {
  switch (provider) {
    case "mistral": {
      const p = createMistralProvider(task);
      return p ? [p] : [];
    }
    case "openrouter":
      return config.openrouter.models[task].map((m) => createOpenRouterProvider(m)).filter((p): p is AIProvider => p !== null);
    case "gemini":
      if (!config.gemini.apiKey) return [];
      return [...new Set(task === "designer" ? [config.gemini.models.creator, config.gemini.models.planner] : [config.gemini.models.planner])].map(
        (m) => new GeminiProvider(m)
      );
    case "groq":
      if (!config.groq.apiKey) return [];
      return [
        new OpenAICompatibleProvider({ provider: "groq", model: config.groq.model, baseUrl: "https://api.groq.com/openai/v1", apiKey: config.groq.apiKey }),
      ];
    case "fixtures":
      return config.nodeEnv === "production" ? [] : [new FixtureProvider()];
    case "ollama":
      return config.ollama.enabled ? [new OllamaProvider(task === "designer" ? config.ollama.models.creator : config.ollama.models.planner)] : [];
    default:
      return [];
  }
}
