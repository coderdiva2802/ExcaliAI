// ─────────────────────────────────────────────────────────
// Sketch library.
//
// Sketches live in PostgreSQL (Sketch table) when the database
// is up, otherwise as JSON files under DATA_DIR/sketches. An
// in-memory registry keeps the ones in use, so the synchronous
// validate/layout stages can draw them.
//
// Reuse rules: approved sketches are used for everyone; a draft
// is used only in the lesson that created it.
// ─────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { isDbAvailable, prisma } from "../db/client.js";
import type { Template } from "../diagram/templates.js";
import type { SketchSource } from "./sources.js";

export type SketchStatus = "draft" | "approved";

export interface SketchRecord {
  id: string;
  key: string;
  slug: string;
  title: string;
  status: SketchStatus;
  lessonId: string | null;
  source: SketchSource;
  drawing: Omit<Template, "id" | "title">;
  createdAt: string;
}

export const SKETCH_ID = /^sk_[a-z0-9]{10,24}$/;
export const newSketchId = () => `sk_${nanoid(14).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;

// ── Registry (synchronous access for layout) ───────────

const registry = new Map<string, SketchRecord>();
export function registerSketch(s: SketchRecord): void {
  registry.set(s.id, s);
  if (registry.size > 300) registry.delete(registry.keys().next().value!);
}
export const registeredSketch = (id: string | undefined) => (id ? registry.get(id) : undefined);
export const forgetSketch = (id: string) => registry.delete(id);

// ── Persistence ────────────────────────────────────────

export interface SketchStore {
  get(id: string): Promise<SketchRecord | null>;
  /** Approved sketches for the key, plus drafts from this lesson. Newest first. */
  find(key: string, lessonId: string | null): Promise<SketchRecord[]>;
  save(s: SketchRecord): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<SketchRecord[]>;
}

function isRecord(v: unknown): v is SketchRecord {
  const r = v as SketchRecord | null;
  return !!r && typeof r.id === "string" && SKETCH_ID.test(r.id) && typeof r.key === "string" && Array.isArray(r.drawing?.paths) && Array.isArray(r.drawing?.parts);
}

class FileSketchStore implements SketchStore {
  constructor(private dir: string) {}
  private file(id: string) { return path.join(this.dir, `${id}.json`); }
  async get(id: string) {
    if (!SKETCH_ID.test(id)) return null;
    try {
      const v = JSON.parse(await fs.readFile(this.file(id), "utf8"));
      return isRecord(v) ? v : null;
    } catch { return null; }
  }
  async list() {
    let files: string[] = [];
    try { files = (await fs.readdir(this.dir)).filter((f) => /^sk_[a-z0-9]+\.json$/.test(f)); } catch { return []; }
    const out: SketchRecord[] = [];
    for (const f of files) { const r = await this.get(f.replace(/\.json$/, "")); if (r) out.push(r); }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async find(key: string, lessonId: string | null) {
    return (await this.list()).filter((s) => s.key === key && (s.status === "approved" || (lessonId && s.lessonId === lessonId)));
  }
  async save(s: SketchRecord) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(s.id)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s), "utf8");
    await fs.rename(tmp, this.file(s.id));
  }
  async remove(id: string) {
    if (SKETCH_ID.test(id)) await fs.rm(this.file(id), { force: true });
  }
}

class PrismaSketchStore implements SketchStore {
  private toRecord(row: { id: string; key: string; slug: string; title: string; status: string; lessonId: string | null; source: unknown; drawing: unknown; createdAt: Date }): SketchRecord | null {
    const r = { ...row, status: row.status === "approved" ? "approved" : "draft", createdAt: row.createdAt.toISOString() } as SketchRecord;
    return isRecord(r) ? r : null;
  }
  async get(id: string) {
    if (!SKETCH_ID.test(id)) return null;
    const row = await prisma.sketch.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }
  async find(key: string, lessonId: string | null) {
    const rows = await prisma.sketch.findMany({
      where: { key, OR: [{ status: "approved" }, ...(lessonId ? [{ lessonId }] : [])] },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows.map((r) => this.toRecord(r)).filter((r): r is SketchRecord => r !== null);
  }
  async save(s: SketchRecord) {
    const data = { key: s.key, slug: s.slug, title: s.title, status: s.status, lessonId: s.lessonId, source: s.source as never, drawing: s.drawing as never };
    await prisma.sketch.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
  }
  async remove(id: string) {
    await prisma.sketch.deleteMany({ where: { id } });
  }
  async list() {
    const rows = await prisma.sketch.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return rows.map((r) => this.toRecord(r)).filter((r): r is SketchRecord => r !== null);
  }
}

let store: SketchStore | null = null;
/** The store matching the lesson storage (decided after the startup DB check). */
export function sketchStore(): SketchStore {
  store ??= isDbAvailable() ? new PrismaSketchStore() : new FileSketchStore(path.join(config.dataDir, "sketches"));
  return store;
}
/** Tests: use a specific store. */
export function useSketchStore(s: SketchStore): void {
  store = s;
}
export { FileSketchStore };
