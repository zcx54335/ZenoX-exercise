import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const tmpDir = path.join(dataDir, ".tmp");

loadEnvFile();

const ttlHours = Number(process.argv.find((arg) => arg.startsWith("--hours="))?.split("=")[1] || process.env.TMP_FILE_TTL_HOURS || 168);
const cutoff = Number.isFinite(ttlHours) && ttlHours > 0
  ? Date.now() - ttlHours * 60 * 60 * 1000
  : Number.POSITIVE_INFINITY;

const resolvedTmp = path.resolve(tmpDir);
if (!resolvedTmp.startsWith(path.resolve(dataDir))) {
  throw new Error(`拒绝清理 data 目录外的路径：${resolvedTmp}`);
}

let removedFiles = 0;
let removedBytes = 0;

await visit(resolvedTmp);

console.log(`运行时临时文件清理完成：删除 ${removedFiles} 个文件，释放 ${formatBytes(removedBytes)}。`);

async function visit(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(target);
      await fs.rmdir(target).catch(() => {});
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    await fs.rm(target, { force: true });
    removedFiles += 1;
    removedBytes += stat.size;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
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
