// ─────────────────────────────────────────────────────────
// Lesson persistence.
//
// LessonMemory is the single source of truth for a lesson's
// conversation/explanation/diagram state.  It is stored in
// PostgreSQL (Lesson.lessonState) when the database is up,
// otherwise as one JSON file per lesson under DATA_DIR — so
// context survives browser refreshes AND server restarts.
// ─────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../db/client.js";
import type { LessonMemory } from "../agent/memory.js";

export const LESSON_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export interface LessonRepository {
  load(id: string): Promise<LessonMemory | null>;
  save(memory: LessonMemory): Promise<void>;
}

function isMemory(value: unknown): value is LessonMemory {
  const v = value as LessonMemory | null;
  return !!v && v.version === 1 && Array.isArray(v.turns) && Array.isArray(v.diagrams);
}

/** Small write-through cache in front of any repository. */
abstract class CachedRepository implements LessonRepository {
  private cache = new Map<string, LessonMemory>();
  protected abstract read(id: string): Promise<unknown>;
  protected abstract write(memory: LessonMemory): Promise<void>;

  async load(id: string): Promise<LessonMemory | null> {
    if (!LESSON_ID_PATTERN.test(id)) return null;
    const cached = this.cache.get(id);
    if (cached) return structuredClone(cached);
    try {
      const value = await this.read(id);
      if (!isMemory(value)) return null;
      this.cache.set(id, value);
      return structuredClone(value);
    } catch (err) {
      console.warn(`💾 could not load lesson ${id}:`, (err as Error).message);
      return null;
    }
  }

  async save(memory: LessonMemory): Promise<void> {
    if (!LESSON_ID_PATTERN.test(memory.lessonId)) throw new Error("invalid lesson id");
    this.cache.set(memory.lessonId, structuredClone(memory));
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    try {
      await this.write(memory);
    } catch (err) {
      // The in-memory copy still lets the session continue.
      console.error(`💾 could not persist lesson ${memory.lessonId}:`, (err as Error).message);
    }
  }
}

export class FileLessonRepository extends CachedRepository {
  constructor(private dir: string) {
    super();
  }

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  protected async read(id: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  protected async write(memory: LessonMemory): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(memory.lessonId)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(memory), "utf8");
    await fs.rename(tmp, this.file(memory.lessonId)); // atomic replace
  }
}

export class PrismaLessonRepository extends CachedRepository {
  protected async read(id: string): Promise<unknown> {
    const lesson = await prisma.lesson.findUnique({ where: { id }, select: { lessonState: true } });
    return lesson?.lessonState ?? null;
  }

  protected async write(memory: LessonMemory): Promise<void> {
    const data = { topic: memory.topic || "Untitled lesson", title: memory.topic || null, lessonState: memory as never };
    await prisma.lesson.upsert({ where: { id: memory.lessonId }, create: { id: memory.lessonId, ...data }, update: data });
  }
}
