import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadDir = path.join(rootDir, "uploads");

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL || "";
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL，无法迁移上传文件到 PostgreSQL。");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: postgresSslConfig(databaseUrl)
});

try {
  await pool.query(`
    create table if not exists zenox_file_objects (
      key text primary key,
      content_type text not null default 'application/octet-stream',
      body bytea not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  const files = await listFiles(uploadDir);
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;
  for (const filePath of files) {
    const key = path.relative(uploadDir, filePath).split(path.sep).join("/");
    if (!key || key === ".gitkeep") {
      skipped += 1;
      continue;
    }
    const body = await fs.readFile(filePath);
    await pool.query(
      `insert into zenox_file_objects (key, content_type, body, updated_at)
       values ($1, $2, $3, now())
       on conflict (key) do update
       set content_type = excluded.content_type,
           body = excluded.body,
           updated_at = now()`,
      [key, contentTypeFor(filePath), body]
    );
    uploaded += 1;
    bytes += body.length;
    if (uploaded % 20 === 0) console.log(`已迁移 ${uploaded} 个文件...`);
  }
  console.log(`上传文件迁移完成：已写入 ${uploaded} 个文件，跳过 ${skipped} 个文件，共 ${formatBytes(bytes)}。`);
} finally {
  await pool.end();
}

async function listFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

function contentTypeFor(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }[ext] || "application/octet-stream";
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
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
