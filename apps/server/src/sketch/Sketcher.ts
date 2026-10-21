// ─────────────────────────────────────────────────────────
// Sketcher — draws structures that have no built-in template.
//
//   labelled_diagram { template: "human_ear", labels: [...] }
//     → built-in template?              (handled by templates.ts)
//     → sketch library (saved before)   approved, or a draft of this lesson
//     → your local SVG folder           resources/sketches/
//     → Wikimedia Commons               freely licensed labelled SVGs
//     → AI freehand sketch              simple shapes, one repair round
//
// New sketches are saved as drafts (reused only in this lesson
// until approved), so each subject costs time and quota once.
// ─────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { z } from "zod";
import type { SSEEvent } from "@excaliai/shared";
import { config } from "../config.js";
import type { AIGateway } from "../llm/gateway.js";
import { redact } from "../llm/types.js";
import type { DiagramSpec } from "../diagram/spec.js";
import { resolveTemplate } from "../diagram/templates.js";
import { composeFreehand, FREEHAND_PROMPT, FreehandSchema, type FreehandResult } from "./freehand.js";
import { matchParts, subjectKey, subjectTitle, subjectWords, type Requested } from "./match.js";
import { findCommons, findLocal, type Found } from "./sources.js";
import { newSketchId, registerSketch, registeredSketch, sketchStore, type SketchRecord } from "./store.js";

export class SketchError extends Error {}

export interface PrepareOptions {
  lessonId: string;
  signal: AbortSignal;
  emit?: (e: SSEEvent) => void;
}

export interface Prepared {
  spec: DiagramSpec;
  /** The sketch used (null for built-in templates). */
  sketch: SketchRecord | null;
}

const MappingSchema = z.object({
  pairs: z.array(z.object({ requested: z.string().max(60), part: z.string().max(60).nullable().catch(null) })).max(20),
});

/** Stable id for a file in the local folder, so edits after a restart find the same sketch. */
const localId = (file: string) => `sk_l${createHash("sha1").update(file).digest("hex").slice(0, 13)}`;

export class Sketcher {
  /** One search per subject and lesson at a time. */
  private inflight = new Map<string, Promise<SketchRecord>>();

  constructor(private designer: AIGateway, private mapper: AIGateway) {}

  async prepare(spec: DiagramSpec, opts: PrepareOptions): Promise<Prepared> {
    const l = spec.labelled;
    if (spec.kind !== "labelled_diagram" || !l || resolveTemplate(l.template)) return { spec, sketch: null };
    const requested: Requested[] = l.labels.map((lb) => ({ part: lb.part, text: lb.text }));

    let sketch = await this.reuse(l.sketch);
    if (!sketch) {
      const key = `${subjectKey(l.template)}|${opts.lessonId}`;
      let job = this.inflight.get(key);
      if (!job) {
        job = this.resolve(l.template, spec.title, requested, opts).finally(() => this.inflight.delete(key));
        this.inflight.set(key, job);
      }
      sketch = await job;
    }
    registerSketch(sketch);
    const labels = await this.mapLabels(l.labels, sketch, opts.signal);
    return { spec: { ...spec, labelled: { template: l.template, sketch: sketch.id, labels } }, sketch };
  }

  /** A sketch already chosen for this diagram (edits, follow-ups). */
  private async reuse(id: string | undefined): Promise<SketchRecord | null> {
    if (!id) return null;
    return registeredSketch(id) ?? (await sketchStore().get(id).catch(() => null));
  }

  private async resolve(slug: string, title: string, requested: Requested[], opts: PrepareOptions): Promise<SketchRecord> {
    const key = subjectKey(slug);
    const words = subjectWords(slug);
    const store = sketchStore();

    // 1. Saved before: approved for everyone, or a draft from this lesson.
    const saved = await store.find(key, opts.lessonId).catch((err) => {
      console.warn("🖍  sketch library unavailable:", (err as Error).message.slice(0, 120));
      return [] as SketchRecord[];
    });
    const pick = saved.find((s) => s.status === "approved") ?? saved[0];
    if (pick) {
      console.log(`🖍  sketch "${key}" from the library (${pick.status})`);
      return pick;
    }

    // 2. Your own reference SVGs.
    opts.emit?.({ type: "progress", stage: "designing", label: `Looking for a reference diagram of the ${words}` });
    const local = await findLocal(slug, requested);
    if (local) {
      console.log(`🖍  sketch "${key}" from the local folder (${local.source.title})`);
      return this.record(local, slug, key, "approved", null, localId(local.source.title ?? slug));
    }

    // 3. Open-licensed online libraries.
    const online = await findCommons(slug, requested, opts.signal).catch((err) => {
      if (opts.signal.aborted) throw err;
      console.warn("🖍  online search failed:", (err as Error).message.slice(0, 120));
      return null;
    });
    const adapt = async (found: Found) => {
      const rec = this.record(found, slug, key, "draft", opts.lessonId);
      await store.save(rec).catch((err) => console.warn("🖍  could not save sketch:", (err as Error).message.slice(0, 120)));
      console.log(`🖍  sketch "${key}" adapted from ${found.source.title} (${found.source.license}), covers ${found.score}/${requested.length}`);
      return rec;
    };
    const minScore = requested.length ? Math.min(2, requested.length) : 0;
    if (online && online.score >= minScore) return adapt(online);

    // 4. AI freehand sketch — or, if that fails, a reference diagram that covers fewer of the requested parts.
    if (!config.sketch.freehand) {
      if (online) return adapt(online);
      throw new SketchError(`I couldn't find a reference diagram of the ${words}.`);
    }
    opts.emit?.({ type: "progress", stage: "designing", label: `Sketching the ${words}` });
    let drawn: Awaited<ReturnType<Sketcher["freehand"]>>;
    try {
      drawn = await this.freehand(words, title, requested, opts.signal);
    } catch (err) {
      if (opts.signal.aborted || !online) throw err;
      console.warn("🖍  freehand sketch failed → using the closest reference diagram:", redact((err as Error).message).slice(0, 120));
      return adapt(online);
    }
    const rec = this.record(
      { title: subjectTitle(slug), drawing: { paths: drawn.result.paths, parts: drawn.result.parts }, source: { kind: "ai", credit: "AI sketch from simple shapes — simplified, check details against a textbook" }, score: 0 },
      slug, key, "draft", opts.lessonId
    );
    await store.save(rec).catch((err) => console.warn("🖍  could not save sketch:", (err as Error).message.slice(0, 120)));
    console.log(`🖍  sketch "${key}" drawn freehand (${rec.drawing.parts.length} parts, ${rec.drawing.paths.length} shapes)`);
    return rec;
  }

  private record(found: Found, slug: string, key: string, status: SketchRecord["status"], lessonId: string | null, id = newSketchId()): SketchRecord {
    return { id, key, slug, title: found.title, status, lessonId, source: found.source, drawing: found.drawing, createdAt: new Date().toISOString() };
  }

  private async freehand(words: string, title: string, requested: Requested[], signal: AbortSignal): Promise<{ title: string; result: FreehandResult }> {
    const wanted = requested.map((r) => r.text ? `${r.part} (${r.text})` : r.part);
    const base = `SUBJECT: ${words}\nDIAGRAM TITLE: ${title}\nPARTS TO SHOW (use these ids): ${wanted.join(", ") || "the main textbook parts"}`;
    let best: { title: string; result: FreehandResult } | null = null;
    let feedback: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const content = feedback ? `${base}\n\nYour previous sketch had problems:\n${feedback}\nReturn a corrected, complete JSON sketch.` : base;
      const { data } = await this.designer.generateStructured(
        { system: FREEHAND_PROMPT, messages: [{ role: "user", content }], temperature: 0.4, maxTokens: 5000, signal },
        FreehandSchema
      );
      const result = composeFreehand(data, requested.map((r) => r.part));
      if (!best || result.problems.length < best.result.problems.length) best = { title: data.title, result };
      if (!result.problems.length) break;
      feedback = result.problems.map((p) => `- ${p}`).join("\n");
      console.log(`🖍  freehand sketch: ${result.problems.length} problem(s) → one repair round`);
    }
    if (!best || best.result.parts.length < 3 || best.result.paths.length < 3) throw new SketchError(`Couldn't sketch "${words}" reliably.`);
    return best;
  }

  /** Requested labels → the sketch's part ids (token match first, then one small LLM call for the rest). */
  private async mapLabels(labels: NonNullable<DiagramSpec["labelled"]>["labels"], sketch: SketchRecord, signal: AbortSignal) {
    const parts = sketch.drawing.parts;
    if (!labels.length) return [];
    const direct = new Map<number, string>();
    labels.forEach((lb, i) => { if (parts.some((p) => p.id === lb.part)) direct.set(i, lb.part); });
    const fuzzy = matchParts(labels.map((lb, i) => (direct.has(i) ? { part: "" } : { part: lb.part, text: lb.text })), parts.filter((p) => ![...direct.values()].includes(p.id)));
    const mapping = new Map([...direct, ...fuzzy]);

    const unmatched = labels.map((lb, i) => ({ lb, i })).filter(({ i }) => !mapping.has(i));
    const free = parts.filter((p) => ![...mapping.values()].includes(p.id));
    if (unmatched.length && free.length) {
      try {
        const { data } = await this.mapper.generateStructured(
          {
            system:
              "Match anatomical / scientific part names. For each REQUESTED name give the AVAILABLE name for the SAME structure " +
              "(a synonym: eardrum = tympanic membrane, hammer = malleus, pinna = auricle), otherwise null. A neighbouring, " +
              "connected or containing structure is NOT a match (inner ear ≠ round window, vestibular system ≠ vestibular nerve). " +
              "When unsure, use null. Return JSON {\"pairs\":[{\"requested\":string,\"part\":string|null}]} only.",
            messages: [{ role: "user", content: `REQUESTED: ${JSON.stringify(unmatched.map(({ lb }) => lb.text || lb.part))}\nAVAILABLE: ${JSON.stringify(free.map((p) => p.name))}` }],
            temperature: 0,
            maxTokens: 800,
            signal,
          },
          MappingSchema
        );
        for (const pair of data.pairs) {
          const u = unmatched.find(({ lb }) => (lb.text || lb.part) === pair.requested);
          const p = free.find((x) => x.name === pair.part);
          if (u && p && !mapping.has(u.i) && ![...mapping.values()].includes(p.id)) {
            mapping.set(u.i, p.id);
            console.log(`🖍  matched "${pair.requested}" → "${p.name}"`);
          }
        }
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn("🖍  label matching call failed:", redact((err as Error).message).slice(0, 120));
      }
    }
    const mapped = labels.flatMap((lb, i) => (mapping.has(i) ? [{ ...lb, part: mapping.get(i)! }] : []));
    if (mapped.length < labels.length) console.log(`🖍  ${labels.length - mapped.length} requested label(s) not in the sketch → dropped`);
    // Nothing matched: label every part of the sketch rather than none.
    return mapped.length ? mapped : [];
  }
}
