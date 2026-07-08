import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");
const schemaPath = path.join(rootDir, "docs", "saas-postgres-schema.sql");

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL;
const stateId = process.env.POSTGRES_STATE_ID || "zenox-app-state";

if (!databaseUrl) {
  console.error("缺少 DATABASE_URL，无法迁移到 PostgreSQL。");
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.error(`没有找到本地数据文件：${dbPath}`);
  process.exit(1);
}

const raw = await fs.readFile(dbPath, "utf8");
const data = JSON.parse(raw);
const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSslConfig() });

try {
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  await pool.query(schemaSql);
  await pool.query(
    `insert into zenox_app_state (id, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    [stateId, JSON.stringify(data)]
  );
  console.log(`已把 data/db.json 迁移到 PostgreSQL state: ${stateId}`);
  console.log("关系型表已创建；下次以 STORAGE_DRIVER=postgres 启动服务时会自动同步关系表。");
} finally {
  await pool.end();
}

function loadEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const rawEnv = readFileSync(envPath, "utf8");
  for (const line of rawEnv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function postgresSslConfig() {
  if (process.env.POSTGRES_SSL === "false") return false;
  if (process.env.POSTGRES_SSL === "true" || /sslmode=require/i.test(databaseUrl)) {
    return { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === "true" };
  }
  return undefined;
}
