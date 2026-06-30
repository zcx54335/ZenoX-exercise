import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
const pageImageDir = path.join(uploadDir, "pages");
const dbPath = path.join(dataDir, "db.json");
const schemaPath = path.join(rootDir, "docs", "saas-postgres-schema.sql");
loadEnvFile();

const emptyDb = {
  organizations: [],
  users: [],
  questions: [],
  pendingQuestions: [],
  students: [],
  assignments: [],
  mistakes: [],
  uploads: [],
  jobs: [],
  aiUsage: [],
  auditLogs: [],
  activity: []
};

await fs.mkdir(dataDir, { recursive: true });
await fs.rm(uploadDir, { recursive: true, force: true });
await fs.mkdir(pageImageDir, { recursive: true });

if ((process.env.STORAGE_DRIVER || "").toLowerCase() === "postgres") {
  const { Pool } = await import("pg");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("STORAGE_DRIVER=postgres 时必须配置 DATABASE_URL");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const schemaSql = await fs.readFile(schemaPath, "utf8");
    await pool.query(schemaSql);
    await pool.query("begin");
    await pool.query("delete from audit_logs");
    await pool.query("delete from ai_usage");
    await pool.query("delete from jobs");
    await pool.query("delete from assignments");
    await pool.query("delete from mistakes");
    await pool.query("delete from students");
    await pool.query("delete from pending_questions");
    await pool.query("delete from questions");
    await pool.query("delete from uploads");
    await pool.query("delete from users");
    await pool.query("delete from organizations");
    await pool.query(
      `insert into zenox_app_state (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [process.env.POSTGRES_STATE_ID || "zenox-app-state", JSON.stringify(emptyDb)]
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback").catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
} else {
  await fs.writeFile(dbPath, JSON.stringify(emptyDb, null, 2), "utf8");
}

console.log("已清空题库、待审核、学生、作业、错题、上传记录和上传文件。");

function loadEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}
