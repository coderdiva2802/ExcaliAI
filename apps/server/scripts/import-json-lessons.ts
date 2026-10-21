// ─────────────────────────────────────────────────────────
// One-time import: copy lessons saved as JSON files (the
// fallback store used when PostgreSQL was unavailable) into
// the database.  Existing database rows are left untouched
// unless the file is newer.  The JSON files are not deleted.
//
//   npx tsx scripts/import-json-lessons.ts
// ─────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { prisma, checkDatabaseConnection } from "../src/db/client.js";
import { LESSON_ID_PATTERN } from "../src/storage/lessonRepository.js";
import type { LessonMemory } from "../src/agent/memory.js";

if (!(await checkDatabaseConnection())) {
  console.error("Database not reachable — check DATABASE_URL in .env");
  process.exit(1);
}

const files = (await fs.readdir(config.dataDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
let imported = 0, skipped = 0;
for (const file of files) {
  const id = file.replace(/\.json$/, "");
  if (!LESSON_ID_PATTERN.test(id)) continue;
  const memory = JSON.parse(await fs.readFile(path.join(config.dataDir, file), "utf8")) as LessonMemory;
  if (memory.version !== 1 || !Array.isArray(memory.turns)) { skipped++; continue; }
  const stat = await fs.stat(path.join(config.dataDir, file));
  const existing = await prisma.lesson.findUnique({ where: { id }, select: { updatedAt: true } });
  if (existing && existing.updatedAt >= stat.mtime) { skipped++; continue; }
  const data = { topic: memory.topic || "Untitled lesson", title: memory.topic || null, lessonState: memory as never };
  await prisma.lesson.upsert({ where: { id }, create: { id, ...data }, update: data });
  imported++;
}
console.log(`Imported ${imported} lesson(s), skipped ${skipped}.`);
await prisma.$disconnect();
