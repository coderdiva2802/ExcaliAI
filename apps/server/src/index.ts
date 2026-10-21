// ─────────────────────────────────────────────────────────
// Server Entry Point
// ─────────────────────────────────────────────────────────

import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, validateConfig } from "./config.js";
import { lessonRoutes } from "./routes/lesson.js";
import { sketchRoutes } from "./routes/sketches.js";
import { checkDatabaseConnection } from "./db/client.js";
import { FileLessonRepository, PrismaLessonRepository } from "./storage/lessonRepository.js";
import { describeRoutes, verifyRoutes } from "./llm/router.js";
import { providerHealth } from "./llm/health.js";

async function main() {
  validateConfig();
  await verifyRoutes();
  console.log(describeRoutes());
  const dbUp = await checkDatabaseConnection();
  const repo = dbUp ? new PrismaLessonRepository() : new FileLessonRepository(config.dataDir);
  if (!dbUp) console.log(`💾 Persisting lessons as JSON files in ${config.dataDir}`);

  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: { level: config.nodeEnv === "development" ? "info" : "warn" },
  });

  await app.register(cors, {
    origin: config.cors.origin,
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Provider health contains route names and status only — never keys or prompts.
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    ai: providerHealth.snapshot(),
  }));
  await app.register(lessonRoutes(repo));
  await app.register(sketchRoutes());

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`\n🎨 ExcaliAI server → http://localhost:${config.port}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
