import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL，请先在 .env 中填写云端 PostgreSQL 连接串。");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: postgresSslConfig()
});

try {
  const result = await pool.query(`
    select
      current_database() as database,
      current_user as user_name,
      version() as version
  `);
  const row = result.rows[0] || {};
  console.log("云端 PostgreSQL 连接正常。");
  console.log(`database: ${row.database}`);
  console.log(`user: ${row.user_name}`);
  console.log(`version: ${String(row.version || "").split(",")[0]}`);
} finally {
  await pool.end();
}

function postgresSslConfig() {
  if (process.env.POSTGRES_SSL === "false") return false;
  if (process.env.POSTGRES_SSL === "true" || /sslmode=require/i.test(databaseUrl)) {
    return { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === "true" };
  }
  return undefined;
}

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
