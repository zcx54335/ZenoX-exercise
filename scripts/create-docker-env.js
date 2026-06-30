import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const rootDir = process.cwd();
const deployDir = path.join(rootDir, "deploy");
const envPath = path.join(deployDir, "docker.env");
const force = process.argv.includes("--force");

function secret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

if (existsSync(envPath) && !force) {
  console.log("deploy/docker.env 已存在，已跳过。需要重新生成请执行：npm run docker:config -- --force");
  process.exit(0);
}

const postgresPassword = secret(18);
const minioPassword = secret(18);
const appSecret = secret(48);
const adminPassword = `Zx-${secret(12)}-Admin`;
const qwenApiKey = process.env.QWEN_API_KEY || "";

const content = `# Docker 一键部署配置
#
# 这份文件只保存在本机，不会提交到 Git。
# 换电脑时重新执行 npm run docker:config 生成即可。

PORT=8080
NODE_ENV=production
APP_SECRET=${appSecret}
ADMIN_USER=admin
ADMIN_PASSWORD=${adminPassword}
COOKIE_SECURE=false

DEFAULT_TENANT_ID=default-org
DEFAULT_ORG_NAME=默认机构
DEFAULT_TRIAL_DAYS=14
DEFAULT_MONTHLY_AI_TOKENS=200000
DEFAULT_MONTHLY_AI_PAGES=1000
MAX_UPLOAD_MB=80
MAX_IMAGE_UPLOAD_MB=12
RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT=240
LOGIN_RATE_LIMIT=12
UPLOAD_RATE_LIMIT=20

STORAGE_DRIVER=postgres
POSTGRES_DB=zenox_exercise
POSTGRES_USER=zenox
POSTGRES_PASSWORD=${postgresPassword}
DATABASE_URL=postgres://zenox:${postgresPassword}@postgres:5432/zenox_exercise
POSTGRES_STATE_ID=zenox-app-state
POSTGRES_SYNC_RELATIONAL=true

FILE_STORAGE_DRIVER=s3
MINIO_ROOT_USER=zenox
MINIO_ROOT_PASSWORD=${minioPassword}
S3_BUCKET=zenox-exercise
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY_ID=zenox
S3_SECRET_ACCESS_KEY=${minioPassword}
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=

QWEN_API_KEY=${qwenApiKey}
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_VISION_MODEL=qwen-vl-plus
ALLOW_MISSING_QWEN_API_KEY=true
`;

await mkdir(deployDir, { recursive: true });
await writeFile(envPath, content, "utf8");

console.log("已生成 deploy/docker.env");
console.log(`管理员账号：admin`);
console.log(`管理员密码：${adminPassword}`);
console.log("请把管理员密码保存好；如需 AI 功能，请在 deploy/docker.env 中填写 QWEN_API_KEY。");
