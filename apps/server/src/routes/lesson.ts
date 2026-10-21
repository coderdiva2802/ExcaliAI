// ─────────────────────────────────────────────────────────
// Lesson Routes
//
// POST /api/lesson               — start a new lesson   (SSE response)
// POST /api/lesson/:id/message   — continue a lesson    (SSE response)
// GET  /api/lesson/:id           — lesson summary (turns + diagrams)
// POST /api/lesson/:id/undo      — roll back the last turn (returns canvas actions)
// ─────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { CanvasState, SSEEvent } from "@excaliai/shared";
import { TutorAgent } from "../agent/TutorAgent.js";
import { undoLastTurn } from "../agent/memory.js";
import { userMessageFor } from "../llm/errors.js";
import { LESSON_ID_PATTERN, type LessonRepository } from "../storage/lessonRepository.js";

// ── Request validation ─────────────────────────────────

const finite = z.number().finite().catch(0);
const CanvasElementSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["text", "rectangle", "circle", "diamond", "arrow", "line", "formula", "code", "freedraw", "other"]).catch("other"),
  x: finite,
  y: finite,
  width: z.number().finite().nonnegative().optional().catch(undefined),
  height: z.number().finite().nonnegative().optional().catch(undefined),
  text: z.string().max(2000).optional().catch(undefined),
  latex: z.string().max(2000).optional().catch(undefined),
  code: z.string().max(10000).optional().catch(undefined),
  language: z.string().max(30).optional().catch(undefined),
  fromId: z.string().max(128).optional().catch(undefined),
  toId: z.string().max(128).optional().catch(undefined),
  diagramId: z.string().max(64).optional().catch(undefined),
});

const MessageBodySchema = z.object({
  prompt: z.string({ required_error: "Please type a question.", invalid_type_error: "Please type a question." }).trim().min(1, "Please type a question.").max(2000, "That message is too long (2000 characters max)."),
  canvasState: z
    .object({
      elements: z.array(CanvasElementSchema).max(5000).default([]),
      viewport: z.object({ scrollX: finite, scrollY: finite, zoom: finite }).catch({ scrollX: 0, scrollY: 0, zoom: 1 }),
    })
    .default({ elements: [], viewport: { scrollX: 0, scrollY: 0, zoom: 1 } }),
});

// ── SSE helpers ────────────────────────────────────────

function openStream(reply: FastifyReply): (event: SSEEvent) => void {
  // Headers set by plugins (e.g. CORS) live on the Fastify reply; carry them over
  // because a hijacked response bypasses Fastify's serialization.
  const pluginHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined)
  );
  reply.hijack();
  reply.raw.writeHead(200, {
    ...pluginHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders?.();
  return (event) => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

// ── Routes ─────────────────────────────────────────────

export function lessonRoutes(repo: LessonRepository) {
  const agent = new TutorAgent(repo);
  /** One running turn per lesson; a newer request cancels the older one. */
  const running = new Map<string, AbortController>();

  async function handleTurn(request: FastifyRequest, reply: FastifyReply, lessonId: string) {
    const body = MessageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? "Invalid request" });
    }

    running.get(lessonId)?.abort();
    const controller = new AbortController();
    running.set(lessonId, controller);

    const emit = openStream(reply);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, 15_000);
    // The client went away (stop button, refresh, network loss) → stop spending LLM calls.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });

    emit({ type: "lesson", lessonId });
    try {
      await agent.runTurn(lessonId, body.data.prompt, body.data.canvasState as CanvasState, emit, controller.signal);
    } catch (err) {
      request.log.error({ err }, "turn failed");
      if (!controller.signal.aborted) emit({ type: "error", ...userMessageFor(err) });
    } finally {
      clearInterval(heartbeat);
      if (running.get(lessonId) === controller) running.delete(lessonId);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  }

  return async function register(app: FastifyInstance) {
    app.post("/api/lesson", (request, reply) => handleTurn(request, reply, nanoid(16)));

    app.post<{ Params: { id: string } }>("/api/lesson/:id/message", (request, reply) => {
      if (!LESSON_ID_PATTERN.test(request.params.id)) return reply.status(400).send({ error: "Invalid lesson id" });
      return handleTurn(request, reply, request.params.id);
    });

    app.get<{ Params: { id: string } }>("/api/lesson/:id", async (request, reply) => {
      const memory = LESSON_ID_PATTERN.test(request.params.id) ? await repo.load(request.params.id) : null;
      if (!memory) return reply.status(404).send({ error: "Lesson not found" });
      return {
        lessonId: memory.lessonId,
        topic: memory.topic,
        turns: memory.turns.map((t) => ({ user: t.user, intent: t.intent, steps: t.steps, question: t.question })),
        diagrams: memory.diagrams.map((d) => ({ id: d.id, title: d.title, kind: d.kind, status: d.status })),
        canUndo: (memory.history?.length ?? 0) > 0,
      };
    });

    app.post<{ Params: { id: string } }>("/api/lesson/:id/undo", async (request, reply) => {
      const id = request.params.id;
      if (!LESSON_ID_PATTERN.test(id)) return reply.status(400).send({ error: "Invalid lesson id" });
      running.get(id)?.abort(); // a turn still being generated is cancelled, not undone
      const memory = await repo.load(id);
      if (!memory) return reply.status(404).send({ error: "Lesson not found" });
      const result = undoLastTurn(memory);
      if (!result) return reply.status(409).send({ error: "There's nothing to undo." });
      await repo.save(result.memory);
      return {
        actions: result.actions,
        undone: result.undone,
        topic: result.memory.topic,
        canUndo: (result.memory.history?.length ?? 0) > 0,
      };
    });
  };
}
