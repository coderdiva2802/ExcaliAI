// ─────────────────────────────────────────────────────────
// Sketch library routes
//
// GET  /api/sketches               — the library (no drawings)
// POST /api/sketches/:id/approve   — keep a draft for everyone
// POST /api/sketches/:id/reject    — delete a bad sketch (the next request redraws it)
//
// Approve / reject need the id of the lesson that created the
// sketch, so a sketch can only be reviewed by the lesson that saw it.
// ─────────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LESSON_ID_PATTERN } from "../storage/lessonRepository.js";
import { SKETCH_ID, forgetSketch, registerSketch, sketchStore } from "../sketch/store.js";

const ReviewBody = z.object({ lessonId: z.string().regex(LESSON_ID_PATTERN) });

export function sketchRoutes() {
  return async function register(app: FastifyInstance) {
    app.get("/api/sketches", async () => {
      const all = await sketchStore().list();
      return all.map((s) => ({
        id: s.id, key: s.key, title: s.title, status: s.status, source: s.source.kind,
        credit: s.source.credit, url: s.source.url, parts: s.drawing.parts.map((p) => p.name), createdAt: s.createdAt,
      }));
    });

    const review = (action: "approve" | "reject") => async (request: { params: { id: string }; body: unknown }, reply: import("fastify").FastifyReply) => {
      const { id } = request.params;
      const body = ReviewBody.safeParse(request.body);
      if (!SKETCH_ID.test(id) || !body.success) return reply.status(400).send({ error: "Invalid request" });
      const store = sketchStore();
      const sketch = await store.get(id);
      if (!sketch) return reply.status(404).send({ error: "That sketch is no longer in the library." });
      if (sketch.lessonId !== body.data.lessonId) return reply.status(403).send({ error: "Only the lesson that created this sketch can review it." });
      if (action === "approve") {
        const approved = { ...sketch, status: "approved" as const };
        await store.save(approved);
        registerSketch(approved);
        // Other drafts of the same subject from this lesson are superseded.
        for (const other of await store.find(sketch.key, sketch.lessonId)) {
          if (other.id !== id && other.status === "draft") await store.remove(other.id);
        }
        return { status: "approved" };
      }
      await store.remove(id);
      forgetSketch(id);
      return { status: "rejected" };
    };

    app.post<{ Params: { id: string } }>("/api/sketches/:id/approve", review("approve"));
    app.post<{ Params: { id: string } }>("/api/sketches/:id/reject", review("reject"));
  };
}
