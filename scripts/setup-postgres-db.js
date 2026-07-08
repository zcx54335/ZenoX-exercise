import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL，请先配置 PostgreSQL 连接串。");
  process.exit(1);
}

const targetUrl = new URL(databaseUrl);
const dbName = targetUrl.pathname.replace(/^\//, "") || "zenox_exercise";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
  console.error(`数据库名不安全：${dbName}`);
  process.exit(1);
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";

const pool = new Pool({
  connectionString: adminUrl.toString(),
  ssl: postgresSslConfig(databaseUrl)
});

try {
  const exists = await pool.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount) {
    console.log(`数据库已存在：${dbName}`);
  } else {
    await pool.query(`create database ${quoteIdentifier(dbName)}`);
    console.log(`已创建数据库：${dbName}`);
  }
} finally {
  await pool.end();
}

function quoteIdentifier(value = "") {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function postgresSslConfig(url = "") {
  if (process.env.POSTGRES_SSL === "false") return false;
  if (process.env.POSTGRES_SSL === "true" || /sslmode=require/i.test(url)) {
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
