// ─────────────────────────────────────────────────────────
// Prisma Client Singleton
// ─────────────────────────────────────────────────────────

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

let dbAvailable = false;

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
    console.log("🐘 PostgreSQL connected successfully.");
    return true;
  } catch {
    dbAvailable = false;
    console.log("ℹ️  PostgreSQL not available — lessons will be persisted as JSON files instead.");
    return false;
  }
}

export function isDbAvailable(): boolean {
  return dbAvailable;
}
