import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadDir = path.join(rootDir, "uploads");

loadEnvFile();

const bucket = process.env.S3_BUCKET || "";
if (!bucket) {
  console.error("缺少 S3_BUCKET，无法迁移上传文件。");
  process.exit(1);
}

if (!existsSync(uploadDir)) {
  console.error(`没有找到本地上传目录：${uploadDir}`);
  process.exit(1);
}

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
      }
    : undefined
});

let uploaded = 0;
let skipped = 0;

for (const filePath of await walk(uploadDir)) {
  const key = path.relative(uploadDir, filePath).split(path.sep).join("/");
  if (!key || key === ".gitkeep") {
    skipped += 1;
    continue;
  }
  const bytes = await fs.readFile(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentTypeFor(filePath)
  }));
  uploaded += 1;
  if (uploaded % 20 === 0) console.log(`已上传 ${uploaded} 个文件...`);
}

console.log(`迁移完成：已上传 ${uploaded} 个文件，跳过 ${skipped} 个文件。`);
console.log("本地 uploads/ 没有删除；确认对象存储可用后再自行清理。");

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream";
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
