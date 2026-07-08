import http from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createAnalysisDiagnostics, addDiagnosticEvent, upsertPageDiagnostic, finalizeAnalysisDiagnostics, compactAnalysisDiagnostics } from "./pipeline/analysis-diagnostics.js";
import { createOcrProvider } from "./pipeline/ocr-providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
const dbPath = path.join(dataDir, "db.json");
const pageImageDir = path.join(uploadDir, "pages");
const questionImageDir = path.join(uploadDir, "question-images");

loadEnvFile();

const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const APP_SECRET = process.env.APP_SECRET || "dev-secret-change-me";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen-plus";
const QWEN_VISION_MODEL = process.env.QWEN_VISION_MODEL || "qwen-vl-plus";
const QWEN_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS || 90000);
const WEB_SEARCH_PROVIDER = (process.env.WEB_SEARCH_PROVIDER || "disabled").toLowerCase();
const WEB_SEARCH_API_KEY = process.env.WEB_SEARCH_API_KEY || process.env.BING_SEARCH_API_KEY || process.env.SERPAPI_API_KEY || process.env.TAVILY_API_KEY || "";
const WEB_SEARCH_ENDPOINT = process.env.WEB_SEARCH_ENDPOINT || "";
const WEB_SEARCH_ENGINE = process.env.WEB_SEARCH_ENGINE || "baidu";
const WEB_SEARCH_LIMIT = Number(process.env.WEB_SEARCH_LIMIT || 8);
const WEB_SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 12000);
const WEB_SEARCH_IMAGE_TIMEOUT_MS = Number(process.env.WEB_SEARCH_IMAGE_TIMEOUT_MS || 10000);
const OCR_PROVIDER = (process.env.OCR_PROVIDER || "qwen").toLowerCase();
const OCR_LAYOUT_PROVIDER = (process.env.OCR_LAYOUT_PROVIDER || OCR_PROVIDER || "qwen").toLowerCase();
const OCR_LAYOUT_ENABLED = process.env.OCR_LAYOUT_ENABLED !== "false";
const PROMPT_VERSION = process.env.PROMPT_VERSION || "analysis-v2";
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || "default-org";
const DEFAULT_ADMIN_ID = process.env.DEFAULT_ADMIN_ID || "default-admin";
const DEFAULT_MONTHLY_AI_TOKENS = Number(process.env.DEFAULT_MONTHLY_AI_TOKENS || 200000);
const DEFAULT_MONTHLY_AI_PAGES = Number(process.env.DEFAULT_MONTHLY_AI_PAGES || 1000);
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || (process.env.DATABASE_URL ? "postgres" : "json")).toLowerCase();
const POSTGRES_STATE_ID = process.env.POSTGRES_STATE_ID || "zenox-app-state";
const POSTGRES_SYNC_RELATIONAL = process.env.POSTGRES_SYNC_RELATIONAL !== "false";
const FILE_STORAGE_DRIVER = (process.env.FILE_STORAGE_DRIVER || process.env.STORAGE_BACKEND || "local").toLowerCase();
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_REGION = process.env.S3_REGION || "auto";
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== "false";
const S3_PUBLIC_BASE_URL = (process.env.S3_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || IS_PRODUCTION;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 80);
const MAX_IMAGE_UPLOAD_MB = Number(process.env.MAX_IMAGE_UPLOAD_MB || 12);
const TMP_FILE_TTL_HOURS = Number(process.env.TMP_FILE_TTL_HOURS || 168);
const MAX_WEB_QUESTION_IMAGE_BYTES = Math.min(MAX_IMAGE_UPLOAD_MB * 1024 * 1024, Number(process.env.MAX_WEB_QUESTION_IMAGE_BYTES || 5 * 1024 * 1024));
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const API_RATE_LIMIT = Number(process.env.API_RATE_LIMIT || 240);
const LOGIN_RATE_LIMIT = Number(process.env.LOGIN_RATE_LIMIT || 12);
const UPLOAD_RATE_LIMIT = Number(process.env.UPLOAD_RATE_LIMIT || 20);
let pgPool = null;
let s3Client = null;

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

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const seedDb = {
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

const SUBJECTS = ["初中数学", "初中物理", "初中化学", "初中英语", "小学数学"];
const STAGES = ["小学", "初中"];
const LEVELS = ["基础", "提高", "压轴"];
const TYPES = ["选择题", "填空题", "解答题", "判断题", "完形填空", "阅读理解", "作文", "实验题", "计算题", "未分类"];
const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "免费试用",
    monthlyAiTokens: 30_000,
    monthlyAiPages: 50,
    maxUploadSizeMb: 20,
    maxUsers: 1,
    maxQuestions: 300,
    allowBatchAnalysis: false
  },
  starter: {
    id: "starter",
    name: "基础版",
    monthlyAiTokens: DEFAULT_MONTHLY_AI_TOKENS,
    monthlyAiPages: DEFAULT_MONTHLY_AI_PAGES,
    maxUploadSizeMb: 80,
    maxUsers: 3,
    maxQuestions: 3_000,
    allowBatchAnalysis: true
  },
  pro: {
    id: "pro",
    name: "专业版",
    monthlyAiTokens: 1_000_000,
    monthlyAiPages: 5_000,
    maxUploadSizeMb: 150,
    maxUsers: 10,
    maxQuestions: 20_000,
    allowBatchAnalysis: true
  },
  school: {
    id: "school",
    name: "校区版",
    monthlyAiTokens: 5_000_000,
    monthlyAiPages: 30_000,
    maxUploadSizeMb: 300,
    maxUsers: 50,
    maxQuestions: 100_000,
    allowBatchAnalysis: true
  }
};
const MAX_TEXT_AI_CHARS = Number(process.env.MAX_TEXT_AI_CHARS || 12000);
const MAX_VISION_PAGES = Number(process.env.MAX_VISION_PAGES || 80);
const VISION_BATCH_SIZE = Number(process.env.VISION_BATCH_SIZE || 1);
const AI_QUESTIONS_PER_BATCH = Number(process.env.AI_QUESTIONS_PER_BATCH || 3);
const ALLOW_AI_FREE_VARIANTS = process.env.ALLOW_AI_FREE_VARIANTS === "true";
const PDF_RENDER_DPI = Number(process.env.PDF_RENDER_DPI || 220);

const analysisJobs = new Map();
const rateBuckets = new Map();
const ocrProvider = createOcrProvider({
  provider: OCR_PROVIDER,
  callQwen,
  normalizeText: normalizeExtractedText,
  readImageSize,
  isLikelyTwoPageSpread,
  tmpDir: path.join(dataDir, ".tmp", "ocr-preprocess"),
  preprocess: process.env.OCR_PREPROCESS !== "false"
});
const layoutProvider = createOcrProvider({
  provider: OCR_LAYOUT_PROVIDER,
  callQwen,
  normalizeText: normalizeExtractedText,
  readImageSize,
  isLikelyTwoPageSpread,
  tmpDir: path.join(dataDir, ".tmp", "layout-preprocess"),
  preprocess: false
});

validateStartupConfig();
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(pageImageDir, { recursive: true });
await fs.mkdir(questionImageDir, { recursive: true });
await cleanupRuntimeTmp();
await initDbStorage();
await initObjectStorage();

function initObjectStorage() {
  if (FILE_STORAGE_DRIVER === "postgres") {
    if (STORAGE_DRIVER !== "postgres" || !pgPool) {
      throw new Error("FILE_STORAGE_DRIVER=postgres 需要同时配置 STORAGE_DRIVER=postgres 和 DATABASE_URL");
    }
    console.log(`Using PostgreSQL file object storage: ${POSTGRES_STATE_ID}`);
    return;
  }
  if (FILE_STORAGE_DRIVER !== "s3") {
    console.log(`Using local file storage: ${uploadDir}`);
    return;
  }
  if (!S3_BUCKET) throw new Error("FILE_STORAGE_DRIVER=s3 时必须配置 S3_BUCKET");
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT || undefined,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
        }
      : undefined
  });
  console.log(`Using S3-compatible file storage: ${S3_BUCKET}`);
}

function validateStartupConfig() {
  if (!IS_PRODUCTION) return;
  const errors = [];
  if (!process.env.APP_SECRET || APP_SECRET === "dev-secret-change-me" || APP_SECRET.length < 32) {
    errors.push("生产环境必须配置长度至少 32 位的 APP_SECRET");
  }
  if (ADMIN_PASSWORD === "admin123" || ADMIN_PASSWORD === "change-me") {
    errors.push("生产环境必须修改 ADMIN_PASSWORD");
  }
  if (STORAGE_DRIVER === "postgres" && !process.env.DATABASE_URL) {
    errors.push("STORAGE_DRIVER=postgres 时必须配置 DATABASE_URL");
  }
  if (FILE_STORAGE_DRIVER === "postgres" && STORAGE_DRIVER !== "postgres") {
    errors.push("FILE_STORAGE_DRIVER=postgres 需要同时配置 STORAGE_DRIVER=postgres");
  }
  if (FILE_STORAGE_DRIVER === "s3") {
    if (!S3_BUCKET) errors.push("FILE_STORAGE_DRIVER=s3 时必须配置 S3_BUCKET");
    if (!process.env.S3_ACCESS_KEY_ID) errors.push("FILE_STORAGE_DRIVER=s3 时必须配置 S3_ACCESS_KEY_ID");
    if (!process.env.S3_SECRET_ACCESS_KEY) errors.push("FILE_STORAGE_DRIVER=s3 时必须配置 S3_SECRET_ACCESS_KEY");
  }
  if (!process.env.QWEN_API_KEY && process.env.ALLOW_MISSING_QWEN_API_KEY !== "true") {
    errors.push("生产环境必须配置 QWEN_API_KEY；如确实要关闭 AI，请设置 ALLOW_MISSING_QWEN_API_KEY=true");
  }
  if (errors.length) {
    throw new Error(`生产环境配置不完整：\n- ${errors.join("\n- ")}`);
  }
}

function postgresSslConfig() {
  if (process.env.POSTGRES_SSL === "false") return false;
  if (process.env.POSTGRES_SSL === "true" || /sslmode=require/i.test(process.env.DATABASE_URL || "")) {
    return { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED === "true" };
  }
  return undefined;
}

async function cleanupRuntimeTmp() {
  if (!Number.isFinite(TMP_FILE_TTL_HOURS) || TMP_FILE_TTL_HOURS <= 0) return;
  const tmpDir = path.join(dataDir, ".tmp");
  const resolvedTmp = path.resolve(tmpDir);
  if (!resolvedTmp.startsWith(path.resolve(dataDir))) return;
  const cutoff = Date.now() - TMP_FILE_TTL_HOURS * 60 * 60 * 1000;
  let removed = 0;
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
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(target, { force: true });
        removed += 1;
      }
    }
  }
  await visit(resolvedTmp);
  if (removed) console.log(`Cleaned ${removed} expired runtime temp files from ${resolvedTmp}`);
}

function legacyHashPassword(password = "") {
  return createHash("sha256").update(String(password)).digest("hex");
}

function hashPassword(password = "") {
  const salt = randomBytes(16).toString("base64url");
  const key = scryptSync(String(password), salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString("base64url");
  return `scrypt$16384$8$1$${salt}$${key}`;
}

function verifyPassword(password = "", storedHash = "") {
  if (!storedHash) return false;
  if (!storedHash.startsWith("scrypt$")) {
    const legacy = legacyHashPassword(password);
    const a = Buffer.from(legacy);
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const parts = storedHash.split("$");
  if (parts.length !== 6) return false;
  const [, n, r, p, salt, expected] = parts;
  try {
    const key = scryptSync(String(password), salt, 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    }).toString("base64url");
    const a = Buffer.from(key);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function shouldUpgradePasswordHash(storedHash = "") {
  return !storedHash.startsWith("scrypt$");
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function billingDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59.999Z`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function planConfig(planId = "starter") {
  return PLAN_CATALOG[planId] || PLAN_CATALOG.starter;
}

function subscriptionStatus(org = {}, now = new Date()) {
  const subscription = org.subscription || {};
  if (subscription.status === "disabled" || org.status === "disabled") return "disabled";
  if (subscription.status === "past_due") return "past_due";
  if (subscription.status === "expired") return "expired";
  const trialEndsAt = subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null;
  const renewsAt = subscription.renewsAt ? new Date(subscription.renewsAt) : null;
  if (renewsAt && renewsAt >= now) return "active";
  if (trialEndsAt && trialEndsAt >= now) return "trialing";
  if (renewsAt || trialEndsAt) return "expired";
  return subscription.status || "active";
}

function normalizeOrganization(org = {}) {
  const now = new Date().toISOString();
  const plan = PLAN_CATALOG[org.plan] ? org.plan : "starter";
  const config = planConfig(plan);
  const limits = {
    monthlyAiTokens: Number(org.limits?.monthlyAiTokens || config.monthlyAiTokens),
    monthlyAiPages: Number(org.limits?.monthlyAiPages || config.monthlyAiPages),
    maxUploadSizeMb: Number(org.limits?.maxUploadSizeMb || config.maxUploadSizeMb),
    maxUsers: Number(org.limits?.maxUsers || config.maxUsers),
    maxQuestions: Number(org.limits?.maxQuestions || config.maxQuestions),
    allowBatchAnalysis: org.limits?.allowBatchAnalysis !== undefined ? Boolean(org.limits.allowBatchAnalysis) : Boolean(config.allowBatchAnalysis)
  };
  const subscription = {
    status: org.subscription?.status || "active",
    trialStartedAt: org.subscription?.trialStartedAt || org.createdAt || now,
    trialEndsAt: org.subscription?.trialEndsAt || "",
    renewsAt: org.subscription?.renewsAt || "",
    canceledAt: org.subscription?.canceledAt || "",
    pastDueAt: org.subscription?.pastDueAt || "",
    note: org.subscription?.note || ""
  };
  return {
    ...org,
    id: org.id || DEFAULT_TENANT_ID,
    name: org.name || process.env.DEFAULT_ORG_NAME || "默认机构",
    plan,
    limits,
    subscription,
    status: org.status || "active",
    createdAt: org.createdAt || now,
    updatedAt: org.updatedAt || now
  };
}

function defaultOrganization() {
  const now = new Date().toISOString();
  return normalizeOrganization({
    id: DEFAULT_TENANT_ID,
    name: process.env.DEFAULT_ORG_NAME || "默认机构",
    plan: "starter",
    subscription: {
      status: "trialing",
      trialStartedAt: now,
      trialEndsAt: addDays(now, Number(process.env.DEFAULT_TRIAL_DAYS || 14)),
      renewsAt: "",
      canceledAt: "",
      pastDueAt: "",
      note: "默认试用"
    },
    createdAt: now,
    updatedAt: now
  });
}

function defaultAdminUser() {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_ADMIN_ID,
    tenantId: DEFAULT_TENANT_ID,
    username: ADMIN_USER,
    displayName: "管理员",
    role: "owner",
    passwordHash: hashPassword(ADMIN_PASSWORD),
    status: "active",
    createdAt: now,
    updatedAt: now
  };
}

function ensureTenantRecord(record = {}, tenantId = DEFAULT_TENANT_ID) {
  return {
    tenantId,
    createdBy: record.createdBy || DEFAULT_ADMIN_ID,
    updatedBy: record.updatedBy || record.createdBy || DEFAULT_ADMIN_ID,
    ...record,
    tenantId: record.tenantId || tenantId
  };
}

function migrateSaasDb(db) {
  const next = { ...seedDb, ...db };
  next.organizations = Array.isArray(next.organizations) ? next.organizations : [];
  next.users = Array.isArray(next.users) ? next.users : [];
  if (!next.organizations.some((org) => org.id === DEFAULT_TENANT_ID)) {
    next.organizations.unshift(defaultOrganization());
  }
  next.organizations = next.organizations.map((org) => normalizeOrganization(org));
  if (!next.users.some((user) => user.username === ADMIN_USER)) {
    next.users.unshift(defaultAdminUser());
  }
  next.users = next.users.map((user) => ({
    ...defaultAdminUser(),
    ...user,
    id: user.id || randomUUID(),
    tenantId: user.tenantId || DEFAULT_TENANT_ID,
    role: user.role || "teacher",
    status: user.status || "active",
    passwordHash: user.passwordHash || hashPassword(user.password || ADMIN_PASSWORD)
  }));
  for (const key of ["questions", "pendingQuestions", "students", "assignments", "mistakes", "uploads", "activity"]) {
    next[key] = Array.isArray(next[key]) ? next[key].map((item) => ensureTenantRecord(item)) : [];
  }
  next.jobs = Array.isArray(next.jobs) ? next.jobs.map((item) => ensureTenantRecord(item)) : [];
  next.aiUsage = Array.isArray(next.aiUsage) ? next.aiUsage.map((item) => ensureTenantRecord(item)) : [];
  next.auditLogs = Array.isArray(next.auditLogs) ? next.auditLogs.map((item) => ensureTenantRecord(item)) : [];
  return next;
}

function sessionTenantId(session = {}) {
  return session.tenantId || DEFAULT_TENANT_ID;
}

function sessionUserId(session = {}) {
  return session.userId || DEFAULT_ADMIN_ID;
}

function belongsToTenant(record = {}, session = {}) {
  return (record.tenantId || DEFAULT_TENANT_ID) === sessionTenantId(session);
}

function stampTenant(input = {}, session = {}) {
  const now = new Date().toISOString();
  return {
    ...input,
    tenantId: input.tenantId || sessionTenantId(session),
    createdBy: input.createdBy || sessionUserId(session),
    updatedBy: sessionUserId(session),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function addAuditLog(db, session, action, targetType, targetId = "", detail = "") {
  db.auditLogs.unshift(stampTenant({
    id: randomUUID(),
    action,
    targetType,
    targetId,
    detail,
    createdAt: new Date().toISOString()
  }, session));
  db.auditLogs = db.auditLogs.slice(0, 1000);
}

function scopedDb(db, session) {
  const tenantId = sessionTenantId(session);
  const filter = (items = []) => items.filter((item) => (item.tenantId || DEFAULT_TENANT_ID) === tenantId);
  const organizations = db.organizations
    .filter((org) => org.id === tenantId)
    .map((org) => ({
      ...normalizeOrganization(org),
      subscriptionStatus: subscriptionStatus(org)
    }));
  return {
    ...db,
    organizations,
    plans: PLAN_CATALOG,
    usage: tenantUsageSummary(db, session),
    users: db.users.filter((user) => user.tenantId === tenantId).map(({ passwordHash, password, ...user }) => user),
    questions: filter(db.questions),
    pendingQuestions: filter(db.pendingQuestions),
    students: filter(db.students),
    assignments: filter(db.assignments),
    mistakes: filter(db.mistakes),
    uploads: filter(db.uploads),
    jobs: filter(db.jobs).slice(0, 100),
    aiUsage: filter(db.aiUsage).slice(0, 200),
    auditLogs: filter(db.auditLogs).slice(0, 200),
    activity: filter(db.activity)
  };
}

function canManageUsers(session = {}) {
  return ["owner", "admin"].includes(session.role || "");
}

async function initDbStorage() {
  if (STORAGE_DRIVER === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("STORAGE_DRIVER=postgres 时必须配置 DATABASE_URL");
    const { Pool } = await import("pg");
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: postgresSslConfig() });
    if (POSTGRES_SYNC_RELATIONAL) {
      await applyPostgresRelationalSchema();
    }
    await applyPostgresObjectSchema();
    await pgPool.query(`
      create table if not exists zenox_app_state (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    const existing = await pgPool.query("select id from zenox_app_state where id = $1", [POSTGRES_STATE_ID]);
    if (!existing.rowCount) {
      await pgPool.query(
        "insert into zenox_app_state (id, data) values ($1, $2::jsonb)",
        [POSTGRES_STATE_ID, JSON.stringify(migrateSaasDb(seedDb))]
      );
    }
    if (POSTGRES_SYNC_RELATIONAL) {
      const state = await pgPool.query("select data from zenox_app_state where id = $1", [POSTGRES_STATE_ID]);
      await syncPostgresRelationalDb(state.rows[0]?.data || seedDb);
    }
    console.log(`Using PostgreSQL storage: ${POSTGRES_STATE_ID}`);
    return;
  }

  if (!existsSync(dbPath)) {
    await fs.writeFile(dbPath, JSON.stringify(seedDb, null, 2), "utf8");
  }
  console.log(`Using JSON storage: ${dbPath}`);
}

async function applyPostgresObjectSchema() {
  await pgPool.query(`
    create table if not exists zenox_file_objects (
      key text primary key,
      content_type text not null default 'application/octet-stream',
      body bytea not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
}

async function applyPostgresRelationalSchema() {
  const schemaPath = path.join(rootDir, "docs", "saas-postgres-schema.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  await pgPool.query(schemaSql);
}

function asJson(value, fallback) {
  if (value === undefined || value === null || value === "") return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function asDate(value) {
  return value || new Date().toISOString();
}

function nullableDate(value) {
  return value || null;
}

async function insertRows(client, sql, rows) {
  for (const row of rows) {
    await client.query(sql, row);
  }
}

async function syncPostgresRelationalDb(db) {
  if (!POSTGRES_SYNC_RELATIONAL) return;
  const normalized = migrateSaasDb(db);
  const userIds = new Set(normalized.users.map((user) => user.id));
  const safeUserId = (id) => userIds.has(id) ? id : userIds.has(DEFAULT_ADMIN_ID) ? DEFAULT_ADMIN_ID : null;
  const safeRole = (role) => ["owner", "admin", "teacher", "reviewer"].includes(role) ? role : "teacher";
  const client = await pgPool.connect();
  try {
    await client.query("begin");
    await client.query("delete from audit_logs");
    await client.query("delete from ai_usage");
    await client.query("delete from jobs");
    await client.query("delete from assignments");
    await client.query("delete from mistakes");
    await client.query("delete from students");
    await client.query("delete from pending_questions");
    await client.query("delete from questions");
    await client.query("delete from uploads");
    await client.query("delete from users");
    await client.query("delete from organizations");

    await insertRows(client, `
      insert into organizations (id, name, plan, limits, created_at, updated_at)
      values ($1, $2, $3, $4::jsonb, $5, $6)
    `, normalized.organizations.map((org) => [
      org.id,
      org.name || "未命名机构",
      org.plan || "starter",
      asJson(org.limits || {}, {}),
      asDate(org.createdAt),
      asDate(org.updatedAt)
    ]));

    await insertRows(client, `
      insert into users (id, tenant_id, username, display_name, role, password_hash, status, last_login_at, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, normalized.users.map((user) => [
      user.id,
      user.tenantId || DEFAULT_TENANT_ID,
      user.username || user.id,
      user.displayName || user.username || "",
      safeRole(user.role),
      user.passwordHash || hashPassword(ADMIN_PASSWORD),
      user.status || "active",
      nullableDate(user.lastLoginAt),
      asDate(user.createdAt),
      asDate(user.updatedAt)
    ]));

    await insertRows(client, `
      insert into uploads (
        id, tenant_id, created_by, updated_by, filename, stored_name, hash, type, size,
        extracted_text, extraction_note, pages, page_images, analysis_status, analysis_error,
        analysis_progress, analysis_diagnostics, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18, $19)
    `, normalized.uploads.map((upload) => [
      upload.id,
      upload.tenantId || DEFAULT_TENANT_ID,
      safeUserId(upload.createdBy),
      safeUserId(upload.updatedBy || upload.createdBy),
      upload.filename || "",
      upload.storedName || "",
      upload.hash || "",
      upload.type || "",
      Number(upload.size || 0),
      upload.extractedText || "",
      upload.extractionNote || "",
      asJson(upload.pages || [], []),
      asJson(upload.pageImages || [], []),
      upload.analysisStatus || "ready",
      upload.analysisError || "",
      asJson(upload.analysisProgress || {}, {}),
      asJson(upload.analysisDiagnostics || {}, {}),
      asDate(upload.createdAt),
      asDate(upload.updatedAt)
    ]));

    await insertRows(client, `
      insert into questions (
        id, tenant_id, created_by, updated_by, stem, options, answer, explanation,
        subject, stage, grade, chapter, knowledge, level, type, source_upload_id,
        source_filename, source_page, question_image_stored_name, explanation_image_stored_name, question_bbox, variant_of,
        quality_status, quality_errors, quality_warnings, revisions, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24::jsonb, $25::jsonb, $26::jsonb, $27, $28)
    `, normalized.questions.map((question) => [
      question.id,
      question.tenantId || DEFAULT_TENANT_ID,
      safeUserId(question.createdBy),
      safeUserId(question.updatedBy || question.createdBy),
      question.stem || "",
      asJson(question.options || [], []),
      question.answer || "",
      question.explanation || "",
      question.subject || "初中数学",
      question.stage || "初中",
      question.grade || "",
      question.chapter || "",
      asJson(question.knowledge || [], []),
      question.level || "基础",
      question.type || "未分类",
      question.sourceUploadId || "",
      question.sourceFilename || "",
      String(question.sourcePage || ""),
      question.questionImageStoredName || "",
      question.explanationImageStoredName || "",
      asJson(question.questionBBox || null, null),
      question.variantOf || "",
      question.qualityStatus || "ok",
      asJson(question.qualityErrors || [], []),
      asJson(question.qualityWarnings || [], []),
      asJson(question.revisions || [], []),
      asDate(question.createdAt),
      asDate(question.updatedAt)
    ]));

    await insertRows(client, `
      insert into pending_questions (
        id, tenant_id, created_by, updated_by, payload, status,
        quality_status, quality_errors, quality_warnings, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
    `, normalized.pendingQuestions.map((question) => [
      question.id,
      question.tenantId || DEFAULT_TENANT_ID,
      safeUserId(question.createdBy),
      safeUserId(question.updatedBy || question.createdBy),
      asJson(question, {}),
      question.status || "pending",
      question.qualityStatus || "ok",
      asJson(question.qualityErrors || [], []),
      asJson(question.qualityWarnings || [], []),
      asDate(question.createdAt),
      asDate(question.updatedAt)
    ]));

    await insertRows(client, `
      insert into students (id, tenant_id, created_by, updated_by, name, stage, grade, level, notes, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, normalized.students.map((student) => [
      student.id,
      student.tenantId || DEFAULT_TENANT_ID,
      safeUserId(student.createdBy),
      safeUserId(student.updatedBy || student.createdBy),
      student.name || "",
      student.stage || "",
      student.grade || "",
      student.level || "",
      student.notes || "",
      asDate(student.createdAt),
      asDate(student.updatedAt)
    ]));

    await insertRows(client, `
      insert into mistakes (id, tenant_id, created_by, updated_by, student_id, question_id, reason, note, date, resolved, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, normalized.mistakes.map((mistake) => [
      mistake.id,
      mistake.tenantId || DEFAULT_TENANT_ID,
      safeUserId(mistake.createdBy),
      safeUserId(mistake.updatedBy || mistake.createdBy),
      mistake.studentId || "",
      mistake.questionId || "",
      mistake.reason || "",
      mistake.note || "",
      mistake.date || new Date().toISOString().slice(0, 10),
      Boolean(mistake.resolved),
      asDate(mistake.createdAt),
      asDate(mistake.updatedAt)
    ]));

    await insertRows(client, `
      insert into assignments (
        id, tenant_id, created_by, updated_by, title, student_id, subject, grade,
        question_ids, generated_questions, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
    `, normalized.assignments.map((assignment) => [
      assignment.id,
      assignment.tenantId || DEFAULT_TENANT_ID,
      safeUserId(assignment.createdBy),
      safeUserId(assignment.updatedBy || assignment.createdBy),
      assignment.title || "",
      assignment.studentId || "",
      assignment.subject || "",
      assignment.grade || "",
      asJson(assignment.questionIds || [], []),
      asJson(assignment.generatedQuestions || [], []),
      asDate(assignment.createdAt),
      asDate(assignment.updatedAt)
    ]));

    await insertRows(client, `
      insert into jobs (id, tenant_id, created_by, type, status, target_id, message, started_at, finished_at, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, normalized.jobs.map((job) => [
      job.id,
      job.tenantId || DEFAULT_TENANT_ID,
      safeUserId(job.createdBy),
      job.type || "job",
      job.status || "pending",
      job.targetId || "",
      job.message || "",
      asDate(job.startedAt || job.createdAt),
      nullableDate(job.finishedAt),
      asDate(job.createdAt),
      asDate(job.updatedAt)
    ]));

    await insertRows(client, `
      insert into ai_usage (
        id, tenant_id, created_by, month, provider, model, purpose,
        input_tokens, output_tokens, total_tokens, pages, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, normalized.aiUsage.map((usage) => [
      usage.id,
      usage.tenantId || DEFAULT_TENANT_ID,
      safeUserId(usage.createdBy),
      usage.month || new Date().toISOString().slice(0, 7),
      usage.provider || "qwen",
      usage.model || "",
      usage.purpose || "",
      Number(usage.inputTokens || 0),
      Number(usage.outputTokens || 0),
      Number(usage.totalTokens || 0),
      Number(usage.pages || 0),
      asDate(usage.createdAt)
    ]));

    await insertRows(client, `
      insert into audit_logs (id, tenant_id, created_by, action, target_type, target_id, detail, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `, normalized.auditLogs.map((log) => [
      log.id,
      log.tenantId || DEFAULT_TENANT_ID,
      safeUserId(log.createdBy),
      log.action || "",
      log.targetType || "",
      log.targetId || "",
      log.detail || "",
      asDate(log.createdAt)
    ]));

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readRawDb() {
  if (STORAGE_DRIVER === "postgres") {
    const result = await pgPool.query("select data from zenox_app_state where id = $1", [POSTGRES_STATE_ID]);
    if (!result.rowCount) return structuredClone(seedDb);
    return result.rows[0].data || structuredClone(seedDb);
  }
  const raw = await fs.readFile(dbPath, "utf8");
  return JSON.parse(raw);
}

async function writeRawDb(db) {
  if (STORAGE_DRIVER === "postgres") {
    await pgPool.query(
      `insert into zenox_app_state (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [POSTGRES_STATE_ID, JSON.stringify(db)]
    );
    await syncPostgresRelationalDb(db);
    return;
  }
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

async function readDb() {
  try {
    const db = migrateSaasDb(await readRawDb());
    db.pendingQuestions = Array.isArray(db.pendingQuestions) ? db.pendingQuestions : [];
    db.uploads = db.uploads.map((upload) => {
      const normalizedUpload = {
        pages: [],
        pageImages: [],
        analysisProgress: {},
        analysisDiagnostics: null,
        storageDriver: FILE_STORAGE_DRIVER,
        ...upload
      };
      if (upload.extractedText && upload.extractedText.length > 20 && looksLikeGarbledText(upload.extractedText)) {
        return {
          ...normalizedUpload,
          extractedText: "",
          extractionNote: "之前的提取结果疑似乱码，已自动隐藏。请转成图片后用 AI OCR，或复制 PDF 文本后粘贴拆题。"
        };
      }
      return normalizedUpload;
    });
    db.uploads = dedupeUploads(db.uploads);
    db.questions = db.questions.map((q) => ({
      options: [],
      sourcePage: "",
      sourceFilename: "",
      sourceImage: "",
      questionImage: "",
      questionImageManual: false,
      questionImageStoredName: "",
      questionImageSource: "",
      explanationImage: "",
      explanationImageStoredName: "",
      explanationImageManual: false,
      diagramSpec: null,
      diagramSvg: "",
      questionBBox: null,
      diagramBBoxes: [],
      variants: [],
      variantOf: "",
      ...q,
      sourceImage: "",
      questionImage: q.questionImageStoredName ? `/api/questions/${q.id}/image` : (q.questionImage || ""),
      explanationImage: q.explanationImageStoredName ? `/api/questions/${q.id}/explanation-image` : (q.explanationImage || ""),
      diagramSpec: normalizeDiagramSpec(q.diagramSpec),
      diagramSvg: q.diagramSvg || renderDiagramSvg(q.diagramSpec),
      questionBBox: normalizeQuestionBBox(q.questionBBox || q.bbox || null),
      diagramBBoxes: Array.isArray(q.diagramBBoxes) ? q.diagramBBoxes.map((box) => normalizeQuestionBBox(box)).filter(Boolean) : [],
      stem: normalizeQuestionText(q.stem),
      options: normalizeOptions(q.options),
      answer: normalizeQuestionText(q.answer),
      explanation: normalizeQuestionText(q.explanation),
      knowledge: normalizeKnowledgeTags(q.knowledge, q.subject, q.stem)
    }));
    const sourceImageByQuestion = new Map();
    for (const upload of db.uploads) {
      for (const page of upload.pages || []) {
        const image = page.image || upload.pageImages?.find((item) => Number(item.page) === Number(page.page))?.url || "";
        if (image) sourceImageByQuestion.set(`${upload.id}:${Number(page.page)}`, image);
      }
    }
    db.questions = db.questions.map((q) => {
      const sourceImage = q.sourceImage || sourceImageByQuestion.get(`${q.sourceUploadId}:${Number(q.sourcePage)}`) || "";
      const next = { ...q, sourceImage };
      if (!next.questionImageStoredName && next.questionImage === sourceImage) {
        next.questionImage = "";
      }
      return next;
    });
    db.pendingQuestions = dedupeQuestionItems(db.pendingQuestions.map((q) => applyQuestionQuality({
      options: [],
      variants: [],
      aiVariants: [],
      bankVariants: [],
      webVariants: [],
      status: "pending",
      questionImage: "",
      revisions: [],
      sourceIndexOnPage: "",
      sourceTotalOnPage: "",
      questionImageSource: "",
      explanationImage: "",
      explanationImageStoredName: "",
      explanationImageManual: false,
      diagramSpec: null,
      diagramSvg: "",
      questionBBox: null,
      diagramBBoxes: [],
      sourceTextLayout: null,
      variantDiagnostics: null,
      ...q,
      stem: normalizeQuestionText(q.stem),
      options: normalizeOptions(q.options),
      answer: normalizeQuestionText(q.answer),
      explanation: normalizeQuestionText(q.explanation),
      sourceImage: q.sourceImage || sourceImageByQuestion.get(`${q.sourceUploadId}:${Number(q.sourcePage)}`) || "",
      questionBBox: normalizeQuestionBBox(q.questionBBox || q.bbox || null),
      diagramSpec: normalizeDiagramSpec(q.diagramSpec),
      diagramSvg: q.diagramSvg || renderDiagramSvg(q.diagramSpec),
      diagramBBoxes: Array.isArray(q.diagramBBoxes) ? q.diagramBBoxes.map((box) => normalizeQuestionBBox(box)).filter(Boolean) : [],
      sourceTextLayout: q.sourceTextLayout || null,
      knowledge: normalizeKnowledgeTags(q.knowledge, q.subject, q.stem)
    })).map((q) => syncVariantGroups(q)));
    const pendingGroups = new Map();
    db.pendingQuestions.forEach((q) => {
      if (!q.sourceUploadId || !q.sourcePage) return;
      const key = `${q.sourceUploadId}:${Number(q.sourcePage)}`;
      if (!pendingGroups.has(key)) pendingGroups.set(key, []);
      pendingGroups.get(key).push(q);
    });
    for (const group of pendingGroups.values()) {
      group.forEach((q, index) => {
        const hasIndex = q.sourceIndexOnPage !== "" && q.sourceIndexOnPage !== undefined && q.sourceIndexOnPage !== null;
        const hasTotal = q.sourceTotalOnPage !== "" && q.sourceTotalOnPage !== undefined && q.sourceTotalOnPage !== null;
        q.sourceIndexOnPage = hasIndex && Number.isFinite(Number(q.sourceIndexOnPage)) ? Number(q.sourceIndexOnPage) : index;
        q.sourceTotalOnPage = hasTotal && Number.isFinite(Number(q.sourceTotalOnPage)) ? Number(q.sourceTotalOnPage) : group.length;
        if (q.questionImageStoredName) {
          q.questionImage = `/api/pending-questions/${q.id}/image`;
        } else if (q.questionImage && q.questionImage !== q.sourceImage) {
          q.questionImage = q.questionImage;
        } else {
          q.questionImage = "";
        }
        q.explanationImage = q.explanationImageStoredName ? `/api/pending-questions/${q.id}/explanation-image` : (q.explanationImage || "");
        q.revisions = Array.isArray(q.revisions) ? q.revisions : [];
        applyQuestionQuality(q);
      });
    }
    return db;
  } catch {
    return migrateSaasDb(structuredClone(seedDb));
  }
}

async function writeDb(db) {
  await writeRawDb(migrateSaasDb(db));
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function enforceRateLimit(req, res, bucket, limit, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(key);
    }
  }
  const key = `${bucket}:${clientIp(req)}`;
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  if (current.count <= limit) return true;
  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(retryAfter),
    "cache-control": "no-store"
  });
  res.end(JSON.stringify({ error: `请求过于频繁，请 ${retryAfter} 秒后再试` }));
  return false;
}

function objectKey(name = "") {
  return String(name || "").replace(/^\/+/, "");
}

function localObjectPath(name = "") {
  const target = path.normalize(path.join(uploadDir, objectKey(name)));
  const relative = path.relative(uploadDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("文件路径非法");
  return target;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function saveObject(name, buffer, contentType = "application/octet-stream") {
  const key = objectKey(name);
  if (FILE_STORAGE_DRIVER === "postgres") {
    await pgPool.query(
      `insert into zenox_file_objects (key, content_type, body, updated_at)
       values ($1, $2, $3, now())
       on conflict (key) do update
       set content_type = excluded.content_type,
           body = excluded.body,
           updated_at = now()`,
      [key, contentType, Buffer.from(buffer)]
    );
    return key;
  }
  if (FILE_STORAGE_DRIVER === "s3") {
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType
    }));
    return key;
  }
  const target = localObjectPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return key;
}

async function readObject(name) {
  const key = objectKey(name);
  if (FILE_STORAGE_DRIVER === "postgres") {
    const result = await pgPool.query("select body from zenox_file_objects where key = $1", [key]);
    if (!result.rowCount) throw new Error("Object not found");
    return Buffer.from(result.rows[0].body);
  }
  if (FILE_STORAGE_DRIVER === "s3") {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return streamToBuffer(result.Body);
  }
  return fs.readFile(localObjectPath(key));
}

async function deleteObject(name) {
  const key = objectKey(name);
  if (FILE_STORAGE_DRIVER === "postgres") {
    await pgPool.query("delete from zenox_file_objects where key = $1", [key]).catch(() => {});
    return;
  }
  if (FILE_STORAGE_DRIVER === "s3") {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => {});
    return;
  }
  await fs.rm(localObjectPath(key), { force: true }).catch(() => {});
}

async function deleteObjectIfExists(name) {
  if (!name) return;
  await deleteObject(name).catch(() => {});
}

async function objectExists(name) {
  try {
    await readObject(name);
    return true;
  } catch {
    return false;
  }
}

async function readObjectToTemp(name, ext = "") {
  const bytes = await readObject(name);
  const tmpDir = path.join(dataDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${randomUUID()}${ext || path.extname(name) || ".bin"}`);
  await fs.writeFile(tmpPath, bytes);
  return tmpPath;
}

async function sendObject(res, name, contentType = "application/octet-stream") {
  try {
    const file = await readObject(name);
    res.writeHead(200, { "content-type": contentType });
    return res.end(file);
  } catch {
    return text(res, 404, "Not found");
  }
}

function publicObjectUrl(name) {
  const key = objectKey(name);
  if (FILE_STORAGE_DRIVER === "s3" && S3_PUBLIC_BASE_URL) return `${S3_PUBLIC_BASE_URL}/${encodeURI(key)}`;
  return "";
}

async function deleteUploadCascade(db, upload, session = {}) {
  if (!upload) return;
  const pendingRelated = (db.pendingQuestions || []).filter((q) => q.sourceUploadId === upload.id);
  const objectNames = new Set([
    upload.storedName || "",
    ...((upload.pageImages || []).map((item) => item.storedName || "")),
    ...pendingRelated.flatMap((q) => [
      q.questionImageStoredName || "",
      q.explanationImageStoredName || ""
    ])
  ].filter(Boolean));
  for (const name of objectNames) {
    await deleteObjectIfExists(name);
  }
  db.pendingQuestions = (db.pendingQuestions || []).filter((q) => q.sourceUploadId !== upload.id);
  db.uploads = (db.uploads || []).filter((item) => item.id !== upload.id);
  addActivity(db, "删除资料", `${upload.filename}`, session);
  addAuditLog(db, session, "upload.delete", "upload", upload.id, upload.filename || "删除资料");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(raw.split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function sign(value) {
  return createHmac("sha256", APP_SECRET).update(value).digest("base64url");
}

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    tenantId: user.tenantId || DEFAULT_TENANT_ID,
    role: user.role || "teacher",
    nonce: randomBytes(12).toString("hex"),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function sessionCookie(value = "", maxAge = 60 * 60 * 24 * 14) {
  const parts = [
    `session=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, tokenSig] = token.split(".");
  const expected = sign(payload);
  const a = Buffer.from(tokenSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

function requireAuth(req, res) {
  const rawSession = verifySession(parseCookies(req).session);
  const session = rawSession ? {
    userId: rawSession.userId || DEFAULT_ADMIN_ID,
    username: rawSession.username || ADMIN_USER,
    displayName: rawSession.displayName || rawSession.username || ADMIN_USER,
    tenantId: rawSession.tenantId || DEFAULT_TENANT_ID,
    role: rawSession.role || "owner",
    exp: rawSession.exp
  } : null;
  if (!session) {
    json(res, 401, { error: "请先登录" });
    return null;
  }
  return session;
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > limit) throw httpError(413, "请求体太大");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "请求体太大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 5 * 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function safeName(name) {
  const cleaned = String(name || "upload").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
  return cleaned.slice(0, 120) || "upload";
}

function fileExtension(filename = "") {
  return path.extname(safeName(filename)).toLowerCase();
}

function allowedUploadSpec(file = {}, purpose = "document") {
  const ext = fileExtension(file.filename);
  const mime = String(file.type || "").toLowerCase().split(";")[0].trim() || "application/octet-stream";
  const isImagePurpose = purpose === "image";
  const specs = [
    {
      kind: "pdf",
      exts: [".pdf"],
      mimes: ["application/pdf", "application/octet-stream"],
      matches: (buffer) => buffer.slice(0, 5).toString("utf8") === "%PDF-"
    },
    {
      kind: "docx",
      exts: [".docx"],
      mimes: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
        "application/octet-stream"
      ],
      matches: (buffer) => buffer.slice(0, 2).toString("utf8") === "PK"
    },
    {
      kind: "png",
      exts: [".png"],
      mimes: ["image/png", "application/octet-stream"],
      matches: (buffer) => buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a
    },
    {
      kind: "jpeg",
      exts: [".jpg", ".jpeg"],
      mimes: ["image/jpeg", "application/octet-stream"],
      matches: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    },
    {
      kind: "webp",
      exts: [".webp"],
      mimes: ["image/webp", "application/octet-stream"],
      matches: (buffer) => buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP"
    },
    {
      kind: "text",
      exts: [".txt"],
      mimes: ["text/plain", "application/octet-stream"],
      matches: () => true
    }
  ].filter((spec) => !isImagePurpose || ["png", "jpeg", "webp"].includes(spec.kind));
  return specs.find((spec) => spec.exts.includes(ext) && spec.mimes.includes(mime) && spec.matches(file.body || Buffer.alloc(0)));
}

function validateUploadFile(file = {}, { purpose = "document", maxBytes = MAX_UPLOAD_MB * 1024 * 1024 } = {}) {
  if (!file.filename || !file.body?.length) throw httpError(400, "没有收到文件");
  if (file.body.length > maxBytes) throw httpError(413, `文件太大，当前上限为 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  const spec = allowedUploadSpec(file, purpose);
  if (!spec) {
    throw httpError(
      400,
      purpose === "image"
        ? "图片格式不支持，请上传 PNG、JPG 或 WEBP"
        : "文件格式不支持，请上传 PDF、DOCX、PNG、JPG、WEBP 或 TXT"
    );
  }
  return spec;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(cursor, headerEnd).toString("utf8");
    let next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) next = buffer.length;
    let body = buffer.slice(headerEnd + 4, next);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.slice(0, -2);
    }
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || "application/octet-stream";
    if (name) parts.push({ name, filename, type, body });
    cursor = next;
  }
  return parts;
}

function inflateMaybe(buffer) {
  try {
    return zlib.inflateSync(buffer);
  } catch {
    try {
      return zlib.inflateRawSync(buffer);
    } catch {
      return buffer;
    }
  }
}

function extractPdfStreams(buffer) {
  const raw = buffer.toString("latin1");
  const streams = [];
  const streamRegex = /(<<[\s\S]*?>>)\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  for (const match of raw.matchAll(streamRegex)) {
    const bodyStart = raw.indexOf(match[2], match.index);
    if (bodyStart === -1) continue;
    const body = buffer.slice(bodyStart, bodyStart + match[2].length);
    const inflated = /\/FlateDecode/.test(match[1]) ? inflateMaybe(body) : body;
    streams.push({
      dict: match[1],
      text: inflated.toString("latin1")
    });
  }
  return streams;
}

function hexToUtf16(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  if (!clean) return "";
  const bytes = [];
  for (let i = 0; i < clean.length - 1; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) bytes.splice(0, 2);
  if (bytes.length >= 2 && bytes.filter((_, i) => i % 2 === 0 && bytes[i] === 0).length > bytes.length / 4) {
    let out = "";
    for (let i = 0; i < bytes.length - 1; i += 2) {
      const code = (bytes[i] << 8) + bytes[i + 1];
      if (code) out += String.fromCodePoint(code);
    }
    return out;
  }
  return Buffer.from(bytes).toString("utf8").replace(/\u0000/g, "");
}

function buildToUnicodeMap(streams) {
  const map = new Map();
  for (const stream of streams) {
    if (!/beginbfchar|beginbfrange/.test(stream.text)) continue;
    for (const block of stream.text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const line of block[1].split(/\r?\n/)) {
        const pair = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (pair) map.set(pair[1].toUpperCase(), hexToUtf16(pair[2]));
      }
    }
    for (const block of stream.text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const line of block[1].split(/\r?\n/)) {
        const range = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (!range) continue;
        const start = parseInt(range[1], 16);
        const end = parseInt(range[2], 16);
        const dest = parseInt(range[3], 16);
        const width = range[1].length;
        for (let code = start; code <= end && code - start < 300; code += 1) {
          map.set(code.toString(16).toUpperCase().padStart(width, "0"), String.fromCodePoint(dest + code - start));
        }
      }
    }
  }
  return map;
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function decodePdfHexText(hex, unicodeMap) {
  const clean = hex.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (!clean) return "";
  if (unicodeMap.size) {
    let out = "";
    for (let i = 0; i < clean.length;) {
      const four = clean.slice(i, i + 4);
      const two = clean.slice(i, i + 2);
      if (unicodeMap.has(four)) {
        out += unicodeMap.get(four);
        i += 4;
      } else if (unicodeMap.has(two)) {
        out += unicodeMap.get(two);
        i += 2;
      } else {
        i += four.length === 4 ? 4 : 2;
      }
    }
    if (out.trim()) return out;
  }
  return hexToUtf16(clean);
}

function decodePdfTextToken(token, unicodeMap) {
  if (token.startsWith("<")) return decodePdfHexText(token.slice(1, -1), unicodeMap);
  return decodePdfString(token.slice(1, -1));
}

function extractTextFromContentStream(text, unicodeMap) {
  const parts = [];
  for (const section of text.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = section[1];
    for (const match of body.matchAll(/(\((?:\\.|[^\\)])*\)|<(?!!|<)[0-9A-Fa-f\s]+>)\s*Tj/g)) {
      const decoded = decodePdfTextToken(match[1], unicodeMap).trim();
      if (decoded) parts.push(decoded);
    }
    for (const match of body.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const tokens = match[1].match(/\((?:\\.|[^\\)])*\)|<(?!!|<)[0-9A-Fa-f\s]+>/g) || [];
      const decoded = tokens.map((token) => decodePdfTextToken(token, unicodeMap)).join("").trim();
      if (decoded) parts.push(decoded);
    }
    for (const match of body.matchAll(/'(\s*)\((?:\\.|[^\\)])*\)|"[\s\S]*?\((?:\\.|[^\\)])*\)/g)) {
      const tokens = match[0].match(/\((?:\\.|[^\\)])*\)/g) || [];
      const decoded = tokens.map((token) => decodePdfTextToken(token, unicodeMap)).join("").trim();
      if (decoded) parts.push(decoded);
    }
  }
  return parts;
}

function looksLikeGarbledText(text) {
  const cleaned = normalizeExtractedText(text);
  if (cleaned.length < 8) return true;
  const bad = (cleaned.match(/[□�@]{2,}|[\u0000-\u0008\u000b-\u001f]/g) || []).join("").length;
  const useful = (cleaned.match(/[\p{Script=Han}A-Za-z0-9=+\-×÷*/().,，。？！：；、]/gu) || []).length;
  return bad > cleaned.length * 0.08 || useful < cleaned.length * 0.35;
}

function extractPdfText(buffer) {
  const streams = extractPdfStreams(buffer);
  const unicodeMap = buildToUnicodeMap(streams);
  const textParts = [];
  for (const stream of streams) {
    if (/beginbfchar|beginbfrange|\/Image|\/XObject/.test(stream.text)) continue;
    textParts.push(...extractTextFromContentStream(stream.text, unicodeMap));
  }
  const extracted = normalizeExtractedText(textParts.join("\n"));
  return looksLikeGarbledText(extracted) ? "" : extracted;
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeQuestionText(value) {
  return String(value || "")
    .replace(/[＝]/g, "=")
    .replace(/[－–—]/g, "-")
    .replace(/[，]/g, "，")
    .replace(/[：]/g, "：")
    .replace(/[≤≦]/g, "≤")
    .replace(/[≥≧]/g, "≥")
    .replace(/[≠]/g, "≠")
    .replace(/∥|∥/g, "∥")
    .replace(/⊥|⟂/g, "⊥")
    .replace(/°|˚|º/g, "°")
    .replace(/\$+\s*\\(?:dfrac|frac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}\s*\$+/g, "$1/$2")
    .replace(/\\(?:dfrac|frac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$1/$2")
    .replace(/\$+\s*\\sqrt\s*\{([^{}]+)\}\s*\$+/g, "√($1)")
    .replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)")
    .replace(/\bsqrt\s*\(([^()]+)\)/gi, "√($1)")
    .replace(/\bsqrt\s*\{([^{}]+)\}/gi, "√($1)")
    .replace(/\$+/g, "")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\cdot/g, "·")
    .replace(/\\pm/g, "±")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\angle/g, "∠")
    .replace(/\\parallel/g, "∥")
    .replace(/\\perp/g, "⊥")
    .replace(/\\triangle/g, "△")
    .replace(/\\because/g, "∵")
    .replace(/\\therefore/g, "∴")
    .replace(/\\infty/g, "∞")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\theta/g, "θ")
    .replace(/\\pi/g, "π")
    .replace(/\\circ/g, "°")
    .replace(/\\degree/g, "°")
    .replace(/\\left|\\right/g, "")
    .replace(/([A-Za-z])\s*\/\s*\/\s*([A-Za-z])/g, "$1∥$2")
    .replace(/([A-Za-z])\s*parallel\s*([A-Za-z])/gi, "$1∥$2")
    .replace(/([A-Za-z]{1,2})\s*perp\s*([A-Za-z]{1,2})/gi, "$1⊥$2")
    .replace(/([A-Za-z])\s*∥\s*([A-Za-z])/g, "$1∥$2")
    .replace(/([A-Za-z]{1,2})\s*⊥\s*([A-Za-z]{1,2})/g, "$1⊥$2")
    .replace(/∠\s*([A-Za-z0-9]+)/g, "∠$1")
    .replace(/△\s*([A-Za-z]{3})/g, "△$1")
    .replace(/(\d+)\s*\/\s*(\d+)/g, "$1/$2")
    .replace(/直线\s*l\b/g, "直线ℓ")
    .replace(/\{([^{}]+)\}\^\{([^{}]+)\}/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
    .replace(/([A-Za-z0-9）)])\^\{([^{}]+)\}/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
    .replace(/([A-Za-z0-9）)])\s*\^\s*\{?(-?\d+)\}?/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
    .replace(/([A-Za-z0-9）)])\^(-?\d+)/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
    .replace(/([A-Za-z0-9）)])_\{([^{}]+)\}/g, "$1_$2")
    .trim();
}

function toSuperscript(value = "") {
  const map = {
    "0": "⁰",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
    "5": "⁵",
    "6": "⁶",
    "7": "⁷",
    "8": "⁸",
    "9": "⁹",
    "-": "⁻",
    "+": "⁺",
    "(": "⁽",
    ")": "⁾",
    "n": "ⁿ"
  };
  return String(value).split("").map((char) => map[char] || char).join("");
}

function splitQuestionsFromText(text) {
  const cleaned = normalizeExtractedText(text);
  if (!cleaned) return [];
  const prepared = cleaned
    .replace(/([。！？；;])\s*(?=\d{1,3}[.、](?!\d)\s*\S)/g, "$1\n")
    .replace(/([。！？；;])\s*(?=[一二三四五六七八九十]+[、.．]\s*\S)/g, "$1\n")
    .replace(/([^\n])\s+(?=\d{1,3}[.、](?!\d)\s*[\u4e00-\u9fa5A-Za-z])/g, "$1\n")
    .replace(/[ \t]+(?=\d{1,3}[.、](?!\d)\s*\S)/g, "\n")
    .replace(/[ \t]+(?=[（(]\s*\d{1,2}\s*[)）])/g, "\n");
  const blocks = [];
  let current = [];
  for (const line of prepared.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (/^【(?:左|右|上|下)半(?:页|区|部分|栏)】$/.test(line)) continue;
    if (!current.length && isProbablySectionHeading(line)) continue;
    if (isTopLevelQuestionStart(line) && current.length) {
      blocks.push(current.join("\n").trim());
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks
    .map((item) => item.trim())
    .filter((item) => item.length > 8)
    .filter((item) => !isProbablySectionHeading(item))
    .filter((item) => looksLikeQuestionCandidate(item));
}

function isTopLevelQuestionStart(line = "") {
  const value = String(line).trim();
  if (isProbablySectionHeading(value)) return false;
  if (/^[（(]\s*\d{1,3}\s*[)）]|^（?[一二三四五六七八九十]\s*[)）]/.test(value)) return false;
  if (/^[A-D][.、]/i.test(value)) return false;
  return /^(?:\d{1,3}[.、](?!\d)|\d{1,3}\)(?!\s*[A-Da-d][.、])|[一二三四五六七八九十]+[、.．])/.test(value);
}

function inferQuestionType(text) {
  if (/A[.、]|B[.、]|C[.、]|D[.、]|选择|选出/.test(text)) return "选择题";
  if (/填空|____|__|（\s*）|\(\s*\)/.test(text)) return "填空题";
  if (/证明|解答|计算|求|说明|画图|作图/.test(text)) return "解答题";
  if (/判断|正确|错误/.test(text)) return "判断题";
  return "未分类";
}

function makeQuestion(input = {}) {
  const now = new Date().toISOString();
  const subject = normalizeOneOf(input.subject, SUBJECTS, "初中数学");
  const stem = normalizeQuestionText(input.stem);
  const question = {
    id: randomUUID(),
    stem,
    options: normalizeOptions(input.options),
    answer: normalizeQuestionText(input.answer),
    explanation: normalizeQuestionText(input.explanation),
    subject,
    stage: normalizeOneOf(input.stage, STAGES, "初中"),
    level: normalizeOneOf(input.level, LEVELS, "基础"),
    grade: input.grade || "",
    chapter: input.chapter || "",
    knowledge: normalizeKnowledgeTags(input.knowledge, subject, stem),
    type: input.type || inferQuestionType(stem),
    studentName: input.studentName || "",
    mistakeReason: input.mistakeReason || "",
    sourceUploadId: input.sourceUploadId || "",
    sourceFilename: input.sourceFilename || "",
    sourcePage: input.sourcePage || "",
    sourceUrl: input.sourceUrl || "",
    sourceTitle: normalizeQuestionText(input.sourceTitle || ""),
    searchQuery: normalizeQuestionText(input.searchQuery || ""),
    sourceImage: input.sourceImage || "",
    questionImage: input.questionImage || "",
    questionImageManual: Boolean(input.questionImageManual),
    questionImageStoredName: input.questionImageStoredName || "",
    questionImageSource: input.questionImageSource || "",
    explanationImage: input.explanationImage || "",
    explanationImageManual: Boolean(input.explanationImageManual),
    explanationImageStoredName: input.explanationImageStoredName || "",
    diagramSpec: normalizeDiagramSpec(input.diagramSpec),
    diagramSvg: input.diagramSvg || renderDiagramSvg(input.diagramSpec),
    questionBBox: normalizeQuestionBBox(input.questionBBox || input.bbox || null),
    diagramBBoxes: Array.isArray(input.diagramBBoxes) ? input.diagramBBoxes.map((box) => normalizeQuestionBBox(box)).filter(Boolean) : [],
    sourceText: input.sourceText || "",
    sourceTextLayout: input.sourceTextLayout || null,
    sourceIndexOnPage: input.sourceIndexOnPage ?? "",
    sourceTotalOnPage: input.sourceTotalOnPage ?? "",
    variantOf: input.variantOf || "",
    variants: Array.isArray(input.variants) ? input.variants : [],
    aiVariants: Array.isArray(input.aiVariants) ? input.aiVariants : [],
    bankVariants: Array.isArray(input.bankVariants) ? input.bankVariants : [],
    webVariants: Array.isArray(input.webVariants) ? input.webVariants : [],
    variantDiagnostics: input.variantDiagnostics || null,
    duplicateOf: input.duplicateOf || "",
    forceApproved: Boolean(input.forceApproved),
    qualityStatus: input.qualityStatus || "ok",
    qualityErrors: Array.isArray(input.qualityErrors) ? input.qualityErrors : [],
    qualityWarnings: Array.isArray(input.qualityWarnings) ? input.qualityWarnings : [],
    revisions: Array.isArray(input.revisions) ? input.revisions : [],
    tenantId: input.tenantId || DEFAULT_TENANT_ID,
    createdBy: input.createdBy || DEFAULT_ADMIN_ID,
    updatedBy: input.updatedBy || input.createdBy || DEFAULT_ADMIN_ID,
    createdAt: now,
    updatedAt: now
  };
  applyQuestionMatchProfile(question, { touch: false, now });
  return question;
}

function makePendingQuestion(input = {}) {
  const question = makeQuestion(input);
  const split = splitVariantGroups(input, question);
  return applyQuestionQuality({
    ...question,
    status: input.status || "pending",
    variants: split.variants,
    aiVariants: split.aiVariants,
    bankVariants: split.bankVariants,
    webVariants: split.webVariants,
    variantDiagnostics: input.variantDiagnostics || question.variantDiagnostics || null,
    revisions: Array.isArray(input.revisions) ? input.revisions : question.revisions,
    createdAt: input.createdAt || question.createdAt,
    updatedAt: new Date().toISOString()
  });
}

function revisionSnapshot(question = {}) {
  return {
    id: question.id || "",
    stem: question.stem || "",
    options: normalizeOptions(question.options),
    answer: question.answer || "",
    explanation: question.explanation || "",
    subject: question.subject || "",
    stage: question.stage || "",
    grade: question.grade || "",
    chapter: question.chapter || "",
    knowledge: parseTags(question.knowledge),
    level: question.level || "",
    type: question.type || "",
    sourceUploadId: question.sourceUploadId || "",
    sourceFilename: question.sourceFilename || "",
    sourcePage: question.sourcePage || "",
    questionImage: question.questionImage || "",
    questionImageManual: Boolean(question.questionImageManual),
    questionImageStoredName: question.questionImageStoredName || "",
    questionImageSource: question.questionImageSource || "",
    explanationImage: question.explanationImage || "",
    explanationImageManual: Boolean(question.explanationImageManual),
    explanationImageStoredName: question.explanationImageStoredName || "",
    diagramSpec: normalizeDiagramSpec(question.diagramSpec),
    diagramSvg: question.diagramSvg || "",
    questionBBox: normalizeQuestionBBox(question.questionBBox || question.bbox || null),
    diagramBBoxes: Array.isArray(question.diagramBBoxes) ? question.diagramBBoxes.map((box) => normalizeQuestionBBox(box)).filter(Boolean) : [],
    aiVariants: normalizeVariants(question.aiVariants || [], question),
    bankVariants: normalizeVariants(question.bankVariants || [], question, 5),
    webVariants: normalizeVariants(question.webVariants || [], question),
    variantDiagnostics: question.variantDiagnostics || null,
    qualityStatus: question.qualityStatus || "",
    qualityErrors: Array.isArray(question.qualityErrors) ? question.qualityErrors : [],
    qualityWarnings: Array.isArray(question.qualityWarnings) ? question.qualityWarnings : []
  };
}

function addRevision(question = {}, session = {}, action = "edit", before = null, after = null, detail = "") {
  question.revisions = Array.isArray(question.revisions) ? question.revisions : [];
  question.revisions.unshift({
    id: randomUUID(),
    action,
    detail,
    before: before || null,
    after: after || revisionSnapshot(question),
    createdBy: sessionUserId(session),
    createdAt: new Date().toISOString()
  });
  question.revisions = question.revisions.slice(0, 30);
  return question;
}

function appendUniqueText(left = "", right = "") {
  const a = normalizeQuestionText(left);
  const b = normalizeQuestionText(right);
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n${b}`;
}

function mergePendingQuestionData(primary = {}, secondary = {}, order = "after") {
  const first = order === "before" ? secondary : primary;
  const second = order === "before" ? primary : secondary;
  const merged = { ...primary };
  merged.stem = appendUniqueText(first.stem, second.stem);
  merged.options = normalizeOptions(primary.options).length ? normalizeOptions(primary.options) : normalizeOptions(secondary.options);
  merged.answer = appendUniqueText(primary.answer, secondary.answer);
  merged.explanation = appendUniqueText(primary.explanation, secondary.explanation);
  merged.knowledge = [...new Set([...parseTags(primary.knowledge), ...parseTags(secondary.knowledge)])].slice(0, 4);
  merged.chapter = primary.chapter || secondary.chapter || "";
  merged.grade = primary.grade || secondary.grade || "";
  merged.type = primary.type && primary.type !== "未分类" ? primary.type : (secondary.type || primary.type);
  merged.level = primary.level || secondary.level || "基础";
  merged.sourceText = appendUniqueText(primary.sourceText, secondary.sourceText);
  merged.sourcePage = [primary.sourcePage, secondary.sourcePage].filter(Boolean).join(" / ");
  merged.sourceImage = primary.sourceImage || secondary.sourceImage || "";
  if (!primary.questionImageStoredName && secondary.questionImageStoredName) {
    merged.questionImageStoredName = secondary.questionImageStoredName;
    merged.questionImage = secondary.questionImage;
    merged.questionImageManual = secondary.questionImageManual;
    merged.questionImageSource = secondary.questionImageSource || "";
    merged.questionBBox = secondary.questionBBox || null;
  }
  merged.aiVariants = normalizeVariants([...(primary.aiVariants || []), ...(secondary.aiVariants || [])], merged).map((item) => ({ ...item, source: item.source || "AI生成" }));
  merged.bankVariants = normalizeVariants([...(primary.bankVariants || []), ...(secondary.bankVariants || [])], merged, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
  merged.webVariants = normalizeVariants([...(primary.webVariants || []), ...(secondary.webVariants || [])], merged).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  merged.variants = [...merged.webVariants, ...merged.aiVariants, ...merged.bankVariants];
  merged.updatedAt = new Date().toISOString();
  return applyQuestionQuality(merged);
}

function normalizeOneOf(value, allowed, fallback) {
  const textValue = String(value || "").trim();
  return allowed.includes(textValue) ? textValue : fallback;
}

function normalizeOptions(value) {
  if (Array.isArray(value)) return value.map(normalizeQuestionText).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\n|(?=[A-D][.、])/).map(normalizeQuestionText).filter(Boolean);
}

function normalizeKnowledgeTags(value, subject = "", stem = "") {
  const raw = parseTags(value).concat(parseTags(stem)).join(" ");
  const source = `${raw} ${subject}`;
  const tags = [];
  const add = (tag) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };

  if (/概率|随机|必然|不可能|可能性|事件|频率|抽样|摸球|骰子|转盘|彩票/.test(source)) add("概率");
  if (/统计|平均数|中位数|众数|方差|样本|调查|条形图|折线图|扇形图/.test(source)) add("统计");
  if (/方程|不等式|方程组|解方程|应用题/.test(source)) add("方程与不等式");
  if (/函数|一次函数|二次函数|反比例函数|图象/.test(source)) add("函数");
  if (/几何|三角形|四边形|圆|角|平行|垂直|全等|相似|勾股|面积|体积/.test(source)) add("几何");
  if (/整式|因式分解|分式|根式|有理数|实数|代数式|科学记数法|幂|平方|立方/.test(source)) add("数与代数");
  if (/电路|电流|电压|电阻|欧姆|功率|力|压强|浮力|热|光|声|磁/.test(source)) add("物理基础");
  if (/酸|碱|盐|溶液|化学式|方程式|元素|原子|分子|实验/.test(source)) add("化学基础");
  if (/阅读|完形|语法|词汇|作文|听力|句型|时态/.test(source)) add("英语综合");

  if (!tags.length) {
    for (const item of parseTags(value)) {
      const cleaned = item.replace(/^(必然|不可能|随机)?事件的?/, "事件").replace(/分类$/, "");
      add(cleaned.length > 6 ? cleaned.slice(0, 6) : cleaned);
      if (tags.length >= 2) break;
    }
  }
  return tags.slice(0, 2);
}

function normalizeDiagramSpec(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const type = String(input.type || input.diagramType || "").trim();
  if (!["geometry", "coordinate", "statistics"].includes(type)) return null;
  return JSON.parse(JSON.stringify({ ...input, type })).valueOf();
}

function svgText(value = "") {
  return escapeHtmlDoc(String(value || ""));
}

function svgNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatCompactNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value || "");
  return Number(number.toFixed(digits)).toString();
}

function svgLabel(text, x, y, options = {}) {
  const anchor = options.anchor || "middle";
  const weight = options.weight || "700";
  const size = options.size || 14;
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="#0f172a" stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke fill">${svgText(text)}</text>`;
}

function normalizeDiagramLabel(value = "") {
  const text = normalizeQuestionText(value).trim();
  return text === "l" ? "ℓ" : text;
}

function svgPoint(base, x, y, label = "", options = {}) {
  const radius = options.radius || 3.2;
  base.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="#111827"/>`);
  if (label) base.push(svgLabel(label, x + (options.dx ?? 14), y + (options.dy ?? -10), { size: options.size || 14, weight: "600" }));
}

function svgArcPath(cx, cy, radius, startDeg, endDeg) {
  const start = {
    x: cx + Math.cos((startDeg * Math.PI) / 180) * radius,
    y: cy + Math.sin((startDeg * Math.PI) / 180) * radius
  };
  const end = {
    x: cx + Math.cos((endDeg * Math.PI) / 180) * radius,
    y: cy + Math.sin((endDeg * Math.PI) / 180) * radius
  };
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg > startDeg ? 1 : 0;
  return `M${start.x.toFixed(1)} ${start.y.toFixed(1)} A${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

function svgAngleMark(base, cx, cy, radius, startDeg, endDeg, label, labelX, labelY) {
  base.push(`<path d="${svgArcPath(cx, cy, radius, startDeg, endDeg)}" fill="none" stroke="#111827" stroke-width="1.4" stroke-linecap="round"/>`);
  base.push(svgLabel(label, labelX, labelY, { size: 13, weight: "600" }));
}

function svgLine(base, from, to, options = {}) {
  const dashed = options.dashed ? ` stroke-dasharray="${options.dashed === true ? "6 5" : options.dashed}"` : "";
  const width = options.width || 2;
  const color = options.color || "#111827";
  base.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${dashed}/>`);
}

function svgPath(base, d, options = {}) {
  const color = options.color || "#111827";
  const width = options.width || 2;
  const fill = options.fill || "none";
  const dashed = options.dashed ? ` stroke-dasharray="${options.dashed === true ? "6 5" : options.dashed}"` : "";
  base.push(`<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dashed}/>`);
}

function pointBetween(a, b, ratio = 0.5) {
  return {
    x: Math.round(a.x + (b.x - a.x) * ratio),
    y: Math.round(a.y + (b.y - a.y) * ratio)
  };
}

function svgAngleByPoints(base, vertex, armA, armB, radius, label, labelX, labelY) {
  const start = (Math.atan2(armA.y - vertex.y, armA.x - vertex.x) * 180) / Math.PI;
  const endRaw = (Math.atan2(armB.y - vertex.y, armB.x - vertex.x) * 180) / Math.PI;
  const delta = ((endRaw - start + 540) % 360) - 180;
  const end = start + delta;
  svgAngleMark(base, vertex.x, vertex.y, radius, start, end, label, labelX, labelY);
}

function svgTick(base, point, angleDeg, options = {}) {
  const length = options.length || 18;
  const rad = ((angleDeg + 90) * Math.PI) / 180;
  const dx = Math.cos(rad) * length / 2;
  const dy = Math.sin(rad) * length / 2;
  svgLine(base, { x: point.x - dx, y: point.y - dy }, { x: point.x + dx, y: point.y + dy }, { width: options.width || 1.7 });
}

function appendParallelTransversalSvg(base, width, height, spec = {}) {
  const left = 72;
  const right = width - 72;
  const topY = Math.round(height * 0.38);
  const bottomY = Math.round(height * 0.64);
  const topX = Math.round(width * 0.46);
  const bottomX = Math.round(width * 0.55);
  const transTop = { x: topX - 52, y: Math.round(height * 0.18) };
  const transBottom = { x: bottomX + 48, y: Math.round(height * 0.84) };
  const line1Label = normalizeDiagramLabel(spec.line1Label || "a");
  const line2Label = normalizeDiagramLabel(spec.line2Label || "b");
  const transversalLabel = normalizeDiagramLabel(spec.transversalLabel || "c");
  const stroke = "#111827";
  const angleText = (value) => String(value).replace(/^∠\s*/, "");

  base.push(`<line x1="${left}" y1="${topY}" x2="${right}" y2="${topY}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`);
  base.push(`<line x1="${left}" y1="${bottomY}" x2="${right}" y2="${bottomY}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`);
  base.push(`<line x1="${transTop.x}" y1="${transTop.y}" x2="${transBottom.x}" y2="${transBottom.y}" stroke="${stroke}" stroke-width="2" stroke-linecap="round"/>`);

  const slashX1 = Math.round(width * 0.78);
  base.push(`<path d="M${slashX1 - 9} ${topY - 8} L${slashX1 + 5} ${topY + 8}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>`);
  base.push(`<path d="M${slashX1 - 9} ${bottomY - 8} L${slashX1 + 5} ${bottomY + 8}" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>`);

  base.push(svgLabel(line1Label, right + 18, topY + 5, { size: 15, weight: "600" }));
  base.push(svgLabel(line2Label, right + 18, bottomY + 5, { size: 15, weight: "600" }));
  base.push(svgLabel(transversalLabel, transTop.x - 12, transTop.y + 2, { size: 15, weight: "600" }));

  const arcRadius = 16;
  [
    [topX, topY, 198, 226, "1", topX - 28, topY - 24],
    [topX, topY, 314, 342, "2", topX + 30, topY - 22],
    [topX, topY, 18, 46, "4", topX + 30, topY + 30],
    [topX, topY, 134, 162, "3", topX - 34, topY + 30],
    [bottomX, bottomY, 198, 226, "5", bottomX - 30, bottomY - 24],
    [bottomX, bottomY, 314, 342, "6", bottomX + 30, bottomY - 22],
    [bottomX, bottomY, 18, 46, "8", bottomX + 30, bottomY + 30],
    [bottomX, bottomY, 134, 162, "7", bottomX - 34, bottomY + 30]
  ].forEach(([cx, cy, start, end, label, labelX, labelY]) => svgAngleMark(base, cx, cy, arcRadius, start, end, angleText(label), labelX, labelY));
}

function appendTriangleTemplateSvg(base, width, height, spec = {}) {
  const labels = {
    a: spec.aLabel || "A",
    b: spec.bLabel || "B",
    c: spec.cLabel || "C",
    d: spec.dLabel || "D"
  };
  const A = { x: Math.round(width * 0.48), y: Math.round(height * 0.18) };
  const B = { x: Math.round(width * 0.22), y: Math.round(height * 0.76) };
  const C = { x: Math.round(width * 0.78), y: Math.round(height * 0.76) };
  const D = { x: Math.round(width * 0.50), y: Math.round(height * 0.76) };
  const stroke = "#111827";
  base.push(`<path d="M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} Z" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>`);
  if (spec.showMedian || spec.showHeight || spec.showBisector) {
    base.push(`<line x1="${A.x}" y1="${A.y}" x2="${D.x}" y2="${D.y}" stroke="${stroke}" stroke-width="1.8"/>`);
    svgPoint(base, D.x, D.y, labels.d, { dx: 12, dy: 18, size: 13 });
  }
  if (spec.showHeight) {
    base.push(`<path d="M${D.x} ${D.y} l0 -14 l14 0 l0 14" fill="none" stroke="${stroke}" stroke-width="1.3"/>`);
  }
  svgPoint(base, A.x, A.y, labels.a, { dx: -18, dy: -12 });
  svgPoint(base, B.x, B.y, labels.b, { dx: -16, dy: 18 });
  svgPoint(base, C.x, C.y, labels.c, { dx: 16, dy: 18 });
}

function appendCircleTemplateSvg(base, width, height, spec = {}) {
  const cx = Math.round(width * 0.5);
  const cy = Math.round(height * 0.52);
  const r = Math.round(Math.min(width, height) * 0.28);
  const stroke = "#111827";
  const pointAt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + Math.round(Math.cos(rad) * r), y: cy + Math.round(Math.sin(rad) * r) };
  };
  const A = pointAt(205);
  const B = pointAt(335);
  const C = pointAt(265);
  const T = pointAt(35);
  base.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="2"/>`);
  base.push(`<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="${stroke}" stroke-width="1.8"/>`);
  base.push(`<line x1="${cx}" y1="${cy}" x2="${T.x}" y2="${T.y}" stroke="${stroke}" stroke-width="1.5"/>`);
  if (spec.showInscribedAngle) {
    base.push(`<line x1="${C.x}" y1="${C.y}" x2="${A.x}" y2="${A.y}" stroke="${stroke}" stroke-width="1.5"/>`);
    base.push(`<line x1="${C.x}" y1="${C.y}" x2="${B.x}" y2="${B.y}" stroke="${stroke}" stroke-width="1.5"/>`);
  }
  svgPoint(base, cx, cy, spec.centerLabel || "O", { dx: 14, dy: 4, radius: 2.8 });
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: -14, dy: 16 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: 14, dy: 16 });
  if (spec.showInscribedAngle) svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: -4, dy: 20 });
  svgPoint(base, T.x, T.y, spec.tLabel || "P", { dx: 16, dy: -8 });
}

function appendTriangleCeviansAnglesSvg(base, width, height, spec = {}) {
  const A = { x: Math.round(width * 0.48), y: Math.round(height * 0.13) };
  const B = { x: Math.round(width * 0.18), y: Math.round(height * 0.80) };
  const C = { x: Math.round(width * 0.82), y: Math.round(height * 0.80) };
  const D = pointBetween(A, B, 0.58);
  const E = pointBetween(A, C, 0.56);
  svgPath(base, `M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} Z`);
  svgLine(base, D, E, { width: 1.8 });
  svgLine(base, D, C, { width: 1.8 });
  if (spec.showAuxiliary !== false) svgLine(base, B, E, { width: 1.4, dashed: "5 5", color: "#475569" });
  svgAngleByPoints(base, C, B, D, 18, "1", C.x - 24, C.y - 14);
  svgAngleByPoints(base, D, A, E, 16, "2", D.x + 18, D.y - 13);
  svgAngleByPoints(base, D, E, C, 18, "3", D.x + 20, D.y + 26);
  svgAngleByPoints(base, E, D, C, 16, "4", E.x - 18, E.y + 22);
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: -16, dy: -12 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: -16, dy: 18 });
  svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: 16, dy: 18 });
  svgPoint(base, D.x, D.y, spec.dLabel || "D", { dx: -18, dy: 4, radius: 3 });
  svgPoint(base, E.x, E.y, spec.eLabel || "E", { dx: 17, dy: -3, radius: 3 });
}

function appendTriangleMidlineParallelSvg(base, width, height, spec = {}) {
  const A = { x: Math.round(width * 0.50), y: Math.round(height * 0.14) };
  const B = { x: Math.round(width * 0.18), y: Math.round(height * 0.80) };
  const C = { x: Math.round(width * 0.84), y: Math.round(height * 0.80) };
  const D = pointBetween(A, B, 0.52);
  const E = pointBetween(A, C, 0.52);
  svgPath(base, `M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} Z`);
  svgLine(base, D, E, { width: 1.9 });
  svgTick(base, pointBetween(A, D, 0.5), 122, { length: 13 });
  svgTick(base, pointBetween(D, B, 0.5), 122, { length: 13 });
  svgTick(base, pointBetween(A, E, 0.5), 58, { length: 13 });
  svgTick(base, pointBetween(E, C, 0.5), 58, { length: 13 });
  const midDE = pointBetween(D, E, 0.5);
  const midBC = pointBetween(B, C, 0.5);
  svgTick(base, { x: midDE.x, y: midDE.y }, 0, { length: 16 });
  svgTick(base, { x: midBC.x, y: midBC.y }, 0, { length: 16 });
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: -16, dy: -12 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: -16, dy: 18 });
  svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: 16, dy: 18 });
  svgPoint(base, D.x, D.y, spec.dLabel || "D", { dx: -18, dy: 2, radius: 3 });
  svgPoint(base, E.x, E.y, spec.eLabel || "E", { dx: 17, dy: 2, radius: 3 });
}

function appendSimilarTrianglesParallelSvg(base, width, height, spec = {}) {
  const A = { x: Math.round(width * 0.50), y: Math.round(height * 0.12) };
  const B = { x: Math.round(width * 0.16), y: Math.round(height * 0.82) };
  const C = { x: Math.round(width * 0.84), y: Math.round(height * 0.82) };
  const D = pointBetween(A, B, 0.42);
  const E = pointBetween(A, C, 0.42);
  const F = pointBetween(A, B, 0.68);
  const G = pointBetween(A, C, 0.68);
  svgPath(base, `M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} Z`);
  svgLine(base, D, E, { width: 1.7 });
  svgLine(base, F, G, { width: 1.7 });
  svgTick(base, pointBetween(D, E, 0.62), 0, { length: 14 });
  svgTick(base, pointBetween(F, G, 0.62), 0, { length: 14 });
  svgTick(base, pointBetween(B, C, 0.62), 0, { length: 14 });
  base.push(svgLabel("DE∥FG∥BC", width / 2, height - 18, { size: 12, weight: "600" }));
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: -15, dy: -11 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: -16, dy: 18 });
  svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: 16, dy: 18 });
  svgPoint(base, D.x, D.y, spec.dLabel || "D", { dx: -17, dy: 0, radius: 3 });
  svgPoint(base, E.x, E.y, spec.eLabel || "E", { dx: 17, dy: 0, radius: 3 });
  svgPoint(base, F.x, F.y, spec.fLabel || "F", { dx: -17, dy: 0, radius: 3 });
  svgPoint(base, G.x, G.y, spec.gLabel || "G", { dx: 17, dy: 0, radius: 3 });
}

function appendCircleTangentSecantSvg(base, width, height, spec = {}) {
  const O = { x: Math.round(width * 0.43), y: Math.round(height * 0.52) };
  const r = Math.round(Math.min(width, height) * 0.27);
  const A = { x: O.x + r, y: O.y };
  const P = { x: A.x, y: Math.round(O.y - r * 1.12) };
  const far = { x: Math.round(O.x - r * 1.35), y: Math.round(O.y + r * 0.78) };
  const dx = far.x - P.x;
  const dy = far.y - P.y;
  const fx = P.x - O.x;
  const fy = P.y - O.y;
  const qa = dx * dx + dy * dy;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - r * r;
  const disc = Math.max(0, qb * qb - 4 * qa * qc);
  const roots = [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)].sort((left, right) => left - right);
  const B = { x: Math.round(P.x + dx * roots[0]), y: Math.round(P.y + dy * roots[0]) };
  const C = { x: Math.round(P.x + dx * roots[1]), y: Math.round(P.y + dy * roots[1]) };
  base.push(`<circle cx="${O.x}" cy="${O.y}" r="${r}" fill="none" stroke="#111827" stroke-width="2"/>`);
  svgLine(base, { x: A.x, y: A.y - r * 0.92 }, { x: A.x, y: A.y + r * 0.92 }, { width: 1.9 });
  svgLine(base, P, far, { width: 1.8 });
  svgLine(base, O, A, { width: 1.5 });
  svgPath(base, `M${A.x} ${A.y - 15} l-14 0 l0 14`, { width: 1.3 });
  svgAngleByPoints(base, P, A, far, 18, "1", P.x - 30, P.y + 6);
  svgPoint(base, O.x, O.y, spec.centerLabel || "O", { dx: -14, dy: 18, radius: 2.8 });
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: 16, dy: -8 });
  svgPoint(base, P.x, P.y, spec.pLabel || "P", { dx: 16, dy: 6 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: -14, dy: -10 });
  svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: 16, dy: 16 });
}

function appendQuadrilateralFoldSvg(base, width, height, spec = {}) {
  const A = { x: Math.round(width * 0.18), y: Math.round(height * 0.20) };
  const B = { x: Math.round(width * 0.78), y: Math.round(height * 0.20) };
  const C = { x: Math.round(width * 0.78), y: Math.round(height * 0.76) };
  const D = { x: Math.round(width * 0.18), y: Math.round(height * 0.76) };
  const E = { x: Math.round(width * 0.50), y: A.y };
  const F = { x: Math.round(width * 0.66), y: D.y };
  const P = { x: Math.round(width * 0.52), y: Math.round(height * 0.52) };
  svgPath(base, `M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} L${D.x} ${D.y} Z`);
  svgLine(base, E, F, { width: 1.8, dashed: "7 5" });
  svgPath(base, `M${E.x} ${E.y} L${P.x} ${P.y} L${F.x} ${F.y}`, { width: 1.7, color: "#475569" });
  svgAngleByPoints(base, E, A, P, 16, "1", E.x - 18, E.y + 28);
  svgAngleByPoints(base, F, P, C, 16, "2", F.x + 20, F.y - 18);
  svgPoint(base, A.x, A.y, spec.aLabel || "A", { dx: -15, dy: -10 });
  svgPoint(base, B.x, B.y, spec.bLabel || "B", { dx: 16, dy: -10 });
  svgPoint(base, C.x, C.y, spec.cLabel || "C", { dx: 16, dy: 18 });
  svgPoint(base, D.x, D.y, spec.dLabel || "D", { dx: -15, dy: 18 });
  svgPoint(base, E.x, E.y, spec.eLabel || "E", { dx: 0, dy: -12, radius: 3 });
  svgPoint(base, F.x, F.y, spec.fLabel || "F", { dx: 16, dy: 15, radius: 3 });
  svgPoint(base, P.x, P.y, spec.pLabel || "P", { dx: 15, dy: -5, radius: 3 });
}

function appendGridProbabilitySvg(base, width, height, spec = {}) {
  const rows = Math.max(2, Math.min(8, Math.round(svgNumber(spec.rows, 3))));
  const cols = Math.max(2, Math.min(8, Math.round(svgNumber(spec.cols, 3))));
  const shaded = new Set((Array.isArray(spec.shaded) ? spec.shaded : [[1, 1], [1, 2]])
    .map((cell) => Array.isArray(cell) ? `${Number(cell[0])}:${Number(cell[1])}` : `${Number(cell.row)}:${Number(cell.col)}`));
  const size = Math.min((width - 96) / cols, (height - 70) / rows);
  const startX = Math.round((width - size * cols) / 2);
  const startY = Math.round((height - size * rows) / 2);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = startX + c * size;
      const y = startY + r * size;
      const key = `${r + 1}:${c + 1}`;
      base.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${shaded.has(key) ? "#cbd5e1" : "#fff"}" stroke="#111827" stroke-width="1.6"/>`);
    }
  }
  if (spec.label) base.push(svgLabel(spec.label, width / 2, startY - 14, { size: 13, weight: "600" }));
}

function appendRotationCongruenceComprehensiveSvg(base, width, height, spec = {}) {
  const stroke = "#111827";
  const helperStroke = "#64748b";
  const caseId = Math.max(1, Math.round(svgNumber(spec.caseId, 1)));
  const lean = ((caseId % 3) - 1) * 8;
  const lift = (caseId % 2) * 8;
  const panelWidth = Math.min(180, Math.floor((width - 40) / 3));
  const gap = Math.max(12, Math.floor((width - panelWidth * 3) / 4));
  const yBase = Math.max(150, height - 58);
  const line = (a, b, options = {}) => svgLine(base, a, b, {
    width: options.width || 1.35,
    color: options.color || stroke,
    dashed: options.dashed || ""
  });
  const point = (p, dx = 6, dy = -6, options = {}) => svgPoint(base, p.x, p.y, p.name, {
    dx,
    dy,
    radius: options.radius || 1.9,
    size: options.size || 10
  });
  const label = (text, x, y, options = {}) => base.push(svgLabel(text, x, y, {
    size: options.size || 10,
    weight: options.weight || "600",
    anchor: options.anchor || "middle"
  }));
  const rightMark = (p, size = 9) => {
    base.push(`<path d="M${p.x + 3} ${p.y - 3} l${size} 0 l0 ${-size}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
  };
  const translate = (ox, p) => ({ ...p, x: ox + p.x, y: p.y });
  const titleY = height - 18;

  const drawFigure1 = (ox) => {
    const A = translate(ox, { name: "A", x: 44, y: 56 + lift / 2 });
    const B = translate(ox, { name: "B", x: 22, y: yBase });
    const C = translate(ox, { name: "C", x: 142, y: yBase });
    const D = translate(ox, { name: "D", x: 84 + lean, y: yBase - 42 - lift / 2 });
    const E = translate(ox, { name: "E", x: 158 + lean, y: 52 - lift });
    for (const [a, b] of [[A, B], [B, C], [C, A], [A, D], [D, E], [E, A], [B, D], [C, E]]) line(a, b);
    rightMark(B);
    rightMark(D, 8);
    point(A, -4, -9);
    point(B, -12, 6);
    point(C, 8, 9);
    point(D, 5, -8);
    point(E, 6, -8);
    label("图1", ox + 90, titleY);
  };

  const drawFigure2 = (ox) => {
    const A = translate(ox, { name: "A", x: 42, y: 58 + lift / 2 });
    const B = translate(ox, { name: "B", x: 20, y: yBase });
    const C = translate(ox, { name: "C", x: 142, y: yBase });
    const E = translate(ox, { name: "E", x: 158 + lean, y: 42 - lift });
    const D = translate(ox, { name: "D", x: 92 + lean / 2, y: yBase - 46 - lift / 2 });
    const M = translate(ox, { name: "M", x: 82, y: yBase - 24 });
    const F = translate(ox, { name: "F", x: 103 + lean / 2, y: yBase - 66 - lift / 2 });
    for (const [a, b] of [[A, B], [B, C], [C, A], [A, D], [D, E], [E, A], [B, D], [E, D]]) line(a, b);
    line(B, { x: ox + 122, y: yBase - 78 }, { color: helperStroke, dashed: "4 4", width: 1.05 });
    line(E, D, { color: stroke, width: 1.35 });
    rightMark(B);
    rightMark(D, 8);
    point(A, -4, -9);
    point(B, -12, 6);
    point(C, 8, 9);
    point(D, 5, -8);
    point(E, 6, -8);
    point(M, 5, 12, { radius: 1.5, size: 9 });
    point(F, 6, -6, { radius: 1.5, size: 9 });
    label("图2", ox + 90, titleY);
  };

  const drawBackup = (ox) => {
    const A = translate(ox, { name: "A", x: 48, y: 58 });
    const B = translate(ox, { name: "B", x: 24, y: yBase });
    const C = translate(ox, { name: "C", x: 144, y: yBase });
    for (const [a, b] of [[A, B], [B, C], [C, A]]) line(a, b);
    rightMark(B);
    point(A, -4, -9);
    point(B, -12, 6);
    point(C, 8, 9);
    label("备用图", ox + 90, titleY);
  };

  drawFigure1(gap);
  drawFigure2(gap * 2 + panelWidth);
  drawBackup(gap * 3 + panelWidth * 2);
}

function appendCoordinateTemplateSvg(base, width, height, spec = {}) {
  const padding = 36;
  const xMin = svgNumber(spec.xMin, -4);
  const xMax = svgNumber(spec.xMax, 4);
  const yMin = svgNumber(spec.yMin, -3);
  const yMax = svgNumber(spec.yMax, 5);
  const tx = (x) => padding + ((svgNumber(x) - xMin) / Math.max(1, xMax - xMin)) * (width - padding * 2);
  const ty = (y) => height - padding - ((svgNumber(y) - yMin) / Math.max(1, yMax - yMin)) * (height - padding * 2);
  for (let x = Math.ceil(xMin); x <= Math.floor(xMax); x += 1) {
    base.push(`<line x1="${tx(x)}" y1="${padding}" x2="${tx(x)}" y2="${height - padding}" stroke="#e5e7eb" stroke-width="1"/>`);
  }
  for (let y = Math.ceil(yMin); y <= Math.floor(yMax); y += 1) {
    base.push(`<line x1="${padding}" y1="${ty(y)}" x2="${width - padding}" y2="${ty(y)}" stroke="#e5e7eb" stroke-width="1"/>`);
  }
  base.push(`<line x1="${padding}" y1="${ty(0)}" x2="${width - padding}" y2="${ty(0)}" stroke="#111827" stroke-width="1.6"/>`);
  base.push(`<line x1="${tx(0)}" y1="${height - padding}" x2="${tx(0)}" y2="${padding}" stroke="#111827" stroke-width="1.6"/>`);
  base.push(`<path d="M${width - padding} ${ty(0)} l-8 -4 l0 8 Z" fill="#111827"/>`);
  base.push(`<path d="M${tx(0)} ${padding} l-4 8 l8 0 Z" fill="#111827"/>`);
  base.push(`<text x="${width - padding + 10}" y="${ty(0) + 5}" font-size="12">x</text><text x="${tx(0) + 6}" y="${padding - 8}" font-size="12">y</text>`);
  const k = svgNumber(spec.k, 1);
  const b = svgNumber(spec.b, 1);
  const p1 = { x: xMin, y: k * xMin + b };
  const p2 = { x: xMax, y: k * xMax + b };
  base.push(`<line x1="${tx(p1.x)}" y1="${ty(p1.y)}" x2="${tx(p2.x)}" y2="${ty(p2.y)}" stroke="#111827" stroke-width="2"/>`);
  for (const point of Array.isArray(spec.points) ? spec.points : [{ name: "A", x: 0, y: b }]) {
    svgPoint(base, tx(point.x), ty(point.y), point.name || "", { dx: 14, dy: -10, radius: 3.4 });
  }
}

function appendTravelDistanceTimeGraphSvg(base, width, height, spec = {}) {
  const left = 52;
  const right = 38;
  const top = 28;
  const bottom = 42;
  const axisColor = "#111827";
  const guideColor = "#64748b";
  const renderSeriesGraph = ({ xMax, yMax, xTicks = [], yTicks = [], series = [], points = [], guides = [], xLabel = "x/小时", yLabel = "y/千米" }) => {
    const safeXMax = Math.max(1, svgNumber(xMax, 10));
    const safeYMax = Math.max(1, svgNumber(yMax, 1000));
    const tx = (x) => left + (svgNumber(x) / safeXMax) * (width - left - right);
    const ty = (y) => height - bottom - (svgNumber(y) / safeYMax) * (height - top - bottom);
    const O = { x: tx(0), y: ty(0) };
    svgLine(base, O, { x: width - right + 6, y: O.y }, { width: 1.8, color: axisColor });
    svgLine(base, O, { x: O.x, y: top - 8 }, { width: 1.8, color: axisColor });
    base.push(`<path d="M${width - right + 6} ${O.y} l-8 -4 l0 8 Z" fill="${axisColor}"/>`);
    base.push(`<path d="M${O.x} ${top - 8} l-4 8 l8 0 Z" fill="${axisColor}"/>`);
    base.push(`<text x="${width - right - 24}" y="${O.y - 10}" font-size="12" fill="${axisColor}">${svgText(xLabel)}</text>`);
    base.push(`<text x="${O.x + 6}" y="${top - 14}" font-size="12" fill="${axisColor}">${svgText(yLabel)}</text>`);

    for (const tick of [...new Set(xTicks.map((value) => formatCompactNumber(value)))].map(Number).filter((value) => Number.isFinite(value) && value >= 0)) {
      const x = tx(tick);
      base.push(`<line x1="${x}" y1="${O.y - 6}" x2="${x}" y2="${O.y + 6}" stroke="${axisColor}" stroke-width="1.2"/>`);
      if (tick !== 0) base.push(svgLabel(formatCompactNumber(tick), x, O.y + 22, { size: 12, weight: "600" }));
    }
    for (const tick of [...new Set(yTicks.map((value) => formatCompactNumber(value)))].map(Number).filter((value) => Number.isFinite(value) && value > 0)) {
      const y = ty(tick);
      base.push(`<line x1="${O.x - 6}" y1="${y}" x2="${O.x + 6}" y2="${y}" stroke="${axisColor}" stroke-width="1.2"/>`);
      base.push(svgLabel(formatCompactNumber(tick), O.x - 12, y + 4, { size: 12, weight: "600", anchor: "end" }));
    }
    for (const guide of guides) {
      if (guide.x !== undefined) svgLine(base, { x: tx(guide.x), y: O.y }, { x: tx(guide.x), y: ty(guide.y ?? safeYMax) }, { width: 1.1, color: guideColor, dashed: "5 4" });
      if (guide.y !== undefined) svgLine(base, { x: O.x, y: ty(guide.y) }, { x: tx(guide.x ?? safeXMax), y: ty(guide.y) }, { width: 1.1, color: guideColor, dashed: "5 4" });
    }
    for (const item of series) {
      const pts = Array.isArray(item.points) ? item.points : [];
      if (pts.length < 2) continue;
      const d = pts.map((point, index) => `${index ? "L" : "M"}${tx(point.x)} ${ty(point.y)}`).join(" ");
      svgPath(base, d, { width: svgNumber(item.width, 2.4), color: item.color || "#0f172a", dashed: item.dashed || "" });
      if (item.label) {
        const last = pts[pts.length - 1];
        base.push(svgLabel(item.label, tx(last.x) + 12, ty(last.y) + 4, { size: 12, weight: "700" }));
      }
    }
    svgPoint(base, O.x, O.y, "O", { dx: -14, dy: 18, radius: 0.1, size: 12 });
    for (const point of points) {
      svgPoint(base, tx(point.x), ty(point.y), point.name || "", { dx: point.dx ?? 12, dy: point.dy ?? -10, radius: 3.2 });
    }
  };

  const distance = Math.max(100, svgNumber(spec.distance, 1200));
  const meetTime = Math.max(0.5, svgNumber(spec.meetTime, 4.8));
  const fastArrivalTime = Math.max(meetTime + 0.5, svgNumber(spec.fastArrivalTime, 8));
  const slowArrivalTime = Math.max(fastArrivalTime + 0.5, svgNumber(spec.slowArrivalTime, 12));
  const cDistance = Math.max(0, Math.min(distance, svgNumber(spec.cDistance, distance * 0.66)));
  const mode = spec.graphMode || spec.mode || "distance_between";
  if (mode === "position_two_lines") {
    renderSeriesGraph({
      xMax: slowArrivalTime * 1.12,
      yMax: distance * 1.14,
      xLabel: spec.xLabel || "x/小时",
      yLabel: spec.yLabel || "离甲地距离/千米",
      xTicks: [0, meetTime, fastArrivalTime, slowArrivalTime],
      yTicks: [distance, cDistance],
      series: [
        { label: spec.fastLineLabel || "甲车", points: [{ x: 0, y: 0 }, { x: fastArrivalTime, y: distance }] },
        { label: spec.slowLineLabel || "乙车", points: [{ x: 0, y: distance }, { x: slowArrivalTime, y: 0 }], color: "#2563eb" }
      ],
      points: [
        { name: "A", x: 0, y: 0, dx: 12, dy: 18 },
        { name: "B", x: 0, y: distance, dx: 14, dy: -8 },
        { name: "P", x: meetTime, y: cDistance, dx: 12, dy: -10 },
        { name: "C", x: fastArrivalTime, y: distance, dx: 12, dy: -10 },
        { name: "D", x: slowArrivalTime, y: 0, dx: 12, dy: -10 }
      ],
      guides: [{ x: meetTime, y: cDistance }, { y: cDistance, x: meetTime }, { x: fastArrivalTime, y: distance }, { x: slowArrivalTime, y: distance }]
    });
    return;
  }
  if (mode === "delayed_distance") {
    const delayTime = Math.max(0.5, Math.min(meetTime - 0.2, svgNumber(spec.delayTime, Math.max(1, meetTime / 3))));
    const startDistance = Math.max(distance * 0.35, Math.min(distance * 0.9, svgNumber(spec.startDistance, distance * 0.75)));
    renderSeriesGraph({
      xMax: slowArrivalTime * 1.08,
      yMax: Math.max(distance, startDistance) * 1.14,
      xLabel: spec.xLabel || "x/小时",
      yLabel: spec.yLabel || "两车距离/千米",
      xTicks: [0, delayTime, meetTime, fastArrivalTime, slowArrivalTime],
      yTicks: [startDistance, cDistance],
      series: [
        { points: [{ x: 0, y: startDistance }, { x: delayTime, y: startDistance }, { x: meetTime, y: 0 }, { x: fastArrivalTime, y: cDistance }, { x: slowArrivalTime, y: distance }] }
      ],
      points: [
        { name: "A", x: 0, y: startDistance, dx: 12, dy: -8 },
        { name: "B", x: delayTime, y: startDistance, dx: 12, dy: -8 },
        { name: "C", x: meetTime, y: 0, dx: 10, dy: -12 },
        { name: "D", x: fastArrivalTime, y: cDistance, dx: 12, dy: -10 },
        { name: "E", x: slowArrivalTime, y: distance, dx: 12, dy: -10 }
      ],
      guides: [{ x: delayTime, y: startDistance }, { x: meetTime, y: startDistance }, { x: fastArrivalTime, y: cDistance }, { y: cDistance, x: fastArrivalTime }]
    });
    return;
  }
  if (mode === "rest_position") {
    renderSeriesGraph({
      xMax: slowArrivalTime * 1.08,
      yMax: distance * 1.14,
      xLabel: spec.xLabel || "x/小时",
      yLabel: spec.yLabel || "离甲地距离/千米",
      xTicks: [0, meetTime, fastArrivalTime, slowArrivalTime],
      yTicks: [cDistance, distance],
      series: [
        { points: [{ x: 0, y: 0 }, { x: meetTime, y: cDistance }, { x: fastArrivalTime, y: cDistance }, { x: slowArrivalTime, y: distance }] }
      ],
      points: [
        { name: "A", x: 0, y: 0, dx: -14, dy: 18 },
        { name: "B", x: meetTime, y: cDistance, dx: 12, dy: -10 },
        { name: "C", x: fastArrivalTime, y: cDistance, dx: 12, dy: -10 },
        { name: "D", x: slowArrivalTime, y: distance, dx: 12, dy: -10 }
      ],
      guides: [{ x: meetTime, y: cDistance }, { x: fastArrivalTime, y: cDistance }, { y: cDistance, x: fastArrivalTime }, { x: slowArrivalTime, y: distance }, { y: distance, x: slowArrivalTime }]
    });
    return;
  }
  const xMax = slowArrivalTime * 1.08;
  const yMax = distance * 1.12;
  const tx = (x) => left + (svgNumber(x) / xMax) * (width - left - right);
  const ty = (y) => height - bottom - (svgNumber(y) / yMax) * (height - top - bottom);
  const O = { x: tx(0), y: ty(0) };
  const A = { x: tx(0), y: ty(distance) };
  const B = { x: tx(meetTime), y: ty(0) };
  const C = { x: tx(fastArrivalTime), y: ty(cDistance) };
  const D = { x: tx(slowArrivalTime), y: ty(distance) };

  svgLine(base, O, { x: width - right + 6, y: O.y }, { width: 1.8, color: axisColor });
  svgLine(base, O, { x: O.x, y: top - 8 }, { width: 1.8, color: axisColor });
  base.push(`<path d="M${width - right + 6} ${O.y} l-8 -4 l0 8 Z" fill="${axisColor}"/>`);
  base.push(`<path d="M${O.x} ${top - 8} l-4 8 l8 0 Z" fill="${axisColor}"/>`);
  base.push(`<text x="${width - right - 24}" y="${O.y - 10}" font-size="12" fill="${axisColor}">${svgText(spec.xLabel || "x/小时")}</text>`);
  base.push(`<text x="${O.x + 6}" y="${top - 14}" font-size="12" fill="${axisColor}">${svgText(spec.yLabel || "y/千米")}</text>`);

  const xTicks = [0, meetTime, fastArrivalTime, slowArrivalTime];
  for (let tick = 1; tick < slowArrivalTime; tick += 1) {
    if (tick !== Math.round(meetTime) && tick !== Math.round(fastArrivalTime)) {
      const x = tx(tick);
      base.push(`<line x1="${x}" y1="${O.y - 4}" x2="${x}" y2="${O.y + 4}" stroke="#94a3b8" stroke-width="1"/>`);
    }
  }
  for (const tick of xTicks) {
    const x = tx(tick);
    base.push(`<line x1="${x}" y1="${O.y - 6}" x2="${x}" y2="${O.y + 6}" stroke="${axisColor}" stroke-width="1.2"/>`);
    if (tick === 0) continue;
    base.push(svgLabel(formatCompactNumber(tick), x, O.y + 22, { size: 12, weight: "600" }));
  }

  const yTicks = [...new Set([distance, cDistance].map((value) => formatCompactNumber(value)))].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  for (const tick of yTicks) {
    const y = ty(tick);
    base.push(`<line x1="${O.x - 6}" y1="${y}" x2="${O.x + 6}" y2="${y}" stroke="${axisColor}" stroke-width="1.2"/>`);
    base.push(svgLabel(formatCompactNumber(tick), O.x - 12, y + 4, { size: 12, weight: "600", anchor: "end" }));
  }

  svgLine(base, A, D, { width: 1.2, color: guideColor, dashed: "5 4" });
  svgLine(base, B, { x: B.x, y: O.y }, { width: 1.2, color: guideColor, dashed: "5 4" });
  svgLine(base, C, { x: C.x, y: O.y }, { width: 1.2, color: guideColor, dashed: "5 4" });
  svgLine(base, D, { x: D.x, y: O.y }, { width: 1.2, color: guideColor, dashed: "5 4" });
  svgLine(base, C, { x: O.x, y: C.y }, { width: 1.2, color: guideColor, dashed: "5 4" });

  svgPath(base, `M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} L${D.x} ${D.y}`, { width: 2.4, color: "#0f172a" });
  svgPoint(base, O.x, O.y, "O", { dx: -14, dy: 18, radius: 0.1, size: 12 });
  svgPoint(base, A.x, A.y, "A", { dx: 14, dy: -8, radius: 3.2 });
  svgPoint(base, B.x, B.y, "B", { dx: 10, dy: -12, radius: 3.2 });
  svgPoint(base, C.x, C.y, "C", { dx: 14, dy: -8, radius: 3.2 });
  svgPoint(base, D.x, D.y, "D", { dx: 14, dy: -8, radius: 3.2 });
}

function appendQuadraticParabolaComprehensiveSvg(base, width, height, spec = {}) {
  const left = 58;
  const right = 38;
  const top = 26;
  const bottom = 38;
  const axisColor = "#111827";
  const curveColor = "#111827";
  const guideColor = "#94a3b8";
  const leftRoot = svgNumber(spec.leftRoot, -2);
  const rightRoot = svgNumber(spec.rightRoot, 4);
  const h = svgNumber(spec.h, (leftRoot + rightRoot) / 2);
  const d = Math.max(0.5, svgNumber(spec.d, Math.abs(rightRoot - leftRoot) / 2));
  const z = Math.max(0.15, Math.min(0.9, svgNumber(spec.z, 2 / 3)));
  const vertexY = svgNumber(spec.vertexY, -(d ** 2));
  const pointD = spec.pointD && typeof spec.pointD === "object"
    ? { x: svgNumber(spec.pointD.x, h + d * z), y: svgNumber(spec.pointD.y, -((1 - z ** 2) * d ** 2)) }
    : { x: h + d * z, y: -((1 - z ** 2) * d ** 2) };
  const xMin = Math.min(leftRoot - d * 0.55, -0.7);
  const xMax = Math.max(rightRoot + d * 0.55, 0.7);
  const yMin = Math.min(vertexY - d * 0.45, pointD.y - d * 0.35);
  const yMax = Math.max(d * 0.45, 1.2);
  const tx = (x) => left + ((svgNumber(x) - xMin) / Math.max(1e-9, xMax - xMin)) * (width - left - right);
  const ty = (y) => height - bottom - ((svgNumber(y) - yMin) / Math.max(1e-9, yMax - yMin)) * (height - top - bottom);
  const O = { x: tx(0), y: ty(0) };
  const A = { x: tx(leftRoot), y: ty(0) };
  const B = { x: tx(rightRoot), y: ty(0) };
  const C = { x: tx(h), y: ty(vertexY) };
  const D = { x: tx(pointD.x), y: ty(pointD.y) };

  svgLine(base, { x: left - 10, y: O.y }, { x: width - right + 8, y: O.y }, { width: 1.8, color: axisColor });
  svgLine(base, { x: O.x, y: height - bottom + 8 }, { x: O.x, y: top - 8 }, { width: 1.8, color: axisColor });
  base.push(`<path d="M${width - right + 8} ${O.y} l-8 -4 l0 8 Z" fill="${axisColor}"/>`);
  base.push(`<path d="M${O.x} ${top - 8} l-4 8 l8 0 Z" fill="${axisColor}"/>`);
  base.push(`<text x="${width - right + 16}" y="${O.y + 4}" font-size="13" font-weight="600" fill="${axisColor}">x</text>`);
  base.push(`<text x="${O.x + 7}" y="${top - 12}" font-size="13" font-weight="600" fill="${axisColor}">y</text>`);

  const pts = [];
  for (let index = 0; index <= 96; index += 1) {
    const x = xMin + ((xMax - xMin) * index) / 96;
    const y = (x - leftRoot) * (x - rightRoot);
    pts.push(`${tx(x).toFixed(1)},${ty(y).toFixed(1)}`);
  }
  base.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${curveColor}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`);
  base.push(svgLabel("L", width - right - 18, top + 18, { size: 13, weight: "700" }));

  svgLine(base, C, D, { width: 1.8, color: curveColor });
  svgLine(base, { x: D.x, y: O.y }, D, { width: 1.1, color: guideColor, dashed: "5 5" });
  svgLine(base, { x: C.x, y: O.y }, C, { width: 1.1, color: guideColor, dashed: "5 5" });

  svgPoint(base, O.x, O.y, "O", { dx: -14, dy: 18, radius: 0.1, size: 12 });
  svgPoint(base, A.x, A.y, "A", { dx: -12, dy: 20, radius: 3.1, size: 13 });
  svgPoint(base, B.x, B.y, "B", { dx: 12, dy: 20, radius: 3.1, size: 13 });
  svgPoint(base, C.x, C.y, "C", { dx: 12, dy: 18, radius: 3.1, size: 13 });
  svgPoint(base, D.x, D.y, "D", { dx: 14, dy: -8, radius: 3.1, size: 13 });
}

function renderDiagramSvg(specInput = null) {
  const spec = normalizeDiagramSpec(specInput);
  if (!spec) return "";
  const width = Math.max(260, Math.min(720, svgNumber(spec.width, 420)));
  const height = Math.max(180, Math.min(520, svgNumber(spec.height, 280)));
  const base = [`<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>`];

  if (spec.type === "geometry") {
    if (spec.template === "parallel_transversal") {
      appendParallelTransversalSvg(base, width, height, spec);
    } else if (spec.template === "triangle_basic") {
      appendTriangleTemplateSvg(base, width, height, spec);
    } else if (spec.template === "circle_basic") {
      appendCircleTemplateSvg(base, width, height, spec);
    } else if (spec.template === "triangle_cevians_angles") {
      appendTriangleCeviansAnglesSvg(base, width, height, spec);
    } else if (spec.template === "triangle_midline_parallel") {
      appendTriangleMidlineParallelSvg(base, width, height, spec);
    } else if (spec.template === "similar_triangles_parallel") {
      appendSimilarTrianglesParallelSvg(base, width, height, spec);
    } else if (spec.template === "circle_tangent_secant") {
      appendCircleTangentSecantSvg(base, width, height, spec);
    } else if (spec.template === "quadrilateral_fold") {
      appendQuadrilateralFoldSvg(base, width, height, spec);
    } else if (spec.template === "grid_probability") {
      appendGridProbabilitySvg(base, width, height, spec);
    } else if (spec.template === "rotation_congruence_comprehensive") {
      appendRotationCongruenceComprehensiveSvg(base, width, height, spec);
    } else {
    const points = new Map((Array.isArray(spec.points) ? spec.points : []).map((point) => {
      const name = String(point.name || point.id || "").trim();
      return [name, { name, x: svgNumber(point.x, 0), y: svgNumber(point.y, 0) }];
    }).filter(([name]) => name));
    const pointList = [...points.values()];
    const center = pointList.length
      ? {
        x: pointList.reduce((sum, item) => sum + item.x, 0) / pointList.length,
        y: pointList.reduce((sum, item) => sum + item.y, 0) / pointList.length
      }
      : { x: width / 2, y: height / 2 };
    const point = (name) => points.get(String(name || "").trim());
    for (const polygon of Array.isArray(spec.polygons) ? spec.polygons : []) {
      const names = Array.isArray(polygon) ? polygon : polygon.points;
      const coords = (Array.isArray(names) ? names : []).map(point).filter(Boolean).map((p) => `${p.x},${p.y}`).join(" ");
      if (coords) base.push(`<polygon points="${coords}" fill="rgba(22,119,255,0.06)" stroke="#94a3b8" stroke-width="1.5"/>`);
    }
    for (const circle of Array.isArray(spec.circles) ? spec.circles : []) {
      const center = point(circle.center) || { x: svgNumber(circle.cx, 0), y: svgNumber(circle.cy, 0) };
      const radius = svgNumber(circle.r || circle.radius, 40);
      base.push(`<circle cx="${center.x}" cy="${center.y}" r="${radius}" fill="none" stroke="#334155" stroke-width="2"/>`);
    }
    for (const line of Array.isArray(spec.lines) ? spec.lines : []) {
      const from = point(Array.isArray(line) ? line[0] : line.from);
      const to = point(Array.isArray(line) ? line[1] : line.to);
      if (!from || !to) continue;
      const dashed = !Array.isArray(line) && line.dashed ? ` stroke-dasharray="6 5"` : "";
      base.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#0f172a" stroke-width="2"${dashed}/>`);
    }
    for (const mark of Array.isArray(spec.marks) ? spec.marks : []) {
      const at = point(mark.at);
      const rawX = at ? at.x : svgNumber(mark.x, NaN);
      const rawY = at ? at.y : svgNumber(mark.y, NaN);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
      const dx = svgNumber(mark.dx, at ? 14 : 0);
      const dy = svgNumber(mark.dy, at ? -12 : 0);
      const x = clampNumber(rawX + dx, 16, width - 16);
      const y = clampNumber(rawY + dy, 18, height - 12);
      base.push(svgLabel(mark.text || "", x, y, { size: 13, weight: "700" }));
    }
    for (const p of points.values()) {
      base.push(`<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#0f172a"/>`);
      const vx = p.x - center.x;
      const vy = p.y - center.y;
      const length = Math.hypot(vx, vy) || 1;
      const x = clampNumber(p.x + (vx / length) * 18, 16, width - 16);
      const y = clampNumber(p.y + (vy / length) * 18 + 5, 18, height - 12);
      base.push(svgLabel(p.name, x, y, { size: 14, weight: "700" }));
    }
    }
  }

  if (spec.type === "coordinate") {
    if (spec.template === "coordinate_linear") {
      appendCoordinateTemplateSvg(base, width, height, spec);
    } else if (spec.template === "travel_distance_time_graph") {
      appendTravelDistanceTimeGraphSvg(base, width, height, spec);
    } else if (spec.template === "quadratic_parabola_comprehensive") {
      appendQuadraticParabolaComprehensiveSvg(base, width, height, spec);
    } else {
    const padding = 34;
    const xMin = svgNumber(spec.xMin, -5);
    const xMax = svgNumber(spec.xMax, 5);
    const yMin = svgNumber(spec.yMin, -5);
    const yMax = svgNumber(spec.yMax, 5);
    const tx = (x) => padding + ((svgNumber(x) - xMin) / Math.max(1, xMax - xMin)) * (width - padding * 2);
    const ty = (y) => height - padding - ((svgNumber(y) - yMin) / Math.max(1, yMax - yMin)) * (height - padding * 2);
    base.push(`<line x1="${padding}" y1="${ty(0)}" x2="${width - padding}" y2="${ty(0)}" stroke="#334155" stroke-width="1.5"/>`);
    base.push(`<line x1="${tx(0)}" y1="${padding}" x2="${tx(0)}" y2="${height - padding}" stroke="#334155" stroke-width="1.5"/>`);
    base.push(`<text x="${width - padding + 6}" y="${ty(0) + 4}" font-size="12">x</text><text x="${tx(0) + 5}" y="${padding - 8}" font-size="12">y</text>`);
    for (const curve of Array.isArray(spec.curves) ? spec.curves : []) {
      const points = (Array.isArray(curve.points) ? curve.points : []).map((p) => `${tx(p.x)},${ty(p.y)}`).join(" ");
      if (points) base.push(`<polyline points="${points}" fill="none" stroke="${svgText(curve.color || "#1677ff")}" stroke-width="2.2"/>`);
    }
    const drawCoordinateLine = (item = {}, dashed = false) => {
      const from = item.from || {};
      const to = item.to || {};
      const x1 = tx(from.x);
      const y1 = ty(from.y);
      const x2 = tx(to.x);
      const y2 = ty(to.y);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return;
      const dash = dashed || item.dashed ? ` stroke-dasharray="${svgText(item.dash || "6 5")}"` : "";
      base.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${svgText(item.color || "#64748b")}" stroke-width="${svgNumber(item.width, 1.5)}"${dash}/>`);
    };
    for (const guide of Array.isArray(spec.guides) ? spec.guides : []) drawCoordinateLine(guide, true);
    for (const segment of Array.isArray(spec.segments) ? spec.segments : []) drawCoordinateLine(segment, false);
    for (const label of Array.isArray(spec.labels) ? spec.labels : []) {
      const x = tx(label.x);
      const y = ty(label.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      base.push(`<text x="${x + svgNumber(label.dx, 0)}" y="${y + svgNumber(label.dy, 0)}" font-size="${svgNumber(label.size, 12)}" font-weight="${svgText(label.weight || "700")}" fill="${svgText(label.color || "#0f172a")}">${svgText(label.text || "")}</text>`);
    }
    for (const p of Array.isArray(spec.points) ? spec.points : []) {
      const x = tx(p.x);
      const y = ty(p.y);
      base.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="#dc2626"/>`);
      if (p.name) base.push(`<text x="${x + 7}" y="${y - 7}" font-size="13" fill="#0f172a">${svgText(p.name)}</text>`);
    }
    }
  }

  if (spec.type === "statistics") {
    const bars = Array.isArray(spec.bars) ? spec.bars : [];
    const padding = 36;
    const maxValue = Math.max(1, ...bars.map((bar) => svgNumber(bar.value, 0)));
    base.push(`<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#334155" stroke-width="1.5"/>`);
    base.push(`<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#334155" stroke-width="1.5"/>`);
    const barWidth = Math.max(18, (width - padding * 2) / Math.max(1, bars.length) * 0.58);
    bars.forEach((bar, index) => {
      const slot = (width - padding * 2) / Math.max(1, bars.length);
      const x = padding + slot * index + (slot - barWidth) / 2;
      const h = (svgNumber(bar.value, 0) / maxValue) * (height - padding * 2);
      const y = height - padding - h;
      base.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="#1677ff" opacity="0.82"/>`);
      base.push(`<text x="${x + barWidth / 2}" y="${height - padding + 18}" text-anchor="middle" font-size="12">${svgText(bar.label || "")}</text>`);
      base.push(`<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="12">${svgText(bar.value)}</text>`);
    });
  }

  if (spec.title) base.push(`<text x="${width / 2}" y="22" text-anchor="middle" font-size="15" font-weight="700">${svgText(spec.title)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${base.join("")}</svg>`;
}

function normalizeVariants(variants = [], parent = {}, limit = 3) {
  return (Array.isArray(variants) ? variants : []).slice(0, limit).map((item) => normalizeVariant(item, parent)).filter(Boolean);
}

function stableTemplateOffset(question = {}, templateId = "", count = 0) {
  if (!count) return 0;
  const seed = [
    templateId,
    question.id,
    question.stem,
    normalizeOptions(question.options).join("|"),
    question.sourceUploadId,
    question.sourcePage,
    question.variantGenerationNonce
  ].filter(Boolean).join("|");
  const hash = createHash("sha256").update(seed || templateId || "template").digest("hex");
  return Number.parseInt(hash.slice(0, 8), 16) % count;
}

function templateCaseSignature(item = {}) {
  const explicit = normalizeQuestionText(item.templateCaseId || item.diagramSignature || "");
  if (explicit) return explicit;
  const spec = item.diagramSpec || {};
  if (!spec || typeof spec !== "object") return "";
  if (spec.template === "travel_distance_time_graph") {
    return [
      spec.template,
      spec.graphMode || "distance_between",
      spec.distance,
      spec.meetTime,
      spec.fastArrivalTime,
      spec.slowArrivalTime,
      spec.cDistance
    ].filter((value) => value !== undefined && value !== null && value !== "").join("|");
  }
  if (spec.template) {
    return [
      spec.template,
      spec.line1Label,
      spec.line2Label,
      spec.transversalLabel,
      spec.k,
      spec.b,
      spec.rows,
      spec.cols
    ].filter((value) => value !== undefined && value !== null && value !== "").join("|");
  }
  return "";
}

function templateDataSignature(item = {}) {
  const spec = item.diagramSpec || {};
  if (!spec || typeof spec !== "object") return "";
  if (spec.template === "travel_distance_time_graph") {
    return [
      spec.template,
      spec.distance,
      spec.meetTime,
      spec.fastArrivalTime,
      spec.slowArrivalTime,
      spec.cDistance
    ].filter((value) => value !== undefined && value !== null && value !== "").join("|");
  }
  return "";
}

function pickTemplateVariants(variants = [], question = {}, templateId = "", limit = 3) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (list.length <= limit) return list;
  const offset = stableTemplateOffset(question, templateId, list.length);
  const ordered = templateId === "rotation_congruence_comprehensive_text"
    ? list.slice().sort((a, b) => {
      const rank = (item = {}) => {
        if (String(item.variationType || "").includes("full_exploration")) return 0;
        return 10;
      };
      return rank(a) - rank(b);
    })
    : list.slice(offset).concat(list.slice(0, offset));
  const selected = [];
  const usedVariationTypes = new Set();
  const usedCaseSignatures = new Set();
  const usedDataSignatures = new Set();
  const usedGraphModes = new Set();
  const take = (item) => {
    selected.push(item);
    const variationType = item.variationType || "";
    const caseSignature = templateCaseSignature(item);
    const dataSignature = templateDataSignature(item);
    const graphMode = item.diagramSpec?.graphMode || item.diagramSpec?.mode || "";
    if (variationType) usedVariationTypes.add(variationType);
    if (caseSignature) usedCaseSignatures.add(caseSignature);
    if (dataSignature) usedDataSignatures.add(dataSignature);
    if (graphMode) usedGraphModes.add(graphMode);
  };

  for (const item of ordered) {
    const variationType = item.variationType || "";
    const caseSignature = templateCaseSignature(item);
    const dataSignature = templateDataSignature(item);
    const graphMode = item.diagramSpec?.graphMode || item.diagramSpec?.mode || "";
    if (!variationType || usedVariationTypes.has(variationType)) continue;
    if (caseSignature && usedCaseSignatures.has(caseSignature)) continue;
    if (dataSignature && usedDataSignatures.has(dataSignature)) continue;
    if (graphMode && usedGraphModes.has(graphMode)) continue;
    take(item);
    if (selected.length >= limit) return selected;
  }

  for (const item of ordered) {
    const graphMode = item.diagramSpec?.graphMode || item.diagramSpec?.mode || "";
    if (!graphMode || usedGraphModes.has(graphMode)) continue;
    take(item);
    if (selected.length >= limit) return selected;
  }

  for (const item of ordered) {
    const key = item.variationType || "";
    if (!key || usedVariationTypes.has(key)) continue;
    take(item);
    if (selected.length >= limit) return selected;
  }

  for (const item of ordered) {
    const caseSignature = templateCaseSignature(item);
    if (!caseSignature || usedCaseSignatures.has(caseSignature)) continue;
    take(item);
    if (selected.length >= limit) return selected;
  }

  for (const item of ordered) {
    if (selected.includes(item)) continue;
    take(item);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function isTransversalAngleProblem(text = "") {
  return /(截线|所截|被[^。；，,]*截|同位角|内错角|同旁内角|两直线.*相交|平行线.*角|a\s*\/\/\s*b|a\s*∥\s*b)/i.test(String(text || ""));
}

function isTriangleTemplateProblem(text = "") {
  return /(三角形|△|等腰|等边|直角三角形|全等|相似|中线|角平分线|高线|垂足|边\s*[A-Z]{2}|∠[A-Z])/.test(String(text || ""));
}

function isCircleTemplateProblem(text = "") {
  return /(圆|圆心|半径|直径|弦|切线|割线|圆周角|圆心角|扇形|弧|⊙)/.test(String(text || ""));
}

function isCoordinateTemplateProblem(text = "") {
  return /(平面直角坐标系|坐标系|一次函数|二次函数|函数图象|函数图像|抛物线|直线\s*y|y\s*=|坐标轴|点[ABC].*坐标)/i.test(String(text || ""));
}

function isTravelDistanceTimeGraphProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(快车|慢车|甲车|乙车|两车|汽车|列车|火车|动车|车辆|车)/.test(value)
    && /(距离|路程|相距|千米|公里|km|y)/i.test(value)
    && /(时间|小时|h|x)/i.test(value)
    && /(图象|图像|图示|如图|根据图|函数关系式|关系式|线段BC|y与x|两者的关系)/.test(value)
    && /(相遇|同时出发|到达目的地|到达后停止|行驶|驶往)/.test(value);
}

function isStatisticsTemplateProblem(text = "") {
  return /(统计图|条形图|折线图|扇形图|频数|频率|样本|调查|平均数|中位数|众数)/.test(String(text || ""));
}

function isGridProbabilityProblem(text = "") {
  const value = String(text || "");
  return /(方格|网格|格子|九宫格|宫格|阴影|涂黑)/.test(value)
    && /(概率|可能性|随机|阴影|涂黑)/.test(value);
}

function isTriangleCeviansAngleProblem(text = "") {
  const value = String(text || "");
  return /(三角形|△)/.test(value)
    && /(点\s*[D-F]|[D-F]\s*在|[D-F]为|交于|连接|连结|作|过点)/i.test(value)
    && /(∠\d|角\d|角平分|外角|内角|同位角|内错角|相等|平行|垂直|⊥)/.test(value);
}

function isTriangleMidlineParallelProblem(text = "") {
  const value = String(text || "");
  return /(三角形|△)/.test(value) && /(中点|中位线|D为.*中点|E为.*中点|DE\s*∥\s*BC|平行于.*BC)/i.test(value);
}

function isSimilarTrianglesParallelProblem(text = "") {
  const value = String(text || "");
  return /(相似|比例|对应边|面积比|DE\s*∥\s*BC|FG\s*∥\s*BC|平行线分线段成比例)/i.test(value)
    && /(三角形|△|平行)/.test(value);
}

function isCircleTangentSecantProblem(text = "") {
  const value = String(text || "");
  return /(圆|⊙)/.test(value) && /(切线|割线|切点|切割线|弦切角)/.test(value);
}

function isQuadrilateralFoldProblem(text = "") {
  return /(矩形|正方形|平行四边形|四边形).*(折叠|翻折|沿.*折|重合|对折)|(?:折叠|翻折).*(矩形|正方形|平行四边形|四边形)/.test(String(text || ""));
}

function isCongruentTrianglesProofProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(全等|≌|SAS|ASA|AAS|SSS|HL|证明.*△.*≌|求证.*△.*≌)/i.test(value)
    && /(三角形|△|Rt△|边|角|对应|证明|求证)/.test(value);
}

function isRotationCongruenceComprehensiveProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  const hasRotation = /(旋转|绕点|固定.*顶点|完全重合|纸片|线片|转动)/.test(value);
  const hasCongruentRightTriangles = /(全等|AB=AD|AD=AB|BC=DE|DE=BC|∠ABC=∠ADE|直角三角形|Rt△)/i.test(value);
  const hasExploration = /(BD|CE|中线|延长线|直角三角形|面积|探究|拓展|初步感知|深入探究|[（(]1[)）].*[（(]2[)）])/i.test(value);
  return hasRotation && hasCongruentRightTriangles && hasExploration;
}

function isAngleBisectorTemplateProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(角平分线|平分∠|平分角|到角两边距离|角的平分线|AD平分|BD平分|CD平分)/.test(value)
    && /(三角形|△|∠|距离|垂直|证明|求|等腰|边)/.test(value);
}

function isMovingPointExtremumProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(动点|点P.*运动|P为.*动点|最值|最大值|最小值|最短|面积最大|周长最小|取最大|取最小)/.test(value)
    && /(线段|三角形|矩形|面积|周长|函数|坐标|二次函数|AP|PB|x)/i.test(value);
}

function isFunctionGeometryComprehensiveProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(函数几何|函数.*几何|坐标.*几何|一次函数|二次函数|抛物线|直线y|y=)/i.test(value)
    && /(三角形|面积|交点|坐标|顶点|动点|综合|证明|最值|与x轴|与y轴)/.test(value);
}

function isQuadraticParabolaComprehensiveProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  const hasParabola = /(二次函数|抛物线|y=.*x²|y=.*x\^2|ax²|ax\^2)/i.test(value);
  const hasCoordinateFrame = /(平面直角坐标系|xOy|坐标系|x轴|y轴|与x轴交于|交于A、B|交于A,B|顶点为|顶点)/i.test(value);
  const hasComprehensiveSignals = /(第四象限|面积|△|三角形|tan|正切|平移|定点|A'|A′|B'|B′|L'|L′|参数a|a>0|延长|交x轴|交于点E)/i.test(value);
  const hasMultiStep = /[（(]1[)）].*[（(]2[)）]|①.*②|求.*求.*判断|若是.*若不是/.test(value);
  return hasParabola && hasCoordinateFrame && (hasComprehensiveSignals || hasMultiStep);
}

function isGeometryComprehensiveProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(几何综合|综合题|证明|求证|辅助线|动点|分类讨论|[（(]1[)）].*[（(]2[)）]|①.*②|③)/.test(value)
    && /(三角形|△|四边形|矩形|正方形|圆|⊙|平行|垂直|相似|全等|角平分线|中点|切线|线段|直线|角|边|点[A-Z])/i.test(value);
}

function isGenericGeometryProofProblem(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  return /(证明|求证|说明理由|请说明)/.test(value)
    && /(∠|角|线段|直线|平行|垂直|相等|中点|三角形|△|四边形|矩形|正方形|圆|⊙|全等|相似|边|点[A-Z])/i.test(value)
    && !/(概率|统计|方程|不等式|函数关系式|一次函数|二次函数|抛物线|平均数|中位数|众数)/.test(value);
}

function inferComplexGeometryTemplate(text = "") {
  if (isFunctionGeometryComprehensiveProblem(text)) return "function_geometry_comprehensive_text";
  if (isMovingPointExtremumProblem(text)) return "moving_point_extremum_text";
  if (isRotationCongruenceComprehensiveProblem(text)) return "rotation_congruence_comprehensive_text";
  if (isCongruentTrianglesProofProblem(text)) return "congruent_triangles_proof_text";
  if (isAngleBisectorTemplateProblem(text)) return "angle_bisector_text";
  if (isGenericGeometryProofProblem(text)) return "geometry_comprehensive_text";
  if (isGeometryComprehensiveProblem(text)) return "geometry_comprehensive_text";
  if (isTriangleMidlineParallelProblem(text)) return "triangle_midline_parallel";
  if (isSimilarTrianglesParallelProblem(text)) return "similar_triangles_parallel";
  if (isTriangleCeviansAngleProblem(text)) return "triangle_cevians_angles";
  if (isCircleTangentSecantProblem(text)) return "circle_tangent_secant";
  if (isQuadrilateralFoldProblem(text)) return "quadrilateral_fold";
  return "";
}

function makeComplexGeometryDiagramSpec(template, rawDiagramSpec = null) {
  const defaults = {
    type: "geometry",
    template,
    width: 420,
    height: 280
  };
  return rawDiagramSpec?.template === template ? { ...defaults, ...rawDiagramSpec, template } : defaults;
}

function makeParallelTransversalDiagramSpec(question = {}, parent = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, parent.stem].filter(Boolean).join("\n");
  const lowerLabels = body.match(/直线\s*([a-zℓ])\s*[、,，和与]\s*([a-zℓ])[^。；，,]*直线\s*([a-zℓ])/i);
  const pairLabels = [...body.matchAll(/直线\s*([A-Z]{2})/g)].map((match) => match[1]);
  return {
    type: "geometry",
    template: "parallel_transversal",
    width: 420,
    height: 280,
    line1Label: normalizeDiagramLabel(lowerLabels?.[1] || pairLabels[0] || "a"),
    line2Label: normalizeDiagramLabel(lowerLabels?.[2] || pairLabels[1] || "b"),
    transversalLabel: normalizeDiagramLabel(lowerLabels?.[3] || pairLabels[2] || "c")
  };
}

function makeTriangleDiagramSpec(question = {}, parent = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, parent.stem].filter(Boolean).join("\n");
  return {
    type: "geometry",
    template: "triangle_basic",
    width: 420,
    height: 280,
    showMedian: /(中线|中点|BD\s*=\s*DC|D为.*中点)/i.test(body),
    showHeight: /(高|垂直|垂足|⊥)/.test(body),
    showBisector: /(角平分线|平分∠)/.test(body)
  };
}

function makeCircleDiagramSpec(question = {}, parent = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, parent.stem].filter(Boolean).join("\n");
  return {
    type: "geometry",
    template: "circle_basic",
    width: 420,
    height: 280,
    showInscribedAngle: /(圆周角|弦|弧|∠)/.test(body)
  };
}

function makeCoordinateDiagramSpec(question = {}, parent = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, parent.stem].filter(Boolean).join("\n");
  const kb = body.match(/y\s*=\s*([+-]?\d+(?:\.\d+)?)\s*x\s*([+-]\s*\d+(?:\.\d+)?)?/i);
  return {
    type: "coordinate",
    template: "coordinate_linear",
    width: 420,
    height: 280,
    xMin: -4,
    xMax: 4,
    yMin: -3,
    yMax: 5,
    k: kb ? Number(kb[1]) : 1,
    b: kb?.[2] ? Number(kb[2].replace(/\s+/g, "")) : 1,
    points: [{ name: "A", x: 0, y: kb?.[2] ? Number(kb[2].replace(/\s+/g, "")) : 1 }]
  };
}

function makeTravelDistanceTimeGraphDiagramSpec({
  distance = 1200,
  meetTime = 4.8,
  fastArrivalTime = 8,
  slowArrivalTime = 12,
  speedSlow = 100,
  graphMode = "distance_between",
  delayTime = 0,
  startDistance = 0,
  fastLineLabel = "",
  slowLineLabel = ""
} = {}) {
  const cDistance = speedSlow * fastArrivalTime;
  return {
    type: "coordinate",
    template: "travel_distance_time_graph",
    graphMode,
    width: 420,
    height: 280,
    distance,
    meetTime,
    fastArrivalTime,
    slowArrivalTime,
    cDistance,
    delayTime,
    startDistance,
    fastLineLabel,
    slowLineLabel,
    xLabel: "x/小时",
    yLabel: ["position_two_lines", "rest_position"].includes(graphMode) ? "离甲地距离/千米" : "y/千米"
  };
}

function makeStatisticsDiagramSpec() {
  return {
    type: "statistics",
    template: "bar_basic",
    width: 420,
    height: 280,
    bars: [
      { label: "甲", value: 12 },
      { label: "乙", value: 18 },
      { label: "丙", value: 15 }
    ]
  };
}

const TEMPLATE_LABELS = {
  parallel_transversal: "平行线截线角",
  triangle_basic: "三角形基础",
  triangle_cevians_angles: "三角形多线角标",
  triangle_midline_parallel: "三角形中位线",
  similar_triangles_parallel: "相似三角形",
  circle_basic: "圆基础",
  circle_tangent_secant: "圆切线",
  quadrilateral_fold: "四边形折叠",
  grid_probability: "方格概率",
  coordinate_linear: "一次函数坐标",
  travel_distance_time_graph: "行程距离时间图",
  bar_basic: "条形统计图",
  probability_text: "概率基础",
  linear_equation_text: "一元一次方程",
  linear_inequality_text: "一元一次不等式",
  pythagorean_text: "勾股定理",
  plane_area_text: "平面图形面积",
  quadratic_function_text: "二次函数基础",
  proportion_percent_text: "百分比与比例",
  polynomial_operations_text: "整式运算",
  factorization_text: "因式分解",
  radical_text: "二次根式",
  rational_expression_text: "分式运算",
  equation_system_text: "二元一次方程组",
  quadratic_equation_text: "一元二次方程",
  linear_inequality_system_text: "一元一次不等式组",
  linear_function_application_text: "一次函数应用",
  inverse_proportion_text: "反比例函数",
  statistics_calculation_text: "统计图计算",
  trigonometry_text: "锐角三角函数",
  polygon_angles_text: "多边形角",
  quadrilateral_basic_text: "四边形性质",
  circle_angle_text: "圆周角与弦",
  transformation_text: "图形变换",
  real_number_estimation_text: "实数估算",
  construction_text: "尺规作图",
  similar_comprehensive_text: "相似综合",
  circle_comprehensive_text: "圆综合",
  quadratic_piecewise_text: "二次函数压轴分段",
  circle_similarity_comprehensive_text: "圆与相似综合",
  rotation_congruence_comprehensive_text: "旋转相似综合",
  moving_point_area_function_text: "动点面积函数",
  geometry_extremum_text: "几何最值",
  probability_tree_list_text: "概率树状图与列表法",
  sales_application_text: "销售应用题",
  travel_application_text: "行程应用题",
  work_application_text: "工程应用题",
  geometry_comprehensive_text: "几何综合大题",
  congruent_triangles_proof_text: "全等三角形证明",
  angle_bisector_text: "角平分线",
  moving_point_extremum_text: "动点最值",
  function_geometry_comprehensive_text: "函数几何综合",
  number_algebra_text: "数与代数"
};

function makeGridProbabilityDiagramSpec(question = {}, parent = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, parent.stem].filter(Boolean).join("\n");
  const grid = body.match(/(\d)\s*[×xX]\s*(\d)/);
  const rows = grid ? Number(grid[1]) : 3;
  const cols = grid ? Number(grid[2]) : 3;
  const shadedCount = Math.max(1, Math.min(rows * cols - 1, Number((body.match(/(\d+)\s*个[^，。；]*阴影/) || [])[1] || 2)));
  const shaded = [];
  for (let index = 0; index < shadedCount; index += 1) {
    shaded.push([Math.floor(index / cols) + 1, (index % cols) + 1]);
  }
  return {
    type: "geometry",
    template: "grid_probability",
    width: 420,
    height: 280,
    rows,
    cols,
    shaded,
    label: "阴影区域"
  };
}

function inferTemplateDiagramSpec(question = {}, parent = {}, rawDiagramSpec = null) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, question.imageNote, parent.stem].filter(Boolean).join("\n");
  if (rawDiagramSpec && (question.generationMode === "system_template" || /系统模板/.test(question.source || ""))) {
    return rawDiagramSpec;
  }
  if (isTravelDistanceTimeGraphProblem(body)) return rawDiagramSpec?.template === "travel_distance_time_graph" ? rawDiagramSpec : makeTravelDistanceTimeGraphDiagramSpec();
  if (isTransversalAngleProblem(body)) return makeParallelTransversalDiagramSpec(question, parent);
  if (isGridProbabilityProblem(body)) return rawDiagramSpec?.template === "grid_probability" ? rawDiagramSpec : makeGridProbabilityDiagramSpec(question, parent);
  const complexTemplate = inferComplexGeometryTemplate(body);
  if (complexTemplate) {
    if (!["triangle_midline_parallel", "similar_triangles_parallel", "circle_tangent_secant", "quadrilateral_fold"].includes(complexTemplate)) return rawDiagramSpec || null;
    return makeComplexGeometryDiagramSpec(complexTemplate, rawDiagramSpec);
  }
  if (isTriangleTemplateProblem(body)) return makeTriangleDiagramSpec(question, parent);
  if (isCircleTemplateProblem(body)) return makeCircleDiagramSpec(question, parent);
  if (isCoordinateTemplateProblem(body)) return rawDiagramSpec?.type === "coordinate" ? rawDiagramSpec : makeCoordinateDiagramSpec(question, parent);
  if (isStatisticsTemplateProblem(body)) return rawDiagramSpec?.type === "statistics" ? rawDiagramSpec : makeStatisticsDiagramSpec(question, parent);
  return null;
}

function normalizeVariant(item = {}, parent = {}) {
  const subject = normalizeOneOf(item.subject || parent.subject, SUBJECTS, parent.subject || "初中数学");
  const stem = normalizeQuestionText(item.stem);
  const rawDiagramSpec = normalizeDiagramSpec(item.diagramSpec);
  const templateDiagramSpec = inferTemplateDiagramSpec({ ...item, stem }, parent, rawDiagramSpec);
  const diagramSpec = templateDiagramSpec || rawDiagramSpec;
  const templateId = item.templateId || item.verification?.templateId || diagramSpec?.template || "";
  const source = item.source || "";
  const generationMode = item.generationMode || (/系统模板/.test(source) ? "system_template" : "");
  const variant = {
    id: item.id || "",
    stem,
    options: normalizeOptions(item.options),
    answer: normalizeQuestionText(item.answer),
    explanation: normalizeQuestionText(item.explanation),
    subject,
    stage: normalizeOneOf(item.stage || parent.stage, STAGES, parent.stage || "初中"),
    grade: item.grade || parent.grade || "",
    chapter: item.chapter || parent.chapter || "",
    knowledge: normalizeKnowledgeTags(item.knowledge || parent.knowledge, subject, stem),
    level: normalizeOneOf(item.level || parent.level, LEVELS, parent.level || "基础"),
    type: item.type || parent.type || inferQuestionType(item.stem || ""),
    source,
    sourceQuestionId: item.sourceQuestionId || "",
    sourceUrl: item.sourceUrl || item.url || "",
    sourceTitle: normalizeQuestionText(item.sourceTitle || item.title || ""),
    sourceSnippet: normalizeQuestionText(item.sourceSnippet || item.snippet || ""),
    searchQuery: normalizeQuestionText(item.searchQuery || ""),
    webSearchScore: Number(item.webSearchScore || item.score || 0),
    templateId,
    generationMode,
    verification: (item.verification || generationMode === "system_template") ? normalizeVariantVerification(item.verification, templateId) : null,
    polishStatus: item.polishStatus || "",
    reuseSourceImage: Boolean(item.reuseSourceImage),
    imageNote: normalizeQuestionText(item.imageNote || ""),
    variationType: item.variationType || "",
    templateCaseId: normalizeQuestionText(item.templateCaseId || ""),
    diagramSignature: normalizeQuestionText(item.diagramSignature || item.templateCaseId || ""),
    questionImage: item.questionImage || "",
    questionImageStoredName: item.questionImageStoredName || "",
    questionImageManual: Boolean(item.questionImageManual),
    diagramSpec,
    diagramSvg: templateDiagramSpec ? renderDiagramSvg(diagramSpec) : (item.diagramSvg || renderDiagramSvg(diagramSpec)),
    matchProfile: item.matchProfile || null,
    matchInfo: item.matchInfo || null,
    feedback: item.feedback || "",
    feedbackAt: item.feedbackAt || "",
    variantOf: parent.id || ""
  };
  if (variant.generationMode === "system_template" || /系统模板/.test(variant.source)) {
    variant.verification = verifyTemplateVariant(variant, parent);
  }
  if (!variant.stem) return null;
  if (!isVariantTypeConsistent(variant, parent)) return null;
  return variant;
}

function variantGroup(item = {}) {
  const source = String(item.source || "");
  if (/联网|AI查题|web|online/i.test(source)) return "web";
  if (/题库|复用|bank/i.test(source)) return "bank";
  if (/AI|生成|ai/i.test(source)) return "ai";
  return "";
}

function splitVariantGroups(input = {}, parent = {}) {
  const explicitAi = normalizeVariants(input.aiVariants || [], parent).map((item) => ({ ...item, source: item.source || "AI生成" }));
  const explicitBank = normalizeVariants(input.bankVariants || [], parent, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
  const explicitWeb = normalizeVariants(input.webVariants || [], parent).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  const legacy = normalizeVariants(input.variants || [], parent, 9);
  const legacyAi = legacy.filter((item) => variantGroup(item) === "ai").map((item) => ({ ...item, source: item.source || "AI生成" }));
  const legacyBank = legacy.filter((item) => variantGroup(item) === "bank").map((item) => ({ ...item, source: item.source || "题库找题" }));
  const legacyWeb = legacy.filter((item) => variantGroup(item) === "web").map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  const legacyUnknown = legacy.filter((item) => !variantGroup(item)).map((item) => ({ ...item, source: item.source || "AI生成" }));
  const aiVariants = explicitAi.length ? explicitAi : [...legacyAi, ...legacyUnknown].slice(0, 3);
  const bankVariants = explicitBank.length ? explicitBank : legacyBank.slice(0, 5);
  const webVariants = explicitWeb.length ? explicitWeb : legacyWeb.slice(0, 3);
  return {
    aiVariants,
    bankVariants,
    webVariants,
    variants: [...webVariants, ...aiVariants, ...bankVariants].slice(0, 11)
  };
}

function syncVariantGroups(question = {}) {
  const split = splitVariantGroups(question, question);
  question.aiVariants = split.aiVariants;
  question.bankVariants = split.bankVariants;
  question.webVariants = split.webVariants;
  question.variants = split.variants;
  return question;
}

function isBareChoiceAnswer(answer = "") {
  return /^[A-D]$/i.test(String(answer).trim());
}

function hasVisibleChoiceOptions(question = {}) {
  return normalizeOptions(question.options).length >= 2 || /(?:^|\n)\s*A[.、]\s*\S[\s\S]*(?:^|\n)\s*B[.、]\s*\S/im.test(String(question.stem || ""));
}

function isVariantTypeConsistent(variant = {}, parent = {}) {
  const parentIsChoice = parent.type === "选择题" || hasVisibleChoiceOptions(parent);
  const variantIsChoice = variant.type === "选择题" || hasVisibleChoiceOptions(variant);
  const isSystemTemplate = variant.generationMode === "system_template" || /系统模板/.test(variant.source || "");
  if (isSystemTemplate && variant.type !== "选择题") {
    return !isBareChoiceAnswer(variant.answer);
  }
  if ((parentIsChoice || variant.type === "选择题") && !hasVisibleChoiceOptions(variant)) return false;
  if (!parentIsChoice && variantIsChoice) return false;
  if (!variantIsChoice && isBareChoiceAnswer(variant.answer)) return false;
  return true;
}

function hasBoundQuestionImage(question = {}) {
  return Boolean(
    question.questionImageStoredName
    || question.questionImageManual
    || question.diagramSvg
    || question.diagramSpec
    || (question.questionImage && !String(question.questionImage).includes("/uploads/") && question.questionImage !== question.sourceImage)
  );
}

function hasImageCue(text = "") {
  return /(如图|下图|图中|图示|见图|阴影区域|阴影部分|由图可知|根据图|如右图|如左图|统计图|条形图|折线图|扇形图|图形说明|图表|坐标图|频数\/个|频率图|示意图)/.test(String(text));
}

function shouldUseSourcePageAsQuestionImage(question = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.imageNote].filter(Boolean).join("\n");
  return Boolean(question.sourceImage && hasImageCue(body));
}

function hasFormulaRisk(text = "") {
  return /(\\frac|\\dfrac|\\sqrt|\$|[a-zA-Z0-9]\^\{?\d|√|∠|△|≈|≠|≤|≥|±|π)/.test(String(text));
}

function mathSymbolConsistencyIssues(text = "") {
  const value = String(text || "");
  const issues = [];
  if (/\\(?:frac|dfrac|sqrt|angle|parallel|perp|times|div|cdot|leq|geq|neq|triangle|circ|degree)\b/.test(value)) {
    issues.push("仍含 LaTeX 命令");
  }
  if (/\$/.test(value)) issues.push("仍含 $ 公式包裹符");
  if (/[A-Za-z]\s*\/\/\s*[A-Za-z]/.test(value)) issues.push("平行符号请统一写成 ∥");
  if (/[A-Za-z]{1,2}\s+perp\s+[A-Za-z]{1,2}/i.test(value)) issues.push("垂直符号请统一写成 ⊥");
  if (/\bsqrt\s*[\({]/i.test(value)) issues.push("根号请统一写成 √");
  if (/[A-Za-z0-9）)]\s*\^\s*\{?-?\d+\}?/.test(value)) issues.push("指数请统一写成上标，如 x²");
  if (/∠\s+[A-Za-z0-9]/.test(value)) issues.push("角符号和编号/点名之间不要留空格，如 ∠1、∠ABC");
  if (/△\s+[A-Za-z]{3}/.test(value)) issues.push("三角形符号和点名之间不要留空格，如 △ABC");
  return [...new Set(issues)];
}

function hasTextDiagramDescription(text = "") {
  return /图形说明[:：]\s*\S{6,}/.test(String(text));
}

function extractAngleNumbers(text = "") {
  const numbers = new Set();
  for (const match of String(text || "").matchAll(/∠\s*(\d{1,2})/g)) numbers.add(match[1]);
  for (const match of String(text || "").matchAll(/角\s*(\d{1,2})/g)) numbers.add(match[1]);
  return [...numbers];
}

function diagramSpecQualityIssues(specInput = null, variant = {}, parent = {}) {
  const spec = normalizeDiagramSpec(specInput);
  if (!spec) return [];
  const issues = [];
  const body = [variant.stem, normalizeOptions(variant.options).join("\n"), variant.explanation, variant.imageNote, parent.stem].filter(Boolean).join("\n");
  const angleNumbers = extractAngleNumbers(body);
  if (spec.type === "geometry") {
    if ([
      "parallel_transversal",
      "triangle_basic",
      "circle_basic",
      "triangle_cevians_angles",
      "triangle_midline_parallel",
      "similar_triangles_parallel",
      "circle_tangent_secant",
      "quadrilateral_fold",
      "grid_probability",
      "rotation_congruence_comprehensive"
    ].includes(spec.template)) {
      return [];
    }
    if (isTransversalAngleProblem(body) && spec.template !== "parallel_transversal") {
      issues.push("配图模板错误：截线角问题必须使用系统专用截线模板");
    }
    const points = Array.isArray(spec.points) ? spec.points : [];
    const pointNames = points.map((point) => String(point.name || point.id || "").trim()).filter(Boolean);
    const marks = Array.isArray(spec.marks) ? spec.marks : [];
    const markText = marks.map((mark) => String(mark.text || "")).join(" ");
    if (!points.length) issues.push("配图结构不完整：几何图缺少点坐标");
    if (angleNumbers.length && pointNames.some((name) => /\d/.test(name))) {
      issues.push("配图标注错误：疑似把∠1、∠2这类角编号当成点名");
    }
    if (angleNumbers.length >= 2) {
      const markedCount = angleNumbers.filter((number) => markText.includes(number)).length;
      if (markedCount < Math.min(3, angleNumbers.length)) {
        issues.push("配图标注不完整：题干出现角编号，但 diagramSpec 没有对应角标");
      }
    }
    if (/直线\s*[a-zA-Z]/.test(body) && (Array.isArray(spec.lines) ? spec.lines.length : 0) < 2) {
      issues.push("配图结构不完整：题干描述多条直线，但图中线段不足");
    }
    const width = Math.max(260, Math.min(720, svgNumber(spec.width, 420)));
    const height = Math.max(180, Math.min(520, svgNumber(spec.height, 280)));
    if (points.some((point) => svgNumber(point.x, -9999) < 0 || svgNumber(point.y, -9999) < 0 || svgNumber(point.x, 9999) > width || svgNumber(point.y, 9999) > height)) {
      issues.push("配图坐标越界：部分点超出画布");
    }
  }
  if (spec.type === "coordinate" && ["coordinate_linear", "travel_distance_time_graph", "quadratic_parabola_comprehensive"].includes(spec.template)) return [];
  if (spec.type === "statistics" && spec.template === "bar_basic") return [];
  return issues;
}

function isProbablySectionHeading(text = "") {
  const value = normalizeQuestionText(text).replace(/\s+/g, "");
  if (!value) return false;
  if (value.length <= 42 && /^(?:[一二三四五六七八九十]+[、.．])?(?:选择题|填空题|解答题|判断题|计算题|实验题)(?:\(.*\)|（.*）)?$/.test(value)) return true;
  const hasQuestionSignal = /[?？=＝]|____|_{2,}|（\s*）|\(\s*\)|A[.、]|B[.、]|求|证明|计算|选择|为\(\)/.test(text);
  if (hasQuestionSignal) return false;
  if (value.length <= 34 && /(目录|章末测试|单元测试|满分|时间|总分|答题卡|答案解析|参考答案|试卷|练习|检测卷|测试卷|专题训练|巩固练习)$/.test(value)) return true;
  if (value.length <= 46 && /^(?:第[一二三四五六七八九十\d]+[章节]|专题[一二三四五六七八九十\d]+|模块[一二三四五六七八九十\d]+|Unit\d+)/i.test(value)) return true;
  if (value.length <= 60 && /(?:姓名|班级|学号|得分|满分|时间).*(?:姓名|班级|学号|得分|满分|时间)/.test(value)) return true;
  return false;
}

function isSubQuestionFragment(text = "") {
  const value = String(text || "").trim();
  return /^[（(]\s*\d{1,2}\s*[)）]/.test(value) || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(value);
}

function questionQualityIssues(question = {}) {
  const errors = [];
  const warnings = [];
  const stem = normalizeQuestionText(question.stem);
  const options = normalizeOptions(question.options);
  const body = [stem, options.join("\n")].filter(Boolean).join("\n");
  const normalizedAnswer = normalizeQuestionText(question.answer);
  const normalizedExplanation = normalizeQuestionText(question.explanation);
  const fullBody = [stem, options.join("\n"), normalizedAnswer, normalizedExplanation].filter(Boolean).join("\n");
  const type = question.type || inferQuestionType(body);
  const answer = normalizedAnswer;
  const choiceLike = type === "选择题" || hasVisibleChoiceOptions({ ...question, stem, options });
  for (const issue of mathSymbolConsistencyIssues(fullBody)) {
    errors.push(`数学符号未统一：${issue}`);
  }

  if (!stem) errors.push("没有题干");
  if (stem && stem.length < 8 && !options.length) errors.push("题干过短，疑似拆题失败");
  if (isProbablySectionHeading(stem)) errors.push("只有题型标题或页眉页脚，不是完整题目");
  if (isSubQuestionFragment(stem)) errors.push("疑似把大题的小问单独拆出，请合并到原大题");

  if (type === "选择题" && !hasVisibleChoiceOptions({ ...question, stem, options })) {
    errors.push("选择题没有识别到选项");
  }
  if (choiceLike && options.length > 0 && options.length < 4) errors.push("选择题选项不完整，请补齐 A/B/C/D");
  if (options.length === 1) errors.push("只识别到 1 个选项，请补全选项或改题型");
  if (!choiceLike && isBareChoiceAnswer(answer)) errors.push("答案只有选项字母，但题型不是选择题");
  if (choiceLike && answer && !/[A-D]/i.test(answer) && answer.length > 0) warnings.push("选择题答案没有明显的 A/B/C/D，请核对");

  if (hasImageCue(body) && !hasBoundQuestionImage(question) && !hasTextDiagramDescription(body)) {
    errors.push("题干提到如图/图中/阴影，请先自动补截图；不准时再手动框选");
  }
  if (hasImageCue(body) && question.questionImageSource && question.questionImageSource !== "manual") {
    warnings.push("本题配图为自动候选截图，请核对是否准确");
  }
  if (hasFormulaRisk(body) && !hasBoundQuestionImage(question)) {
    warnings.push("题干含复杂公式符号，建议核对公式或绑定截图");
  }
  if (!answer) warnings.push("缺少答案");
  if (!normalizeQuestionText(question.explanation)) warnings.push("缺少解析");
  if (!normalizeKnowledgeTags(question.knowledge, question.subject, stem).length) warnings.push("缺少知识点");

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function applyQuestionQuality(question = {}) {
  const { errors, warnings } = questionQualityIssues(question);
  question.qualityErrors = errors;
  question.qualityWarnings = warnings;
  question.qualityStatus = errors.length ? "blocked" : warnings.length ? "warning" : "ok";
  question.analysisError = errors[0] || "";
  return question;
}

function normalizeKnowledgeSet(value) {
  return new Set(parseTags(value).map((item) => item.toLowerCase()));
}

function overlapScore(a = [], b = []) {
  const left = normalizeKnowledgeSet(a);
  const right = normalizeKnowledgeSet(b);
  let score = 0;
  for (const item of left) {
    if (right.has(item)) score += 4;
  }
  return score;
}

function similarityScore(target = {}, candidate = {}) {
  const targetText = [target.stem, target.chapter, ...(target.knowledge || [])].join(" ");
  const candidateText = [candidate.stem, candidate.chapter, ...(candidate.knowledge || [])].join(" ");
  let score = 0;
  if (target.subject && candidate.subject === target.subject) score += 12;
  if (target.stage && candidate.stage === target.stage) score += 6;
  if (target.level && candidate.level === target.level) score += 8;
  if (target.type && candidate.type === target.type) score += 10;
  if (target.grade && candidate.grade === target.grade) score += 3;
  if (target.chapter && candidate.chapter && candidate.chapter.includes(target.chapter)) score += 5;
  score += overlapScore(target.knowledge, candidate.knowledge);
  for (const token of parseTags(targetText).slice(0, 20)) {
    if (token.length >= 2 && candidateText.includes(token)) score += 1;
  }
  return score;
}

function questionBodyForMatch(question = {}) {
  return normalizeQuestionText([
    question.stem,
    normalizeOptions(question.options).join("\n"),
    question.explanation,
    question.imageNote,
    question.chapter,
    ...(question.knowledge || [])
  ].filter(Boolean).join("\n"));
}

function hasQuestionVisual(question = {}) {
  return Boolean(question.questionImage || question.questionImageStoredName || question.diagramSpec || question.diagramSvg || question.sourceImage);
}

function questionNeedsVisual(question = {}) {
  const body = questionBodyForMatch(question);
  return hasQuestionVisual(question) || /(如图|下图|图中|图示|示意图|统计图|条形图|折线图|扇形图|函数图象|函数图像|坐标系|抛物线|圆|⊙|几何|阴影|网格|方格|图形)/.test(body);
}

function matchProfileForQuestion(question = {}) {
  const body = questionBodyForMatch(question);
  const diagramSpec = normalizeDiagramSpec(question.diagramSpec);
  const templateId = question.matchProfile?.templateId || question.templateId || diagramSpec?.template || detectedTemplateKey(question);
  const visualType = diagramSpec?.type
    || (/(平面直角坐标系|坐标系|函数图象|函数图像|抛物线|一次函数|二次函数)/.test(body) ? "coordinate" : "")
    || (/(统计图|条形图|折线图|扇形图|频率|频数)/.test(body) ? "statistics" : "")
    || (/(如图|图中|圆|⊙|三角形|四边形|矩形|正方形|平行线|垂线|角平分线|相似|全等|旋转|折叠|阴影|网格|方格)/.test(body) ? "geometry" : "")
    || (questionNeedsVisual(question) ? "visual" : "text");
  const structureTags = new Set();
  const tagRules = [
    ["coordinate", /(坐标系|x轴|y轴|函数图象|函数图像|抛物线|顶点|对称轴|象限)/i],
    ["quadratic", /(二次函数|抛物线|x²|x\^2|顶点|对称轴)/i],
    ["linear_function", /(一次函数|正比例函数|y\s*=\s*kx|函数关系式)/i],
    ["geometry", /(三角形|四边形|矩形|正方形|圆|⊙|平行线|垂线|角|边|线段)/],
    ["circle", /(圆|⊙|切线|弦|圆周角|圆心角|直径|半径)/],
    ["triangle", /(三角形|△|角平分线|中线|高线|中位线)/],
    ["similar", /(相似|∽|比例|对应边)/],
    ["congruence", /(全等|≌|SAS|ASA|AAS|SSS|HL)/],
    ["rotation", /(旋转|绕.*旋转|中心旋转)/],
    ["translation", /(平移|沿.*方向)/],
    ["fold", /(折叠|翻折)/],
    ["moving_point", /(动点|点P.*运动|运动到|速度|t秒|面积.*函数)/i],
    ["extremum", /(最大值|最小值|最短|最小|最大|取值范围|存在点)/],
    ["proof", /(证明|求证|说明理由)/],
    ["multi_part", /[（(]\s*1\s*[)）][\s\S]*[（(]\s*2\s*[)）]/],
    ["choice_options", /(?:^|\n)\s*A[.、．]\s*\S[\s\S]*(?:^|\n)\s*B[.、．]\s*\S/im],
    ["statistics", /(平均数|中位数|众数|方差|统计图|频率|频数|样本容量)/],
    ["probability", /(概率|随机|摸球|抽签|树状图|列表法|转盘|骰子)/],
    ["application", /(售价|利润|行程|工程|相遇|追及|工作效率|打折|折扣)/]
  ];
  for (const [tag, pattern] of tagRules) {
    if (pattern.test(body)) structureTags.add(tag);
  }
  return {
    version: 1,
    templateId,
    templateLabel: templateId ? TEMPLATE_LABELS[templateId] || templateId : "",
    visualRequired: questionNeedsVisual(question),
    visualType,
    structureTags: [...structureTags].sort(),
    type: question.type || inferQuestionType(question.stem || ""),
    level: question.level || "",
    subject: question.subject || "",
    stage: question.stage || "",
    knowledge: normalizeKnowledgeTags(question.knowledge, question.subject, question.stem)
  };
}

function matchProfileFieldSnapshot(question = {}) {
  return {
    matchProfile: question.matchProfile || null,
    templateId: question.templateId || "",
    templateLabel: question.templateLabel || "",
    structureTags: Array.isArray(question.structureTags) ? question.structureTags : [],
    visualType: question.visualType || "",
    visualRequired: Boolean(question.visualRequired)
  };
}

function applyQuestionMatchProfile(question = {}, { touch = true, now = new Date().toISOString() } = {}) {
  const before = JSON.stringify(matchProfileFieldSnapshot(question));
  const profile = matchProfileForQuestion(question);
  question.matchProfile = profile;
  question.templateId = profile.templateId || "";
  question.templateLabel = profile.templateLabel || "";
  question.structureTags = profile.structureTags || [];
  question.visualType = profile.visualType || "";
  question.visualRequired = Boolean(profile.visualRequired);
  const changed = before !== JSON.stringify(matchProfileFieldSnapshot(question));
  if (changed && touch) question.updatedAt = now;
  return changed;
}

function backfillQuestionMatchProfiles(db, session = null) {
  const now = new Date().toISOString();
  const summary = {
    total: 0,
    updated: 0,
    withTemplate: 0,
    withoutTemplate: 0,
    visualRequired: 0,
    byTemplate: {}
  };
  for (const question of db.questions || []) {
    if (session && !belongsToTenant(question, session)) continue;
    summary.total += 1;
    if (applyQuestionMatchProfile(question, { now })) summary.updated += 1;
    const templateId = question.matchProfile?.templateId || "";
    if (templateId) {
      summary.withTemplate += 1;
      summary.byTemplate[templateId] = (summary.byTemplate[templateId] || 0) + 1;
    } else {
      summary.withoutTemplate += 1;
    }
    if (question.matchProfile?.visualRequired) summary.visualRequired += 1;
  }
  return summary;
}

function knowledgeCoverage(targetKnowledge = [], candidate = {}) {
  const targetTags = normalizeKnowledgeTags(targetKnowledge, candidate.subject || "", "").map((item) => item.toLowerCase());
  const candidateTags = normalizeKnowledgeTags(candidate.knowledge, candidate.subject, candidate.stem).map((item) => item.toLowerCase());
  const candidateText = questionBodyForMatch(candidate).toLowerCase();
  const matched = targetTags.filter((tag) =>
    candidateTags.includes(tag)
    || candidateTags.some((item) => item.includes(tag) || tag.includes(item))
    || candidateText.includes(tag)
  );
  return { total: targetTags.length, matched: [...new Set(matched)] };
}

function sharedValues(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function bankMatchDecision(target = {}, candidate = {}) {
  const targetProfile = matchProfileForQuestion(target);
  const candidateProfile = matchProfileForQuestion(candidate);
  const reasons = [];
  const rejectReasons = [];
  const duplicateSimilarity = textSimilarity(target.stem || "", candidate.stem || "");
  const duplicateCandidate = isLikelySameQuestionText(target.stem || "", candidate.stem || "") || duplicateSimilarity >= 0.84;

  if (targetProfile.subject && candidateProfile.subject !== targetProfile.subject) rejectReasons.push("科目不一致");
  if (targetProfile.stage && candidateProfile.stage !== targetProfile.stage) rejectReasons.push("学段不一致");
  if (targetProfile.type && targetProfile.type !== "未分类" && candidateProfile.type !== targetProfile.type) rejectReasons.push("题型不一致");
  if (targetProfile.level && candidateProfile.level !== targetProfile.level) rejectReasons.push("难度不一致");
  if (targetProfile.visualRequired && !hasQuestionVisual(candidate)) rejectReasons.push("原题依赖图片，候选题没有配图");
  if (targetProfile.visualRequired && candidateProfile.visualType !== targetProfile.visualType) rejectReasons.push("图形类型不一致");

  const coverage = knowledgeCoverage(targetProfile.knowledge, candidate);
  if (coverage.total && coverage.matched.length < coverage.total) {
    rejectReasons.push(`核心知识点未全命中（${coverage.matched.length}/${coverage.total}）`);
  }

  const targetTemplate = targetProfile.templateId;
  const candidateTemplate = candidateProfile.templateId;
  if (targetTemplate && candidateTemplate && targetTemplate !== candidateTemplate) {
    rejectReasons.push("题型模板不一致");
  }
  if (targetTemplate && !candidateTemplate) {
    rejectReasons.push("候选题缺少可识别模板");
  }

  const sharedStructure = sharedValues(targetProfile.structureTags, candidateProfile.structureTags);
  const requiredStructure = targetProfile.structureTags.filter((tag) => !["multi_part", "choice_options", "application"].includes(tag));
  if (requiredStructure.length && sharedValues(requiredStructure, candidateProfile.structureTags).length < Math.min(requiredStructure.length, 2)) {
    rejectReasons.push("题目结构不一致");
  }
  if (rejectReasons.length) return { passed: false, rejectReasons, duplicateCandidate };

  let score = 0;
  if (targetTemplate && candidateTemplate === targetTemplate) {
    score += 45;
    reasons.push(`模板一致：${targetProfile.templateLabel || targetTemplate}`);
  } else {
    score += 18;
    reasons.push("结构规则一致");
  }
  score += 20;
  reasons.push(`题型一致：${targetProfile.type}`);
  score += 16;
  reasons.push(`难度一致：${targetProfile.level || "未标难度"}`);
  if (coverage.total) {
    score += 18 + coverage.matched.length * 3;
    reasons.push(`核心知识点全命中：${coverage.matched.length}/${coverage.total}`);
  }
  if (targetProfile.visualRequired) {
    score += 12;
    reasons.push(`图形类型一致：${candidateProfile.visualType}`);
  }
  if (sharedStructure.length) {
    score += Math.min(18, sharedStructure.length * 4);
    reasons.push(`结构标签命中：${sharedStructure.slice(0, 4).join("、")}`);
  }
  const textScore = textSimilarity(target.stem || "", candidate.stem || "");
  score += Math.round(textScore * 12);
  if (textScore >= 0.2) reasons.push(`文本相似度：${Math.round(textScore * 100)}%`);
  if (duplicateCandidate) {
    score += 30;
    reasons.unshift("疑似原题/重复题");
  }

  return {
    passed: score >= 70 || duplicateCandidate,
    score,
    duplicateCandidate,
    reasons,
    rejectReasons: [],
    targetProfile,
    candidateProfile,
    coverage,
    sharedStructure,
    textSimilarity: textScore
  };
}

function bankMatchReadiness(question = {}) {
  const profile = matchProfileForQuestion(question);
  const missing = [];
  if (!profile.type || profile.type === "未分类") missing.push("题型");
  if (!profile.level) missing.push("难度");
  if (!profile.knowledge.length) missing.push("核心知识点");
  if (!profile.subject) missing.push("科目");
  if (!profile.stage) missing.push("学段");
  return {
    ready: missing.length === 0,
    missing,
    profile
  };
}

function bankMatchDiagnostics(db, target = {}, { exclude = [] } = {}) {
  const excluded = new Set(exclude.filter(Boolean));
  const targetTenant = target.tenantId || DEFAULT_TENANT_ID;
  const candidates = (db.questions || []).filter((q) => (q.tenantId || DEFAULT_TENANT_ID) === targetTenant && q.stem && !excluded.has(q.id));
  const reasonCounts = new Map();
  let passed = 0;
  for (const candidate of candidates) {
    const decision = bankMatchDecision(target, candidate);
    if (decision.passed) {
      passed += 1;
      continue;
    }
    for (const reason of decision.rejectReasons || []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }
  const topRejectReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 5)
    .map(([reason, count]) => `${reason}：${count} 道`);
  return {
    candidateCount: candidates.length,
    passed,
    topRejectReasons
  };
}

function bankNoMatchMessage(db, question = {}, options = {}) {
  const readiness = bankMatchReadiness(question);
  if (!readiness.ready) {
    return `请先补全${readiness.missing.join("、")}后再找题库相似题。题库相似题不会降级乱找，必须题型、难度、核心知识点一致。`;
  }
  const diagnostics = bankMatchDiagnostics(db, question, options);
  const details = diagnostics.topRejectReasons.length
    ? `主要未命中原因：${diagnostics.topRejectReasons.join("；")}。`
    : "当前正式题库没有可比较的候选题。";
  return `没有足够相似题。已检查 ${diagnostics.candidateCount} 道正式题库题，要求题型、难度、核心知识点和结构规则一致；${details}`;
}

function findReusableQuestions(db, target = {}, { limit = 5, exclude = [] } = {}) {
  const excluded = new Set(exclude.filter(Boolean));
  const targetFingerprint = fingerprint(target.stem);
  const targetTenant = target.tenantId || DEFAULT_TENANT_ID;
  const scored = db.questions
    .filter((q) => (q.tenantId || DEFAULT_TENANT_ID) === targetTenant && q.stem && !excluded.has(q.id))
    .map((q) => ({ question: q, decision: bankMatchDecision(target, q) }))
    .filter(({ question, decision }) => {
      if (!decision.passed) return false;
      if (!decision.duplicateCandidate && fingerprint(question.stem) === targetFingerprint) return false;
      return true;
    })
    .sort((a, b) => b.decision.score - a.decision.score || new Date(b.question.createdAt || 0) - new Date(a.question.createdAt || 0));
  target.matchProfile = matchProfileForQuestion(target);
  return scored.slice(0, limit).map(({ question, decision }) => {
    question.matchProfile = decision.candidateProfile;
    return ({
    id: question.id,
    stem: question.stem,
    options: normalizeOptions(question.options),
    answer: question.answer || "",
    explanation: question.explanation || "",
    subject: question.subject,
    stage: question.stage,
    grade: question.grade,
    chapter: question.chapter,
    knowledge: question.knowledge || [],
    level: question.level,
    type: question.type,
    source: decision.duplicateCandidate ? "疑似原题/重复题" : "题库找题",
    sourceQuestionId: question.id,
    questionImage: question.questionImage || "",
    questionImageStoredName: question.questionImageStoredName || "",
    questionImageManual: Boolean(question.questionImageManual),
    diagramSpec: normalizeDiagramSpec(question.diagramSpec),
    diagramSvg: question.diagramSvg || renderDiagramSvg(question.diagramSpec),
    imageNote: question.questionImageStoredName || question.questionImage ? "使用题库原配图" : "",
    templateId: decision.candidateProfile.templateId,
    matchProfile: decision.candidateProfile,
    matchInfo: {
      score: decision.score,
      duplicateCandidate: decision.duplicateCandidate,
      reasons: decision.reasons,
      textSimilarity: decision.textSimilarity,
      templateId: decision.candidateProfile.templateId,
      templateLabel: decision.candidateProfile.templateLabel,
      type: decision.candidateProfile.type,
      level: decision.candidateProfile.level,
      knowledgeMatched: decision.coverage?.matched || [],
      knowledgeTotal: decision.coverage?.total || 0,
      visualType: decision.candidateProfile.visualType,
      structureTags: decision.candidateProfile.structureTags,
      sharedStructure: decision.sharedStructure || []
    }
  });
  });
}

function fillVariantsFromBank(db, question, aiVariants = []) {
  const reusable = normalizeVariants(findReusableQuestions(db, question, { limit: 3 }), question);
  const seen = new Set(reusable.map((item) => fingerprint(item.stem)));
  const fallback = normalizeVariants(aiVariants, question).filter((item) => {
    const key = fingerprint(item.stem);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return reusable.concat(fallback).slice(0, 3);
}

function variantQualityIssues(variant = {}, parent = {}) {
  const errors = [];
  const body = [variant.stem, normalizeOptions(variant.options).join("\n"), variant.answer, variant.explanation, variant.imageNote].filter(Boolean).join("\n");
  const parentBody = [parent.stem, normalizeOptions(parent.options).join("\n"), parent.imageNote].filter(Boolean).join("\n");
  if (variant.generationMode === "system_template" || /系统模板/.test(variant.source || "")) {
    const verification = verifyTemplateVariant(variant, parent);
    if (!verification.passed) errors.push(`系统验答案未通过：${verification.notes}`);
  }
  for (const issue of mathSymbolConsistencyIssues(body)) {
    errors.push(`数学符号未统一：${issue}`);
  }
  if (isTravelDistanceTimeGraphProblem(parentBody)) {
    if (!isTravelDistanceTimeGraphProblem(body)) errors.push("相似度不足：原题是行程距离-时间图，变式题没有保持同一图象题型");
    if (variant.diagramSpec?.template !== "travel_distance_time_graph") errors.push("配图模板错误：行程图题必须使用距离-时间折线图模板");
    const graphMode = variant.diagramSpec?.graphMode || "distance_between";
    if (graphMode === "position_two_lines") {
      if (!/(交点\s*P|点\s*P|两车.*图象|运动图象)/.test(body)) errors.push("相似度不足：双折线位置图应围绕交点 P 或两车运动图象读图");
    } else if (!/线段\s*(?:AB|BC|CD)|AB|BC|CD/.test(body)) {
      errors.push("相似度不足：变式题缺少折线图线段函数关系式探究");
    }
  }
  if (isTransversalAngleProblem(parentBody)) {
    if (!isTransversalAngleProblem(body)) errors.push("相似度不足：原题是截线角题，变式题没有保持同一图形关系");
    if (extractAngleNumbers(body).length < 4) errors.push("相似度不足：截线角变式题应保留多个角编号条件");
  }
  const needsDiagram = hasImageCue(body) || hasImageCue(parent.stem || "") || Boolean(parent.questionImageStoredName || parent.questionImage || parent.diagramSvg || parent.diagramSpec);
  if (needsDiagram && !variant.diagramSvg && !variant.diagramSpec && !variant.questionImageStoredName && !variant.questionImage && !hasTextDiagramDescription(body)) {
    errors.push("缺少配图：AI 未生成 diagramSpec");
  }
  errors.push(...diagramSpecQualityIssues(variant.diagramSpec, variant, parent));
  if (!variant.answer) errors.push("缺少答案");
  if (!variant.explanation) errors.push("缺少解析");
  return errors;
}

function validateGeneratedVariants(variants = [], parent = {}) {
  const valid = [];
  const errors = [];
  for (const [index, variant] of variants.entries()) {
    const issues = variantQualityIssues(variant, parent);
    if (issues.length) {
      errors.push(`第 ${index + 1} 道：${issues.join("；")}`);
      continue;
    }
    valid.push({ ...variant, source: variant.source || "AI生成" });
  }
  return { valid, errors };
}

function detectedTemplateKey(question = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, question.imageNote].filter(Boolean).join("\n");
  if (isTravelDistanceTimeGraphProblem(body)) return "travel_distance_time_graph";
  if (isTransversalAngleProblem(body)) return "parallel_transversal";
  if (isGridProbabilityProblem(body)) return "grid_probability";
  if (isQuadraticParabolaComprehensiveProblem(body)) return "quadratic_piecewise_text";
  if (/(二次函数|抛物线).*(压轴|分段|存在点|面积最大|面积最小|动点|取值范围|综合|定点|平移|第四象限|tan|正切)/.test(body)) return "quadratic_piecewise_text";
  if (isRotationCongruenceComprehensiveProblem(body)) return "rotation_congruence_comprehensive_text";
  if (/轴对称|对称轴|关于.*对称|旋转|平移|中心对称|位似|图形变换/.test(body) && !/(二次函数|抛物线|函数图象|函数图像|坐标系|x轴|y轴)/i.test(body)) return "transformation_text";
  if (/尺规作图|作图题|作.*垂直平分线|作.*角平分线|作.*垂线|作.*平行线|不写作法|保留作图痕迹/.test(body)) return "construction_text";
  if (/概率树|树状图|列表法|列表.*概率|画树状图|用列表法/.test(body)) return "probability_tree_list_text";
  if (/(动点|点P.*运动|P为.*动点).*(面积|S=|函数关系式|表达式)/i.test(body)) return "moving_point_area_function_text";
  if (/(几何最值|最短|最小值|最大值|周长最小|面积最大|将军饮马|点到直线距离)/.test(body) && /(几何|三角形|矩形|圆|线段|点|直线|折叠|轴对称)/.test(body)) return "geometry_extremum_text";
  if (/(圆|⊙).*(相似|△.*∽|切线.*比例|弦.*比例|割线.*比例)|相似.*(圆|⊙)/.test(body)) return "circle_similarity_comprehensive_text";
  if (/相似综合|相似.*综合|△.*∽|相似.*面积|相似.*比例|平行线分线段成比例.*面积/.test(body)) return "similar_comprehensive_text";
  if (/圆综合|切线.*圆周角|圆周角.*切线|弦.*切线|直径.*切线|圆.*综合|⊙.*切线.*弦/.test(body)) return "circle_comprehensive_text";
  const complex = inferComplexGeometryTemplate(body);
  if (complex) return complex;
  if (isFunctionGeometryComprehensiveProblem(body)) return "function_geometry_comprehensive_text";
  if (isMovingPointExtremumProblem(body)) return "moving_point_extremum_text";
  if (isCongruentTrianglesProofProblem(body)) return "congruent_triangles_proof_text";
  if (isAngleBisectorTemplateProblem(body)) return "angle_bisector_text";
  if (/反比例函数|双曲线|y\s*=\s*[+-]?\d+\s*\/\s*x|k\/x|xy\s*=\s*[+-]?\d+/i.test(body)) return "inverse_proportion_text";
  if (/一元二次方程|二次方程|配方法|公式法|因式分解法解方程|判别式|根的判别式|x².*=|x\^2.*=/.test(body)) return "quadratic_equation_text";
  if (/二次函数|抛物线|顶点|对称轴|y\s*=.*x²|y\s*=.*x\^2/i.test(body)) return "quadratic_function_text";
  if (/一次函数.*应用|函数关系式|实际问题.*一次函数|水费|电费|话费|出租车|行程.*函数|售价.*函数|利润.*函数|y\s*=\s*kx\s*\+\s*b/i.test(body)) return "linear_function_application_text";
  if (isCoordinateTemplateProblem(body)) return "coordinate_linear";
  if (/平均数|中位数|众数|方差|频率|样本容量|扇形统计图|条形统计图|折线统计图|统计表|补全统计图/.test(body)) return "statistics_calculation_text";
  if (isStatisticsTemplateProblem(body)) return "bar_basic";
  if (/锐角三角函数|sin|cos|tan|正弦|余弦|正切|坡度|仰角|俯角/.test(body)) return "trigonometry_text";
  if (/圆周角|圆心角|弧|弦|同弧|等弧|直径所对|半圆所对/.test(body)) return "circle_angle_text";
  if (isCircleTemplateProblem(body)) return "circle_basic";
  if (/勾股|直角三角形|斜边|直角边/.test(body)) return "pythagorean_text";
  if (isTriangleTemplateProblem(body)) return "triangle_basic";
  if (/概率|随机|摸球|抽签|转盘|骰子|必然|不可能|可能性/.test(body)) return "probability_text";
  if (/估算|在哪两个整数之间|无理数.*范围|√\d+.*介于|实数.*大小比较|近似值/.test(body)) return "real_number_estimation_text";
  if (/销售|售价|进价|利润|利润率|打折|折扣|盈利|亏损|原价|定价/.test(body)) return "sales_application_text";
  if (/行程|相遇|追及|速度|路程|甲地|乙地|同时出发|相向而行|同向而行|行驶|千米|公里|km\/h|km/.test(body)) return "travel_application_text";
  if (/工程|工作效率|单独完成|合作完成|修路|加工|完成这项工作|甲队|乙队/.test(body)) return "work_application_text";
  if (/不等式组|解集.*公共部分|公共解集/.test(body)) return "linear_inequality_system_text";
  if (/不等式|解集|解不等式|不等式组/.test(body)) return "linear_inequality_text";
  if (/方程组|二元一次方程组|加减消元|代入消元/.test(body)) return "equation_system_text";
  if (/分式方程|分式|约分|通分|最简分式|分母不为0/.test(body)) return "rational_expression_text";
  if (/方程组|解方程|一元一次方程|方程/.test(body)) return "linear_equation_text";
  if (/二次根式|最简二次根式|化简根式|根号|√|算术平方根|平方根|立方根/.test(body)) return "radical_text";
  if (/多边形|内角和|外角和|正多边形|n边形/.test(body)) return "polygon_angles_text";
  if (/平行四边形|矩形|菱形|正方形|梯形|中位线|对角线/.test(body)) return "quadrilateral_basic_text";
  if (/面积|周长|长方形|正方形|平行四边形|梯形|底边|高为|底为/.test(body)) return "plane_area_text";
  if (/百分比|百分数|折扣|打折|增长率|利润|售价|原价|比例|正比例|反比例|比值/.test(body)) return "proportion_percent_text";
  if (/因式分解|提公因式|平方差公式|完全平方公式|分解因式/.test(body)) return "factorization_text";
  if (/整式|合并同类项|去括号|单项式|多项式|同类项|化简|乘法公式|完全平方|平方差|幂的运算/.test(body)) return "polynomial_operations_text";
  if (/科学记数法|绝对值|有理数|实数|整式|幂|平方|立方|代数式/.test(body)) return "number_algebra_text";
  return "";
}

function variantDefaults(parent = {}, extra = {}) {
  return {
    subject: parent.subject || "初中数学",
    stage: parent.stage || "初中",
    grade: parent.grade || "",
    chapter: parent.chapter || "",
    knowledge: normalizeKnowledgeTags(extra.knowledge || parent.knowledge, parent.subject || "初中数学", extra.stem || parent.stem),
    level: parent.level || "基础",
    type: parent.type || inferQuestionType(extra.stem || parent.stem || ""),
    source: "AI生成·系统模板",
    ...extra
  };
}

function choiceOptions(values = []) {
  return values.map((value, index) => `${String.fromCharCode(65 + index)}. ${value}`);
}

function optionLetterIndex(answer = "") {
  const match = normalizeQuestionText(answer).trim().match(/^[A-D]/i);
  return match ? match[0].toUpperCase().charCodeAt(0) - 65 : -1;
}

function stripOptionLabel(value = "") {
  return normalizeQuestionText(value).replace(/^[A-D][.、．]\s*/i, "").replace(/\s+/g, "");
}

function normalizeComparableMathText(value = "") {
  return normalizeQuestionText(value)
    .replace(/^[A-D][.、．]\s*/i, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/\s+/g, "")
    .replace(/平方厘米|平方米|厘米|cm²|cm2|cm|m²|m2|米|元|人|次|个|°/g, "")
    .replace(/：/g, ":")
    .trim();
}

function parseComparableMathValue(value = "") {
  const text = normalizeComparableMathText(value).replace(/,/g, "");
  if (!text) return null;
  const percent = text.match(/^([-+]?\d+(?:\.\d+)?)%$/);
  if (percent) return Number(percent[1]) / 100;
  const fraction = text.match(/^([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)$/);
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
  const radical = text.match(/^([-+]?(?:\d+(?:\.\d+)?)?)√\(?(\d+(?:\.\d+)?)\)?$/);
  if (radical) {
    const coefficient = radical[1] === "" || radical[1] === "+" ? 1 : (radical[1] === "-" ? -1 : Number(radical[1]));
    return coefficient * Math.sqrt(Number(radical[2]));
  }
  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return null;
}

function comparableMathUnit(value = "") {
  const text = normalizeQuestionText(value);
  if (/平方厘米|cm²|cm2/.test(text)) return "area-cm";
  if (/平方米|m²|m2/.test(text)) return "area-m";
  if (/厘米|cm\b/.test(text)) return "length-cm";
  if (/米|m\b/.test(text)) return "length-m";
  if (/元/.test(text)) return "money";
  if (/°/.test(text)) return "degree";
  return "";
}

function mathAnswersEquivalent(left = "", right = "") {
  const leftText = normalizeComparableMathText(left);
  const rightText = normalizeComparableMathText(right);
  if (!leftText || !rightText) return false;
  const leftUnit = comparableMathUnit(left);
  const rightUnit = comparableMathUnit(right);
  if (leftUnit && rightUnit && leftUnit !== rightUnit) return false;
  if (leftText === rightText) return true;
  const leftNumber = parseComparableMathValue(leftText);
  const rightNumber = parseComparableMathValue(rightText);
  if (leftNumber !== null && rightNumber !== null) {
    return Math.abs(leftNumber - rightNumber) < 1e-9;
  }
  return false;
}

function normalizeSuperscriptDigits(value = "") {
  const map = {
    "⁰": "0",
    "¹": "1",
    "²": "2",
    "³": "3",
    "⁴": "4",
    "⁵": "5",
    "⁶": "6",
    "⁷": "7",
    "⁸": "8",
    "⁹": "9",
    "⁻": "-",
    "⁺": "+"
  };
  return String(value).split("").map((char) => map[char] || char).join("");
}

function expressionVariables(...expressions) {
  const names = new Set();
  for (const expression of expressions) {
    for (const match of normalizeQuestionText(expression).matchAll(/[a-zA-Z]/g)) {
      names.add(match[0]);
    }
  }
  return [...names].filter((name) => /^[a-zA-Z]$/.test(name)).slice(0, 3);
}

function evaluateMathExpression(expression = "", values = {}) {
  let text = normalizeQuestionText(expression)
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, String(Math.PI))
    .replace(/（/g, "(")
    .replace(/）/g, ")");
  if (!text || /=|≤|≥|>|<|,|，/.test(text)) return null;
  text = text.replace(/√\(([-+]?\d+(?:\.\d+)?)\)/g, (_, value) => String(Math.sqrt(Number(value))));
  text = text.replace(/√([-+]?\d+(?:\.\d+)?)/g, (_, value) => String(Math.sqrt(Number(value))));
  text = text.replace(/([A-Za-z0-9)])([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, base, exp) => `${base}**${normalizeSuperscriptDigits(exp)}`);
  text = text
    .replace(/(\d)([A-Za-z])/g, "$1*$2")
    .replace(/([A-Za-z])(\d)/g, "$1*$2")
    .replace(/\)([A-Za-z0-9(])/g, ")*$1")
    .replace(/([A-Za-z0-9])\(/g, "$1*(");
  for (const [name, value] of Object.entries(values)) {
    text = text.replace(new RegExp(`\\b${name}\\b`, "g"), `(${Number(value)})`);
  }
  if (/[A-Za-z]|[^0-9+\-*/().]/.test(text)) return null;
  try {
    const result = Function(`"use strict"; return (${text});`)();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function expressionsEquivalent(left = "", right = "", variables = []) {
  const names = variables.length ? variables : expressionVariables(left, right);
  if (!names.length) return mathAnswersEquivalent(left, right);
  const samples = [-3, -1, 0, 2, 5];
  let checked = 0;
  for (const sample of samples) {
    const values = Object.fromEntries(names.map((name, index) => [name, sample + index + 1]));
    const a = evaluateMathExpression(left, values);
    const b = evaluateMathExpression(right, values);
    if (a === null || b === null) continue;
    if (Math.abs(a - b) > 1e-8) return false;
    checked += 1;
  }
  return checked >= 3;
}

function mathTextIncludesAnswer(text = "", answer = "") {
  const expectedText = normalizeComparableMathText(answer);
  const body = normalizeComparableMathText(text);
  if (!expectedText || !body) return false;
  if (body.includes(expectedText)) return true;
  const expectedNumber = parseComparableMathValue(expectedText);
  if (expectedNumber === null) return false;
  const candidates = body.match(/[-+]?\d+(?:\.\d+)?\/[-+]?\d+(?:\.\d+)?|[-+]?\d+(?:\.\d+)?%?/g) || [];
  return candidates.some((candidate) => {
    const value = parseComparableMathValue(candidate);
    return value !== null && Math.abs(value - expectedNumber) < 1e-9;
  });
}

function normalizeVariantVerification(verification = null, templateId = "") {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return templateId ? {
      passed: false,
      method: "system-template",
      templateId,
      notes: "缺少系统校验结果"
    } : null;
  }
  return {
    passed: Boolean(verification.passed),
    method: verification.method || "system-template",
    templateId: verification.templateId || templateId || "",
    expectedAnswer: normalizeQuestionText(verification.expectedAnswer || ""),
    expectedOption: normalizeQuestionText(verification.expectedOption || ""),
    expectedValue: normalizeQuestionText(verification.expectedValue || ""),
    expectedExpression: normalizeQuestionText(verification.expectedExpression || ""),
    expectedValues: Array.isArray(verification.expectedValues) ? verification.expectedValues.map(normalizeQuestionText).filter(Boolean) : [],
    notes: normalizeQuestionText(verification.notes || "")
  };
}

function verifyTemplateVariant(variant = {}, parent = {}) {
  const templateId = variant.templateId || variant.verification?.templateId || variant.diagramSpec?.template || detectedTemplateKey(parent);
  const verification = normalizeVariantVerification(variant.verification, templateId) || {};
  const expectedAnswer = normalizeQuestionText(verification.expectedAnswer || variant.answer);
  const expectedFinalValue = normalizeQuestionText(verification.expectedValue || verification.expectedOption || "");
  const expectedValues = verification.expectedValues?.length ? verification.expectedValues : (expectedFinalValue ? [expectedFinalValue] : []);
  const answer = normalizeQuestionText(variant.answer);
  const options = normalizeOptions(variant.options);
  const failures = [];
  const answerIndex = optionLetterIndex(answer);
  const expectedIndex = optionLetterIndex(expectedAnswer);

  if (expectedAnswer && answer.toUpperCase() !== expectedAnswer.toUpperCase()) {
    failures.push(`答案应为 ${expectedAnswer}，当前为 ${answer || "空"}`);
  }
  if (options.length >= 2) {
    const index = expectedIndex >= 0 ? expectedIndex : answerIndex;
    if (index < 0 || index >= options.length) {
      failures.push("答案字母没有对应选项");
    } else if (verification.expectedOption) {
      const expectedOption = stripOptionLabel(verification.expectedOption);
      const actualOption = stripOptionLabel(options[index]);
      const sameOptionCount = options.filter((option) => mathAnswersEquivalent(stripOptionLabel(option), expectedOption)).length;
      if (!mathAnswersEquivalent(actualOption, expectedOption)) failures.push(`答案选项应为 ${verification.expectedOption}`);
      if (sameOptionCount !== 1) failures.push("正确选项不唯一或不存在");
      if (verification.expectedExpression) {
        const variables = expressionVariables(verification.expectedExpression, actualOption);
        if (!expressionsEquivalent(actualOption, verification.expectedExpression, variables)) {
          failures.push(`答案选项与标准表达式 ${verification.expectedExpression} 不等价`);
        }
        const equivalentCount = options.filter((option) => expressionsEquivalent(stripOptionLabel(option), verification.expectedExpression, variables)).length;
        if (equivalentCount !== 1) failures.push("表达式等价的正确选项不唯一或不存在");
      }
    }
  }
  if ((variant.diagramSpec || variant.diagramSvg) && !renderDiagramSvg(variant.diagramSpec) && !variant.diagramSvg) {
    failures.push("配图模板无法渲染");
  }
  if (!variant.explanation) failures.push("缺少解析，无法追溯答案");
  if (variant.explanation && expectedValues.length) {
    for (const value of expectedValues) {
      if (!mathTextIncludesAnswer(`${variant.answer}\n${variant.explanation}`, value)) {
        failures.push(`解析没有追溯到 ${value}`);
      }
    }
  }

  return {
    ...verification,
    passed: failures.length === 0,
    method: verification.method || "system-template",
    templateId,
    expectedAnswer,
    expectedValue: expectedFinalValue,
    expectedExpression: verification.expectedExpression || "",
    expectedValues,
    notes: failures.length ? failures.join("；") : (verification.notes || "系统已核对答案、选项和配图模板")
  };
}

function attachTemplateVerification(variant = {}, templateId = "") {
  const options = normalizeOptions(variant.options);
  const provided = normalizeVariantVerification(variant.verification, templateId) || {};
  const expectedAnswer = normalizeQuestionText(provided.expectedAnswer || variant.answer);
  const index = optionLetterIndex(expectedAnswer);
  const expectedOption = index >= 0 && index < options.length ? stripOptionLabel(options[index]) : "";
  const withVerification = {
    ...variant,
    templateId,
    generationMode: "system_template",
    source: "AI生成·系统模板",
    verification: {
      passed: true,
      method: "system-template",
      templateId,
      expectedAnswer,
      expectedOption: provided.expectedOption || expectedOption,
      expectedValue: provided.expectedValue || provided.expectedOption || expectedOption,
      expectedExpression: provided.expectedExpression || "",
      expectedValues: provided.expectedValues || [],
      notes: `${TEMPLATE_LABELS[templateId] || "系统模板"}：系统按模板生成并校验`
    }
  };
  return { ...withVerification, verification: verifyTemplateVariant(withVerification, {}) };
}

function protectedTemplateTokens(text = "") {
  const value = normalizeQuestionText(text);
  const tokens = [
    ...value.matchAll(/∠[A-Za-z0-9]+/g),
    ...value.matchAll(/[A-Z]{2,4}(?:∥|⊥|=|:)[A-Z0-9]{0,4}/g),
    ...value.matchAll(/[A-Z]{1,3}\/[A-Z]{1,3}/g),
    ...value.matchAll(/\d+(?:\.\d+)?(?:°|\/\d+|×10[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+|²|³)?/g),
    ...value.matchAll(/y\s*=\s*[+-]?\d*(?:\.\d+)?x\s*[+-]\s*\d+/gi)
  ].map((match) => match[0].replace(/\s+/g, ""));
  return [...new Set(tokens)].filter(Boolean);
}

function keepsProtectedTemplateTokens(before = "", after = "") {
  const compactAfter = normalizeQuestionText(after).replace(/\s+/g, "");
  return protectedTemplateTokens(before).every((token) => compactAfter.includes(token));
}

async function polishSystemTemplateVariants(db, variants = [], parent = {}, session = {}) {
  if (process.env.ALLOW_TEMPLATE_POLISH !== "true") return variants;
  if (variants.some((variant) => variant.diagramSpec || variant.generationMode === "system_template" || /系统模板/.test(variant.source || ""))) {
    return variants;
  }
  if (!process.env.QWEN_API_KEY || !variants.length) return variants;
  const prompt = `你只负责润色下面 3 道系统模板题的题干和解析，让语言更像教材题。
必须遵守：
1. 只允许返回 stem 和 explanation，不允许改 options、answer、knowledge、diagramSpec、templateId。
2. 不得改任何数字、点名、线段名、角编号、函数式、答案和选项。
3. 不得新增条件，不得改变题型，不得把选择题改成其他题。
4. 只输出 JSON：{"variants":[{"stem":"...","explanation":"..."}]}。

题目：
${variants.map((item, index) => `第${index + 1}题\n题干：${item.stem}\n选项：${normalizeOptions(item.options).join("；")}\n答案：${item.answer}\n解析：${item.explanation}`).join("\n\n")}`;
  try {
    const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.1, db, session, purpose: "template_variant_polish" });
    const parsed = parseAiJson(content);
    const polished = Array.isArray(parsed) ? parsed : parsed.variants || parsed.questions || [];
    return variants.map((variant, index) => {
      const item = polished[index] || {};
      const nextStem = normalizeQuestionText(item.stem || "");
      const nextExplanation = normalizeQuestionText(item.explanation || "");
      if (!nextStem || !nextExplanation) return variant;
      if (!keepsProtectedTemplateTokens(`${variant.stem}\n${variant.explanation}`, `${nextStem}\n${nextExplanation}`)) return variant;
      const next = {
        ...variant,
        stem: nextStem,
        explanation: nextExplanation,
        polishStatus: "ai_polished"
      };
      const verification = verifyTemplateVariant(next, parent);
      return verification.passed ? { ...next, verification } : variant;
    });
  } catch {
    return variants;
  }
}

function makeQuadraticDiagramSpec({ a = 1, h = 0, k = 0, xMin = -4, xMax = 4, yMin = -4, yMax = 8, pointName = "V" } = {}) {
  const points = [];
  const steps = 28;
  for (let index = 0; index <= steps; index += 1) {
    const x = xMin + ((xMax - xMin) * index) / steps;
    points.push({ x: Number(x.toFixed(2)), y: Number((a * (x - h) ** 2 + k).toFixed(2)) });
  }
  return {
    type: "coordinate",
    template: "quadratic_function",
    width: 420,
    height: 280,
    xMin,
    xMax,
    yMin,
    yMax,
    curves: [{ points, color: "#0f172a" }],
    points: [{ name: pointName, x: h, y: k }]
  };
}

function makeCongruentTrianglesDiagramSpec(kind = "two_triangles") {
  if (kind === "shared_side") {
    return {
      type: "geometry",
      width: 420,
      height: 280,
      points: [
        { name: "A", x: 210, y: 38 },
        { name: "B", x: 92, y: 222 },
        { name: "C", x: 328, y: 222 },
        { name: "D", x: 210, y: 222 }
      ],
      polygons: [["A", "B", "D"], ["A", "D", "C"]],
      lines: [["A", "B"], ["A", "C"], ["B", "C"], ["A", "D"]],
      marks: [
        { x: 145, y: 132, text: "AB=AC" },
        { x: 214, y: 244, text: "BD=CD" }
      ]
    };
  }
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "A", x: 72, y: 214 },
      { name: "B", x: 164, y: 72 },
      { name: "C", x: 252, y: 214 },
      { name: "D", x: 248, y: 72 },
      { name: "E", x: 340, y: 214 },
      { name: "F", x: 164, y: 214 }
    ],
    polygons: [["A", "B", "C"], ["D", "E", "F"]],
    lines: [["A", "B"], ["B", "C"], ["C", "A"], ["D", "E"], ["E", "F"], ["F", "D"]],
    marks: [
      { x: 142, y: 138, text: "对应边" },
      { x: 258, y: 138, text: "对应角" }
    ]
  };
}

function makeAngleBisectorDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "O", x: 96, y: 212 },
      { name: "A", x: 338, y: 212 },
      { name: "B", x: 290, y: 64 },
      { name: "P", x: 214, y: 142 },
      { name: "M", x: 214, y: 212 },
      { name: "N", x: 252, y: 104 }
    ],
    lines: [["O", "A"], ["O", "B"], ["O", "P"], ["P", "M"], ["P", "N"]],
    marks: [
      { x: 152, y: 172, text: "∠1=∠2" },
      { x: 226, y: 235, text: "PM⊥OA" },
      { x: 284, y: 108, text: "PN⊥OB" }
    ]
  };
}

function makeMovingPointSegmentDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 220,
    points: [
      { name: "A", x: 76, y: 118 },
      { name: "P", x: 210, y: 118 },
      { name: "B", x: 344, y: 118 }
    ],
    lines: [["A", "B"]],
    marks: [
      { x: 142, y: 96, text: "AP=x" },
      { x: 276, y: 96, text: "PB=10-x" }
    ]
  };
}

function makeInverseProportionDiagramSpec({ k = 6, pointName = "P", px = 2, xMin = -5, xMax = 5, yMin = -5, yMax = 5 } = {}) {
  const makeBranch = (from, to) => {
    const points = [];
    const steps = 30;
    for (let index = 0; index <= steps; index += 1) {
      const x = from + ((to - from) * index) / steps;
      if (Math.abs(x) < 0.2) continue;
      points.push({ x: Number(x.toFixed(2)), y: Number((k / x).toFixed(2)) });
    }
    return points;
  };
  return {
    type: "coordinate",
    width: 420,
    height: 280,
    xMin,
    xMax,
    yMin,
    yMax,
    curves: [
      { points: makeBranch(xMin, -0.5), color: "#0f172a" },
      { points: makeBranch(0.5, xMax), color: "#0f172a" }
    ],
    points: [{ name: pointName, x: px, y: Number((k / px).toFixed(2)) }],
    title: `y=${k}/x`
  };
}

function makeRightTriangleTrigDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "A", x: 92, y: 218 },
      { name: "B", x: 332, y: 218 },
      { name: "C", x: 332, y: 70 }
    ],
    polygons: [["A", "B", "C"]],
    lines: [["A", "B"], ["B", "C"], ["C", "A"]],
    marks: [
      { x: 306, y: 202, text: "90°" },
      { x: 132, y: 205, text: "30°" },
      { x: 220, y: 238, text: "邻边" },
      { x: 350, y: 146, text: "对边" }
    ]
  };
}

function makeQuadrilateralBasicDiagramSpec(kind = "parallelogram") {
  const base = {
    type: "geometry",
    width: 420,
    height: 280,
    points: [],
    polygons: [["A", "B", "C", "D"]],
    lines: [["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"], ["A", "C"], ["B", "D"]],
    marks: []
  };
  if (kind === "rectangle") {
    base.points = [
      { name: "A", x: 92, y: 78 },
      { name: "B", x: 328, y: 78 },
      { name: "C", x: 328, y: 210 },
      { name: "D", x: 92, y: 210 }
    ];
    base.marks = [{ x: 105, y: 96, text: "90°" }, { x: 315, y: 96, text: "90°" }];
  } else if (kind === "rhombus") {
    base.points = [
      { name: "A", x: 210, y: 48 },
      { name: "B", x: 330, y: 140 },
      { name: "C", x: 210, y: 232 },
      { name: "D", x: 90, y: 140 }
    ];
    base.marks = [{ x: 210, y: 136, text: "AC⊥BD" }];
  } else {
    base.points = [
      { name: "A", x: 120, y: 82 },
      { name: "B", x: 330, y: 82 },
      { name: "C", x: 282, y: 210 },
      { name: "D", x: 72, y: 210 }
    ];
    base.marks = [{ x: 212, y: 62, text: "AB∥CD" }, { x: 334, y: 150, text: "AD∥BC" }];
  }
  return base;
}

function makePolygonAnglesDiagramSpec(sides = 6) {
  const count = Math.max(3, Math.min(8, Math.round(sides)));
  const cx = 210;
  const cy = 142;
  const radius = 88;
  const names = "ABCDEFGH".slice(0, count).split("");
  const points = names.map((name, index) => {
    const angle = -90 + (360 * index) / count;
    return {
      name,
      x: Math.round(cx + Math.cos((angle * Math.PI) / 180) * radius),
      y: Math.round(cy + Math.sin((angle * Math.PI) / 180) * radius)
    };
  });
  const lines = points.map((point, index) => [point.name, points[(index + 1) % points.length].name]);
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points,
    polygons: [names],
    lines,
    marks: [{ x: 210, y: 142, text: `${count} 边形` }]
  };
}

function makeCircleAngleDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "O", x: 210, y: 142 },
      { name: "A", x: 118, y: 206 },
      { name: "B", x: 302, y: 206 },
      { name: "C", x: 210, y: 48 },
      { name: "D", x: 302, y: 78 }
    ],
    circles: [{ center: "O", r: 96 }],
    lines: [["A", "B"], ["A", "C"], ["B", "C"], ["A", "D"], ["B", "D"], ["O", "A"], ["O", "B"]],
    marks: [
      { x: 210, y: 190, text: "∠AOB" },
      { x: 212, y: 74, text: "∠ACB" },
      { x: 280, y: 95, text: "∠ADB" }
    ]
  };
}

function makeTransformationDiagramSpec(kind = "translation") {
  const baseTriangle = [
    { name: "A", x: 82, y: 186 },
    { name: "B", x: 162, y: 186 },
    { name: "C", x: 116, y: 92 }
  ];
  const moved = kind === "rotation"
    ? [
      { name: "A'", x: 302, y: 204 },
      { name: "B'", x: 302, y: 124 },
      { name: "C'", x: 210, y: 170 }
    ]
    : kind === "symmetry"
      ? [
        { name: "A'", x: 338, y: 186 },
        { name: "B'", x: 258, y: 186 },
        { name: "C'", x: 304, y: 92 }
      ]
      : [
        { name: "A'", x: 246, y: 186 },
        { name: "B'", x: 326, y: 186 },
        { name: "C'", x: 280, y: 92 }
      ];
  const marks = kind === "symmetry"
    ? [{ x: 210, y: 142, text: "对称轴 l" }]
    : kind === "rotation"
      ? [{ x: 210, y: 218, text: "绕 O 旋转" }]
      : [{ x: 210, y: 70, text: "平移方向" }];
  const lines = [
    ["A", "B"], ["B", "C"], ["C", "A"],
    ["A'", "B'"], ["B'", "C'"], ["C'", "A'"]
  ];
  if (kind === "symmetry") {
    lines.push(["A", "A'"], ["B", "B'"], ["C", "C'"]);
  }
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [...baseTriangle, ...moved, ...(kind === "rotation" ? [{ name: "O", x: 210, y: 218 }] : [])],
    polygons: [["A", "B", "C"], ["A'", "B'", "C'"]],
    lines,
    marks
  };
}

function makeRotationCongruenceComprehensiveDiagramSpec(caseId = 1) {
  return {
    type: "geometry",
    template: "rotation_congruence_comprehensive",
    width: 620,
    height: 250,
    caseId
  };
}

function makeConstructionDiagramSpec(kind = "perpendicular_bisector") {
  if (kind === "angle_bisector") return makeAngleBisectorDiagramSpec();
  return {
    type: "geometry",
    template: "construction_perpendicular_bisector",
    width: 420,
    height: 260,
    points: [
      { name: "A", x: 96, y: 150 },
      { name: "B", x: 324, y: 150 },
      { name: "O", x: 210, y: 150 },
      { name: "P", x: 210, y: 58 },
      { name: "Q", x: 210, y: 242 }
    ],
    circles: [{ center: "A", r: 118 }, { center: "B", r: 118 }],
    lines: [["A", "B"], ["P", "Q"]],
    marks: [
      { x: 210, y: 34, text: "作图痕迹" },
      { x: 228, y: 148, text: "PQ⊥AB" },
      { x: 198, y: 174, text: "AO=BO" }
    ]
  };
}

function makeSimilarComprehensiveDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "A", x: 210, y: 44 },
      { name: "B", x: 82, y: 226 },
      { name: "C", x: 338, y: 226 },
      { name: "D", x: 146, y: 136 },
      { name: "E", x: 274, y: 136 }
    ],
    polygons: [["A", "B", "C"], ["A", "D", "E"]],
    lines: [["A", "B"], ["B", "C"], ["C", "A"], ["D", "E"]],
    marks: [
      { x: 210, y: 116, text: "DE∥BC" },
      { x: 118, y: 176, text: "AD/AB" },
      { x: 304, y: 176, text: "AE/AC" }
    ]
  };
}

function makeCircleComprehensiveDiagramSpec() {
  return {
    type: "geometry",
    width: 420,
    height: 280,
    points: [
      { name: "O", x: 190, y: 142 },
      { name: "A", x: 284, y: 142 },
      { name: "B", x: 118, y: 206 },
      { name: "C", x: 92, y: 92 },
      { name: "P", x: 284, y: 54 },
      { name: "D", x: 284, y: 230 }
    ],
    circles: [{ center: "O", r: 94 }],
    lines: [["O", "A"], ["P", "D"], ["P", "B"], ["C", "A"], ["B", "A"]],
    marks: [
      { x: 302, y: 142, text: "PA 为切线" },
      { x: 218, y: 134, text: "OA⊥PA" },
      { x: 134, y: 214, text: "弦 AB" }
    ]
  };
}

function formatSignedTerm(value = 0, variable = "") {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "";
  const abs = Math.abs(number);
  const body = variable ? (abs === 1 ? variable : `${abs}${variable}`) : `${abs}`;
  return `${number > 0 ? "+" : "-"}${body}`;
}

function formatQuadraticFromRoots(rootA = 0, rootB = 4) {
  const sum = Number(rootA) + Number(rootB);
  const product = Number(rootA) * Number(rootB);
  return `y=-x²${formatSignedTerm(sum, "x")}${formatSignedTerm(-product)}`;
}

function formatShiftedVariable(variable = "x", h = 0) {
  return h === 0 ? variable : `${variable}${h > 0 ? `-${h}` : `+${Math.abs(h)}`}`;
}

function formatQuadraticVertex(h = 2, k = 4) {
  const inside = formatShiftedVariable("x", h);
  return `y=-(${inside})²+${k}`;
}

function formatQuadraticPointY(rootA = 0, rootB = 4, variable = "t") {
  const sum = Number(rootA) + Number(rootB);
  const product = Number(rootA) * Number(rootB);
  return `-${variable}²${formatSignedTerm(sum, variable)}${formatSignedTerm(-product)}`;
}

function formatQuadraticAreaExpression(rootA = 0, rootB = 4, variable = "t") {
  const baseHalf = Math.abs(Number(rootB) - Number(rootA)) / 2;
  const sum = Number(rootA) + Number(rootB);
  const product = Number(rootA) * Number(rootB);
  const a = -baseHalf;
  const b = baseHalf * sum;
  const c = -baseHalf * product;
  return `S=${formatSignedTerm(a, `${variable}²`).replace(/^\+/, "")}${formatSignedTerm(b, variable)}${formatSignedTerm(c)}`;
}

function makeQuadraticPiecewiseDiagramSpec({ h = 2, k = 4, leftRoot = 0, rightRoot = 4, pointName = "P" } = {}) {
  const parabola = [];
  const xMin = Math.min(leftRoot - 1, h - 3);
  const xMax = Math.max(rightRoot + 1, h + 3);
  const yMin = -1;
  const yMax = Math.max(k + 1, 5);
  for (let index = 0; index <= 32; index += 1) {
    const x = xMin + ((xMax - xMin) * index) / 32;
    parabola.push({ x: Number(x.toFixed(2)), y: Number((-((x - h) ** 2) + k).toFixed(2)) });
  }
  return {
    type: "coordinate",
    template: "quadratic_piecewise",
    width: 420,
    height: 280,
    xMin,
    xMax,
    yMin,
    yMax,
    curves: [{ points: parabola, color: "#0f172a" }],
    points: [
      { name: "A", x: leftRoot, y: 0 },
      { name: "B", x: rightRoot, y: 0 },
      { name: pointName, x: h, y: k }
    ],
    title: formatQuadraticVertex(h, k)
  };
}

function formatRootFactor(root = 0) {
  const value = Number(root);
  if (!Number.isFinite(value) || value === 0) return "x";
  return value < 0 ? `(x+${Math.abs(value)})` : `(x-${value})`;
}

function formatFactoredParabola(leftRoot = -1, rightRoot = 3, coefficient = "a") {
  const factors = `${formatRootFactor(leftRoot)}${formatRootFactor(rightRoot)}`;
  const prefix = coefficient === "1" || coefficient === "" ? "" : coefficient;
  return `y=${prefix}${factors}`;
}

function makeParabolaComprehensiveDiagramSpec({ leftRoot = -2, rightRoot = 4, z = 2 / 3, shift = 2 } = {}) {
  const h = (Number(leftRoot) + Number(rightRoot)) / 2;
  const d = Math.abs(Number(rightRoot) - Number(leftRoot)) / 2;
  const vertexY = -(d ** 2);
  const pointD = { x: h + d * z, y: -((1 - z ** 2) * d ** 2) };
  const xMin = Math.min(leftRoot - 0.8, h - d - 0.6);
  const xMax = Math.max(rightRoot + 0.8, h + d + 0.6);
  const yMin = Math.min(vertexY - 1.5, pointD.y - 1.5);
  const yMax = Math.max(2, d + 1);
  const parabola = [];
  for (let index = 0; index <= 48; index += 1) {
    const x = xMin + ((xMax - xMin) * index) / 48;
    parabola.push({ x: Number(x.toFixed(2)), y: Number(((x - leftRoot) * (x - rightRoot)).toFixed(2)) });
  }
  return {
    type: "coordinate",
    template: "quadratic_parabola_comprehensive",
    width: 460,
    height: 300,
    leftRoot,
    rightRoot,
    h,
    d,
    z,
    shift,
    vertexY,
    pointD,
    xMin,
    xMax,
    yMin,
    yMax,
    curves: [{ points: parabola, color: "#0f172a" }],
    guides: [
      { from: { x: h, y: 0 }, to: { x: h, y: vertexY }, color: "#94a3b8" },
      { from: { x: pointD.x, y: 0 }, to: pointD, color: "#94a3b8" }
    ],
    segments: [
      { from: { x: h, y: vertexY }, to: pointD, color: "#0f172a", width: 1.8 }
    ],
    points: [
      { name: "A", x: leftRoot, y: 0 },
      { name: "B", x: rightRoot, y: 0 },
      { name: "C", x: h, y: vertexY },
      { name: "D", x: pointD.x, y: pointD.y }
    ],
    labels: [
      { x: rightRoot - 0.2, y: yMax - 0.4, text: "L" },
      { x: h + shift, y: yMax - 0.9, text: `右移 ${shift}` }
    ]
  };
}

function makeParabolaComprehensiveTemplateVariants(question = {}, base = {}) {
  const cases = [
    {
      leftRoot: -2,
      rightRoot: 4,
      z: 2 / 3,
      ratioText: "S△ACD=S△ABD",
      ratioExplain: "面积相等",
      uText: "2d/3",
      shift: 2,
      variationType: "same_structure_area_equal_translation_intersection"
    },
    {
      leftRoot: -2,
      rightRoot: 6,
      z: 1 / 2,
      ratioText: "S△ACD=1/2S△ABD",
      ratioExplain: "△ACD 的面积是 △ABD 面积的一半",
      uText: "d/2",
      shift: 2,
      variationType: "same_structure_area_half_translation_intersection"
    },
    {
      leftRoot: -4,
      rightRoot: 2,
      z: 1 / 3,
      ratioText: "S△ACD=1/4S△ABD",
      ratioExplain: "△ACD 的面积是 △ABD 面积的四分之一",
      uText: "d/3",
      shift: 4,
      variationType: "same_structure_area_quarter_translation_intersection"
    }
  ];

  return cases.map((item) => {
    const left = item.leftRoot;
    const right = item.rightRoot;
    const h = (left + right) / 2;
    const d = Math.abs(right - left) / 2;
    const ab = right - left;
    const u = d * item.z;
    const dX = h + u;
    const dY = -((1 - item.z ** 2) * d ** 2);
    const tanValue = Math.abs(dY) / Math.max(1e-9, right - dX);
    const commonX = (item.shift + left + right) / 2;
    const commonY = (commonX - left) * (commonX - right);
    const expr = formatFactoredParabola(left, right, "a");
    const exprA1 = formatFactoredParabola(left, right, "");
    const movedExpr = `y=${formatRootFactor(left + item.shift)}${formatRootFactor(right + item.shift)}`;
    const answer = `AB=${ab}，tan∠ABD=${formatCompactNumber(tanValue)}，L 与 L' 相交于点 (${formatCompactNumber(commonX)},${formatCompactNumber(commonY)})`;
    return variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，在平面直角坐标系 xOy 中，抛物线 L：${expr}（a>0）与 x 轴交于 A、B 两点（点 A 在点 B 的左侧），顶点为 C，D 是第四象限抛物线上一点。\n(1) 求线段 AB 的长；\n(2) 当 a=1 时，若 ${item.ratioText}，求 tan∠ABD 的值；\n(3) 当 a=1 时，将抛物线 L 向右平移 ${item.shift} 个单位得到 L'，判断 L' 与 L 是否相交；若相交，求交点坐标。`,
      options: [],
      answer,
      explanation: `(1) 令 y=0，得 x=${left} 或 x=${right}，所以 A(${left},0)，B(${right},0)，AB=${ab}。\n(2) 当 a=1 时，设顶点 C(${h},-${d ** 2})，D(${h}+u，u²-${d ** 2})，0<u<${d}。可得 S△ACD=1/2·${d}·u(u+${d})，S△ABD=${d}(${d ** 2}-u²)。由 ${item.ratioExplain} 解得 u=${item.uText}=${formatCompactNumber(u)}，所以 D(${formatCompactNumber(dX)},${formatCompactNumber(dY)})，tan∠ABD=${formatCompactNumber(Math.abs(dY))}/${formatCompactNumber(right - dX)}=${formatCompactNumber(tanValue)}。\n(3) 当 a=1 时，L：${exprA1}，L'：${movedExpr}。联立两式得 x=${formatCompactNumber(commonX)}，代入 L 得 y=${formatCompactNumber(commonY)}，所以 L 与 L' 相交于点 (${formatCompactNumber(commonX)},${formatCompactNumber(commonY)})。`,
      knowledge: ["二次函数", "函数与几何", "抛物线平移"],
      difficulty: "提高",
      variationType: item.variationType,
      templateCaseId: `parabola_comprehensive|${left}|${right}|${item.z}|${item.shift}`,
      diagramSpec: makeParabolaComprehensiveDiagramSpec(item),
      imageNote: "系统模板：二次函数压轴综合",
      verification: {
        expectedAnswer: answer,
        expectedValues: [`AB=${ab}`, `tan∠ABD=${formatCompactNumber(tanValue)}`, `(${formatCompactNumber(commonX)},${formatCompactNumber(commonY)})`]
      }
    });
  });
}

function makeMovingPointAreaDiagramSpec() {
  return {
    type: "geometry",
    template: "moving_point_area",
    width: 420,
    height: 260,
    points: [
      { name: "A", x: 72, y: 198 },
      { name: "B", x: 342, y: 198 },
      { name: "P", x: 182, y: 198 },
      { name: "C", x: 182, y: 78 },
      { name: "D", x: 342, y: 78 }
    ],
    polygons: [["P", "B", "D", "C"]],
    lines: [["A", "B"], ["P", "C"], ["C", "D"], ["D", "B"]],
    marks: [
      { x: 120, y: 218, text: "AP=x" },
      { x: 264, y: 218, text: "PB=12-x" },
      { x: 356, y: 142, text: "高=6" },
      { x: 244, y: 120, text: "S=6(12-x)" }
    ]
  };
}

function makeGeometryExtremumDiagramSpec() {
  return {
    type: "geometry",
    template: "geometry_extremum",
    width: 420,
    height: 260,
    points: [
      { name: "A", x: 92, y: 78 },
      { name: "B", x: 324, y: 92 },
      { name: "A'", x: 92, y: 218 },
      { name: "P", x: 196, y: 150 },
      { name: "M", x: 60, y: 150 },
      { name: "N", x: 360, y: 150 }
    ],
    lines: [["M", "N"], ["A", "P"], ["P", "B"], ["A'", "P"], ["A'", "B"]],
    marks: [
      { x: 210, y: 142, text: "直线 l" },
      { x: 72, y: 150, text: "A 与 A' 对称" },
      { x: 244, y: 188, text: "A'B 最短" }
    ]
  };
}

function makeProbabilityTreeDiagramSpec() {
  return {
    type: "geometry",
    template: "probability_tree_list",
    width: 420,
    height: 280,
    points: [
      { name: "O", x: 78, y: 140 },
      { name: "A", x: 190, y: 86 },
      { name: "B", x: 190, y: 194 },
      { name: "C", x: 322, y: 54 },
      { name: "D", x: 322, y: 118 },
      { name: "E", x: 322, y: 162 },
      { name: "F", x: 322, y: 226 }
    ],
    lines: [["O", "A"], ["O", "B"], ["A", "C"], ["A", "D"], ["B", "E"], ["B", "F"]],
    marks: [
      { x: 132, y: 92, text: "红 1/2" },
      { x: 132, y: 190, text: "白 1/2" },
      { x: 260, y: 62, text: "红" },
      { x: 260, y: 128, text: "白" },
      { x: 260, y: 168, text: "红" },
      { x: 260, y: 232, text: "白" }
    ]
  };
}

function makeCircleSimilarityDiagramSpec() {
  return {
    type: "geometry",
    template: "circle_similarity_comprehensive",
    width: 420,
    height: 280,
    points: [
      { name: "O", x: 206, y: 142 },
      { name: "A", x: 112, y: 206 },
      { name: "B", x: 300, y: 206 },
      { name: "C", x: 252, y: 62 },
      { name: "D", x: 170, y: 96 },
      { name: "P", x: 324, y: 78 }
    ],
    circles: [{ center: "O", r: 96 }],
    lines: [["A", "B"], ["A", "C"], ["B", "C"], ["P", "A"], ["P", "D"], ["D", "B"]],
    marks: [
      { x: 236, y: 102, text: "△PDA∽△PAB" },
      { x: 316, y: 132, text: "切线/割线" },
      { x: 150, y: 218, text: "弦 AB" }
    ]
  };
}

function makeQuadraticPiecewiseTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const vertexCases = [
    { h: 2, d: 2 }, { h: 3, d: 2 }, { h: 1, d: 3 }, { h: 4, d: 3 },
    { h: 0, d: 2 }, { h: 2, d: 3 }, { h: 3, d: 4 }, { h: -1, d: 3 }
  ];
  for (const item of vertexCases) {
    const { h, d } = item;
    const k = d * d;
    const left = h - d;
    const right = h + d;
    const expr = formatQuadraticVertex(h, k);
    const area = d * k;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，抛物线 ${expr} 与 x 轴交于 A、B 两点，顶点为 P。\n(1) 求 A、B、P 的坐标；\n(2) 求 △PAB 的面积。`,
      options: [],
      answer: `A(${left},0)，B(${right},0)，P(${h},${k})，S△PAB=${area}`,
      explanation: `(1) 令 y=0，得 (${formatShiftedVariable("x", h)})²=${k}，所以 x=${left} 或 x=${right}，A(${left},0)，B(${right},0)。由顶点式可得 P(${h},${k})。\n(2) AB=${2 * d}，点 P 到 x 轴的距离为 ${k}，所以 S△PAB=1/2×${2 * d}×${k}=${area}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeQuadraticPiecewiseDiagramSpec({ h, k, leftRoot: left, rightRoot: right }),
      imageNote: "系统模板：二次函数交点与面积",
      verification: { expectedAnswer: `A(${left},0)，B(${right},0)，P(${h},${k})，S△PAB=${area}`, expectedValues: [`A(${left},0)`, `B(${right},0)`, `P(${h},${k})`, `${area}`] }
    }));
  }

  const segmentCases = [
    { h: 2, d: 2 }, { h: 3, d: 2 }, { h: 4, d: 2 }, { h: 1, d: 3 },
    { h: 2, d: 3 }, { h: 5, d: 3 }, { h: -1, d: 2 }, { h: 0, d: 4 }
  ];
  for (const item of segmentCases) {
    const { h, d } = item;
    const k = d * d;
    const left = h - d;
    const right = h + d;
    const expr = formatQuadraticVertex(h, k);
    const segmentExpr = `MN=-(${formatShiftedVariable("m", h)})²+${k}`;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，抛物线 ${expr} 与 x 轴交于 A、B 两点。点 M(m,0) 在线段 AB 上，过 M 作 x 轴的垂线交抛物线于点 N。\n(1) 写出 MN 关于 m 的函数表达式；\n(2) 求 MN 的最大值。`,
      options: [],
      answer: `${segmentExpr}，最大值为 ${k}`,
      explanation: `(1) 点 N 在抛物线 ${expr} 上，且横坐标为 m，所以 ${segmentExpr}。\n(2) 该二次函数开口向下，顶点纵坐标为 ${k}，因此 MN 的最大值为 ${k}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeQuadraticPiecewiseDiagramSpec({ h, k, leftRoot: left, rightRoot: right }),
      imageNote: "系统模板：二次函数线段最值",
      verification: { expectedAnswer: `${segmentExpr}，最大值为 ${k}`, expectedValues: [segmentExpr, `${k}`] }
    }));
  }

  for (const d of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const expr = formatQuadraticFromRoots(0, 2 * d);
    const yExpr = formatQuadraticPointY(0, 2 * d, "t");
    const areaExpr = formatQuadraticAreaExpression(0, 2 * d, "t");
    const maxArea = d ** 3;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，抛物线 ${expr} 与 x 轴交于 A、B 两点。点 P(t,${yExpr}) 在抛物线上，且 0<t<${2 * d}。\n(1) 求 AB 的长；\n(2) 用 t 表示 △PAB 的面积 S，并求 S 的最大值。`,
      options: [],
      answer: `AB=${2 * d}，${areaExpr}，S最大值为${maxArea}`,
      explanation: `(1) 令 y=0，得 x=0 或 x=${2 * d}，所以 AB=${2 * d}。\n(2) 点 P 到 x 轴的距离为 ${yExpr}，所以 ${areaExpr}。配方可得当 t=${d} 时，S 最大值为 ${maxArea}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeQuadraticPiecewiseDiagramSpec({ h: d, k: d * d, leftRoot: 0, rightRoot: 2 * d }),
      imageNote: "系统模板：二次函数面积函数",
      verification: { expectedAnswer: `AB=${2 * d}，${areaExpr}，S最大值为${maxArea}`, expectedValues: [`AB=${2 * d}`, areaExpr, `${maxArea}`] }
    }));
  }
  return variants;
}

function makeCircleSimilarityTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const tangentSecantCases = [
    [6, 4, 9], [8, 4, 16], [12, 9, 16], [10, 5, 20], [15, 9, 25],
    [9, 3, 27], [12, 8, 18], [18, 12, 27], [14, 7, 28], [16, 8, 32]
  ];
  for (const [pa, pb, pc] of tangentSecantCases) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，PA 是 ⊙O 的切线，PBC 是割线，A、B、C 在圆上，且 PA=${pa}，PB=${pb}。\n(1) 说明 △PAB 与 △PCA 相似；\n(2) 求 PC 的长。`,
      options: [],
      answer: `△PAB∽△PCA，PC=${pc}`,
      explanation: `(1) 切线弦定理可得对应角相等，又 ∠P 为公共角，所以 △PAB∽△PCA。\n(2) 由切割线定理 PA²=PB·PC，得 ${pa}²=${pb}·PC，所以 PC=${pc}。`,
      knowledge: ["几何"],
      diagramSpec: makeCircleSimilarityDiagramSpec(),
      imageNote: "系统模板：圆与相似切割线",
      verification: { expectedAnswer: `△PAB∽△PCA，PC=${pc}`, expectedValues: ["△PAB∽△PCA", `${pc}`] }
    }));
  }
  const tangentCases = [
    [5, 13, 12], [6, 10, 8], [8, 17, 15], [7, 25, 24], [9, 15, 12],
    [10, 26, 24], [12, 20, 16], [15, 17, 8], [20, 29, 21], [24, 25, 7]
  ];
  for (const [oa, op, pa] of tangentCases) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，PA、PB 是 ⊙O 的两条切线，A、B 为切点，连接 AB、OP。\n(1) 求证 △OAP≌△OBP；\n(2) 若 OA=${oa}，OP=${op}，求 PA 的长。`,
      options: [],
      answer: `△OAP≌△OBP，PA=${pa}`,
      explanation: `(1) OA⊥PA，OB⊥PB，OA=OB，OP 为公共边，所以 Rt△OAP≌Rt△OBP（HL）。\n(2) 在 Rt△OAP 中，PA=√(OP²-OA²)=√(${op}²-${oa}²)=${pa}。`,
      knowledge: ["几何"],
      diagramSpec: makeCircleComprehensiveDiagramSpec(),
      imageNote: "系统模板：圆切线与全等",
      verification: { expectedAnswer: `△OAP≌△OBP，PA=${pa}`, expectedValues: ["△OAP≌△OBP", `${pa}`] }
    }));
  }
  return variants;
}

function makeMovingPointAreaTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const rectangleCases = [
    [12, 6, 5], [10, 4, 3], [15, 5, 6], [18, 3, 7], [20, 8, 9],
    [16, 5, 4], [14, 7, 8], [24, 6, 10]
  ];
  for (const [length, height, xValue] of rectangleCases) {
    const expression = `S=${length * height}-${height}x`;
    const value = height * (length - xValue);
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，点 P 在线段 AB 上运动，AB=${length}，AP=x。以 PB 为底、${height} 为高作矩形 PBCD。\n(1) 用 x 表示矩形 PBCD 的面积 S；\n(2) 当 x=${xValue} 时，求 S。`,
      options: [],
      answer: `${expression}，x=${xValue} 时 S=${value}`,
      explanation: `(1) PB=${length}-x，矩形高为 ${height}，所以 S=${height}(${length}-x)=${expression.replace("S=", "")}。\n(2) 当 x=${xValue} 时，S=${length * height}-${height}×${xValue}=${value}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeMovingPointAreaDiagramSpec(),
      imageNote: "系统模板：动点面积函数",
      verification: { expectedAnswer: `${expression}，x=${xValue} 时 S=${value}`, expectedValues: [expression, `${value}`] }
    }));
  }
  for (const length of [8, 10, 12, 14, 16, 18, 20, 24]) {
    const half = length / 2;
    const max = half * half;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，点 P 在线段 AB 上运动，AB=${length}，AP=x，PB=${length}-x。若以 AP、PB 为邻边构造矩形，面积为 S。\n(1) 写出 S 关于 x 的表达式；\n(2) 求 S 的最大值。`,
      options: [],
      answer: `S=x(${length}-x)，最大值为${max}`,
      explanation: `(1) 矩形面积 S=AP·PB=x(${length}-x)。\n(2) S=x(${length}-x)=-(x-${half})²+${max}，所以当 x=${half} 时，S 最大为 ${max}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeMovingPointSegmentDiagramSpec(),
      imageNote: "系统模板：动点面积最值",
      verification: { expectedAnswer: `S=x(${length}-x)，最大值为${max}`, expectedValues: [`S=x(${length}-x)`, `${max}`] }
    }));
  }
  const triangleCases = [
    [2, 5, 3], [3, 4, 2], [4, 6, 2], [5, 8, 2], [6, 5, 3],
    [2, 9, 4], [3, 10, 3], [4, 7, 5]
  ];
  for (const [speed, height, tValue] of triangleCases) {
    const coefficient = speed * height / 2;
    const value = coefficient * tValue;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，点 P 从 A 向 B 运动，AP=${speed}t。以 AP 为底、${height} 为高的三角形面积为 S。\n(1) 用 t 表示 S；\n(2) 当 t=${tValue} 时，求 S。`,
      options: [],
      answer: `S=${coefficient}t，t=${tValue} 时 S=${value}`,
      explanation: `(1) 三角形面积 S=1/2×AP×高=1/2×${speed}t×${height}=${coefficient}t。\n(2) 当 t=${tValue} 时，S=${coefficient}×${tValue}=${value}。`,
      knowledge: ["函数", "几何"],
      diagramSpec: makeMovingPointAreaDiagramSpec(),
      imageNote: "系统模板：动点面积函数",
      verification: { expectedAnswer: `S=${coefficient}t，t=${tValue} 时 S=${value}`, expectedValues: [`S=${coefficient}t`, `${value}`] }
    }));
  }
  return variants;
}

function makeGeometryExtremumTemplateVariants(question = {}, base = {}) {
  const variants = [];
  for (const lineName of ["l", "m", "n", "p", "q", "r", "s", "t"]) {
    variants.push(variantDefaults(question, {
      ...base,
      stem: `如图，点 A、B 在直线 ${lineName} 的同侧，点 P 在直线 ${lineName} 上运动。要使 PA+PB 最小，应作点 A 关于直线 ${lineName} 的对称点 A'，连接 A'B 交直线 ${lineName} 于 P。此时最小值等于（ ）`,
      options: choiceOptions(["AB", "A'B", "AA'", "PB"]),
      answer: "B",
      explanation: "由轴对称可知 PA=PA'，所以 PA+PB=PA'+PB。当 A'、P、B 三点共线时，PA'+PB 最小，最小值为 A'B。",
      knowledge: ["几何"],
      diagramSpec: makeGeometryExtremumDiagramSpec(),
      imageNote: "系统模板：几何最值",
      verification: { expectedAnswer: "B", expectedOption: "A'B", expectedValue: "A'B" }
    }));
  }
  for (const pointName of ["A", "B", "C", "D", "E", "F"]) {
    variants.push(variantDefaults(question, {
      ...base,
      stem: `在直线 l 外有一点 ${pointName}，点 P 在直线 l 上运动，P${pointName} 的最小值是（ ）`,
      options: choiceOptions([`过 ${pointName} 作 l 的垂线段长度`, `任意连接 P${pointName} 的长度`, `${pointName} 到 l 上任一点的距离`, "直线 l 的长度"]),
      answer: "A",
      explanation: `点到直线的所有连线中，垂线段最短，所以 P${pointName} 的最小值是点 ${pointName} 到直线 l 的垂线段长度。`,
      knowledge: ["几何"],
      diagramSpec: makeGeometryExtremumDiagramSpec(),
      imageNote: "系统模板：点到直线最短",
      verification: { expectedAnswer: "A", expectedOption: `过 ${pointName} 作 l 的垂线段长度`, expectedValue: "垂线段长度" }
    }));
  }
  for (const pair of [["A", "B"], ["C", "D"], ["M", "N"], ["E", "F"], ["P", "Q"], ["G", "H"]]) {
    const [a, b] = pair;
    variants.push(variantDefaults(question, {
      ...base,
      stem: `如图，点 ${a}、${b} 在直线 l 的两侧，点 P 在直线 l 上运动。要使 P${a}+P${b} 最小，点 P 应满足（ ）`,
      options: choiceOptions([`${a}、P、${b} 三点共线`, `P${a}⊥l`, `P${b}⊥l`, "P 为任意点"]),
      answer: "A",
      explanation: `两点之间线段最短。当 ${a}、P、${b} 三点共线且 P 在直线 l 上时，P${a}+P${b}=${a}${b}，取得最小值。`,
      knowledge: ["几何"],
      diagramSpec: makeGeometryExtremumDiagramSpec(),
      imageNote: "系统模板：折线路径最短",
      verification: { expectedAnswer: "A", expectedOption: `${a}、P、${b} 三点共线`, expectedValue: `${a}、P、${b} 三点共线` }
    }));
  }
  return variants;
}

function makeProbabilityTreeListTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const ballCases = [
    [1, 1], [1, 2], [2, 1], [2, 3], [3, 2], [3, 1], [4, 1], [4, 2]
  ];
  for (const [red, white] of ballCases) {
    const total = red + white;
    const numerator = red * red;
    const denominator = total * total;
    variants.push(variantDefaults(question, {
      ...base,
      stem: `一个袋中有 ${red} 个红球和 ${white} 个白球，放回地摸两次。两次都摸到红球的概率是（ ）`,
      options: choiceOptions([`${numerator}/${denominator}`, `${red}/${total}`, `${white}/${total}`, "1"]),
      answer: "A",
      explanation: `每次摸到红球的概率为 ${red}/${total}，放回地摸两次相互独立，所以两次都摸到红球的概率为 ${red}/${total}×${red}/${total}=${numerator}/${denominator}。`,
      knowledge: ["概率"],
      diagramSpec: makeProbabilityTreeDiagramSpec(),
      imageNote: "系统模板：概率树状图",
      verification: { expectedAnswer: "A", expectedOption: `${numerator}/${denominator}`, expectedValue: `${numerator}/${denominator}` }
    }));
  }
  const listCases = [
    [3, 2, 4, 2, 6], [4, 3, 5, 3, 12], [5, 2, 6, 2, 10], [3, 3, 5, 2, 9],
    [4, 2, 4, 2, 8], [5, 3, 7, 2, 15]
  ];
  for (const [firstMax, secondMax, target, favorable, total] of listCases) {
    variants.push(variantDefaults(question, {
      ...base,
      stem: `从数字 1 到 ${firstMax} 中随机选一个，再从数字 1 到 ${secondMax} 中随机选一个。两数之和为 ${target} 的概率是（ ）`,
      options: choiceOptions([`1/${total}`, `${favorable}/${total}`, `1/${secondMax}`, `${firstMax}/${total}`]),
      answer: "B",
      explanation: `列表可得共有 ${firstMax}×${secondMax}=${total} 种等可能结果，和为 ${target} 的有 ${favorable} 种，所以概率为 ${favorable}/${total}。`,
      knowledge: ["概率"],
      diagramSpec: makeProbabilityTreeDiagramSpec(),
      imageNote: "系统模板：列表法概率",
      verification: { expectedAnswer: "B", expectedOption: `${favorable}/${total}`, expectedValue: `${favorable}/${total}` }
    }));
  }
  const coinCases = [
    ["两枚", "恰好出现一正一反", "2/4", "1/2"],
    ["三枚", "恰好出现两正一反", "3/8", "3/8"],
    ["三枚", "至少出现一正", "7/8", "7/8"],
    ["两枚", "两枚都是正面", "1/4", "1/4"],
    ["三枚", "三枚都是反面", "1/8", "1/8"],
    ["两枚", "至少出现一反", "3/4", "3/4"]
  ];
  for (const [count, event, raw, answer] of coinCases) {
    variants.push(variantDefaults(question, {
      ...base,
      stem: `同时抛掷${count}质地均匀的硬币，${event}的概率是（ ）`,
      options: choiceOptions([answer === "1/4" ? "1/2" : "1/4", answer === "1/2" ? "1/3" : "1/2", answer, "1"]),
      answer: "C",
      explanation: `用树状图列出所有等可能结果，满足“${event}”的结果所占比例为 ${raw}，所以概率为 ${answer}。`,
      knowledge: ["概率"],
      diagramSpec: makeProbabilityTreeDiagramSpec(),
      imageNote: "系统模板：树状图概率",
      verification: { expectedAnswer: "C", expectedOption: answer, expectedValue: answer }
    }));
  }
  return variants;
}

function makeParallelTransversalTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const spec = (line1Label = "m", line2Label = "n", transversalLabel = "ℓ") => ({
    type: "geometry",
    template: "parallel_transversal",
    width: 420,
    height: 280,
    line1Label,
    line2Label,
    transversalLabel
  });
  const makeChoice = ({ line1 = "m", line2 = "n", transversal = "ℓ", given, value, target, result, options, answer, relation }) => {
    const resultText = `${result}°`;
    variants.push(variantDefaults(question, {
      ...base,
      stem: `如图，直线 ${line1}∥${line2}，被直线 ${transversal} 所截，图中标有 ∠1、∠2、∠3、∠4、∠5、∠6、∠7、∠8。若 ${given}=${value}°，则 ${target} 的度数是（ ）`,
      options: choiceOptions(options),
      answer,
      explanation: `因为 ${line1}∥${line2}，${relation}，所以 ${target}=${resultText}。`,
      knowledge: ["几何"],
      diagramSpec: spec(line1, line2, transversal),
      imageNote: "系统模板：平行线截线角",
      verification: { expectedAnswer: answer, expectedOption: resultText, expectedValue: resultText }
    }));
  };

  [
    {
      given: "∠1",
      value: 62,
      target: "∠6",
      result: 118,
      options: ["62°", "118°", "90°", "28°"],
      answer: "B",
      relation: "∠1 与 ∠5 是同位角，∠1=∠5=62°；∠5 与 ∠6 互为邻补角，∠6=180°-62°=118°"
    },
    {
      given: "∠2",
      value: 70,
      target: "∠7",
      result: 70,
      options: ["70°", "110°", "20°", "90°"],
      answer: "A",
      relation: "∠2 与 ∠6 是同位角，∠2=∠6=70°；∠6 与 ∠7 是对顶角，∠7=70°"
    },
    {
      given: "∠3",
      value: 55,
      target: "∠6",
      result: 55,
      options: ["125°", "45°", "55°", "35°"],
      answer: "C",
      relation: "∠3 与 ∠6 是内错角，∠3=∠6=55°"
    },
    {
      given: "∠6",
      value: 112,
      target: "∠1",
      result: 68,
      options: ["112°", "78°", "68°", "56°"],
      answer: "C",
      relation: "∠5 与 ∠6 互为邻补角，∠5=180°-112°=68°；∠1 与 ∠5 是同位角，∠1=68°"
    },
    {
      given: "∠5",
      value: 48,
      target: "∠1",
      result: 48,
      options: ["48°", "132°", "42°", "90°"],
      answer: "A",
      relation: "∠1 与 ∠5 是同位角，∠1=∠5=48°"
    },
    {
      given: "∠7",
      value: 36,
      target: "∠2",
      result: 36,
      options: ["144°", "54°", "36°", "72°"],
      answer: "C",
      relation: "∠7 与 ∠6 是对顶角，∠6=36°；∠2 与 ∠6 是同位角，∠2=36°"
    },
    {
      given: "∠1",
      value: 105,
      target: "∠5",
      result: 105,
      options: ["75°", "105°", "15°", "95°"],
      answer: "B",
      relation: "∠1 与 ∠5 是同位角，∠1=∠5=105°"
    },
    {
      given: "∠3",
      value: 80,
      target: "∠6",
      result: 80,
      options: ["80°", "100°", "40°", "10°"],
      answer: "A",
      relation: "∠3 与 ∠6 是内错角，∠3=∠6=80°"
    }
  ].forEach(makeChoice);

  [
    {
      line1: "a",
      line2: "b",
      transversal: "c",
      correct: "∠3=∠6",
      options: ["∠3=∠6", "∠1=∠2", "∠5=∠6", "∠7=∠8"],
      answer: "A",
      relation: "∠3 与 ∠6 是内错角"
    },
    {
      line1: "m",
      line2: "n",
      transversal: "ℓ",
      correct: "∠2=∠6",
      options: ["∠1=∠2", "∠2=∠6", "∠3=∠4", "∠5=∠6"],
      answer: "B",
      relation: "∠2 与 ∠6 是同位角"
    },
    {
      line1: "p",
      line2: "q",
      transversal: "t",
      correct: "∠1=∠5",
      options: ["∠7=∠8", "∠5=∠6", "∠1=∠5", "∠2=∠4"],
      answer: "C",
      relation: "∠1 与 ∠5 是同位角"
    },
    {
      line1: "x",
      line2: "y",
      transversal: "z",
      correct: "∠3=∠6",
      options: ["∠1=∠2", "∠5=∠6", "∠7=∠8", "∠3=∠6"],
      answer: "D",
      relation: "∠3 与 ∠6 是内错角"
    }
  ].forEach(({ line1, line2, transversal, correct, options, answer, relation }) => {
    variants.push(variantDefaults(question, {
      ...base,
      stem: `如图，直线 ${line1}、${line2} 被直线 ${transversal} 所截，下列条件中能判定 ${line1}∥${line2} 的是（ ）`,
      options: choiceOptions(options),
      answer,
      explanation: `因为 ${correct}，且 ${relation}，所以根据“同位角相等或内错角相等，两直线平行”，可判定 ${line1}∥${line2}。`,
      knowledge: ["几何"],
      diagramSpec: spec(line1, line2, transversal),
      imageNote: "系统模板：平行线判定",
      verification: { expectedAnswer: answer, expectedOption: correct, expectedValue: correct }
    }));
  });

  return variants;
}

function makeTravelDistanceTimeGraphTemplateVariants(question = {}, base = {}) {
  const variants = [];
  const cases = [
    { distance: 960, fastArrivalTime: 8, slowArrivalTime: 12, queryTime: 6, fastVehicle: "一辆客车", slowVehicle: "一辆货车", fastName: "客车", slowName: "货车" },
    { distance: 900, fastArrivalTime: 6, slowArrivalTime: 12, queryTime: 5, fastVehicle: "一列动车", slowVehicle: "一列普快列车", fastName: "动车", slowName: "普快列车" },
    { distance: 720, fastArrivalTime: 6, slowArrivalTime: 9, queryTime: 5, fastVehicle: "一辆快车", slowVehicle: "一辆慢车", fastName: "快车", slowName: "慢车" },
    { distance: 1500, fastArrivalTime: 10, slowArrivalTime: 15, queryTime: 8, fastVehicle: "一列快车", slowVehicle: "一列慢车", fastName: "快车", slowName: "慢车" },
    { distance: 1800, fastArrivalTime: 9, slowArrivalTime: 18, queryTime: 7, fastVehicle: "一列高速列车", slowVehicle: "一列普通列车", fastName: "高速列车", slowName: "普通列车" },
    { distance: 840, fastArrivalTime: 4, slowArrivalTime: 12, queryTime: 3.5, fastVehicle: "一辆快递车", slowVehicle: "一辆配送车", fastName: "快递车", slowName: "配送车" },
    { distance: 1000, fastArrivalTime: 5, slowArrivalTime: 20, queryTime: 4.5, fastVehicle: "一艘快艇", slowVehicle: "一艘轮船", fastName: "快艇", slowName: "轮船" }
  ];

  const metrics = (item) => {
    const { distance, fastArrivalTime, slowArrivalTime, queryTime } = item;
    const speedFast = distance / fastArrivalTime;
    const speedSlow = distance / slowArrivalTime;
    const meetTime = (fastArrivalTime * slowArrivalTime) / (fastArrivalTime + slowArrivalTime);
    const cDistance = speedSlow * fastArrivalTime;
    const slopeBC = speedFast + speedSlow;
    const expression = `y=${formatCompactNumber(slopeBC)}x${formatSignedTerm(-distance)}`;
    const abExpression = `y=${distance}${formatSignedTerm(-slopeBC, "x")}`;
    const cdExpression = `y=${formatCompactNumber(speedSlow)}x`;
    const queryDistance = slopeBC * queryTime - distance;
    const earlyHours = slowArrivalTime - fastArrivalTime;
    const caseId = `travel-${distance}-${formatCompactNumber(meetTime)}-${fastArrivalTime}-${slowArrivalTime}-${queryTime}`;
    return {
      ...item,
      caseId,
      diagramSignature: `${caseId}-${formatCompactNumber(cDistance)}`,
      speedFast,
      speedSlow,
      meetTime,
      cDistance,
      slopeBC,
      expression,
      abExpression,
      cdExpression,
      queryDistance,
      earlyHours,
      distanceText: formatCompactNumber(distance),
      fastArrivalText: formatCompactNumber(fastArrivalTime),
      slowArrivalText: formatCompactNumber(slowArrivalTime),
      meetText: formatCompactNumber(meetTime),
      queryText: formatCompactNumber(queryTime),
      queryDistanceText: formatCompactNumber(queryDistance),
      fastSpeedText: formatCompactNumber(speedFast),
      slowSpeedText: formatCompactNumber(speedSlow),
      cDistanceText: formatCompactNumber(cDistance),
      slopeText: formatCompactNumber(slopeBC),
      earlyHoursText: formatCompactNumber(earlyHours)
    };
  };

  const diagram = (m, graphMode = "distance_between", extra = {}) => makeTravelDistanceTimeGraphDiagramSpec({
    distance: m.distance,
    meetTime: m.meetTime,
    fastArrivalTime: m.fastArrivalTime,
    slowArrivalTime: m.slowArrivalTime,
    speedSlow: m.speedSlow,
    graphMode,
    fastLineLabel: m.fastName,
    slowLineLabel: m.slowName,
    ...extra
  });

  const baseQuestion = (m, extra) => {
    const graphMode = extra.graphMode || "distance_between";
    const diagramSpec = extra.diagramSpec || diagram(m, graphMode, extra.diagramExtra || {});
    return variantDefaults(question, {
      ...base,
      type: "解答题",
      options: [],
      knowledge: ["函数", "方程与不等式"],
      diagramSpec,
      templateCaseId: `${m.caseId}-${diagramSpec.graphMode || graphMode}`,
      diagramSignature: `${m.diagramSignature}-${diagramSpec.graphMode || graphMode}`,
      imageNote: "系统模板：行程距离时间图",
      ...extra
    });
  };

  for (const item of cases.map(metrics)) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      variationType: "meet_speed_bc_value",
      templateCaseId: `${item.caseId}-distance_between`,
      diagramSignature: `${item.diagramSignature}-distance_between`,
      stem: `${item.fastVehicle}从甲地驶往乙地，${item.slowVehicle}从乙地驶往甲地，两车同时出发，到达目的地后停止。设出发 x 小时后两车之间的距离为 y 千米，两者的关系如图所示。图中 A 表示出发时两地距离，B 表示两车相遇，C 表示${item.fastName}到达乙地，D 表示${item.slowName}到达甲地。根据图象探究：\n(1) 填空：两车出发______小时，两车相遇；\n(2) 求${item.fastName}和${item.slowName}的速度；\n(3) 求线段 BC 所表示的 y 与 x 的关系式，并求行驶 ${item.queryText} 小时后两车相距多少千米。`,
      options: [],
      answer: `两车出发 ${item.meetText} 小时相遇；${item.fastName}速度 ${item.fastSpeedText} 千米/小时，${item.slowName}速度 ${item.slowSpeedText} 千米/小时；BC：${item.expression}，x=${item.queryText} 时 y=${item.queryDistanceText} 千米`,
      explanation: `由图象可知 A(0,${item.distanceText})，B(${item.meetText},0)，C(${item.fastArrivalText},${item.cDistanceText})，D(${item.slowArrivalText},${item.distanceText})。\n(1) B 点表示两车相遇，所以相遇时间为 ${item.meetText} 小时。\n(2) ${item.fastName}先到达目的地，用时 ${item.fastArrivalText} 小时，速度为 ${item.distanceText}÷${item.fastArrivalText}=${item.fastSpeedText} 千米/小时；${item.slowName}用时 ${item.slowArrivalText} 小时，速度为 ${item.distanceText}÷${item.slowArrivalText}=${item.slowSpeedText} 千米/小时。\n(3) 在线段 BC 上，两车均未停止，距离增加速度为 ${item.fastSpeedText}+${item.slowSpeedText}=${item.slopeText} 千米/小时，且过点 B(${item.meetText},0)，所以 ${item.expression}。当 x=${item.queryText} 时，y=${item.slopeText}×${item.queryText}-${item.distanceText}=${item.queryDistanceText} 千米。`,
      knowledge: ["函数", "方程与不等式"],
      diagramSpec: diagram(item),
      imageNote: "系统模板：行程距离时间图",
      verification: {
        expectedAnswer: `两车出发 ${item.meetText} 小时相遇；${item.fastName}速度 ${item.fastSpeedText} 千米/小时，${item.slowName}速度 ${item.slowSpeedText} 千米/小时；BC：${item.expression}，x=${item.queryText} 时 y=${item.queryDistanceText} 千米`,
        expectedValues: [item.meetText, item.fastSpeedText, item.slowSpeedText, item.expression, item.queryDistanceText]
      }
    }));
  }

  for (const item of cases.slice(0, 5).map(metrics)) {
    variants.push(baseQuestion(item, {
      variationType: "read_coordinates_meaning",
      graphMode: "position_two_lines",
      stem: `${item.fastVehicle}从甲地开往乙地，${item.slowVehicle}从乙地开往甲地，两车同时出发，到站后停止。设出发后 x 小时，车辆离甲地的距离为 y 千米，两车的运动图象如图所示。\n(1) 写出交点 P 的坐标，并说明它的实际意义；\n(2) 分别求${item.fastName}和${item.slowName}的速度；\n(3) 写出表示${item.fastName}运动图象的函数表达式。`,
      answer: `P(${item.meetText},${item.cDistanceText})，表示两车出发 ${item.meetText} 小时后相遇，且相遇地点离甲地 ${item.cDistanceText} 千米；${item.fastName}速度 ${item.fastSpeedText} 千米/小时，${item.slowName}速度 ${item.slowSpeedText} 千米/小时；${item.fastName}：y=${item.fastSpeedText}x`,
      explanation: `图中${item.fastName}从甲地出发，图象从 (0,0) 上升到 (${item.fastArrivalText},${item.distanceText})，所以速度为 ${item.distanceText}÷${item.fastArrivalText}=${item.fastSpeedText} 千米/小时。${item.slowName}从乙地出发，图象从 (0,${item.distanceText}) 下降到 (${item.slowArrivalText},0)，所以速度为 ${item.distanceText}÷${item.slowArrivalText}=${item.slowSpeedText} 千米/小时。两线交点 P 的横坐标为相遇时间 ${item.meetText}，纵坐标为相遇地点离甲地的距离 ${item.fastSpeedText}×${item.meetText}=${item.cDistanceText}，故 P(${item.meetText},${item.cDistanceText})。${item.fastName}的图象过原点，斜率为 ${item.fastSpeedText}，表达式为 y=${item.fastSpeedText}x。`,
      verification: {
        expectedValues: [`P(${item.meetText},${item.cDistanceText})`, item.fastSpeedText, item.slowSpeedText, `y=${item.fastSpeedText}x`]
      }
    }));
  }

  for (const item of cases.slice(1, 6).map(metrics)) {
    const restDuration = item.fastArrivalTime - item.meetTime;
    const afterRestDuration = item.slowArrivalTime - item.fastArrivalTime;
    const speedBeforeRest = item.cDistance / item.meetTime;
    const speedAfterRest = (item.distance - item.cDistance) / afterRestDuration;
    const restDurationText = formatCompactNumber(restDuration);
    const afterRestDurationText = formatCompactNumber(afterRestDuration);
    const speedBeforeRestText = formatCompactNumber(speedBeforeRest);
    const speedAfterRestText = formatCompactNumber(speedAfterRest);
    variants.push(baseQuestion(item, {
      variationType: "rest_stop_position",
      graphMode: "rest_position",
      stem: `某车从甲地出发前往乙地，途中在服务区休息一段时间后继续行驶。设出发 x 小时后，车辆离甲地的距离为 y 千米，图象如图所示。\n(1) 该车在服务区休息了多少小时？\n(2) 求休息前的行驶速度；\n(3) 求休息后继续行驶阶段的速度，并说明点 D 的实际意义。`,
      answer: `休息 ${restDurationText} 小时；休息前速度 ${speedBeforeRestText} 千米/小时；休息后速度 ${speedAfterRestText} 千米/小时；D(${item.slowArrivalText},${item.distanceText}) 表示出发 ${item.slowArrivalText} 小时后到达离甲地 ${item.distanceText} 千米的乙地`,
      explanation: `图中 AB 段表示休息前行驶，BC 段水平表示距离不变，即正在休息，CD 段表示休息后继续行驶。B(${item.meetText},${item.cDistanceText})，C(${item.fastArrivalText},${item.cDistanceText})，所以休息时间为 ${item.fastArrivalText}-${item.meetText}=${restDurationText} 小时。休息前速度为 ${item.cDistanceText}÷${item.meetText}=${speedBeforeRestText} 千米/小时。休息后用 ${item.slowArrivalText}-${item.fastArrivalText}=${afterRestDurationText} 小时行驶 ${item.distanceText}-${item.cDistanceText} 千米，速度为 (${item.distanceText}-${item.cDistanceText})÷${afterRestDurationText}=${speedAfterRestText} 千米/小时。D(${item.slowArrivalText},${item.distanceText}) 表示该车到达乙地。`,
      verification: {
        expectedValues: [restDurationText, speedBeforeRestText, speedAfterRestText, `D(${item.slowArrivalText},${item.distanceText})`]
      }
    }));
  }

  for (const item of cases.slice(1, 6).map(metrics)) {
    variants.push(baseQuestion(item, {
      variationType: "reverse_distance_to_time",
      stem: `如图，${item.fastVehicle}、${item.slowVehicle}分别从甲、乙两地同时出发相向而行，到达目的地后停止。设出发 x 小时后两车相距 y 千米，折线 A-B-C-D 表示这一变化过程。\n(1) 求两车相遇的时间；\n(2) 求线段 BC 所表示的 y 与 x 的关系式；\n(3) 两车相遇后再次相距 ${item.queryDistanceText} 千米时，出发了多少小时？`,
      answer: `相遇时间为 ${item.meetText} 小时；BC：${item.expression}；再次相距 ${item.queryDistanceText} 千米时 x=${item.queryText}`,
      explanation: `(1) 点 B 的横坐标为 ${item.meetText}，所以相遇时间为 ${item.meetText} 小时。\n(2) ${item.fastName}速度为 ${item.fastSpeedText} 千米/小时，${item.slowName}速度为 ${item.slowSpeedText} 千米/小时，线段 BC 上两车距离按速度和 ${item.slopeText} 千米/小时增加，且过 B(${item.meetText},0)，所以 ${item.expression}。\n(3) 令 y=${item.queryDistanceText}，得 ${item.queryDistanceText}=${item.slopeText}x-${item.distanceText}，解得 x=${item.queryText}。`,
      verification: {
        expectedValues: [item.meetText, item.expression, `x=${item.queryText}`]
      }
    }));
  }

  for (const item of cases.slice(2).map(metrics)) {
    const afterFastTime = Math.min(item.slowArrivalTime - 1, item.fastArrivalTime + 2);
    const afterFastDistance = item.speedSlow * afterFastTime;
    const afterFastTimeText = formatCompactNumber(afterFastTime);
    const afterFastDistanceText = formatCompactNumber(afterFastDistance);
    variants.push(baseQuestion(item, {
      variationType: "cd_segment_after_arrival",
      stem: `${item.fastVehicle}从甲地、${item.slowVehicle}从乙地同时出发相向而行。${item.fastName}先到达目的地后停止，${item.slowName}继续行驶。设出发 x 小时后两车相距 y 千米，图象如图。\n(1) ${item.fastName}比${item.slowName}早到多少小时？\n(2) 求线段 CD 所表示的 y 与 x 的关系式；\n(3) 当 x=${afterFastTimeText} 时，两车相距多少千米？`,
      answer: `${item.fastName}比${item.slowName}早到 ${item.earlyHoursText} 小时；CD：${item.cdExpression}；x=${afterFastTimeText} 时 y=${afterFastDistanceText} 千米`,
      explanation: `(1) 由图可知 ${item.fastName}在 ${item.fastArrivalText} 小时到达，${item.slowName}在 ${item.slowArrivalText} 小时到达，所以早到 ${item.slowArrivalText}-${item.fastArrivalText}=${item.earlyHoursText} 小时。\n(2) 在线段 CD 上，${item.fastName}已经停止，距离只随${item.slowName}继续前进而增加。${item.slowName}速度为 ${item.distanceText}÷${item.slowArrivalText}=${item.slowSpeedText} 千米/小时，所以 ${item.cdExpression}。\n(3) 当 x=${afterFastTimeText} 时，y=${item.slowSpeedText}×${afterFastTimeText}=${afterFastDistanceText} 千米。`,
      verification: {
        expectedValues: [item.earlyHoursText, item.cdExpression, afterFastDistanceText]
      }
    }));
  }

  for (const item of cases.slice(0, 4).map(metrics)) {
    variants.push(baseQuestion(item, {
      variationType: "piecewise_ab_bc",
      stem: `${item.fastVehicle}从甲地开往乙地，${item.slowVehicle}从乙地开往甲地，两车同时出发，到达目的地后停止。设出发 x 小时后两车相距 y 千米，图中 A 表示出发时两地距离，B 表示两车相遇，C 表示${item.fastName}到达乙地。\n(1) 分别写出线段 AB、BC 所表示的函数表达式；\n(2) 说明这两个表达式中斜率的实际意义；\n(3) 当 x=${item.queryText} 时，两车相距多少千米？`,
      answer: `AB：${item.abExpression}，BC：${item.expression}；斜率绝对值表示两车距离变化速度 ${item.slopeText} 千米/小时；x=${item.queryText} 时 y=${item.queryDistanceText} 千米`,
      explanation: `线段 AB 表示两车相遇前，距离按两车速度和减少，所以 AB：${item.abExpression}。线段 BC 表示相遇后到${item.fastName}到达前，距离按两车速度和增加，所以 BC：${item.expression}。两个斜率的绝对值都是 ${item.slopeText}，表示两车距离每小时变化 ${item.slopeText} 千米。当 x=${item.queryText} 时，使用 BC 段，y=${item.slopeText}×${item.queryText}-${item.distanceText}=${item.queryDistanceText} 千米。`,
      verification: {
        expectedValues: [item.abExpression, item.expression, item.slopeText, item.queryDistanceText]
      }
    }));
  }

  for (const item of cases.slice(3).map(metrics)) {
    const bcInterval = `${item.meetText}<x≤${item.fastArrivalText}`;
    variants.push(baseQuestion(item, {
      variationType: "domain_and_segment_choice",
      stem: `如图，${item.fastVehicle}和${item.slowVehicle}从甲、乙两地同时出发相向而行，到站后停止。图中线段 AB、BC、CD 分别对应相遇前、相遇后到${item.fastName}到站前、${item.fastName}到站后的三个阶段。\n(1) 线段 BC 对应哪一段时间范围？\n(2) 为什么 BC 段的图象比 CD 段更陡？\n(3) 求 BC 段的函数表达式。`,
      answer: `BC 对应 ${bcInterval}；BC 段两车都在运动，距离变化速度为 ${item.slopeText} 千米/小时，CD 段只有${item.slowName}继续运动，速度为 ${item.slowSpeedText} 千米/小时，所以 BC 更陡；BC：${item.expression}`,
      explanation: `点 B 表示相遇，横坐标为 ${item.meetText}；点 C 表示${item.fastName}到达目的地，横坐标为 ${item.fastArrivalText}，所以 BC 对应 ${bcInterval}。BC 段两车继续反向远离，距离变化速度为 ${item.fastSpeedText}+${item.slowSpeedText}=${item.slopeText}；CD 段${item.fastName}停止，距离变化速度只有 ${item.slowSpeedText}，所以 BC 更陡。由 B(${item.meetText},0) 和斜率 ${item.slopeText} 得 ${item.expression}。`,
      verification: {
        expectedValues: [bcInterval, item.slopeText, item.slowSpeedText, item.expression]
      }
    }));
  }

  for (const item of cases.map(metrics)) {
    variants.push(baseQuestion(item, {
      variationType: "graph_data_completion",
      stem: `${item.fastVehicle}与${item.slowVehicle}分别从甲、乙两地同时相向而行，到站后停止。设出发 x 小时后两车相距 y 千米。图象中 A、B、D 三点分别为 A(0,${item.distanceText})，B(${item.meetText},0)，D(${item.slowArrivalText},${item.distanceText})。\n(1) 求两车速度；\n(2) 补全点 C 的坐标，并说明 C 点的实际意义；\n(3) 写出线段 BC 的函数表达式。`,
      options: [],
      answer: `${item.fastName}速度 ${item.fastSpeedText} 千米/小时，${item.slowName}速度 ${item.slowSpeedText} 千米/小时；C(${item.fastArrivalText},${item.cDistanceText})；BC：${item.expression}`,
      explanation: `A、D 的纵坐标都是 ${item.distanceText}，表示两地相距 ${item.distanceText} 千米。D 的横坐标为 ${item.slowArrivalText}，所以${item.slowName}速度为 ${item.distanceText}÷${item.slowArrivalText}=${item.slowSpeedText} 千米/小时。相遇时间为 ${item.meetText}，由速度和 ${item.distanceText}÷${item.meetText}=${item.slopeText}，可得${item.fastName}速度为 ${item.slopeText}-${item.slowSpeedText}=${item.fastSpeedText} 千米/小时。${item.fastName}到达用时 ${item.distanceText}÷${item.fastSpeedText}=${item.fastArrivalText} 小时，此时${item.slowName}行驶 ${item.slowSpeedText}×${item.fastArrivalText}=${item.cDistanceText} 千米，所以 C(${item.fastArrivalText},${item.cDistanceText})。BC 段表达式为 ${item.expression}。`,
      verification: {
        expectedValues: [item.fastSpeedText, item.slowSpeedText, `C(${item.fastArrivalText},${item.cDistanceText})`, item.expression]
      }
    }));
  }

  return variants;
}

function makeGeometryComprehensiveTemplateVariants(question = {}, base = {}, geometry = () => null) {
  const variants = [];
  const similarCases = [
    [2, 3, 15, 2], [1, 2, 18, 3], [3, 2, 20, 2], [2, 5, 21, 1],
    [3, 4, 28, 1], [4, 1, 25, 1], [5, 3, 32, 1], [3, 5, 24, 2]
  ];
  for (const [ad, db, bc, areaScale] of similarCases) {
    const ab = ad + db;
    const de = bc * ad / ab;
    const smallArea = ad * ad * areaScale;
    const bigArea = ab * ab * areaScale;
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，在 △ABC 中，D、E 分别在 AB、AC 上，且 DE∥BC，AD:DB=${ad}:${db}，BC=${bc}。\n(1) 求 DE 的长；\n(2) 若 S△ADE=${smallArea}，求 S△ABC。`,
      options: [],
      answer: `DE=${de}，S△ABC=${bigArea}`,
      explanation: `(1) 因为 AD:DB=${ad}:${db}，所以 AD/AB=${ad}/${ab}。又 DE∥BC，所以 △ADE∽△ABC，DE/BC=AD/AB=${ad}/${ab}，因此 DE=${bc}×${ad}/${ab}=${de}。\n(2) 相似三角形面积比等于相似比的平方，所以 S△ADE:S△ABC=${ad * ad}:${ab * ab}。已知 S△ADE=${smallArea}，所以 S△ABC=${bigArea}。`,
      knowledge: ["几何"],
      diagramSpec: geometry("similar_triangles_parallel"),
      imageNote: "系统模板：几何综合相似",
      verification: { expectedAnswer: `DE=${de}，S△ABC=${bigArea}`, expectedValues: [`${de}`, `${bigArea}`] }
    }));
  }
  for (const bc of [12, 14, 16, 18, 20, 24]) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，在 △ABC 中，D 是 AB 的中点，E 是 AC 的中点，连接 DE。\n(1) 证明 DE∥BC；\n(2) 若 BC=${bc}，求 DE 的长。`,
      options: [],
      answer: `DE∥BC，DE=${bc / 2}`,
      explanation: `(1) 因为 D、E 分别是 AB、AC 的中点，所以 DE 是 △ABC 的中位线，DE∥BC。\n(2) 三角形中位线等于第三边的一半，所以 DE=1/2BC=${bc / 2}。`,
      knowledge: ["几何"],
      diagramSpec: geometry("triangle_midline_parallel"),
      imageNote: "系统模板：几何综合中位线",
      verification: { expectedAnswer: `DE∥BC，DE=${bc / 2}`, expectedValues: ["DE∥BC", `${bc / 2}`] }
    }));
  }
  const tangentTriples = [[6, 10, 8], [9, 15, 12], [5, 13, 12], [8, 17, 15], [7, 25, 24], [12, 20, 16]];
  for (const [oa, op, pa] of tangentTriples) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，PA 是 ⊙O 的切线，A 为切点，OA=${oa}，OP=${op}。\n(1) 证明 OA⊥PA；\n(2) 求 PA 的长。`,
      options: [],
      answer: `OA⊥PA，PA=${pa}`,
      explanation: `(1) 圆的切线垂直于过切点的半径，所以 OA⊥PA。\n(2) 在 Rt△OAP 中，OP 是斜边，由勾股定理得 PA=√(OP²-OA²)=√(${op}²-${oa}²)=${pa}。`,
      knowledge: ["几何"],
      diagramSpec: geometry("circle_tangent_secant"),
      imageNote: "系统模板：几何综合圆切线",
      verification: { expectedAnswer: `OA⊥PA，PA=${pa}`, expectedValues: ["OA⊥PA", `${pa}`] }
    }));
  }
  const proofCases = [
    ["AB=AC，D 是 BC 的中点，连接 AD", "△ABD≌△ACD，∠BAD=∠CAD", "因为 AB=AC，BD=CD，AD 是公共边，所以 △ABD≌△ACD（SSS），从而 ∠BAD=∠CAD。"],
    ["AB=DE，AC=DF，∠BAC=∠EDF", "△ABC≌△DEF", "两边及其夹角分别相等，所以 △ABC≌△DEF（SAS）。"],
    ["∠B=∠E，∠C=∠F，BC=EF", "△ABC≌△DEF", "两角及夹边分别相等，所以 △ABC≌△DEF（ASA）。"],
    ["∠C=∠F=90°，AB=DE，AC=DF", "Rt△ABC≌Rt△DEF", "直角三角形斜边和一条直角边分别相等，所以 Rt△ABC≌Rt△DEF（HL）。"]
  ];
  for (const [condition, answer, explanation] of proofCases) {
    variants.push(variantDefaults(question, {
      ...base,
      type: "解答题",
      stem: `如图，已知 ${condition}。\n求证：${answer.split("，")[0]}。`,
      options: [],
      answer,
      explanation,
      knowledge: ["几何"],
      diagramSpec: makeCongruentTrianglesDiagramSpec("two_triangles"),
      imageNote: "系统模板：几何综合全等",
      verification: { expectedAnswer: answer, expectedValues: [answer.split("，")[0]] }
    }));
  }
  return variants;
}

function missingTemplateSuggestion(question = {}, templateId = "") {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, question.imageNote].filter(Boolean).join("\n");
  if (!templateId) {
    if (/(圆|⊙).*(相似|切线|割线|弦)|相似.*(圆|⊙)/.test(body)) return "缺少「圆与相似综合」专用模板或题干条件不够明确";
    if (/(二次函数|抛物线).*(动点|面积|最值|存在点|取值范围|压轴|综合)/.test(body)) return "缺少「二次函数压轴分段」专用模板或题干缺少函数式/坐标条件";
    if (/(动点|点P.*运动).*(面积|函数关系式|表达式|最值)/.test(body)) return "缺少「动点面积函数」专用模板或运动规则不完整";
    if (/(最短|最小值|最大值|周长最小|将军饮马|几何最值)/.test(body)) return "缺少「几何最值」专用模板或反射/垂线关系不明确";
    if (/(概率树|树状图|列表法|概率)/.test(body)) return "缺少「概率树状图/列表法」专用模板或事件空间不明确";
    if (/(证明|求证|综合题|辅助线|全等|相似|圆|切线|中点|角平分线)/.test(body)) return "缺少「几何综合大题」专用模板或需要先拆成更明确的小题型";
    return "当前题型未命中系统模板，需要新增题型模板和答案校验器";
  }
  return `已命中「${TEMPLATE_LABELS[templateId] || templateId}」，但通过校验的题不足 3 道，需要继续补这个题型的参数化骨架、配图模板或答案校验器`;
}

function templateVariantDiagnostics(question = {}, {
  templateId = "",
  candidateCount = 0,
  normalizedCount = 0,
  valid = [],
  errors = [],
  selected = []
} = {}) {
  const templateLabel = templateId ? TEMPLATE_LABELS[templateId] || templateId : "未命中模板";
  const passedCount = Array.isArray(valid) ? valid.length : 0;
  const selectedCount = Array.isArray(selected) ? selected.length : 0;
  const failedReasons = (Array.isArray(errors) ? errors : []).slice(0, 8);
  const status = selectedCount >= 3 ? "passed" : templateId ? "template_insufficient" : "missing_template";
  return {
    status,
    templateId,
    templateLabel,
    candidateCount,
    normalizedCount,
    passedCount,
    failedCount: Math.max(0, normalizedCount - passedCount),
    selectedCount,
    failedReasons,
    missingTemplate: selectedCount >= 3 ? "" : missingTemplateSuggestion(question, templateId),
    updatedAt: new Date().toISOString()
  };
}

function templateVariantDiagnosticsMessage(diagnostics = {}) {
  if (!diagnostics || typeof diagnostics !== "object") return "";
  const base = diagnostics.templateId
    ? `命中模板：${diagnostics.templateLabel || diagnostics.templateId}`
    : "未命中系统模板";
  const counts = `候选 ${diagnostics.candidateCount || 0} 道，通过校验 ${diagnostics.passedCount || 0} 道，选出 ${diagnostics.selectedCount || 0} 道`;
  const missing = diagnostics.missingTemplate ? `缺口：${diagnostics.missingTemplate}` : "";
  const reasons = Array.isArray(diagnostics.failedReasons) && diagnostics.failedReasons.length
    ? `失败原因：${diagnostics.failedReasons.slice(0, 3).join("；")}`
    : "";
  return [base, counts, missing, reasons].filter(Boolean).join("。");
}

function makeSystemTemplateVariants(question = {}, options = {}) {
  const template = detectedTemplateKey(question);
  const level = question.level || "基础";
  const subject = question.subject || "初中数学";
  const base = { type: "选择题", subject, level, knowledge: normalizeKnowledgeTags(question.knowledge, subject, question.stem) };
  const geometry = (templateName) => ({ type: "geometry", template: templateName, width: 420, height: 280 });
  const variants = [];

  if (template === "parallel_transversal") {
    variants.push(...makeParallelTransversalTemplateVariants(question, base));
  } else if (template === "triangle_midline_parallel") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，D、E 分别是 AB、AC 的中点，若 BC=12，则 DE 的长为（ ）",
        options: choiceOptions(["4", "5", "6", "8"]),
        answer: "C",
        explanation: "三角形中位线平行于第三边且等于第三边的一半，所以 DE=1/2BC=6。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_midline_parallel"),
        imageNote: "系统模板：三角形中位线"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，D、E 分别是 AB、AC 的中点，若 DE=7，则 BC 的长为（ ）",
        options: choiceOptions(["7", "10", "14", "21"]),
        answer: "C",
        explanation: "DE 是 △ABC 的中位线，所以 DE=1/2BC，因此 BC=2DE=14。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_midline_parallel"),
        imageNote: "系统模板：三角形中位线"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，D、E 分别是 AB、AC 的中点，下列结论正确的是（ ）",
        options: choiceOptions(["DE∥BC 且 DE=1/2BC", "DE⊥BC", "DE=BC", "DE 平分∠A"]),
        answer: "A",
        explanation: "连接三角形两边中点的线段叫三角形中位线，它平行于第三边，并且等于第三边的一半。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_midline_parallel"),
        imageNote: "系统模板：三角形中位线"
      })
    );
  } else if (template === "similar_triangles_parallel") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，DE∥BC，若 AD/AB=2/5，BC=15，则 DE 的长为（ ）",
        options: choiceOptions(["5", "6", "8", "10"]),
        answer: "B",
        explanation: "因为 DE∥BC，所以 △ADE∽△ABC，DE/BC=AD/AB=2/5，因此 DE=15×2/5=6。",
        knowledge: ["几何"],
        diagramSpec: geometry("similar_triangles_parallel"),
        imageNote: "系统模板：相似三角形"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，FG∥BC，若 AF/AB=3/4，BC=16，则 FG 的长为（ ）",
        options: choiceOptions(["8", "10", "12", "14"]),
        answer: "C",
        explanation: "因为 FG∥BC，所以 △AFG∽△ABC，FG/BC=AF/AB=3/4，因此 FG=16×3/4=12。",
        knowledge: ["几何"],
        diagramSpec: geometry("similar_triangles_parallel"),
        imageNote: "系统模板：相似三角形"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，DE∥FG∥BC，若 AD:DF:FB=1:1:2，BC=20，则 DE 的长为（ ）",
        options: choiceOptions(["4", "5", "8", "10"]),
        answer: "B",
        explanation: "AD/AB=1/(1+1+2)=1/4。由 DE∥BC 得 △ADE∽△ABC，所以 DE/BC=1/4，DE=20×1/4=5。",
        knowledge: ["几何"],
        diagramSpec: geometry("similar_triangles_parallel"),
        imageNote: "系统模板：平行线分线段成比例"
      })
    );
  } else if (template === "triangle_cevians_angles" || template === "triangle_basic") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，点 D 在 AB 上，点 E 在 AC 上，DE∥BC。若 ∠ABC=55°，则 ∠ADE 的度数是（ ）",
        options: choiceOptions(["35°", "55°", "70°", "125°"]),
        answer: "B",
        explanation: "因为 DE∥BC，AD 与 AB 在同一直线上，所以 ∠ADE 与 ∠ABC 是同位角，∠ADE=∠ABC=55°。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_cevians_angles"),
        imageNote: "系统模板：三角形平行线角"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，点 D 在 AB 上，点 E 在 AC 上，DE∥BC。若 ∠ACB=48°，则 ∠AED 的度数是（ ）",
        options: choiceOptions(["42°", "48°", "84°", "132°"]),
        answer: "B",
        explanation: "因为 DE∥BC，AE 与 AC 在同一直线上，所以 ∠AED 与 ∠ACB 是同位角，∠AED=48°。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_cevians_angles"),
        imageNote: "系统模板：三角形平行线角"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，DE∥BC，下列结论正确的是（ ）",
        options: choiceOptions(["∠ADE=∠ABC", "∠ADE=∠ACB", "AD=BC", "DE⊥AC"]),
        answer: "A",
        explanation: "DE∥BC，AD 与 AB 共线，所以 ∠ADE 与 ∠ABC 是同位角，二者相等。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_cevians_angles"),
        imageNote: "系统模板：三角形平行线角"
      })
    );
  } else if (template === "circle_tangent_secant" || template === "circle_basic") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，PA 是 ⊙O 的切线，A 为切点，若 OA=6，OP=10，则 PA 的长为（ ）",
        options: choiceOptions(["6", "8", "10", "12"]),
        answer: "B",
        explanation: "半径 OA 垂直于切线 PA，所以 △OAP 是直角三角形。PA=√(OP²-OA²)=√(10²-6²)=8。",
        knowledge: ["几何"],
        diagramSpec: geometry("circle_tangent_secant"),
        imageNote: "系统模板：圆切线"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，PA 是 ⊙O 的切线，A 为切点，下列结论正确的是（ ）",
        options: choiceOptions(["OA⊥PA", "OA∥PA", "OP⊥OA", "PA 是圆的直径"]),
        answer: "A",
        explanation: "圆的切线垂直于过切点的半径，所以 OA⊥PA。",
        knowledge: ["几何"],
        diagramSpec: geometry("circle_tangent_secant"),
        imageNote: "系统模板：圆切线"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，PA 是 ⊙O 的切线，A 为切点，若 OA=5，PA=12，则 OP 的长为（ ）",
        options: choiceOptions(["11", "12", "13", "17"]),
        answer: "C",
        explanation: "OA⊥PA，所以 OP²=OA²+PA²=5²+12²=169，OP=13。",
        knowledge: ["几何"],
        diagramSpec: geometry("circle_tangent_secant"),
        imageNote: "系统模板：圆切线"
      })
    );
  } else if (template === "quadrilateral_fold") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，矩形 ABCD 沿 EF 折叠，点 B 落在点 P 处。下列结论一定正确的是（ ）",
        options: choiceOptions(["BE=PE", "BE⊥PE", "EF=BC", "PA=PC"]),
        answer: "A",
        explanation: "折叠前后的对应线段相等，点 B 的对应点为 P，所以 BE=PE。",
        knowledge: ["几何"],
        diagramSpec: geometry("quadrilateral_fold"),
        imageNote: "系统模板：四边形折叠"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，矩形 ABCD 沿 EF 折叠，点 B 落在点 P 处。若 BE=4，则 PE 的长为（ ）",
        options: choiceOptions(["2", "4", "6", "8"]),
        answer: "B",
        explanation: "折叠是轴对称变换，对应线段相等，因此 PE=BE=4。",
        knowledge: ["几何"],
        diagramSpec: geometry("quadrilateral_fold"),
        imageNote: "系统模板：四边形折叠"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，矩形 ABCD 沿 EF 折叠，点 B 落在点 P 处，则直线 EF 是线段 BP 的（ ）",
        options: choiceOptions(["垂直平分线", "中线", "角平分线", "平行线"]),
        answer: "A",
        explanation: "折痕是对应点连线的垂直平分线，所以 EF 是 BP 的垂直平分线。",
        knowledge: ["几何"],
        diagramSpec: geometry("quadrilateral_fold"),
        imageNote: "系统模板：四边形折叠"
      })
    );
  } else if (template === "grid_probability") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，一个 3×3 的方格中有 3 个阴影小方格。随机选择其中一个小方格，选中阴影小方格的概率是（ ）",
        options: choiceOptions(["1/9", "1/3", "1/2", "2/3"]),
        answer: "B",
        explanation: "共有 9 个小方格，其中阴影小方格有 3 个，所以概率为 3/9=1/3。",
        knowledge: ["概率"],
        diagramSpec: { type: "geometry", template: "grid_probability", width: 420, height: 280, rows: 3, cols: 3, shaded: [[1, 1], [1, 2], [2, 1]], label: "阴影小方格" },
        imageNote: "系统模板：方格概率"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，一个 4×4 的方格中有 6 个阴影小方格。随机选择其中一个小方格，选中阴影小方格的概率是（ ）",
        options: choiceOptions(["3/8", "1/4", "5/8", "3/4"]),
        answer: "A",
        explanation: "共有 16 个小方格，其中阴影小方格有 6 个，所以概率为 6/16=3/8。",
        knowledge: ["概率"],
        diagramSpec: { type: "geometry", template: "grid_probability", width: 420, height: 280, rows: 4, cols: 4, shaded: [[1, 1], [1, 2], [2, 1], [2, 2], [3, 3], [4, 4]], label: "阴影小方格" },
        imageNote: "系统模板：方格概率"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，一个 2×5 的方格中有 4 个阴影小方格。随机选择其中一个小方格，选中非阴影小方格的概率是（ ）",
        options: choiceOptions(["2/5", "3/5", "4/5", "1/5"]),
        answer: "B",
        explanation: "共有 10 个小方格，阴影有 4 个，非阴影有 6 个，所以概率为 6/10=3/5。",
        knowledge: ["概率"],
        diagramSpec: { type: "geometry", template: "grid_probability", width: 420, height: 280, rows: 2, cols: 5, shaded: [[1, 1], [1, 2], [2, 4], [2, 5]], label: "阴影小方格" },
        imageNote: "系统模板：方格概率"
      })
    );
  } else if (template === "coordinate_linear") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，直线 y=2x+1 与 y 轴交于点 A，则点 A 的坐标是（ ）",
        options: choiceOptions(["(0,1)", "(1,0)", "(0,2)", "(2,1)"]),
        answer: "A",
        explanation: "令 x=0，得 y=1，所以直线与 y 轴交点为 (0,1)。",
        knowledge: ["函数"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, k: 2, b: 1, points: [{ name: "A", x: 0, y: 1 }] },
        imageNote: "系统模板：一次函数"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，点 P 在直线 y=2x+1 上，若点 P 的横坐标为 2，则点 P 的纵坐标为（ ）",
        options: choiceOptions(["3", "4", "5", "6"]),
        answer: "C",
        explanation: "把 x=2 代入 y=2x+1，得 y=2×2+1=5。",
        knowledge: ["函数"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, k: 2, b: 1, points: [{ name: "P", x: 2, y: 5 }] },
        imageNote: "系统模板：一次函数"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，直线 y=-x+3 与 x 轴交于点 B，则点 B 的坐标是（ ）",
        options: choiceOptions(["(0,3)", "(3,0)", "(-3,0)", "(0,-3)"]),
        answer: "B",
        explanation: "令 y=0，得 -x+3=0，所以 x=3，点 B 的坐标为 (3,0)。",
        knowledge: ["函数"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, k: -1, b: 3, points: [{ name: "B", x: 3, y: 0 }] },
        imageNote: "系统模板：一次函数"
      })
    );
  } else if (template === "bar_basic") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，某小组统计甲、乙、丙三人的跳绳次数分别为 12、18、15 次，则这三个数据的平均数是（ ）",
        options: choiceOptions(["12", "14", "15", "18"]),
        answer: "C",
        explanation: "平均数为 (12+18+15)/3=15。",
        knowledge: ["统计"],
        diagramSpec: { type: "statistics", template: "bar_basic", width: 420, height: 280, bars: [{ label: "甲", value: 12 }, { label: "乙", value: 18 }, { label: "丙", value: 15 }] },
        imageNote: "系统模板：条形统计图"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，四个班参加活动的人数分别为 20、24、18、22 人，人数最多的是（ ）",
        options: choiceOptions(["一班", "二班", "三班", "四班"]),
        answer: "B",
        explanation: "四个数据中最大的是 24，对应二班。",
        knowledge: ["统计"],
        diagramSpec: { type: "statistics", template: "bar_basic", width: 420, height: 280, bars: [{ label: "一班", value: 20 }, { label: "二班", value: 24 }, { label: "三班", value: 18 }, { label: "四班", value: 22 }] },
        imageNote: "系统模板：条形统计图"
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，甲、乙、丙三组人数分别为 8、10、12 人，则丙组人数占总人数的比例是（ ）",
        options: choiceOptions(["1/5", "1/3", "2/5", "1/2"]),
        answer: "C",
        explanation: "总人数为 8+10+12=30，丙组占 12/30=2/5。",
        knowledge: ["统计"],
        diagramSpec: { type: "statistics", template: "bar_basic", width: 420, height: 280, bars: [{ label: "甲", value: 8 }, { label: "乙", value: 10 }, { label: "丙", value: 12 }] },
        imageNote: "系统模板：条形统计图"
      })
    );
  } else if (template === "probability_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "一个袋子中有 3 个红球和 2 个白球，除颜色外完全相同。随机摸出 1 个球，摸到红球的概率是（ ）",
        options: choiceOptions(["1/5", "2/5", "3/5", "4/5"]),
        answer: "C",
        explanation: "共有 5 个球，其中红球 3 个，所以摸到红球的概率为 3/5。",
        knowledge: ["概率"]
      }),
      variantDefaults(question, {
        ...base,
        stem: "掷一枚质地均匀的骰子一次，点数大于 4 的概率是（ ）",
        options: choiceOptions(["1/6", "1/3", "1/2", "2/3"]),
        answer: "B",
        explanation: "骰子共有 6 种等可能结果，点数大于 4 的有 5、6 两种，所以概率为 2/6=1/3。",
        knowledge: ["概率"]
      }),
      variantDefaults(question, {
        ...base,
        stem: "从数字 1、2、3、4 中随机选一个数，选到偶数的概率是（ ）",
        options: choiceOptions(["1/4", "1/2", "3/4", "1"]),
        answer: "B",
        explanation: "共有 4 个数，其中偶数有 2、4 两个，所以概率为 2/4=1/2。",
        knowledge: ["概率"]
      })
    );
  } else if (template === "polynomial_operations_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "化简 (3x²-2x+1)+(x²+5x-4)，结果是（ ）",
        options: choiceOptions(["4x²+3x-3", "4x²-7x-3", "2x²+3x+5", "4x²+3x+5"]),
        answer: "A",
        explanation: "合并同类项：(3x²+x²)+(-2x+5x)+(1-4)=4x²+3x-3。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "4x²+3x-3", expectedValue: "4x²+3x-3", expectedExpression: "4x²+3x-3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "化简 2a(3a-4)+a(2-a)，结果是（ ）",
        options: choiceOptions(["5a²-6a", "7a²-6a", "5a²-10a", "6a²-8a"]),
        answer: "A",
        explanation: "先去括号：2a(3a-4)+a(2-a)=6a²-8a+2a-a²，再合并同类项得 5a²-6a。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "5a²-6a", expectedValue: "5a²-6a", expectedExpression: "5a²-6a" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "计算 (x+3)(x-3)，结果是（ ）",
        options: choiceOptions(["x²-9", "x²+9", "x²-6x+9", "x²+6x+9"]),
        answer: "A",
        explanation: "根据平方差公式 (a+b)(a-b)=a²-b²，(x+3)(x-3)=x²-9。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "x²-9", expectedValue: "x²-9", expectedExpression: "x²-9" }
      })
    );
  } else if (template === "factorization_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "把 x²-16 分解因式，结果是（ ）",
        options: choiceOptions(["(x+4)(x-4)", "(x-4)²", "(x+8)(x-2)", "x(x-16)"]),
        answer: "A",
        explanation: "x²-16=x²-4²，利用平方差公式 a²-b²=(a+b)(a-b)，得 (x+4)(x-4)。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "(x+4)(x-4)", expectedValue: "(x+4)(x-4)", expectedExpression: "x²-16" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "把 3a²+6a 分解因式，结果是（ ）",
        options: choiceOptions(["3a(a+2)", "3(a²+2)", "a(3a+6a)", "3a(a-2)"]),
        answer: "A",
        explanation: "3a² 和 6a 的公因式是 3a，提取公因式得 3a²+6a=3a(a+2)。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "3a(a+2)", expectedValue: "3a(a+2)", expectedExpression: "3a²+6a" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "把 x²+10x+25 分解因式，结果是（ ）",
        options: choiceOptions(["(x+5)²", "(x-5)²", "(x+10)(x+5)", "x(x+10)+25"]),
        answer: "A",
        explanation: "x²+10x+25=x²+2×5×x+5²，符合完全平方公式，所以结果是 (x+5)²。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "(x+5)²", expectedValue: "(x+5)²", expectedExpression: "x²+10x+25" }
      })
    );
  } else if (template === "radical_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "化简 √48，结果是（ ）",
        options: choiceOptions(["4√3", "3√4", "2√12", "16√3"]),
        answer: "A",
        explanation: "因为 48=16×3，所以 √48=√16×√3=4√3。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "4√3", expectedValue: "4√3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "计算 2√3+5√3，结果是（ ）",
        options: choiceOptions(["7√3", "10√3", "7√6", "√21"]),
        answer: "A",
        explanation: "同类二次根式相加，根号部分不变，系数相加，所以 2√3+5√3=7√3。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "7√3", expectedValue: "7√3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "若 a=√5，则 a² 的值为（ ）",
        options: choiceOptions(["√5", "5", "10", "25"]),
        answer: "B",
        explanation: "a=√5，所以 a²=(√5)²=5。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "5", expectedValue: "5" }
      })
    );
  } else if (template === "rational_expression_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "化简 (x²-1)/(x+1)，其中 x≠-1，结果是（ ）",
        options: choiceOptions(["x-1", "x+1", "x²-1", "1/(x+1)"]),
        answer: "A",
        explanation: "x²-1=(x-1)(x+1)，所以 (x²-1)/(x+1)=x-1，条件是 x≠-1。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "x-1", expectedValue: "x-1", expectedExpression: "x-1" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "计算 1/x+1/x，结果是（ ）",
        options: choiceOptions(["2/x", "1/(2x)", "2x", "x/2"]),
        answer: "A",
        explanation: "同分母分式相加，分母不变，分子相加，所以 1/x+1/x=2/x。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "A", expectedOption: "2/x", expectedValue: "2/x", expectedExpression: "2/x" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解分式方程 3/x=1，x 的值为（ ）",
        options: choiceOptions(["1", "2", "3", "4"]),
        answer: "C",
        explanation: "方程两边同乘 x，得 3=x，所以 x=3。经检验 x=3 是原方程的解。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "3", expectedValue: "3" }
      })
    );
  } else if (template === "equation_system_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "解方程组 { x+y=7，x-y=1 }，则 x、y 的值分别为（ ）",
        options: choiceOptions(["x=4，y=3", "x=3，y=4", "x=5，y=2", "x=2，y=5"]),
        answer: "A",
        explanation: "两式相加得 2x=8，所以 x=4。代入 x+y=7，得 y=3。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x=4，y=3", expectedValue: "x=4，y=3", expectedValues: ["x=4", "y=3"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "若 { 2x+y=11，x-y=1 }，则 x 的值为（ ）",
        options: choiceOptions(["2", "3", "4", "5"]),
        answer: "C",
        explanation: "由 x-y=1 得 y=x-1。代入 2x+y=11，得 2x+x-1=11，3x=12，所以 x=4。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "4", expectedValue: "4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "已知 { x+2y=10，x-y=1 }，则 x+y 的值为（ ）",
        options: choiceOptions(["5", "6", "7", "8"]),
        answer: "C",
        explanation: "由 x-y=1 得 x=y+1。代入 x+2y=10，得 y+1+2y=10，3y=9，y=3，x=4，所以 x+y=7。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "7", expectedValue: "7" }
      })
    );
  } else if (template === "quadratic_equation_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "解方程 x²-5x+6=0，方程的两个根是（ ）",
        options: choiceOptions(["x=2 或 x=3", "x=-2 或 x=-3", "x=1 或 x=6", "x=-1 或 x=-6"]),
        answer: "A",
        explanation: "x²-5x+6=(x-2)(x-3)，所以 x=2 或 x=3。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x=2 或 x=3", expectedValue: "x=2 或 x=3", expectedValues: ["x=2", "x=3"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一元二次方程 x²-4x+4=0 的根是（ ）",
        options: choiceOptions(["x=2", "x=-2", "x=4", "x=-4"]),
        answer: "A",
        explanation: "x²-4x+4=(x-2)²，所以方程有两个相等实根 x=2。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x=2", expectedValue: "x=2" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "方程 x²=9 的解是（ ）",
        options: choiceOptions(["x=3", "x=-3", "x=±3", "x=9"]),
        answer: "C",
        explanation: "由 x²=9，得 x=±3。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "x=±3", expectedValue: "x=±3" }
      })
    );
  } else if (template === "linear_inequality_system_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "解不等式组 { x>1，x≤4 }，解集是（ ）",
        options: choiceOptions(["1<x≤4", "x≤1", "x>4", "x≤4"]),
        answer: "A",
        explanation: "两个不等式的公共部分是大于 1 且不超过 4，所以解集为 1<x≤4。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "1<x≤4", expectedValue: "1<x≤4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "不等式组 { x≥-2，x<3 } 的整数解个数是（ ）",
        options: choiceOptions(["4", "5", "6", "7"]),
        answer: "B",
        explanation: "整数解为 -2、-1、0、1、2，共 5 个。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "5", expectedValue: "5" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解不等式组 { 2x>4，x-1≤3 }，解集是（ ）",
        options: choiceOptions(["2<x≤4", "x>2", "x≤4", "x≤2"]),
        answer: "A",
        explanation: "由 2x>4 得 x>2；由 x-1≤3 得 x≤4，公共部分为 2<x≤4。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "2<x≤4", expectedValue: "2<x≤4" }
      })
    );
  } else if (template === "inverse_proportion_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，点 P(2,3) 在反比例函数 y=k/x 的图象上，则 k 的值是（ ）",
        options: choiceOptions(["5", "6", "8", "9"]),
        answer: "B",
        explanation: "点 P(2,3) 在 y=k/x 上，所以 k=xy=2×3=6。",
        knowledge: ["函数"],
        diagramSpec: makeInverseProportionDiagramSpec({ k: 6, pointName: "P", px: 2 }),
        imageNote: "系统模板：反比例函数",
        verification: { expectedAnswer: "B", expectedOption: "6", expectedValue: "6" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "若反比例函数 y=12/x 经过点 A(3,m)，则 m 的值为（ ）",
        options: choiceOptions(["2", "3", "4", "6"]),
        answer: "C",
        explanation: "把 x=3 代入 y=12/x，得 m=12/3=4。",
        knowledge: ["函数"],
        diagramSpec: makeInverseProportionDiagramSpec({ k: 12, pointName: "A", px: 3, yMax: 7 }),
        imageNote: "系统模板：反比例函数",
        verification: { expectedAnswer: "C", expectedOption: "4", expectedValue: "4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "反比例函数 y=k/x 的图象经过点 (-2,5)，则该函数表达式是（ ）",
        options: choiceOptions(["y=10/x", "y=-10/x", "y=5/x", "y=-5/x"]),
        answer: "B",
        explanation: "k=xy=(-2)×5=-10，所以函数表达式为 y=-10/x。",
        knowledge: ["函数"],
        diagramSpec: makeInverseProportionDiagramSpec({ k: -10, pointName: "A", px: -2, yMin: -7, yMax: 7 }),
        imageNote: "系统模板：反比例函数",
        verification: { expectedAnswer: "B", expectedOption: "y=-10/x", expectedValue: "y=-10/x" }
      })
    );
  } else if (template === "trigonometry_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，在 Rt△ABC 中，∠B=90°，∠A=30°，BC=5，则 AC 的长为（ ）",
        options: choiceOptions(["5", "5√3", "10", "10√3"]),
        answer: "C",
        explanation: "在直角三角形中，sin30°=BC/AC=1/2，所以 AC=2BC=10。",
        knowledge: ["几何"],
        diagramSpec: makeRightTriangleTrigDiagramSpec(),
        imageNote: "系统模板：锐角三角函数",
        verification: { expectedAnswer: "C", expectedOption: "10", expectedValue: "10" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "在 Rt△ABC 中，∠C=90°，AC=6，AB=12，则 cosA 的值是（ ）",
        options: choiceOptions(["1/2", "√2/2", "√3/2", "2"]),
        answer: "A",
        explanation: "cosA=邻边/斜边=AC/AB=6/12=1/2。",
        knowledge: ["几何"],
        diagramSpec: makeRightTriangleTrigDiagramSpec(),
        imageNote: "系统模板：锐角三角函数",
        verification: { expectedAnswer: "A", expectedOption: "1/2", expectedValue: "1/2" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某斜坡的坡角为 45°，水平距离为 8 m，则坡高为（ ）",
        options: choiceOptions(["4 m", "8 m", "8√2 m", "16 m"]),
        answer: "B",
        explanation: "tan45°=坡高/水平距离=1，所以坡高=8 m。",
        knowledge: ["几何"],
        diagramSpec: makeRightTriangleTrigDiagramSpec(),
        imageNote: "系统模板：锐角三角函数应用",
        verification: { expectedAnswer: "B", expectedOption: "8 m", expectedValue: "8" }
      })
    );
  } else if (template === "polygon_angles_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "一个六边形的内角和是（ ）",
        options: choiceOptions(["540°", "720°", "900°", "1080°"]),
        answer: "B",
        explanation: "n 边形内角和为 (n-2)×180°。六边形内角和为 (6-2)×180°=720°。",
        knowledge: ["几何"],
        diagramSpec: makePolygonAnglesDiagramSpec(6),
        imageNote: "系统模板：多边形内角和",
        verification: { expectedAnswer: "B", expectedOption: "720°", expectedValue: "720°" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一个多边形的内角和为 1080°，则这个多边形的边数是（ ）",
        options: choiceOptions(["6", "7", "8", "9"]),
        answer: "C",
        explanation: "设边数为 n，则 (n-2)×180°=1080°，n-2=6，所以 n=8。",
        knowledge: ["几何"],
        diagramSpec: makePolygonAnglesDiagramSpec(8),
        imageNote: "系统模板：多边形内角和",
        verification: { expectedAnswer: "C", expectedOption: "8", expectedValue: "8" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "正五边形的每个外角为（ ）",
        options: choiceOptions(["36°", "60°", "72°", "108°"]),
        answer: "C",
        explanation: "任意多边形外角和为 360°，正五边形每个外角为 360°÷5=72°。",
        knowledge: ["几何"],
        diagramSpec: makePolygonAnglesDiagramSpec(5),
        imageNote: "系统模板：正多边形外角",
        verification: { expectedAnswer: "C", expectedOption: "72°", expectedValue: "72°" }
      })
    );
  } else if (template === "quadrilateral_basic_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，平行四边形 ABCD 中，AB=8，BC=5，则 CD 的长为（ ）",
        options: choiceOptions(["5", "8", "10", "13"]),
        answer: "B",
        explanation: "平行四边形的对边相等，所以 CD=AB=8。",
        knowledge: ["几何"],
        diagramSpec: makeQuadrilateralBasicDiagramSpec("parallelogram"),
        imageNote: "系统模板：平行四边形性质",
        verification: { expectedAnswer: "B", expectedOption: "8", expectedValue: "8" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，矩形 ABCD 的对角线 AC=10，则 BD 的长为（ ）",
        options: choiceOptions(["5", "8", "10", "20"]),
        answer: "C",
        explanation: "矩形的对角线相等，所以 BD=AC=10。",
        knowledge: ["几何"],
        diagramSpec: makeQuadrilateralBasicDiagramSpec("rectangle"),
        imageNote: "系统模板：矩形性质",
        verification: { expectedAnswer: "C", expectedOption: "10", expectedValue: "10" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，菱形 ABCD 的对角线 AC、BD 相交于点 O，下列结论正确的是（ ）",
        options: choiceOptions(["AC⊥BD", "AC=BD", "∠A=90°", "AB∥BC"]),
        answer: "A",
        explanation: "菱形的对角线互相垂直，因此 AC⊥BD。",
        knowledge: ["几何"],
        diagramSpec: makeQuadrilateralBasicDiagramSpec("rhombus"),
        imageNote: "系统模板：菱形性质",
        verification: { expectedAnswer: "A", expectedOption: "AC⊥BD", expectedValue: "AC⊥BD" }
      })
    );
  } else if (template === "circle_angle_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，圆心角 ∠AOB=100°，则同弧所对的圆周角 ∠ACB 的度数是（ ）",
        options: choiceOptions(["40°", "50°", "80°", "100°"]),
        answer: "B",
        explanation: "同弧所对的圆周角等于圆心角的一半，所以 ∠ACB=1/2∠AOB=50°。",
        knowledge: ["几何"],
        diagramSpec: makeCircleAngleDiagramSpec(),
        imageNote: "系统模板：圆周角",
        verification: { expectedAnswer: "B", expectedOption: "50°", expectedValue: "50°" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，AB 是 ⊙O 的直径，点 C 在圆上，则 ∠ACB 的度数是（ ）",
        options: choiceOptions(["45°", "60°", "90°", "120°"]),
        answer: "C",
        explanation: "直径所对的圆周角是直角，所以 ∠ACB=90°。",
        knowledge: ["几何"],
        diagramSpec: makeCircleAngleDiagramSpec(),
        imageNote: "系统模板：直径所对圆周角",
        verification: { expectedAnswer: "C", expectedOption: "90°", expectedValue: "90°" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，∠ACB 和 ∠ADB 都对同一条弧 AB，若 ∠ACB=38°，则 ∠ADB 的度数是（ ）",
        options: choiceOptions(["19°", "38°", "76°", "142°"]),
        answer: "B",
        explanation: "同弧所对的圆周角相等，所以 ∠ADB=∠ACB=38°。",
        knowledge: ["几何"],
        diagramSpec: makeCircleAngleDiagramSpec(),
        imageNote: "系统模板：同弧圆周角",
        verification: { expectedAnswer: "B", expectedOption: "38°", expectedValue: "38°" }
      })
    );
  } else if (template === "rotation_congruence_comprehensive_text") {
    const gcd = (a, b) => {
      let x = Math.abs(Number(a));
      let y = Math.abs(Number(b));
      while (y) [x, y] = [y, x % y];
      return x || 1;
    };
    const ratioText = (a, b) => {
      const g = gcd(a, b);
      return `${a / g}/${b / g}`;
    };
    const shared = (item) => {
      const rawHypotenuse = Math.hypot(item.ab, item.bc);
      const hypotenuse = Math.abs(rawHypotenuse - Math.round(rawHypotenuse)) < 1e-9 ? Math.round(rawHypotenuse) : Number(rawHypotenuse.toFixed(4));
      const ratio = ratioText(item.ab, hypotenuse);
      const areaRatio = ratioText(item.ab ** 2, hypotenuse ** 2);
      return { hypotenuse, ratio, areaRatio };
    };
    const cases = [
      (() => {
        const item = { ab: 3, bc: 4, caseId: 7 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `数学活动课上，同学们将两个全等的直角三角形纸片完全重合放置，固定顶点 A，然后将纸片 △ADE 绕点 A 旋转。已知 AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。\n【初步感知】\n(1) 如图1，连接 BD、CE，在旋转过程中，求 BD/CE 的值；\n【深入探究】\n(2) 如图2，当点 D 恰好落在 △ABC 的中线 BM 的延长线上时，延长 ED 交 AC 于点 F，求 CF 的长；\n【拓展延伸】\n(3) 在纸片 △ADE 绕点 A 旋转过程中，试探究 C、D、E 三点能否构成直角三角形。若能，直接写出所有直角三角形 CDE 的面积；若不能，请说明理由。`,
          options: [],
          answer: `BD/CE=${data.ratio}，CF=70/39；能，面积为 48/13、4、12`,
          explanation: `(1) 因为 AB=AD=${item.ab}，BC=DE=${item.bc}，且 ∠ABC=∠ADE=90°，所以 AC=AE=${data.hypotenuse}。旋转过程中 ∠BAD=∠CAE，因此 △ABD∽△ACE，故 BD/CE=AB/AC=${item.ab}/${data.hypotenuse}=${data.ratio}。\n(2) 建立坐标系：取 A(0,0)，B(3,0)，C(3,4)，则 BM 为 △ABC 的中线。设旋转角为 θ，D(3cosθ,3sinθ)。由 D 落在 BM 的延长线上可得 cosθ=7/25，sinθ=24/25，所以 D(21/25,72/25)，E(-3,4)。直线 ED 与 AC 交于 F，解得 AF/AC=25/39，因此 CF=(14/39)AC=70/39。\n(3) 用坐标表示 D、E 后，分别讨论直角在 C、D、E 三种情况。可得非退化直角三角形存在，对应面积分别为 48/13、4、12。`,
          knowledge: ["旋转", "相似三角形", "手拉手模型", "分类讨论", "几何综合"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转探究三段式",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|full-explore`,
          variationType: `rotation_similarity_full_exploration_${item.ab}_${item.bc}`,
          verification: {
            expectedAnswer: `BD/CE=${data.ratio}，CF=70/39；能，面积为 48/13、4、12`,
            expectedValues: [data.ratio, "70/39", "48/13", "4", "12"]
          }
        });
      })(),
      (() => {
        const item = { ab: 5, bc: 12, caseId: 8, cf: "3094/407", areas: ["2160/61", "48", "60"] };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `数学活动课上，同学们将两个全等的直角三角形纸片完全重合放置，固定顶点 A，然后将纸片 △ADE 绕点 A 旋转。已知 AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。\n【初步感知】\n(1) 如图1，连接 BD、CE，求 BD/CE 的值；\n【深入探究】\n(2) 如图2，当点 D 落在 △ABC 的中线 BM 的延长线上时，延长 ED 交 AC 于点 F，求 CF 的长；\n【拓展延伸】\n(3) 在旋转过程中，C、D、E 三点能否构成直角三角形？若能，直接写出所有直角三角形 CDE 的面积。`,
          options: [],
          answer: `BD/CE=${data.ratio}，CF=${item.cf}；能，面积为 ${item.areas.join("、")}`,
          explanation: `(1) AC=AE=${data.hypotenuse}，且 ∠BAD=∠CAE，所以 △ABD∽△ACE，BD/CE=AB/AC=${item.ab}/${data.hypotenuse}=${data.ratio}。\n(2) 用坐标法表示旋转后点 D、E，再由 D 在中线 BM 的延长线上确定旋转角，代入直线 ED 与 AC 的交点 F，可得 CF=${item.cf}。\n(3) 分别讨论直角在 C、D、E 三种情况，可得非退化直角三角形存在，面积分别为 ${item.areas.join("、")}。`,
          knowledge: ["旋转", "相似三角形", "手拉手模型", "分类讨论", "几何综合"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转探究三段式",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|full-explore`,
          variationType: `rotation_similarity_full_exploration_${item.ab}_${item.bc}`,
          verification: {
            expectedAnswer: `BD/CE=${data.ratio}，CF=${item.cf}；能，面积为 ${item.areas.join("、")}`,
            expectedValues: [data.ratio, item.cf, ...item.areas]
          }
        });
      })(),
      (() => {
        const item = { ab: 6, bc: 8, caseId: 9, cf: "140/39", areas: ["192/13", "16", "48"] };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，两个全等的直角三角形纸片 △ABC 和 △ADE 共顶点 A 放置，AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。固定 △ABC，将 △ADE 绕点 A 旋转。\n【问题探究】\n(1) 连接 BD、CE，求 BD/CE；\n(2) 当点 D 在 △ABC 的中线 BM 的延长线上时，延长 ED 交 AC 于 F，求 CF；\n(3) 在旋转过程中，若 △CDE 为直角三角形，直接写出 △CDE 的所有可能面积。`,
          options: [],
          answer: `BD/CE=${data.ratio}，CF=${item.cf}，面积为 ${item.areas.join("、")}`,
          explanation: `(1) AC=AE=${data.hypotenuse}，且 ∠BAD=∠CAE，所以 △ABD∽△ACE，BD/CE=AB/AC=${data.ratio}。\n(2) 建系后利用“D 在中线延长线”求出旋转角，再求 ED 与 AC 的交点，得 CF=${item.cf}。\n(3) 对 ∠C、∠D、∠E 逐一分类，满足条件的非退化情形对应面积为 ${item.areas.join("、")}。`,
          knowledge: ["旋转", "相似三角形", "手拉手模型", "分类讨论", "几何综合"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转探究三段式",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|full-explore`,
          variationType: `rotation_similarity_full_exploration_${item.ab}_${item.bc}`,
          verification: {
            expectedAnswer: `BD/CE=${data.ratio}，CF=${item.cf}，面积为 ${item.areas.join("、")}`,
            expectedValues: [data.ratio, item.cf, ...item.areas]
          }
        });
      })(),
      (() => {
        const item = { ab: 5, bc: 12, ce: 26, area: 169, caseId: 2 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，将两个全等的直角三角形纸片 △ABC 和 △ADE 共顶点 A 放置，固定 △ABC，把 △ADE 绕点 A 旋转。已知 AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。\n(1) 连接 BD、CE，证明 △ABD∽△ACE，并写出相似比；\n(2) 若 CE=${item.ce}，求 BD 的长；\n(3) 若 S△ACE=${item.area}，求 S△ABD。`,
          options: [],
          answer: `△ABD∽△ACE，相似比 ${data.ratio}，BD=10，S△ABD=25`,
          explanation: `(1) AC=AE=${data.hypotenuse}，且 ∠BAD=∠CAE，所以 △ABD∽△ACE，相似比 AB:AC=${item.ab}:${data.hypotenuse}，即 ${data.ratio}。\n(2) BD/CE=${data.ratio}，CE=${item.ce}，所以 BD=${item.ce}×${data.ratio}=10。\n(3) 相似三角形面积比等于相似比的平方，S△ABD:S△ACE=${data.areaRatio}，所以 S△ABD=${item.area}×${data.areaRatio}=25。`,
          knowledge: ["旋转", "相似三角形", "面积比", "几何综合"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转相似面积",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|ce${item.ce}`,
          variationType: "rotation_similarity_area_ratio",
          verification: {
            expectedAnswer: `△ABD∽△ACE，相似比 ${data.ratio}，BD=10，S△ABD=25`,
            expectedValues: ["△ABD∽△ACE", data.ratio, "BD=10", "S△ABD=25"]
          }
        });
      })(),
      (() => {
        const item = { ab: 6, bc: 8, ce: 15, caseId: 3 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，两个全等的直角三角形纸片 △ABC、△ADE 共顶点 A 放置，AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。固定 △ABC，将 △ADE 绕点 A 旋转。\n(1) 求 BD/CE；\n(2) 若 CE=${item.ce}，求 BD；\n(3) 当 BD 与 CE 交于 P 时，证明 ∠BPC=∠BAC。`,
          options: [],
          answer: `BD/CE=${data.ratio}，BD=9，∠BPC=∠BAC`,
          explanation: `(1) AC=AE=${data.hypotenuse}，且 ∠BAD=∠CAE，所以 △ABD∽△ACE，BD/CE=AB/AC=${item.ab}/${data.hypotenuse}=${data.ratio}。\n(2) CE=${item.ce}，所以 BD=${item.ce}×${data.ratio}=9。\n(3) 由相似得 ∠ABD=∠ACE，从而两条对应连线 BD、CE 的夹角等于 ∠BAC，即 ∠BPC=∠BAC。`,
          knowledge: ["旋转", "相似三角形", "定角"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转定角",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|angle`,
          variationType: "rotation_similarity_constant_angle",
          verification: {
            expectedAnswer: `BD/CE=${data.ratio}，BD=9，∠BPC=∠BAC`,
            expectedValues: [data.ratio, "BD=9", "∠BPC=∠BAC"]
          }
        });
      })(),
      (() => {
        const item = { ab: 3, bc: 4, caseId: 4 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，两个全等的直角三角形纸片 △ABC 和 △ADE 共顶点 A 放置，AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。固定 △ABC，把 △ADE 绕点 A 旋转。\n(1) 如图1，连接 BD、CE，求 BD/CE；\n(2) 如图2，当点 D 落在 △ABC 的中线 BM 的延长线上时，延长 ED 交 AC 于 F，求 CF 的长；\n(3) 写出求 CF 时用到的核心模型。`,
          options: [],
          answer: `BD/CE=${data.ratio}，CF=70/39，核心模型是旋转相似手拉手模型`,
          explanation: `(1) 同理可证 △ABD∽△ACE，所以 BD/CE=AB/AC=${data.ratio}。\n(2) 取 A(0,0)，B(3,0)，C(3,4)，则中点 M(3/2,2)。设旋转角为 θ，D(3cosθ,3sinθ) 落在 BM 延长线上，可得 cosθ+3/4 sinθ=1，解得 cosθ=7/25，sinθ=24/25，所以 D(21/25,72/25)，E(-3,4)。直线 ED 与 AC 交于 F，解得 AF/AC=25/39，因此 CF=(14/39)AC=70/39。\n(3) 核心是旋转相似手拉手模型：由 △ABD∽△ACE 得对应线段成比例、对应角相等。`,
          knowledge: ["旋转", "相似三角形", "中线", "坐标法"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转中线探究",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|median`,
          variationType: "rotation_similarity_median_extension",
          verification: {
            expectedAnswer: `BD/CE=${data.ratio}，CF=70/39，核心模型是旋转相似手拉手模型`,
            expectedValues: [data.ratio, "70/39", "旋转相似"]
          }
        });
      })(),
      (() => {
        const item = { ab: 8, bc: 15, bd: 16, caseId: 5 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，Rt△ABC 与 Rt△ADE 全等且共顶点 A，AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。△ADE 绕点 A 旋转，连接 BD、CE。\n(1) 判断 △ABD 与 △ACE 是否相似，并说明理由；\n(2) 若 BD=${item.bd}，求 CE；\n(3) 若 BD 与 CE 交于点 P，求证 ∠BPC 为定值。`,
          options: [],
          answer: `△ABD∽△ACE，CE=34，∠BPC=∠BAC`,
          explanation: `(1) AC=AE=${data.hypotenuse}，∠BAD=∠CAE，所以 △ABD∽△ACE。\n(2) BD/CE=AB/AC=${data.ratio}，BD=${item.bd}，所以 CE=${item.bd}÷${data.ratio}=34。\n(3) 由相似可得对应角相等，所以 BD 与 CE 的夹角等于 ∠BAC，故 ∠BPC 为定值。`,
          knowledge: ["旋转", "相似三角形", "定角"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转相似定角",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|fixed-angle`,
          variationType: "rotation_similarity_reasoning",
          verification: {
            expectedAnswer: `△ABD∽△ACE，CE=34，∠BPC=∠BAC`,
            expectedValues: ["△ABD∽△ACE", "CE=34", "∠BPC=∠BAC"]
          }
        });
      })(),
      (() => {
        const item = { ab: 7, bc: 24, area: 49, caseId: 6 };
        const data = shared(item);
        return variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: `如图，两个全等直角三角形 △ABC 和 △ADE 共顶点 A 放置，AB=AD=${item.ab}，BC=DE=${item.bc}，∠ABC=∠ADE=90°。固定 △ABC，旋转 △ADE。\n(1) 证明 △ABD∽△ACE；\n(2) 写出 S△ABD:S△ACE；\n(3) 若 S△ABD=${item.area}，求 S△ACE。`,
          options: [],
          answer: `△ABD∽△ACE，S△ABD:S△ACE=${data.areaRatio}，S△ACE=625`,
          explanation: `(1) 因为 AC=AE=${data.hypotenuse}，且 ∠BAD=∠CAE，所以 △ABD∽△ACE。\n(2) 相似比 AB:AC=${data.ratio}，面积比为相似比的平方，因此 S△ABD:S△ACE=${data.areaRatio}。\n(3) S△ACE=${item.area}÷${data.areaRatio}=625。`,
          knowledge: ["旋转", "相似三角形", "面积比"],
          diagramSpec: makeRotationCongruenceComprehensiveDiagramSpec(item.caseId),
          imageNote: "系统模板：旋转相似面积比",
          templateCaseId: `rotation_similarity|${item.ab}|${item.bc}|area`,
          variationType: "rotation_similarity_area",
          verification: {
            expectedAnswer: `△ABD∽△ACE，S△ABD:S△ACE=${data.areaRatio}，S△ACE=625`,
            expectedValues: ["△ABD∽△ACE", data.areaRatio, "625"]
          }
        });
      })()
    ];
    variants.push(...cases);
  } else if (template === "transformation_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，△ABC 向右平移 4 个单位得到 △A'B'C'。若点 A 的坐标为 (1,2)，则点 A' 的坐标是（ ）",
        options: choiceOptions(["(5,2)", "(1,6)", "(-3,2)", "(5,6)"]),
        answer: "A",
        explanation: "向右平移 4 个单位，横坐标加 4，纵坐标不变，所以 A'(1+4,2)，即 A'(5,2)。",
        knowledge: ["几何"],
        diagramSpec: makeTransformationDiagramSpec("translation"),
        imageNote: "系统模板：平移变换",
        verification: { expectedAnswer: "A", expectedOption: "(5,2)", expectedValue: "(5,2)" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，△ABC 与 △A'B'C' 关于直线 l 成轴对称。若 AB=6，则 A'B' 的长为（ ）",
        options: choiceOptions(["3", "6", "9", "12"]),
        answer: "B",
        explanation: "轴对称变换保持对应线段长度不变，所以 A'B'=AB=6。",
        knowledge: ["几何"],
        diagramSpec: makeTransformationDiagramSpec("symmetry"),
        imageNote: "系统模板：轴对称",
        verification: { expectedAnswer: "B", expectedOption: "6", expectedValue: "6" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，△ABC 绕点 O 旋转得到 △A'B'C'。下列结论一定正确的是（ ）",
        options: choiceOptions(["OA=OA'", "AB∥A'B'", "∠A=90°", "AC⊥A'C'"]),
        answer: "A",
        explanation: "旋转变换保持点到旋转中心的距离不变，因此 OA=OA'。",
        knowledge: ["几何"],
        diagramSpec: makeTransformationDiagramSpec("rotation"),
        imageNote: "系统模板：旋转变换",
        verification: { expectedAnswer: "A", expectedOption: "OA=OA'", expectedValue: "OA=OA'" }
      })
    );
  } else if (template === "real_number_estimation_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "估算 √20 的值在哪两个连续整数之间（ ）",
        options: choiceOptions(["3 和 4", "4 和 5", "5 和 6", "6 和 7"]),
        answer: "B",
        explanation: "因为 4²=16，5²=25，且 16<20<25，所以 4<√20<5。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "4 和 5", expectedValue: "4 和 5", expectedValues: ["4<√20<5"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "下列各数中，与 √50 最接近的是（ ）",
        options: choiceOptions(["6", "7", "8", "9"]),
        answer: "B",
        explanation: "√50≈7.07，最接近的整数是 7。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "7", expectedValue: "7" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "若 n<√37<n+1，且 n 为整数，则 n 的值为（ ）",
        options: choiceOptions(["5", "6", "7", "8"]),
        answer: "B",
        explanation: "因为 6²=36，7²=49，且 36<37<49，所以 6<√37<7，n=6。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "6", expectedValue: "6" }
      })
    );
  } else if (template === "construction_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，用尺规作线段 AB 的垂直平分线，作图中两个等半径圆弧的交点为 P、Q。下列结论正确的是（ ）",
        options: choiceOptions(["PQ⊥AB 且 AO=BO", "PQ∥AB", "AP=AB", "∠A=∠B"]),
        answer: "A",
        explanation: "尺规作线段垂直平分线时，连接两组等半径圆弧交点 P、Q，所得直线 PQ 垂直平分 AB，所以 PQ⊥AB 且 AO=BO。",
        knowledge: ["几何"],
        diagramSpec: makeConstructionDiagramSpec("perpendicular_bisector"),
        imageNote: "系统模板：尺规作垂直平分线",
        verification: { expectedAnswer: "A", expectedOption: "PQ⊥AB 且 AO=BO", expectedValue: "PQ⊥AB", expectedValues: ["PQ⊥AB", "AO=BO"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，点 P 在 ∠AOB 的角平分线上，PM⊥OA，PN⊥OB。尺规作角平分线的依据是（ ）",
        options: choiceOptions(["到角两边距离相等的点在角平分线上", "两点确定一条直线", "同位角相等", "垂线段最短"]),
        answer: "A",
        explanation: "角平分线上的点到角两边的距离相等，反过来到角两边距离相等的点在角平分线上，这是作角平分线的依据。",
        knowledge: ["几何"],
        diagramSpec: makeConstructionDiagramSpec("angle_bisector"),
        imageNote: "系统模板：尺规作角平分线",
        verification: { expectedAnswer: "A", expectedOption: "到角两边距离相等的点在角平分线上", expectedValue: "到角两边距离相等" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，已作出线段 AB 的垂直平分线 PQ。若 AP=7，则 BP 的长为（ ）",
        options: choiceOptions(["3.5", "7", "14", "无法确定"]),
        answer: "B",
        explanation: "垂直平分线上的点到线段两端点的距离相等，所以 AP=BP。已知 AP=7，因此 BP=7。",
        knowledge: ["几何"],
        diagramSpec: makeConstructionDiagramSpec("perpendicular_bisector"),
        imageNote: "系统模板：垂直平分线性质",
        verification: { expectedAnswer: "B", expectedOption: "7", expectedValue: "7" }
      })
    );
  } else if (template === "similar_comprehensive_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，DE∥BC，D、E 分别在 AB、AC 上，AD:AB=2:5，BC=20。\n(1) 求 DE 的长；\n(2) 若 S△ADE=12，求 S△ABC。",
        options: [],
        answer: "DE=8，S△ABC=75",
        explanation: "(1) 因为 DE∥BC，所以 △ADE∽△ABC，相似比 AD:AB=2:5，故 DE:BC=2:5，DE=20×2/5=8。\n(2) 相似三角形面积比等于相似比的平方，所以 S△ADE:S△ABC=4:25。S△ABC=12×25/4=75。",
        knowledge: ["几何"],
        diagramSpec: makeSimilarComprehensiveDiagramSpec(),
        imageNote: "系统模板：相似综合",
        verification: { expectedAnswer: "DE=8，S△ABC=75", expectedValues: ["8", "75"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，DE∥BC，AD=3，DB=6，DE=5。\n(1) 证明 △ADE∽△ABC；\n(2) 求 BC 的长。",
        options: [],
        answer: "△ADE∽△ABC，BC=15",
        explanation: "(1) 因为 DE∥BC，所以对应角相等，△ADE∽△ABC。\n(2) AB=AD+DB=9，相似比 AD:AB=3:9=1:3，所以 DE:BC=1:3，BC=15。",
        knowledge: ["几何"],
        diagramSpec: makeSimilarComprehensiveDiagramSpec(),
        imageNote: "系统模板：相似综合",
        verification: { expectedAnswer: "△ADE∽△ABC，BC=15", expectedValues: ["△ADE∽△ABC", "15"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，△ADE∽△ABC，且 AD/AB=3/4，S△ABC=64。\n求 S△ADE。",
        options: [],
        answer: "S△ADE=36",
        explanation: "相似三角形面积比等于相似比的平方。AD/AB=3/4，所以 S△ADE:S△ABC=9:16，S△ADE=64×9/16=36。",
        knowledge: ["几何"],
        diagramSpec: makeSimilarComprehensiveDiagramSpec(),
        imageNote: "系统模板：相似面积比",
        verification: { expectedAnswer: "S△ADE=36", expectedValues: ["36"] }
      })
    );
  } else if (template === "circle_comprehensive_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，PA 是 ⊙O 的切线，A 为切点，OA=6，OP=10。\n(1) 证明 OA⊥PA；\n(2) 求 PA 的长。",
        options: [],
        answer: "OA⊥PA，PA=8",
        explanation: "(1) 圆的切线垂直于过切点的半径，所以 OA⊥PA。\n(2) 在 Rt△OAP 中，PA=√(OP²-OA²)=√(10²-6²)=8。",
        knowledge: ["几何"],
        diagramSpec: makeCircleComprehensiveDiagramSpec(),
        imageNote: "系统模板：圆综合",
        verification: { expectedAnswer: "OA⊥PA，PA=8", expectedValues: ["OA⊥PA", "8"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，AB 是 ⊙O 的直径，点 C 在圆上，连接 AC、BC。\n(1) 求证 ∠ACB=90°；\n(2) 若 AC=6，BC=8，求 AB 的长。",
        options: [],
        answer: "∠ACB=90°，AB=10",
        explanation: "(1) 直径所对的圆周角是直角，所以 ∠ACB=90°。\n(2) 在 Rt△ABC 中，AB 为斜边，AB=√(6²+8²)=10。",
        knowledge: ["几何"],
        diagramSpec: makeCircleAngleDiagramSpec(),
        imageNote: "系统模板：圆综合",
        verification: { expectedAnswer: "∠ACB=90°，AB=10", expectedValues: ["∠ACB=90°", "10"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，∠ACB 和 ∠ADB 都对同一条弧 AB，且 ∠ACB=42°。\n(1) 求 ∠ADB；\n(2) 若圆心角 ∠AOB 对同一条弧 AB，求 ∠AOB。",
        options: [],
        answer: "∠ADB=42°，∠AOB=84°",
        explanation: "(1) 同弧所对的圆周角相等，所以 ∠ADB=∠ACB=42°。\n(2) 同弧所对的圆心角等于圆周角的 2 倍，所以 ∠AOB=84°。",
        knowledge: ["几何"],
        diagramSpec: makeCircleAngleDiagramSpec(),
        imageNote: "系统模板：圆综合",
        verification: { expectedAnswer: "∠ADB=42°，∠AOB=84°", expectedValues: ["42°", "84°"] }
      })
    );
  } else if (template === "quadratic_piecewise_text") {
    if (isQuadraticParabolaComprehensiveProblem([question.stem, question.imageNote].filter(Boolean).join("\n"))) {
      variants.push(...makeParabolaComprehensiveTemplateVariants(question, base));
    } else {
      variants.push(...makeQuadraticPiecewiseTemplateVariants(question, base));
      variants.push(
        variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: "如图，抛物线 y=-(x-2)²+4 与 x 轴交于 A、B 两点，顶点为 P。\n(1) 求 A、B、P 的坐标；\n(2) 求 △PAB 的面积。",
          options: [],
          answer: "A(0,0)，B(4,0)，P(2,4)，S△PAB=8",
          explanation: "(1) 令 y=0，得 (x-2)²=4，所以 x=0 或 x=4，A(0,0)，B(4,0)。由顶点式可得 P(2,4)。\n(2) AB=4，点 P 到 x 轴的距离为 4，所以 S△PAB=1/2×4×4=8。",
          knowledge: ["函数", "几何"],
          diagramSpec: makeQuadraticPiecewiseDiagramSpec(),
          imageNote: "系统模板：二次函数压轴",
          verification: { expectedAnswer: "A(0,0)，B(4,0)，P(2,4)，S△PAB=8", expectedValues: ["A(0,0)", "B(4,0)", "P(2,4)", "8"] }
        }),
        variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: "如图，抛物线 y=-(x-2)²+4 与 x 轴交于 A、B 两点。点 M(m,0) 在线段 AB 上，过 M 作 x 轴的垂线交抛物线于点 N。\n(1) 写出 MN 关于 m 的函数表达式；\n(2) 求 MN 的最大值。",
          options: [],
          answer: "MN=-(m-2)²+4，最大值为 4",
          explanation: "(1) 点 N 在抛物线 y=-(x-2)²+4 上，且横坐标为 m，所以 MN=-(m-2)²+4。\n(2) 该二次函数开口向下，顶点为 (2,4)，因此 MN 的最大值为 4。",
          knowledge: ["函数", "几何"],
          diagramSpec: makeQuadraticPiecewiseDiagramSpec(),
          imageNote: "系统模板：二次函数线段最值",
          verification: { expectedAnswer: "MN=-(m-2)²+4，最大值为 4", expectedValues: ["MN=-(m-2)²+4", "4"] }
        }),
        variantDefaults(question, {
          ...base,
          type: "解答题",
          stem: "如图，抛物线 y=-x²+4x 与 x 轴交于 A、B 两点。点 P(t,-t²+4t) 在抛物线上，且 0<t<4。\n(1) 求 AB 的长；\n(2) 用 t 表示 △PAB 的面积 S，并求 S 的最大值。",
          options: [],
          answer: "AB=4，S=-2t²+8t，S最大值为8",
          explanation: "(1) 令 y=0，得 -x²+4x=0，x=0 或 x=4，所以 AB=4。\n(2) 点 P 到 x 轴的距离为 -t²+4t，所以 S=1/2×4×(-t²+4t)=-2t²+8t=-2(t-2)²+8，最大值为 8。",
          knowledge: ["函数", "几何"],
          diagramSpec: makeQuadraticPiecewiseDiagramSpec(),
          imageNote: "系统模板：二次函数面积函数",
          verification: { expectedAnswer: "AB=4，S=-2t²+8t，S最大值为8", expectedValues: ["AB=4", "S=-2t²+8t", "8"] }
        })
      );
    }
  } else if (template === "circle_similarity_comprehensive_text") {
    variants.push(...makeCircleSimilarityTemplateVariants(question, base));
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，PA 是 ⊙O 的切线，PBC 是割线，A、B、C 在圆上，且 PA=6，PB=4。\n(1) 说明 △PAB 与 △PCA 相似；\n(2) 求 PC 的长。",
        options: [],
        answer: "△PAB∽△PCA，PC=9",
        explanation: "(1) 切线弦定理可得对应角相等，又 ∠P 为公共角，所以 △PAB∽△PCA。\n(2) 由切割线定理 PA²=PB·PC，得 6²=4·PC，所以 PC=9。",
        knowledge: ["几何"],
        diagramSpec: makeCircleSimilarityDiagramSpec(),
        imageNote: "系统模板：圆与相似综合",
        verification: { expectedAnswer: "△PAB∽△PCA，PC=9", expectedValues: ["△PAB∽△PCA", "9"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，PA、PB 是 ⊙O 的两条切线，A、B 为切点，连接 AB、OP。\n(1) 求证 △OAP≌△OBP；\n(2) 若 OA=5，OP=13，求 PA 的长。",
        options: [],
        answer: "△OAP≌△OBP，PA=12",
        explanation: "(1) OA⊥PA，OB⊥PB，OA=OB，OP 为公共边，所以 Rt△OAP≌Rt△OBP（HL）。\n(2) 在 Rt△OAP 中，PA=√(OP²-OA²)=√(13²-5²)=12。",
        knowledge: ["几何"],
        diagramSpec: makeCircleComprehensiveDiagramSpec(),
        imageNote: "系统模板：圆切线与全等",
        verification: { expectedAnswer: "△OAP≌△OBP，PA=12", expectedValues: ["△OAP≌△OBP", "12"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，AB 是 ⊙O 的弦，点 P 在圆外，P-A-B 共线，PC 为切线，C 为切点。若 PA=3，PB=12。\n求 PC 的长。",
        options: [],
        answer: "PC=6",
        explanation: "由切割线定理，PC²=PA·PB=3×12=36，所以 PC=6。",
        knowledge: ["几何"],
        diagramSpec: makeCircleSimilarityDiagramSpec(),
        imageNote: "系统模板：圆与相似切割线",
        verification: { expectedAnswer: "PC=6", expectedValues: ["6"] }
      })
    );
  } else if (template === "moving_point_area_function_text") {
    variants.push(...makeMovingPointAreaTemplateVariants(question, base));
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，点 P 在线段 AB 上运动，AB=12，AP=x。以 PB 为底、6 为高作矩形 PBCD。\n(1) 用 x 表示矩形 PBCD 的面积 S；\n(2) 当 x=5 时，求 S。",
        options: [],
        answer: "S=72-6x，x=5 时 S=42",
        explanation: "(1) PB=12-x，矩形高为 6，所以 S=6(12-x)=72-6x。\n(2) 当 x=5 时，S=72-6×5=42。",
        knowledge: ["函数", "几何"],
        diagramSpec: makeMovingPointAreaDiagramSpec(),
        imageNote: "系统模板：动点面积函数",
        verification: { expectedAnswer: "S=72-6x，x=5 时 S=42", expectedValues: ["S=72-6x", "42"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，点 P 在线段 AB 上运动，AB=10，AP=x，PB=10-x。若以 AP、PB 为邻边构造矩形，面积为 S。\n(1) 写出 S 关于 x 的表达式；\n(2) 求 S 的最大值。",
        options: [],
        answer: "S=x(10-x)，最大值为25",
        explanation: "(1) 矩形面积 S=AP·PB=x(10-x)。\n(2) S=x(10-x)=-(x-5)²+25，所以当 x=5 时，S 最大为 25。",
        knowledge: ["函数", "几何"],
        diagramSpec: makeMovingPointSegmentDiagramSpec(),
        imageNote: "系统模板：动点面积最值",
        verification: { expectedAnswer: "S=x(10-x)，最大值为25", expectedValues: ["S=x(10-x)", "25"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，点 P 从 A 向 B 运动，AB=16，AP=2t。以 AP 为底、5 为高的三角形面积为 S。\n(1) 用 t 表示 S；\n(2) 当 t=3 时，求 S。",
        options: [],
        answer: "S=5t，t=3 时 S=15",
        explanation: "(1) 三角形面积 S=1/2×AP×高=1/2×2t×5=5t。\n(2) 当 t=3 时，S=5×3=15。",
        knowledge: ["函数", "几何"],
        diagramSpec: makeMovingPointAreaDiagramSpec(),
        imageNote: "系统模板：动点面积函数",
        verification: { expectedAnswer: "S=5t，t=3 时 S=15", expectedValues: ["S=5t", "15"] }
      })
    );
  } else if (template === "geometry_extremum_text") {
    variants.push(...makeGeometryExtremumTemplateVariants(question, base));
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，点 A、B 在直线 l 的同侧，点 P 在直线 l 上运动。要使 PA+PB 最小，应作点 A 关于直线 l 的对称点 A'，连接 A'B 交 l 于 P。此时最小值等于（ ）",
        options: choiceOptions(["AB", "A'B", "AA'", "PB"]),
        answer: "B",
        explanation: "由轴对称可知 PA=PA'，所以 PA+PB=PA'+PB。当 A'、P、B 三点共线时，PA'+PB 最小，最小值为 A'B。",
        knowledge: ["几何"],
        diagramSpec: makeGeometryExtremumDiagramSpec(),
        imageNote: "系统模板：几何最值",
        verification: { expectedAnswer: "B", expectedOption: "A'B", expectedValue: "A'B" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "在直线 l 外有一点 A，点 P 在直线 l 上运动，PA 的最小值是（ ）",
        options: choiceOptions(["过 A 作 l 的垂线段长度", "任意连接 AP 的长度", "A 到 l 上任一点的距离", "直线 l 的长度"]),
        answer: "A",
        explanation: "点到直线的所有连线中，垂线段最短，所以 PA 的最小值是点 A 到直线 l 的垂线段长度。",
        knowledge: ["几何"],
        diagramSpec: makeGeometryExtremumDiagramSpec(),
        imageNote: "系统模板：点到直线最短",
        verification: { expectedAnswer: "A", expectedOption: "过 A 作 l 的垂线段长度", expectedValue: "垂线段长度" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，点 A、B 在直线 l 的两侧，点 P 在直线 l 上运动。要使 PA+PB 最小，点 P 应满足（ ）",
        options: choiceOptions(["A、P、B 三点共线", "AP⊥l", "BP⊥l", "P 为任意点"]),
        answer: "A",
        explanation: "两点之间线段最短。当 A、P、B 三点共线且 P 在直线 l 上时，PA+PB=AB，取得最小值。",
        knowledge: ["几何"],
        diagramSpec: makeGeometryExtremumDiagramSpec(),
        imageNote: "系统模板：折线路径最短",
        verification: { expectedAnswer: "A", expectedOption: "A、P、B 三点共线", expectedValue: "A、P、B 三点共线" }
      })
    );
  } else if (template === "probability_tree_list_text") {
    variants.push(...makeProbabilityTreeListTemplateVariants(question, base));
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "一个袋中有 1 个红球和 1 个白球，放回地摸两次。两次都摸到红球的概率是（ ）",
        options: choiceOptions(["1/4", "1/2", "3/4", "1"]),
        answer: "A",
        explanation: "用树状图列出所有等可能结果：红红、红白、白红、白白，共 4 种，其中两次都红只有 1 种，所以概率为 1/4。",
        knowledge: ["概率"],
        diagramSpec: makeProbabilityTreeDiagramSpec(),
        imageNote: "系统模板：概率树状图",
        verification: { expectedAnswer: "A", expectedOption: "1/4", expectedValue: "1/4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "从数字 1、2、3 中随机选一个，再从数字 1、2 中随机选一个。两数之和为 4 的概率是（ ）",
        options: choiceOptions(["1/6", "1/3", "1/2", "2/3"]),
        answer: "B",
        explanation: "列表可得共有 3×2=6 种等可能结果，和为 4 的有 (2,2)、(3,1) 两种，所以概率为 2/6=1/3。",
        knowledge: ["概率"],
        diagramSpec: makeProbabilityTreeDiagramSpec(),
        imageNote: "系统模板：列表法概率",
        verification: { expectedAnswer: "B", expectedOption: "1/3", expectedValue: "1/3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "同时抛掷两枚质地均匀的硬币，恰好出现一正一反的概率是（ ）",
        options: choiceOptions(["1/4", "1/3", "1/2", "3/4"]),
        answer: "C",
        explanation: "所有等可能结果为正正、正反、反正、反反，共 4 种；一正一反有 2 种，所以概率为 2/4=1/2。",
        knowledge: ["概率"],
        diagramSpec: makeProbabilityTreeDiagramSpec(),
        imageNote: "系统模板：树状图概率",
        verification: { expectedAnswer: "C", expectedOption: "1/2", expectedValue: "1/2" }
      })
    );
  } else if (template === "travel_distance_time_graph") {
    variants.push(...makeTravelDistanceTimeGraphTemplateVariants(question, base));
  } else if (template === "linear_function_application_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "某地出租车起步价为 8 元，超过 3 km 后每千米加收 2 元。若行驶 7 km，则车费为（ ）",
        options: choiceOptions(["12 元", "14 元", "16 元", "18 元"]),
        answer: "C",
        explanation: "7 km 超过起步里程 3 km 的部分是 4 km，车费为 8+2×4=16 元。",
        knowledge: ["函数"],
        verification: { expectedAnswer: "C", expectedOption: "16 元", expectedValue: "16" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某水站收费 y 与用水量 x 的关系为 y=3x+5。当 x=10 时，应缴水费为（ ）",
        options: choiceOptions(["25 元", "30 元", "35 元", "40 元"]),
        answer: "C",
        explanation: "把 x=10 代入 y=3x+5，得 y=3×10+5=35，所以应缴 35 元。",
        knowledge: ["函数"],
        verification: { expectedAnswer: "C", expectedOption: "35 元", expectedValue: "35" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一次函数的图象经过点 (0,2) 和 (4,10)，则这个一次函数的表达式是（ ）",
        options: choiceOptions(["y=2x+2", "y=2x-2", "y=4x+2", "y=x+6"]),
        answer: "A",
        explanation: "设 y=kx+b。由点 (0,2) 得 b=2；由点 (4,10) 得 10=4k+2，解得 k=2，所以 y=2x+2。",
        knowledge: ["函数"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, xMin: -1, xMax: 5, yMin: -1, yMax: 11, k: 2, b: 2, points: [{ name: "A", x: 0, y: 2 }, { name: "B", x: 4, y: 10 }] },
        imageNote: "系统模板：一次函数应用",
        verification: { expectedAnswer: "A", expectedOption: "y=2x+2", expectedValue: "y=2x+2" }
      })
    );
  } else if (template === "sales_application_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "某商品进价为 80 元，按 25% 的利润率定价，则定价为（ ）",
        options: choiceOptions(["90 元", "100 元", "105 元", "120 元"]),
        answer: "B",
        explanation: "定价=进价×(1+利润率)=80×(1+25%)=100 元。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "100 元", expectedValue: "100" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一件商品原价 240 元，打八折出售，售价为（ ）",
        options: choiceOptions(["180 元", "188 元", "192 元", "200 元"]),
        answer: "C",
        explanation: "打八折表示按原价的 80% 出售，售价为 240×80%=192 元。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "C", expectedOption: "192 元", expectedValue: "192" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某商品进价 120 元，售价 150 元，则利润率是（ ）",
        options: choiceOptions(["20%", "25%", "30%", "40%"]),
        answer: "B",
        explanation: "利润为 150-120=30 元，利润率=利润÷进价=30÷120=25%。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "25%", expectedValue: "25%" }
      })
    );
  } else if (template === "travel_application_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "甲、乙两地相距 180 km，一辆汽车以 60 km/h 的速度从甲地开往乙地，需要（ ）",
        options: choiceOptions(["2 h", "3 h", "4 h", "5 h"]),
        answer: "B",
        explanation: "时间=路程÷速度=180÷60=3 h。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "3 h", expectedValue: "3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "甲、乙两人从相距 120 km 的两地同时相向而行，甲速 35 km/h，乙速 25 km/h，则相遇时间是（ ）",
        options: choiceOptions(["1 h", "2 h", "3 h", "4 h"]),
        answer: "B",
        explanation: "相向而行时速度和为 35+25=60 km/h，相遇时间=120÷60=2 h。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "2 h", expectedValue: "2" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "甲车每小时行 70 km，乙车每小时行 50 km。甲车从后方追乙车，两车相距 40 km，则甲车追上乙车需要（ ）",
        options: choiceOptions(["1 h", "2 h", "3 h", "4 h"]),
        answer: "B",
        explanation: "追及速度差为 70-50=20 km/h，追及时间=40÷20=2 h。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "2 h", expectedValue: "2" }
      })
    );
  } else if (template === "work_application_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "甲单独完成一项工程需 6 天，乙单独完成需 12 天。两人合作完成这项工程需（ ）",
        options: choiceOptions(["3 天", "4 天", "6 天", "9 天"]),
        answer: "B",
        explanation: "甲效率为 1/6，乙效率为 1/12，合作效率为 1/6+1/12=1/4，所以合作完成需 4 天。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "4 天", expectedValue: "4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "甲、乙合作 6 天完成一项工程，甲单独完成需 10 天。乙单独完成需（ ）",
        options: choiceOptions(["12 天", "15 天", "18 天", "20 天"]),
        answer: "B",
        explanation: "合作效率为 1/6，甲效率为 1/10，乙效率为 1/6-1/10=1/15，所以乙单独完成需 15 天。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "15 天", expectedValue: "15" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一项工作，甲每天完成 1/8，乙每天完成 1/12。两人合作 3 天后，还剩这项工作的（ ）",
        options: choiceOptions(["1/8", "1/4", "3/8", "1/2"]),
        answer: "C",
        explanation: "两人每天共完成 1/8+1/12=5/24，3 天完成 15/24=5/8，还剩 1-5/8=3/8。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "3/8", expectedValue: "3/8" }
      })
    );
  } else if (template === "statistics_calculation_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，甲、乙、丙三组人数分别为 8、12、16 人，则这三组人数的平均数是（ ）",
        options: choiceOptions(["10", "12", "14", "16"]),
        answer: "B",
        explanation: "平均数为 (8+12+16)/3=36/3=12。",
        knowledge: ["统计"],
        diagramSpec: { type: "statistics", template: "bar_basic", width: 420, height: 280, bars: [{ label: "甲", value: 8 }, { label: "乙", value: 12 }, { label: "丙", value: 16 }] },
        imageNote: "系统模板：统计图计算",
        verification: { expectedAnswer: "B", expectedOption: "12", expectedValue: "12" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，四个小组完成题数分别为 10、15、20、15，则这组数据的众数是（ ）",
        options: choiceOptions(["10", "15", "20", "25"]),
        answer: "B",
        explanation: "数据 10、15、20、15 中，15 出现 2 次，次数最多，所以众数是 15。",
        knowledge: ["统计"],
        diagramSpec: { type: "statistics", template: "bar_basic", width: 420, height: 280, bars: [{ label: "一组", value: 10 }, { label: "二组", value: 15 }, { label: "三组", value: 20 }, { label: "四组", value: 15 }] },
        imageNote: "系统模板：统计图计算",
        verification: { expectedAnswer: "B", expectedOption: "15", expectedValue: "15" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某班 40 名学生参加调查，其中喜欢篮球的有 12 人。喜欢篮球的人数所占百分比是（ ）",
        options: choiceOptions(["20%", "25%", "30%", "40%"]),
        answer: "C",
        explanation: "喜欢篮球的人数占 12/40=0.3=30%。",
        knowledge: ["统计"],
        verification: { expectedAnswer: "C", expectedOption: "30%", expectedValue: "30%" }
      })
    );
  } else if (template === "congruent_triangles_proof_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，AB=AC，D 是 BC 的中点，连接 AD。\n(1) 证明 △ABD≌△ACD；\n(2) 求证 AD 平分 ∠BAC。",
        options: [],
        answer: "△ABD≌△ACD，∠BAD=∠CAD",
        explanation: "(1) 因为 AB=AC，D 是 BC 的中点，所以 BD=CD，又 AD 是公共边，所以 △ABD≌△ACD（SSS）。\n(2) 由全等三角形对应角相等，得 ∠BAD=∠CAD，所以 AD 平分 ∠BAC。",
        knowledge: ["几何"],
        diagramSpec: makeCongruentTrianglesDiagramSpec("shared_side"),
        imageNote: "系统模板：全等三角形证明",
        verification: { expectedAnswer: "△ABD≌△ACD，∠BAD=∠CAD", expectedValues: ["△ABD≌△ACD", "∠BAD=∠CAD"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，已知 AB=DE，AC=DF，∠BAC=∠EDF。\n求证：△ABC≌△DEF。",
        options: [],
        answer: "△ABC≌△DEF",
        explanation: "在 △ABC 和 △DEF 中，AB=DE，∠BAC=∠EDF，AC=DF，满足两边及其夹角分别相等，所以 △ABC≌△DEF（SAS）。",
        knowledge: ["几何"],
        diagramSpec: makeCongruentTrianglesDiagramSpec("two_triangles"),
        imageNote: "系统模板：全等三角形 SAS",
        verification: { expectedAnswer: "△ABC≌△DEF", expectedValues: ["△ABC≌△DEF", "SAS"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 Rt△ABC 和 Rt△DEF 中，∠C=∠F=90°，AB=DE，AC=DF。\n求证：Rt△ABC≌Rt△DEF。",
        options: [],
        answer: "Rt△ABC≌Rt△DEF",
        explanation: "因为 ∠C=∠F=90°，AB、DE 分别为斜边，且 AB=DE，AC=DF，所以两个直角三角形的斜边和一条直角边分别相等，Rt△ABC≌Rt△DEF（HL）。",
        knowledge: ["几何"],
        diagramSpec: makeCongruentTrianglesDiagramSpec("two_triangles"),
        imageNote: "系统模板：直角三角形全等",
        verification: { expectedAnswer: "Rt△ABC≌Rt△DEF", expectedValues: ["Rt△ABC≌Rt△DEF", "HL"] }
      })
    );
  } else if (template === "angle_bisector_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，在 △ABC 中，AD 平分 ∠BAC，若 ∠BAC=64°，则 ∠BAD 的度数是（ ）",
        options: choiceOptions(["24°", "30°", "32°", "64°"]),
        answer: "C",
        explanation: "AD 平分 ∠BAC，所以 ∠BAD=1/2∠BAC=1/2×64°=32°。",
        knowledge: ["几何"],
        diagramSpec: { type: "geometry", template: "triangle_basic", width: 420, height: 280, showBisector: true },
        imageNote: "系统模板：角平分线计算",
        verification: { expectedAnswer: "C", expectedOption: "32°", expectedValue: "32°" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，OP 平分 ∠AOB，PM⊥OA，PN⊥OB，垂足分别为 M、N。若 PM=5，则 PN 的长为（ ）",
        options: choiceOptions(["3", "4", "5", "10"]),
        answer: "C",
        explanation: "角平分线上的点到角两边的距离相等。因为 OP 平分 ∠AOB，PM⊥OA，PN⊥OB，所以 PN=PM=5。",
        knowledge: ["几何"],
        diagramSpec: makeAngleBisectorDiagramSpec(),
        imageNote: "系统模板：角平分线距离",
        verification: { expectedAnswer: "C", expectedOption: "5", expectedValue: "5" }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，AB=AC，AD 平分 ∠BAC，交 BC 于点 D。\n求证：BD=CD。",
        options: [],
        answer: "BD=CD",
        explanation: "因为 AD 平分 ∠BAC，所以 ∠BAD=∠CAD。又 AB=AC，AD 为公共边，所以 △ABD≌△ACD（SAS）。由全等三角形对应边相等，得 BD=CD。",
        knowledge: ["几何"],
        diagramSpec: { type: "geometry", template: "triangle_basic", width: 420, height: 280, showBisector: true },
        imageNote: "系统模板：角平分线与全等",
        verification: { expectedAnswer: "BD=CD", expectedValues: ["BD=CD", "△ABD≌△ACD"] }
      })
    );
  } else if (template === "moving_point_extremum_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，点 P 在线段 AB 上运动，AB=10，设 AP=x，PB=10-x。若 S=AP·PB，则 S 的最大值是（ ）",
        options: choiceOptions(["20", "24", "25", "30"]),
        answer: "C",
        explanation: "S=x(10-x)=-(x-5)²+25，所以当 x=5 时，S 取得最大值 25。",
        knowledge: ["函数"],
        diagramSpec: makeMovingPointSegmentDiagramSpec(),
        imageNote: "系统模板：动点最值",
        verification: { expectedAnswer: "C", expectedOption: "25", expectedValue: "25", expectedValues: ["x=5", "25"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某动点问题中，面积 S 与时间 t 的关系为 S=-2(t-3)²+18，则 S 的最大值是（ ）",
        options: choiceOptions(["12", "16", "18", "20"]),
        answer: "C",
        explanation: "S=-2(t-3)²+18，二次项系数小于 0，开口向下。当 t=3 时，S 取得最大值 18。",
        knowledge: ["函数"],
        diagramSpec: makeMovingPointSegmentDiagramSpec(),
        imageNote: "系统模板：动点最值",
        verification: { expectedAnswer: "C", expectedOption: "18", expectedValue: "18", expectedValues: ["t=3", "18"] }
      }),
      variantDefaults(question, {
        ...base,
        stem: "用 12 m 长的篱笆靠墙围成一个矩形，设垂直于墙的一边长为 x m，则面积 S=x(12-2x)。面积 S 的最大值是（ ）",
        options: choiceOptions(["16 m²", "18 m²", "24 m²", "36 m²"]),
        answer: "B",
        explanation: "S=x(12-2x)=-2x²+12x=-2(x-3)²+18，所以当 x=3 时，S 取得最大值 18 m²。",
        knowledge: ["函数"],
        diagramSpec: makeMovingPointSegmentDiagramSpec(),
        imageNote: "系统模板：动点最值",
        verification: { expectedAnswer: "B", expectedOption: "18 m²", expectedValue: "18", expectedValues: ["x=3", "18"] }
      })
    );
  } else if (template === "function_geometry_comprehensive_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，直线 y=x+2 与 x 轴交于点 A，与 y 轴交于点 B。\n(1) 求 A、B 两点的坐标；\n(2) 求 △AOB 的面积。",
        options: [],
        answer: "A(-2,0)，B(0,2)，S△AOB=2",
        explanation: "(1) 令 y=0，得 x=-2，所以 A(-2,0)；令 x=0，得 y=2，所以 B(0,2)。\n(2) OA=2，OB=2，且 OA⊥OB，所以 S△AOB=1/2×2×2=2。",
        knowledge: ["函数", "几何"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, xMin: -4, xMax: 4, yMin: -1, yMax: 5, k: 1, b: 2, points: [{ name: "A", x: -2, y: 0 }, { name: "B", x: 0, y: 2 }] },
        imageNote: "系统模板：函数几何综合",
        verification: { expectedAnswer: "A(-2,0)，B(0,2)，S△AOB=2", expectedValues: ["A(-2,0)", "B(0,2)", "2"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，直线 y=-2x+6 与坐标轴分别交于 A、B 两点，其中 A 在 x 轴上，B 在 y 轴上。\n(1) 求 A、B 的坐标；\n(2) 求 △AOB 的面积。",
        options: [],
        answer: "A(3,0)，B(0,6)，S△AOB=9",
        explanation: "(1) 令 y=0，得 -2x+6=0，x=3，所以 A(3,0)；令 x=0，得 y=6，所以 B(0,6)。\n(2) OA=3，OB=6，所以 S△AOB=1/2×3×6=9。",
        knowledge: ["函数", "几何"],
        diagramSpec: { type: "coordinate", template: "coordinate_linear", width: 420, height: 280, xMin: -1, xMax: 5, yMin: -1, yMax: 7, k: -2, b: 6, points: [{ name: "A", x: 3, y: 0 }, { name: "B", x: 0, y: 6 }] },
        imageNote: "系统模板：一次函数与面积",
        verification: { expectedAnswer: "A(3,0)，B(0,6)，S△AOB=9", expectedValues: ["A(3,0)", "B(0,6)", "9"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，抛物线 y=-(x-1)²+4 的顶点为 P，与 y 轴交于点 B。\n(1) 求点 P、B 的坐标；\n(2) 求该函数的最大值。",
        options: [],
        answer: "P(1,4)，B(0,3)，最大值为 4",
        explanation: "(1) 由顶点式 y=-(x-1)²+4 可知顶点 P(1,4)。令 x=0，得 y=-(0-1)²+4=3，所以 B(0,3)。\n(2) 抛物线开口向下，顶点纵坐标为 4，所以函数最大值为 4。",
        knowledge: ["函数", "几何"],
        diagramSpec: makeQuadraticDiagramSpec({ a: -1, h: 1, k: 4, xMin: -3, xMax: 5, yMin: -4, yMax: 6, pointName: "P" }),
        imageNote: "系统模板：二次函数几何综合",
        verification: { expectedAnswer: "P(1,4)，B(0,3)，最大值为 4", expectedValues: ["P(1,4)", "B(0,3)", "4"] }
      })
    );
  } else if (template === "geometry_comprehensive_text") {
    variants.push(...makeGeometryComprehensiveTemplateVariants(question, base, geometry));
    variants.push(
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，D、E 分别在 AB、AC 上，且 DE∥BC，AD:DB=2:3，BC=15。\n(1) 求 DE 的长；\n(2) 若 S△ADE=8，求 S△ABC。",
        options: [],
        answer: "DE=6，S△ABC=50",
        explanation: "(1) 因为 AD:DB=2:3，所以 AD/AB=2/5。又 DE∥BC，所以 △ADE∽△ABC，DE/BC=AD/AB=2/5，因此 DE=15×2/5=6。\n(2) 相似三角形面积比等于相似比的平方，所以 S△ADE:S△ABC=(2/5)²=4:25。已知 S△ADE=8，所以 S△ABC=8÷4/25=50。",
        knowledge: ["几何"],
        diagramSpec: geometry("similar_triangles_parallel"),
        imageNote: "系统模板：几何综合相似",
        verification: { expectedAnswer: "DE=6，S△ABC=50", expectedValues: ["6", "50"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，在 △ABC 中，D 是 AB 的中点，E 是 AC 的中点，连接 DE。\n(1) 证明 DE∥BC；\n(2) 若 BC=18，求 DE 的长。",
        options: [],
        answer: "DE∥BC，DE=9",
        explanation: "(1) 因为 D、E 分别是 AB、AC 的中点，所以 DE 是 △ABC 的中位线。根据三角形中位线定理，DE∥BC。\n(2) 三角形中位线等于第三边的一半，所以 DE=1/2BC=1/2×18=9。",
        knowledge: ["几何"],
        diagramSpec: geometry("triangle_midline_parallel"),
        imageNote: "系统模板：几何综合中位线",
        verification: { expectedAnswer: "DE∥BC，DE=9", expectedValues: ["DE∥BC", "9"] }
      }),
      variantDefaults(question, {
        ...base,
        type: "解答题",
        stem: "如图，PA 是 ⊙O 的切线，A 为切点，OA=9，OP=15。\n(1) 证明 OA⊥PA；\n(2) 求 PA 的长。",
        options: [],
        answer: "OA⊥PA，PA=12",
        explanation: "(1) 圆的切线垂直于过切点的半径，所以 OA⊥PA。\n(2) 在 Rt△OAP 中，OP 是斜边，由勾股定理得 PA=√(OP²-OA²)=√(15²-9²)=√144=12。",
        knowledge: ["几何"],
        diagramSpec: geometry("circle_tangent_secant"),
        imageNote: "系统模板：几何综合圆切线",
        verification: { expectedAnswer: "OA⊥PA，PA=12", expectedValues: ["OA⊥PA", "12"] }
      })
    );
  } else if (template === "linear_equation_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "解方程 3x+5=20，x 的值为（ ）",
        options: choiceOptions(["3", "5", "6", "8"]),
        answer: "B",
        explanation: "移项得 3x=15，两边同时除以 3，得 x=5。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "B", expectedOption: "5", expectedValue: "5" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解方程 2(x-1)=10，x 的值为（ ）",
        options: choiceOptions(["4", "5", "6", "8"]),
        answer: "C",
        explanation: "去括号得 2x-2=10，移项得 2x=12，所以 x=6。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "6", expectedValue: "6" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解方程 5x-7=3x+9，x 的值为（ ）",
        options: choiceOptions(["6", "7", "8", "9"]),
        answer: "C",
        explanation: "移项得 5x-3x=9+7，即 2x=16，所以 x=8。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "C", expectedOption: "8", expectedValue: "8" }
      })
    );
  } else if (template === "linear_inequality_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "解不等式 2x+3>9，解集是（ ）",
        options: choiceOptions(["x>3", "x<3", "x>6", "x<6"]),
        answer: "A",
        explanation: "移项得 2x>6，两边同时除以 2，得 x>3。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x>3", expectedValue: "x>3" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解不等式 3x-4≤8，解集是（ ）",
        options: choiceOptions(["x≤4", "x≥4", "x≤12", "x≥12"]),
        answer: "A",
        explanation: "移项得 3x≤12，两边同时除以 3，得 x≤4。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x≤4", expectedValue: "x≤4" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "解不等式 -2x+6<10，解集是（ ）",
        options: choiceOptions(["x>-2", "x<-2", "x>2", "x<2"]),
        answer: "A",
        explanation: "移项得 -2x<4，两边同时除以 -2，不等号方向改变，得 x>-2。",
        knowledge: ["方程与不等式"],
        verification: { expectedAnswer: "A", expectedOption: "x>-2", expectedValue: "x>-2" }
      })
    );
  } else if (template === "pythagorean_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，直角三角形的两条直角边长分别为 6 和 8，则斜边长为（ ）",
        options: choiceOptions(["8", "10", "12", "14"]),
        answer: "B",
        explanation: "由勾股定理，斜边长为 √(6²+8²)=√100=10。",
        knowledge: ["几何"],
        diagramSpec: { type: "geometry", template: "triangle_basic", width: 420, height: 280, showHeight: true },
        imageNote: "系统模板：勾股定理",
        verification: { expectedAnswer: "B", expectedOption: "10", expectedValue: "10" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，直角三角形的斜边长为 13，一条直角边长为 5，则另一条直角边长为（ ）",
        options: choiceOptions(["10", "11", "12", "13"]),
        answer: "C",
        explanation: "由勾股定理，另一条直角边长为 √(13²-5²)=√144=12。",
        knowledge: ["几何"],
        diagramSpec: { type: "geometry", template: "triangle_basic", width: 420, height: 280, showHeight: true },
        imageNote: "系统模板：勾股定理",
        verification: { expectedAnswer: "C", expectedOption: "12", expectedValue: "12" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "如图，在 Rt△ABC 中，∠C=90°，AC=9，BC=12，则 AB 的长为（ ）",
        options: choiceOptions(["13", "14", "15", "16"]),
        answer: "C",
        explanation: "AB 是斜边，AB=√(AC²+BC²)=√(9²+12²)=√225=15。",
        knowledge: ["几何"],
        diagramSpec: { type: "geometry", template: "triangle_basic", width: 420, height: 280, showHeight: true },
        imageNote: "系统模板：勾股定理",
        verification: { expectedAnswer: "C", expectedOption: "15", expectedValue: "15" }
      })
    );
  } else if (template === "plane_area_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "一个长方形的长为 8 cm，宽为 5 cm，它的面积是（ ）",
        options: choiceOptions(["13 cm²", "26 cm²", "40 cm²", "80 cm²"]),
        answer: "C",
        explanation: "长方形面积=长×宽=8×5=40 cm²。",
        knowledge: ["几何"],
        verification: { expectedAnswer: "C", expectedOption: "40 cm²", expectedValue: "40" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一个三角形的底为 10 cm，高为 6 cm，它的面积是（ ）",
        options: choiceOptions(["16 cm²", "30 cm²", "60 cm²", "120 cm²"]),
        answer: "B",
        explanation: "三角形面积=底×高÷2=10×6÷2=30 cm²。",
        knowledge: ["几何"],
        verification: { expectedAnswer: "B", expectedOption: "30 cm²", expectedValue: "30" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "一个梯形的上底为 6 cm，下底为 10 cm，高为 4 cm，它的面积是（ ）",
        options: choiceOptions(["24 cm²", "28 cm²", "32 cm²", "64 cm²"]),
        answer: "C",
        explanation: "梯形面积=(上底+下底)×高÷2=(6+10)×4÷2=32 cm²。",
        knowledge: ["几何"],
        verification: { expectedAnswer: "C", expectedOption: "32 cm²", expectedValue: "32" }
      })
    );
  } else if (template === "quadratic_function_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "如图，二次函数 y=(x-2)²+3 的图象顶点坐标是（ ）",
        options: choiceOptions(["(2,3)", "(-2,3)", "(2,-3)", "(0,3)"]),
        answer: "A",
        explanation: "二次函数 y=(x-h)²+k 的顶点坐标为 (h,k)，所以 y=(x-2)²+3 的顶点坐标为 (2,3)。",
        knowledge: ["函数"],
        diagramSpec: makeQuadraticDiagramSpec({ a: 1, h: 2, k: 3, xMin: -1, xMax: 5, yMin: 0, yMax: 13 }),
        imageNote: "系统模板：二次函数顶点",
        verification: { expectedAnswer: "A", expectedOption: "(2,3)", expectedValue: "(2,3)" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "二次函数 y=x²-4x+1 的对称轴是（ ）",
        options: choiceOptions(["x=1", "x=2", "x=4", "x=-2"]),
        answer: "B",
        explanation: "y=x²-4x+1=(x-2)²-3，所以对称轴是 x=2。",
        knowledge: ["函数"],
        diagramSpec: makeQuadraticDiagramSpec({ a: 1, h: 2, k: -3, xMin: -1, xMax: 5, yMin: -4, yMax: 8 }),
        imageNote: "系统模板：二次函数对称轴",
        verification: { expectedAnswer: "B", expectedOption: "x=2", expectedValue: "x=2" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "二次函数 y=-(x+1)²+5 的最大值是（ ）",
        options: choiceOptions(["-1", "1", "5", "6"]),
        answer: "C",
        explanation: "该函数开口向下，顶点为 (-1,5)，所以函数的最大值是 5。",
        knowledge: ["函数"],
        diagramSpec: makeQuadraticDiagramSpec({ a: -1, h: -1, k: 5, xMin: -5, xMax: 3, yMin: -6, yMax: 6 }),
        imageNote: "系统模板：二次函数最值",
        verification: { expectedAnswer: "C", expectedOption: "5", expectedValue: "5" }
      })
    );
  } else if (template === "proportion_percent_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "一件商品原价 200 元，打八折出售，售价是（ ）",
        options: choiceOptions(["120 元", "140 元", "160 元", "180 元"]),
        answer: "C",
        explanation: "打八折表示按原价的 80% 出售，售价为 200×80%=160 元。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "C", expectedOption: "160 元", expectedValue: "160" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "某商品从 80 元涨到 100 元，增长率是（ ）",
        options: choiceOptions(["20%", "25%", "30%", "40%"]),
        answer: "B",
        explanation: "增长率=(100-80)÷80=20÷80=25%。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "25%", expectedValue: "25%" }
      }),
      variantDefaults(question, {
        ...base,
        stem: "甲、乙两数的比是 3:5，且两数之和为 40，则甲数是（ ）",
        options: choiceOptions(["12", "15", "18", "25"]),
        answer: "B",
        explanation: "总份数为 3+5=8，甲占 3/8，所以甲数为 40×3/8=15。",
        knowledge: ["数与代数"],
        verification: { expectedAnswer: "B", expectedOption: "15", expectedValue: "15" }
      })
    );
  } else if (template === "number_algebra_text") {
    variants.push(
      variantDefaults(question, {
        ...base,
        stem: "将 0.0000012 用科学记数法表示为（ ）",
        options: choiceOptions(["1.2×10⁻⁶", "12×10⁻⁶", "1.2×10⁶", "0.12×10⁻⁵"]),
        answer: "A",
        explanation: "0.0000012 的小数点向右移动 6 位得到 1.2，所以写成 1.2×10⁻⁶。",
        knowledge: ["数与代数"]
      }),
      variantDefaults(question, {
        ...base,
        stem: "计算 2³×2² 的结果是（ ）",
        options: choiceOptions(["2⁵", "2⁶", "4⁵", "4⁶"]),
        answer: "A",
        explanation: "同底数幂相乘，底数不变，指数相加，所以 2³×2²=2⁵。",
        knowledge: ["数与代数"]
      }),
      variantDefaults(question, {
        ...base,
        stem: "若 x=3，则代数式 2x²-1 的值为（ ）",
        options: choiceOptions(["11", "15", "17", "18"]),
        answer: "C",
        explanation: "把 x=3 代入，2x²-1=2×3²-1=18-1=17。",
        knowledge: ["数与代数"]
      })
    );
  }

  if (!variants.length) {
    const diagnostics = templateVariantDiagnostics(question, { templateId: template, candidateCount: 0, normalizedCount: 0, valid: [], errors: [], selected: [] });
    return options.withDiagnostics ? { variants: [], diagnostics } : [];
  }
  const normalized = normalizeVariants(variants.map((item) => attachTemplateVerification(item, template)), question, variants.length)
    .map((item) => ({ ...item, source: "AI生成·系统模板" }));
  const { valid, errors } = validateGeneratedVariants(normalized, question);
  const selected = pickTemplateVariants(valid, question, template, 3);
  const diagnostics = templateVariantDiagnostics(question, {
    templateId: template,
    candidateCount: variants.length,
    normalizedCount: normalized.length,
    valid,
    errors,
    selected
  });
  return options.withDiagnostics ? { variants: selected, diagnostics } : selected;
}

function findPendingQuestionBankVariants(db, question, session = {}) {
  const readiness = bankMatchReadiness(question);
  if (!readiness.ready) {
    throw new Error(bankNoMatchMessage(db, question, { exclude: [question.id] }));
  }
  const variants = normalizeVariants(findReusableQuestions(db, question, { limit: 5 }), question, 5)
    .map((item) => ({ ...item, source: item.source || "题库找题" }));
  if (!variants.length) throw new Error(bankNoMatchMessage(db, question, { exclude: [question.id] }));
  question.webVariants = normalizeVariants(question.webVariants || [], question).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  question.aiVariants = normalizeVariants(question.aiVariants || [], question).map((item) => ({ ...item, source: item.source || "AI生成" }));
  question.bankVariants = variants;
  question.variants = [...question.webVariants, ...question.aiVariants, ...question.bankVariants];
  question.status = "pending";
  question.analysisError = "";
  question.updatedBy = sessionUserId(session);
  question.updatedAt = new Date().toISOString();
  return question;
}

function webSearchProviderLabel() {
  return ({
    bing: "Bing",
    serpapi: "SerpAPI",
    tavily: "Tavily"
  })[WEB_SEARCH_PROVIDER] || WEB_SEARCH_PROVIDER || "disabled";
}

function ensureWebSearchConfigured() {
  if (!WEB_SEARCH_PROVIDER || WEB_SEARCH_PROVIDER === "disabled" || WEB_SEARCH_PROVIDER === "none") {
    const error = new Error("AI查题不是千问接口，需要单独配置网页搜索服务。在 deploy/docker.env 或 .env 中设置 WEB_SEARCH_PROVIDER=tavily/bing/serpapi 和 WEB_SEARCH_API_KEY 后重启。");
    error.statusCode = 501;
    throw error;
  }
  if (!WEB_SEARCH_API_KEY && WEB_SEARCH_PROVIDER !== "custom") {
    const error = new Error(`AI查题已选择 ${webSearchProviderLabel()}，但没有配置 WEB_SEARCH_API_KEY。`);
    error.statusCode = 501;
    throw error;
  }
}

function isWebSearchConfigured() {
  if (!WEB_SEARCH_PROVIDER || WEB_SEARCH_PROVIDER === "disabled" || WEB_SEARCH_PROVIDER === "none") return false;
  if (WEB_SEARCH_PROVIDER === "custom") return Boolean(WEB_SEARCH_ENDPOINT);
  return Boolean(WEB_SEARCH_API_KEY);
}

function webSearchConfigHint() {
  if (!WEB_SEARCH_PROVIDER || WEB_SEARCH_PROVIDER === "disabled" || WEB_SEARCH_PROVIDER === "none") {
    return "AI查题不是千问接口，需要单独配置网页搜索服务：在 deploy/docker.env 或 .env 中设置 WEB_SEARCH_PROVIDER=tavily/bing/serpapi 和 WEB_SEARCH_API_KEY，重启后系统会搜索网页、抓取正文并抽取题卡。";
  }
  if (WEB_SEARCH_PROVIDER === "custom" && !WEB_SEARCH_ENDPOINT) {
    return "WEB_SEARCH_PROVIDER=custom 但缺少 WEB_SEARCH_ENDPOINT，无法自动查题。";
  }
  if (!WEB_SEARCH_API_KEY && WEB_SEARCH_PROVIDER !== "custom") {
    return `已选择 ${webSearchProviderLabel()}，但缺少 WEB_SEARCH_API_KEY，无法自动查题。`;
  }
  return "搜索服务暂不可用，无法自动查题。";
}

function buildManualSearchUrl(query = "") {
  const encoded = encodeURIComponent(query);
  return `https://www.baidu.com/s?wd=${encoded}`;
}

function fallbackOnlineSearchVariants(question = {}, reason = "") {
  return buildOnlineQuestionSearchQueries(question).slice(0, 3).map((query, index) => ({
    stem: `搜索相似题：${query}`,
    options: [],
    answer: "",
    explanation: `${reason || webSearchConfigHint()}\n点击来源链接后，可在搜索结果中核对完整题干、答案和解析。`,
    subject: question.subject,
    stage: question.stage,
    grade: question.grade,
    chapter: question.chapter,
    knowledge: question.knowledge,
    level: question.level,
    type: question.type,
    source: "AI查题·搜索入口",
    sourceUrl: buildManualSearchUrl(query),
    sourceTitle: `搜索：${query}`,
    sourceSnippet: reason || webSearchConfigHint(),
    searchQuery: query,
    webSearchScore: 0,
    imageNote: `搜索入口 ${index + 1}`
  }));
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = WEB_SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const textBody = await response.text();
    let body = null;
    try {
      body = textBody ? JSON.parse(textBody) : null;
    } catch {
      body = { raw: textBody };
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || body?.raw || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = WEB_SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (/\.pdf(?:$|[?#])/i.test(String(url || ""))) throw new Error("搜索结果是 PDF，已跳过网页正文抽题，避免乱码");
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 ZenoXExerciseBot/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") || "";
    if (/application\/pdf|application\/octet-stream|application\/zip|image\//i.test(contentType)) {
      throw new Error(`搜索结果不是普通网页（${contentType}），已跳过抽题`);
    }
    const text = await response.text();
    if (looksLikeGarbledText(text.slice(0, 3000))) throw new Error("网页正文疑似乱码，已跳过抽题");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBufferWithTimeout(url, options = {}, timeoutMs = WEB_SEARCH_IMAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 ZenoXExerciseBot/1.0",
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\//i.test(contentType)) throw new Error(`不是图片资源（${contentType || "unknown"}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("图片为空");
    if (bytes.length > MAX_WEB_QUESTION_IMAGE_BYTES) throw new Error("图片过大");
    return { bytes, contentType };
  } finally {
    clearTimeout(timer);
  }
}

function isLikelyPdfSearchResult(result = {}) {
  const value = `${result.title || ""} ${result.url || ""}`.toLowerCase();
  return /\.pdf(?:$|[?#])/.test(value) || /\[pdf\]|pdf\s*$/i.test(value) || /scribd\.com|slideshare\.net/.test(value);
}

function isVideoSearchResult(result = {}) {
  const value = `${result.title || ""} ${result.url || ""}`.toLowerCase();
  return /youtube\.com|youtu\.be|bilibili\.com|ixigua\.com|douyin\.com|kuaishou\.com|v\.qq\.com|youku\.com|iqiyi\.com|video|视频|公开课|讲课|channel/.test(value);
}

function isBlockedQuestionSearchSource(result = {}) {
  const value = `${result.title || ""} ${result.url || ""} ${result.snippet || ""}`.toLowerCase();
  return /csdn\.net|blog\.csdn|zhihu\.com|bilibili\.com|youtube\.com|youtu\.be|wenku\.baidu|docin\.com|scribd\.com|slideshare\.net|baijiahao|sohu\.com|163\.com|weixin\.qq\.com|公众号|博客|模型大全|模型大汇总|知识点归纳|老师熬夜整理/.test(value);
}

function isWrongStageSearchResult(result = {}, question = {}) {
  const value = normalizeQuestionText(`${result.title || ""}\n${result.snippet || ""}\n${result.questionText || ""}`);
  if ((question.stage || "").includes("初中") || (question.subject || "").includes("初中")) {
    if (/(小学|小升初|一年级|二年级|三年级|四年级|五年级|六年级|少儿|幼小)/.test(value)) return true;
  }
  if (/(知识分享官|公开课|课堂实录|教学设计|教案|说课稿|课件|视频讲解|频道|播放量|Go to channel)/i.test(value)) return true;
  return false;
}

function isArticleOrTemplateSummary(text = "") {
  const value = normalizeQuestionText(text);
  if (!value) return true;
  if (/(CSDN|博客|blog|weixin_\d+|老师熬夜整理|模型大全|模型大汇总|知识点归纳|重点归纳|模板说明|本文整理|转给孩子|收藏起来|目录|Page\s*\d+|下载积分|阅读权限|文档页码|上传人|版权声明)/i.test(value)) return true;
  if (/(一般会在|掌握.*模型|能够为考试节省|基础扎实|举一反三|非常重要的内容|这个模型证明起来|没有什么难度)/.test(value)) return true;
  const questionCues = (value.match(/(?:^\s*\d{1,2}[.、）)]|如图|求证|求|证明|计算|若|已知|连接|延长|交于|答案|解析|[（(]\s*\d+\s*[)）])/gm) || []).length;
  return questionCues < 2;
}

function isAnswerOrExplanationLine(line = "") {
  const value = normalizeQuestionText(line).replace(/\s+/g, "");
  if (!value) return false;
  return /^(?:答案|参考答案|解析|分析|解答|解|证明|证法|详解|点评|考点|故选|故答案为|综上所述|因此答案|【解析】|【答案】|【分析】)/.test(value)
    || /^(?:故选|选[:：]?[A-D]|答案[:：]?[A-D])/.test(value);
}

function stripWebQuestionNoiseLine(line = "") {
  return normalizeQuestionText(line)
    .replace(/^[-_]{2,}\s*$/g, "")
    .replace(/^第\s*\d+\s*页(?:\s*\/\s*共\s*\d+\s*页)?$/g, "")
    .replace(/^Page\s*\d+(?:\s*of\s*\d+)?$/i, "")
    .replace(/^--\s*\d+\s+of\s+\d+\s*--$/i, "")
    .replace(/^\s*(?:中考真题|模拟试题|专题训练|答案解析|解析版|学生版|教师版)\s*$/g, "")
    .replace(/^\s*(?:A|B|C|D|E|F|G|O|M)\s*$/g, "")
    .trim();
}

function cleanOnlineQuestionStem(text = "", parent = {}) {
  const rawLines = normalizeQuestionText(text)
    .replace(/\u00a0/g, " ")
    .split(/\n|(?<=。)\s+(?=\d{1,2}[.、]\s*)/)
    .map(stripWebQuestionNoiseLine)
    .filter(Boolean)
    .filter((line) => !isProbablySectionHeading(line))
    .filter((line) => !/(版权|下载|登录|注册|会员|相关推荐|上一篇|下一篇|广告|扫码|关注|分享|收藏|举报|上传|文库|doc|pdf|试卷第\d+页)/i.test(line));

  if (!rawLines.length) return "";
  if (isAnswerOrExplanationLine(rawLines[0])) return "";

  let start = rawLines.findIndex((line) => {
    if (isAnswerOrExplanationLine(line)) return false;
    return isTopLevelQuestionStart(line)
      || /(如图|已知|若|在.*中|求证|求|计算|证明.*成立|探究|操作|观察|数学活动|平面直角坐标系|抛物线|函数图象|图像)/.test(line);
  });
  if (start < 0) start = 0;

  const kept = [];
  for (const line of rawLines.slice(start)) {
    if (!kept.length && isAnswerOrExplanationLine(line)) return "";
    if (kept.length && isAnswerOrExplanationLine(line)) break;
    if (/^(?:[A-D][.、]\s*)?故选|^答案[:：]|^解析[:：]|^证明[:：]|^解[:：]/.test(line)) break;
    kept.push(line);
    const joined = kept.join("\n");
    if (joined.length > 900) break;
  }

  let stem = normalizeQuestionText(kept.join("\n"))
    .replace(/^(?:\d{4}\s*[·.、-]\s*)?(?:[^。\n]{0,16}中考真题|专题\d*[-—]?\d*|例题\d*)\s*/g, "")
    .replace(/^(\d{1,3})[.、]\s*(?=如图|已知|若|在|数学活动|如图|抛物线|函数)/, "")
    .replace(/(?:\n|^)\s*(?:A|B|C|D|E|F|G|O|M)\s*(?=\n|$)/g, "\n")
    .trim();

  const parentIsChoice = parent.type === "选择题" || hasVisibleChoiceOptions(parent);
  if (!parentIsChoice) {
    stem = stem.replace(/(?:\n|^)\s*[A-D][.、]\s*[^\n]+/g, "").trim();
    if (/故选|正确的结论有|答案是|答案为|选项/.test(stem.slice(0, 80))) return "";
  }
  if (/(^|\n)(?:答案|解析|分析|证明|解答)[:：]|故选|综上所述|考点[:：]|点评[:：]/.test(stem)) return "";
  return stem;
}

function isCompleteOnlineQuestionText(text = "", question = {}) {
  const value = cleanOnlineQuestionStem(text, question);
  if (value.length < 30 || value.length > 1500) return false;
  if (looksLikeGarbledText(value.slice(0, 1000))) return false;
  if (isArticleOrTemplateSummary(value)) return false;
  if (!/(如图|已知|若|求|证明|计算|连接|延长|交于|[（(]\s*1\s*[)）])/.test(value)) return false;
  if (/(模型大全|知识点|大汇总|老师整理|博客|CSDN|公开课|视频|课件|教案)/i.test(value)) return false;
  const parentType = question.type || inferQuestionType(question.stem || "");
  const candidateType = inferQuestionType(value);
  if (parentType && parentType !== "未分类") {
    if (parentType === "选择题" && !hasVisibleChoiceOptions({ stem: value, options: [] })) return false;
    if (parentType !== "选择题" && hasVisibleChoiceOptions({ stem: value, options: [] })) return false;
    if (parentType === "填空题" && candidateType && candidateType !== "填空题") return false;
    if (parentType === "解答题" && candidateType === "选择题") return false;
  }
  const template = detectedTemplateKey(question);
  if (template && !isOnlineTemplateCompatible(question, value)) return false;
  return true;
}

function isUsableWebSearchText(text = "") {
  const value = normalizeQuestionText(text);
  if (value.length < 12) return false;
  if (looksLikeGarbledText(value.slice(0, 1000))) return false;
  const han = (value.match(/[\p{Script=Han}]/gu) || []).length;
  const questionMarkers = /(如图|证明|求|计算|答案|解析|中考|数学|选择|填空|∠|△|函数|方程|相似|全等)/.test(value);
  return han >= 6 && questionMarkers;
}

function webSearchNeedsImage(question = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.explanation, question.imageNote].filter(Boolean).join("\n");
  return hasImageCue(body) || /(几何|图形|圆|相似|全等|旋转|平移|轴对称|函数图象|统计图)/.test(body);
}

function onlineQuestionRequiresDiagram(question = {}, stem = "") {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), stem].filter(Boolean).join("\n");
  return webSearchNeedsImage(question) || /(如图|图中|下图|图象|图像|平面直角坐标系|抛物线|函数|几何|三角形|△|圆|⊙|相似|全等|旋转|平移|轴对称|统计图)/.test(body);
}

function makeOnlineSearchDiagramSpec(question = {}, stem = "") {
  const candidate = {
    ...question,
    stem,
    options: [],
    answer: "",
    explanation: "",
    imageNote: ""
  };
  const sourceTemplate = detectedTemplateKey(question);
  const resultTemplate = detectedTemplateKey(candidate);
  const template = resultTemplate || sourceTemplate;
  if (template === "rotation_congruence_comprehensive_text") return makeRotationCongruenceComprehensiveDiagramSpec(2);
  return inferTemplateDiagramSpec(candidate, question, null);
}

function isSameStrongQuestionTemplate(question = {}, stem = "") {
  const sourceTemplate = detectedTemplateKey(question);
  if (!sourceTemplate) return true;
  const strongTemplates = new Set([
    "travel_distance_time_graph",
    "parallel_transversal",
    "grid_probability",
    "quadratic_piecewise_text",
    "rotation_congruence_comprehensive_text",
    "similar_comprehensive_text",
    "circle_similarity_comprehensive_text",
    "circle_comprehensive_text",
    "moving_point_area_function_text",
    "function_geometry_comprehensive_text"
  ]);
  if (!strongTemplates.has(sourceTemplate)) return true;
  const resultTemplate = detectedTemplateKey({ ...question, stem, options: [], explanation: "", imageNote: "" });
  return resultTemplate === sourceTemplate;
}

function inferredQuestionLevel(question = {}) {
  const body = normalizeQuestionText([question.stem, normalizeOptions(question.options).join("\n"), question.explanation, question.imageNote].filter(Boolean).join("\n"));
  const explicit = question.level && question.level !== "基础" ? question.level : "";
  const type = question.type || inferQuestionType(body);
  const subQuestions = (body.match(/[（(]\s*[一二三四五六七八九十\d]\s*[)）]|①|②|③|④/g) || []).length;
  const isComprehensive = /(压轴|综合|探究|动点|存在点|最值|取值范围|分类讨论|参数|面积最大|面积最小|函数关系式|证明.*求|[（(]1[)）].*[（(]2[)）]|①.*②)/.test(body);
  if (explicit === "压轴" || (type === "解答题" && (isComprehensive || subQuestions >= 2))) return "压轴";
  if (explicit === "提高" || /(提高|培优|中考真题|模拟压轴|证明|求证|综合运用)/.test(body)) return "提高";
  return explicit || "基础";
}

function keywordHitCount(question = {}, text = "") {
  const value = normalizeQuestionText(text).toLowerCase();
  return extractSearchKeywords(question).filter((keyword) => keyword && value.includes(String(keyword).toLowerCase())).length;
}

function isOnlineTemplateCompatible(question = {}, stem = "") {
  const sourceTemplate = detectedTemplateKey(question);
  if (!sourceTemplate) return keywordHitCount(question, stem) >= Math.min(2, extractSearchKeywords(question).length || 1);
  const resultTemplate = detectedTemplateKey({ ...question, stem, options: [], explanation: "", imageNote: "" });
  if (sourceTemplate === resultTemplate) return true;
  const compatible = {
    quadratic_piecewise_text: new Set(["quadratic_piecewise_text", "function_geometry_comprehensive_text"]),
    function_geometry_comprehensive_text: new Set(["function_geometry_comprehensive_text", "quadratic_piecewise_text", "moving_point_area_function_text"]),
    rotation_congruence_comprehensive_text: new Set(["rotation_congruence_comprehensive_text", "transformation_text", "congruent_triangles_proof_text"]),
    circle_similarity_comprehensive_text: new Set(["circle_similarity_comprehensive_text", "circle_comprehensive_text", "similar_comprehensive_text"]),
    similar_comprehensive_text: new Set(["similar_comprehensive_text", "circle_similarity_comprehensive_text", "geometry_comprehensive_text"]),
    geometry_comprehensive_text: new Set(["geometry_comprehensive_text", "congruent_triangles_proof_text", "angle_bisector_text", "moving_point_extremum_text"])
  };
  if (compatible[sourceTemplate]?.has(resultTemplate)) return keywordHitCount(question, stem) >= 3;
  return false;
}

function isOnlineDifficultyCompatible(question = {}, stem = "") {
  const parentLevel = inferredQuestionLevel(question);
  const candidateLevel = inferredQuestionLevel({ ...question, stem, options: [], explanation: "", imageNote: "" });
  if (parentLevel === "压轴") {
    return candidateLevel === "压轴" && !hasVisibleChoiceOptions({ stem, options: [] });
  }
  if (parentLevel === "提高") return candidateLevel === "提高" || candidateLevel === "压轴";
  return candidateLevel !== "压轴";
}

function isOnlineKnowledgeCompatible(question = {}, stem = "") {
  const keywords = extractSearchKeywords(question);
  if (!keywords.length) return true;
  const required = inferredQuestionLevel(question) === "压轴" ? 3 : 2;
  return keywordHitCount(question, stem) >= Math.min(required, keywords.length);
}

function onlineResultRejectionReason(question = {}, stem = "", result = {}) {
  const cleanStem = cleanOnlineQuestionStem(stem || result.questionText || result.snippet || "", question);
  if (!cleanStem) return "不是纯题干，疑似解析/答案/网页杂文";
  if (!isCompleteOnlineQuestionText(cleanStem, question)) return "题干不完整或题型不一致";
  if (!isOnlineTemplateCompatible(question, cleanStem)) return "考点模板不一致";
  if (!isOnlineKnowledgeCompatible(question, cleanStem)) return "知识点关键词不足";
  if (!isOnlineDifficultyCompatible(question, cleanStem)) return "难度不一致";
  if (!isSameStrongQuestionTemplate(question, cleanStem)) return "强模板不一致";
  return "";
}

function extractCandidateImagesFromHtml(html = "", pageUrl = "", questionText = "") {
  const candidates = [];
  const seen = new Set();
  const push = (src = "", meta = {}) => {
    const raw = decodeBasicHtmlEntities(String(src || "").trim());
    if (!raw || /^data:/i.test(raw)) return;
    try {
      const absolute = new URL(raw, pageUrl).toString();
      const lower = absolute.toLowerCase();
      if (seen.has(absolute)) return;
      if (/logo|avatar|icon|sprite|blank|default|loading|qr|wechat|weixin|ad[sx]?|banner|watermark|profile|favicon/.test(lower)) return;
      if (!/\.(png|jpe?g|webp|gif)(?:$|[?#])/.test(lower)) return;
      const label = normalizeQuestionText(`${meta.alt || ""} ${meta.title || ""} ${meta.context || ""}`);
      let score = Number(meta.score || 0);
      if (/(题|试题|几何|函数|图|解析|坐标|三角形|圆|抛物线|旋转|全等|相似|统计)/.test(label)) score += 12;
      if (/(logo|头像|二维码|广告|公众号|微信|扫码|banner|分享|收藏)/i.test(label)) score -= 30;
      if (questionText && label && keywordHitCount({ stem: questionText, knowledge: [] }, label) > 0) score += 6;
      seen.add(absolute);
      candidates.push({ url: absolute, score, alt: meta.alt || "", context: label });
    } catch {
      // ignore malformed image URLs
    }
  };
  for (const match of String(html || "").matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)) {
    push(match[1], { score: -6, context: "meta image" });
  }
  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = /(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i.exec(tag)?.[1] || "";
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    const title = /title=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    push(src, { score: 0, alt, title, context: tag.slice(0, 260) });
    if (candidates.length >= 12) break;
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
}

function extractCandidateImageFromHtml(html = "", pageUrl = "") {
  return extractCandidateImagesFromHtml(html, pageUrl)[0]?.url || "";
}

function decodeBasicHtmlEntities(text = "") {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function htmlToReadableText(html = "") {
  return normalizeQuestionText(decodeBasicHtmlEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|p|div|li|tr|h[1-6]|section|article|table|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")));
}

function questionLikeScore(text = "", question = {}) {
  const value = normalizeQuestionText(text);
  if (value.length < 18) return -50;
  if (isArticleOrTemplateSummary(value)) return -120;
  let score = 0;
  if (/[?？]|（\s*）|\(\s*\)|____|_{2,}/.test(value)) score += 14;
  if (/(如图|下图|图中|证明|求|计算|填空|选择|答案|解析)/.test(value)) score += 12;
  if (/(A[.、]\s*\S|B[.、]\s*\S|C[.、]\s*\S|D[.、]\s*\S)/.test(value)) score += 10;
  if (/(初中|中考|数学|试题|练习|真题|压轴|成都)/.test(value)) score += 6;
  for (const keyword of extractSearchKeywords(question).slice(0, 8)) {
    if (keyword && value.includes(keyword)) score += 8;
  }
  if (/登录|注册|app下载|会员|版权|转载|相关推荐|下一篇|上一篇|广告/.test(value)) score -= 16;
  if (value.length > 1200) score -= 8;
  return score;
}

function extractQuestionBlockFromWebText(text = "", question = {}) {
  const clean = normalizeQuestionText(text).replace(/\n{2,}/g, "\n");
  if (!clean) return "";
  const lines = clean.split(/\n/).map((line) => normalizeQuestionText(line)).filter(Boolean);
  const windows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const chunk = lines.slice(index, index + 8).join("\n");
    const stem = cleanOnlineQuestionStem(chunk, question);
    if (stem && questionLikeScore(stem, question) > 10) windows.push(stem);
  }
  const sentenceChunks = clean
    .split(/(?<=[。！？?？；;])\s*/)
    .map((item) => cleanOnlineQuestionStem(item, question))
    .filter((item) => item.length >= 18 && item.length <= 900);
  const candidates = [...windows, ...sentenceChunks]
    .map((item) => ({ text: item, score: questionLikeScore(item, question) }))
    .filter((item) => item.score > 8 && !onlineResultRejectionReason(question, item.text))
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return candidates[0]?.text?.slice(0, 1200) || "";
}

async function enrichWebSearchResultWithQuestion(result = {}, question = {}) {
  if (!result.url || !/^https?:\/\//i.test(result.url)) return result;
  try {
    const html = await fetchTextWithTimeout(result.url, {}, Math.min(WEB_SEARCH_TIMEOUT_MS, 9000));
    const text = htmlToReadableText(html);
    const questionText = extractQuestionBlockFromWebText(text, question);
    const questionImages = extractCandidateImagesFromHtml(html, result.url, questionText || result.snippet || "");
    const questionImage = questionImages[0]?.url || "";
    if (!questionText && !questionImages.length) return result;
    return {
      ...result,
      questionText,
      questionImage: result.questionImage || questionImage,
      questionImages: [
        ...(Array.isArray(result.questionImages) ? result.questionImages : []),
        ...questionImages
      ],
      snippet: questionText || result.snippet
    };
  } catch (error) {
    return {
      ...result,
      fetchError: error.message || "网页正文抓取失败"
    };
  }
}

function normalizeWebSearchResult(item = {}, query = "") {
  const title = normalizeQuestionText(item.title || item.name || "");
  const url = String(item.url || item.link || item.href || "").trim();
  const snippet = normalizeQuestionText(item.snippet || item.content || item.description || "");
  const questionImage = item.questionImage || item.image || item.image_url || item.thumbnail || "";
  if (isVideoSearchResult({ title, url, snippet })) return null;
  if (isBlockedQuestionSearchSource({ title, url, snippet })) return null;
  if (isLikelyPdfSearchResult({ title, url })) return null;
  if (snippet && !isUsableWebSearchText(`${title}\n${snippet}`)) return null;
  if (!title || !url) return null;
  return {
    title,
    url,
    snippet,
    questionImage,
    questionImages: questionImage ? [{ url: questionImage, score: 0, context: "search result image" }] : [],
    query
  };
}

async function callWebSearchProvider(query = "") {
  ensureWebSearchConfigured();
  const encoded = new URLSearchParams({ q: query });
  if (WEB_SEARCH_PROVIDER === "bing") {
    const endpoint = WEB_SEARCH_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
    const url = `${endpoint}?${encoded.toString()}&count=${Math.max(1, Math.min(10, WEB_SEARCH_LIMIT))}&mkt=zh-CN&responseFilter=Webpages`;
    const data = await fetchJsonWithTimeout(url, {
      headers: { "Ocp-Apim-Subscription-Key": WEB_SEARCH_API_KEY }
    });
    return (data.webPages?.value || []).map((item) => normalizeWebSearchResult({
      title: item.name,
      url: item.url,
      snippet: item.snippet
    }, query)).filter(Boolean);
  }
  if (WEB_SEARCH_PROVIDER === "serpapi") {
    const endpoint = WEB_SEARCH_ENDPOINT || "https://serpapi.com/search.json";
    const params = new URLSearchParams({
      engine: WEB_SEARCH_ENGINE,
      q: query,
      api_key: WEB_SEARCH_API_KEY,
      num: String(Math.max(1, Math.min(10, WEB_SEARCH_LIMIT)))
    });
    const data = await fetchJsonWithTimeout(`${endpoint}?${params.toString()}`);
    const items = data.organic_results || data.results || [];
    return items.map((item) => normalizeWebSearchResult({
      title: item.title,
      url: item.link || item.url,
      snippet: item.snippet || item.rich_snippet || item.content
    }, query)).filter(Boolean);
  }
  if (WEB_SEARCH_PROVIDER === "tavily") {
    const endpoint = WEB_SEARCH_ENDPOINT || "https://api.tavily.com/search";
    const data = await fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: WEB_SEARCH_API_KEY,
        query,
        max_results: Math.max(1, Math.min(10, WEB_SEARCH_LIMIT)),
        search_depth: "basic",
        include_images: true,
        include_answer: false
      })
    });
    return (data.results || []).map((item) => normalizeWebSearchResult({
      title: item.title,
      url: item.url,
      snippet: item.content || item.snippet,
      questionImage: item.image || item.image_url || item.thumbnail
    }, query)).filter(Boolean);
  }
  if (WEB_SEARCH_PROVIDER === "custom") {
    if (!WEB_SEARCH_ENDPOINT) {
      const error = new Error("WEB_SEARCH_PROVIDER=custom 时需要配置 WEB_SEARCH_ENDPOINT。");
      error.statusCode = 501;
      throw error;
    }
    const separator = WEB_SEARCH_ENDPOINT.includes("?") ? "&" : "?";
    const data = await fetchJsonWithTimeout(`${WEB_SEARCH_ENDPOINT}${separator}${encoded.toString()}`, WEB_SEARCH_API_KEY ? {
      headers: { authorization: `Bearer ${WEB_SEARCH_API_KEY}` }
    } : {});
    return (data.results || data.items || []).map((item) => normalizeWebSearchResult(item, query)).filter(Boolean);
  }
  const error = new Error(`暂不支持 WEB_SEARCH_PROVIDER=${WEB_SEARCH_PROVIDER}`);
  error.statusCode = 501;
  throw error;
}

function extractSearchKeywords(question = {}) {
  const body = normalizeQuestionText([question.stem, normalizeOptions(question.options).join("\n"), question.answer, question.explanation].filter(Boolean).join("\n"));
  const dictionary = [
    "二次函数", "抛物线", "一次函数", "反比例函数", "函数图象", "平面直角坐标系", "动点", "最值", "定点", "平移",
    "相似", "全等", "圆", "切线", "角平分线", "垂直平分线", "平行线", "同位角", "内错角", "同旁内角",
    "因式分解", "整式运算", "一元二次方程", "二次根式", "概率", "树状图", "列表法", "统计图", "平均数", "方差",
    "行程", "销售", "工程", "面积", "tan", "正切", "尺规作图", "旋转", "纸片", "中线", "延长线"
  ];
  const hits = dictionary.filter((word) => body.includes(word));
  const knowledge = parseTags(question.knowledge).flatMap((item) => String(item).split(/[,，、/]/)).map((item) => item.trim()).filter(Boolean);
  const formulaHits = [...body.matchAll(/y\s*=\s*[^，。；\n]+|[A-Z]′?|∠[A-Za-z0-9]+|△[A-Za-z]{3}|[a-zA-Z]\s*[∥⊥]\s*[a-zA-Z]/g)].map((match) => normalizeQuestionText(match[0])).slice(0, 6);
  return [...new Set([...knowledge, ...hits, ...formulaHits])].filter(Boolean).slice(0, 10);
}

function buildOnlineQuestionSearchQueries(question = {}) {
  const subject = question.subject || "初中数学";
  const stage = question.stage || "初中";
  const grade = question.grade || "";
  const type = question.type && question.type !== "未分类" ? question.type : "";
  const template = detectedTemplateKey(question);
  const templateLabel = template ? TEMPLATE_LABELS[template] || template : "";
  const keywords = extractSearchKeywords(question);
  const base = [stage, subject, grade, type, templateLabel, ...keywords].filter(Boolean).join(" ");
  const compactStem = normalizeQuestionText(question.stem).replace(/\s+/g, " ");
  const stemKeywords = compactStem
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9∠△²√]+/g, " ")
    .split(/\s+/)
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 8)
    .join(" ");
  const exclusions = "-小学 -公开课 -视频 -YouTube -bilibili -B站 -课件 -教案 -归纳";
  const templateQuery = template === "rotation_congruence_comprehensive_text"
    ? `${stage} ${subject} 中考 几何压轴 旋转 纸片 全等直角三角形 BD CE 答案 解析 如图`
    : "";
  return [...new Set([
    templateQuery,
    `${base} 同类题 题目 答案 解析 如图 ${exclusions}`,
    `${base} 中考 真题 压轴题 答案 解析 ${exclusions}`,
    `${stage} ${subject} ${keywords.slice(0, 7).join(" ")} 试题 答案 解析 ${exclusions}`,
    stemKeywords ? `${stage} ${subject} ${stemKeywords} 答案 解析 ${exclusions}` : ""
  ].map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 4);
}

function scoreOnlineSearchResult(question = {}, result = {}) {
  const text = normalizeQuestionText(`${result.title} ${result.snippet}`).toLowerCase();
  if (isLikelyPdfSearchResult(result)) return -999;
  if (isBlockedQuestionSearchSource(result)) return -999;
  if (isVideoSearchResult(result) || isWrongStageSearchResult(result, question)) return -999;
  if (!isUsableWebSearchText(text)) return -120;
  const keywords = extractSearchKeywords(question);
  let score = 0;
  for (const keyword of keywords) {
    if (keyword && text.includes(String(keyword).toLowerCase())) score += 12;
  }
  if (question.type && text.includes(String(question.type).toLowerCase())) score += 8;
  if ((question.subject || "").includes("数学") && /(数学|中考|初中|试题|练习|解析|答案)/.test(text)) score += 8;
  if (/答案|解析|试题|练习|真题|题库/.test(text)) score += 6;
  if (/中考|压轴|真题|试卷/.test(text)) score += 10;
  if (/小学|公开课|知识分享|视频|youtube|bilibili|课件|教案|归纳/.test(text)) score -= 60;
  const template = detectedTemplateKey(question);
  if (template === "rotation_congruence_comprehensive_text") {
    const coreHits = ["旋转", "纸片", "全等", "直角三角形", "BD", "CE", "中线", "延长线"].filter((word) => text.includes(word.toLowerCase())).length;
    score += coreHits * 16;
    if (coreHits < 3) score -= 80;
  }
  return score;
}

function isAcceptableOnlineQuestionResult(question = {}, result = {}) {
  if (!result || isVideoSearchResult(result) || isBlockedQuestionSearchSource(result) || isLikelyPdfSearchResult(result) || isWrongStageSearchResult(result, question)) return false;
  const text = cleanOnlineQuestionStem(result.questionText || "", question);
  if (onlineResultRejectionReason(question, text, result)) return false;
  const template = detectedTemplateKey(question);
  if (template === "rotation_congruence_comprehensive_text") {
    const coreHits = ["旋转", "纸片", "全等", "直角三角形", "BD", "CE", "中线", "延长线"].filter((word) => text.includes(word)).length;
    if (coreHits < 3) return false;
  }
  return Number(result.score || 0) >= 24;
}

async function normalizeDownloadedQuestionImage(bytes, contentType = "") {
  if (/svg/i.test(contentType)) throw new Error("跳过 SVG/矢量网页图，避免误用站点图标");
  const sharpModule = await import("sharp");
  const image = sharpModule.default(bytes, { failOn: "none" }).rotate();
  const metadata = await image.metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (width < 140 || height < 90) throw new Error("图片尺寸过小，不像题图");
  if (width / Math.max(1, height) > 5 || height / Math.max(1, width) > 5) throw new Error("图片比例异常，不像题图");
  if (width * height < 24_000) throw new Error("图片有效面积过小");
  const png = await image
    .resize({ width: 1400, height: 1200, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return { bytes: png, contentType: "image/png", width, height };
}

async function verifyOnlineQuestionImage(bytes, question = {}, stem = "", candidate = {}, db = null, session = {}) {
  if (!process.env.QWEN_API_KEY) return false;
  const prompt = `你是数学题图审核器。请判断图片能否作为“联网相似题”的本题配图，只输出 JSON。
字段：{"accepted":boolean,"reason":"简短原因"}。
必须 accepted=true 的条件：
1. 图片是数学练习题所需的图形、函数图象、统计图、几何图、表格或题目截图，不是 logo、头像、二维码、广告、公众号配图、页面装饰。
2. 图片和候选题干的核心对象基本匹配，例如点名、图形类型、函数/坐标/统计图类型能对上。
3. 如果图片主要是答案、解析、证明过程或无关整页资料，必须 rejected。

原题题干：${normalizeQuestionText(question.stem).slice(0, 500)}
候选题干：${normalizeQuestionText(stem).slice(0, 700)}
网页图片线索：${normalizeQuestionText([candidate.alt, candidate.context, candidate.url].filter(Boolean).join(" ")).slice(0, 300)}`;
  try {
    const content = await callQwen([{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } }
      ]
    }], { vision: true, temperature: 0.05, db, session, purpose: "web_question_image_verify", pages: 1 });
    const parsed = parseAiJson(content);
    return Boolean(parsed?.accepted);
  } catch {
    return false;
  }
}

async function downloadOnlineQuestionImage(result = {}, question = {}, stem = "", index = 0, db = null, session = {}) {
  const candidates = [
    ...(Array.isArray(result.questionImages) ? result.questionImages : []),
    ...(result.questionImage ? [{ url: result.questionImage, score: 0, context: "primary image" }] : [])
  ].filter((item) => item?.url);
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5)) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    try {
      const downloaded = await fetchBufferWithTimeout(candidate.url, {}, WEB_SEARCH_IMAGE_TIMEOUT_MS);
      const normalized = await normalizeDownloadedQuestionImage(downloaded.bytes, downloaded.contentType);
      const accepted = await verifyOnlineQuestionImage(normalized.bytes, question, stem, candidate, db, session);
      if (!accepted) continue;
      const hash = createHash("sha256").update(candidate.url).update(normalized.bytes.subarray(0, 2048)).digest("hex").slice(0, 14);
      const storedName = `question-images/web/${question.id || "online"}/variant-${index + 1}-${hash}.png`;
      await saveObject(storedName, normalized.bytes, normalized.contentType);
      return {
        storedName,
        sourceUrl: candidate.url,
        width: normalized.width,
        height: normalized.height
      };
    } catch {
      // Try the next candidate image.
    }
  }
  return null;
}

function webVariantImageUrl(questionId = "", index = 0) {
  return questionId ? `/api/pending-questions/${questionId}/web-variants/${index}/image` : "";
}

async function onlineResultToVariant(question = {}, result = {}, index = 0, db = null, session = {}) {
  const extractedStem = cleanOnlineQuestionStem(result.questionText || "", question);
  if (onlineResultRejectionReason(question, extractedStem, result)) return null;
  const imageRequired = onlineQuestionRequiresDiagram(question, extractedStem);
  const image = imageRequired
    ? await downloadOnlineQuestionImage(result, question, extractedStem, index, db, session)
    : null;
  if (imageRequired && !image?.storedName) return null;
  const extractionNote = imageRequired
    ? "已从网页正文抽取纯题干，并下载网页题图到本地；未通过验图的结果已自动丢弃。"
    : "已从网页正文抽取纯题干；该题未检测到必须配图。";
  return {
    stem: extractedStem,
    options: [],
    answer: "",
    explanation: `来源：${result.url}\n搜索词：${result.query}\n说明：${extractionNote}${result.fetchError ? `\n抓取提示：${result.fetchError}` : ""}`,
    subject: question.subject,
    stage: question.stage,
    grade: question.grade,
    chapter: question.chapter,
    knowledge: question.knowledge,
    level: question.level,
    type: question.type,
    source: "AI查题·联网",
    sourceUrl: result.url,
    sourceTitle: result.title,
    sourceSnippet: result.snippet,
    searchQuery: result.query,
    webSearchScore: result.score || 0,
    questionImage: image?.storedName ? webVariantImageUrl(question.id, index) : "",
    questionImageStoredName: image?.storedName || "",
    questionImageManual: false,
    questionImageSource: image?.storedName ? "web-download" : "",
    diagramSpec: null,
    diagramSvg: "",
    imageNote: image?.storedName ? `${webSearchProviderLabel()} 联网查题·本地题图 ${index + 1}` : `${webSearchProviderLabel()} 联网查题·已抽题 ${index + 1}`
  };
}

async function findPendingQuestionOnlineVariants(db, question, session = {}) {
  const queries = buildOnlineQuestionSearchQueries(question);
  if (!queries.length) {
    const error = new Error("这道题缺少知识点或题干关键词，暂时无法联网查题。请先 AI 补全知识点。");
    error.statusCode = 422;
    throw error;
  }
  if (!isWebSearchConfigured()) {
    const error = new Error(webSearchConfigHint());
    error.statusCode = 501;
    question.webVariants = [];
    question.aiVariants = normalizeVariants(question.aiVariants || [], question).map((item) => ({ ...item, source: item.source || "AI生成" }));
    question.bankVariants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
    question.variants = [...question.aiVariants, ...question.bankVariants];
    throw error;
  }
  const found = [];
  const errors = [];
  for (const query of queries) {
    try {
      const results = await callWebSearchProvider(query);
      found.push(...results.map((item) => ({
        ...item,
        score: scoreOnlineSearchResult(question, item)
      })));
    } catch (error) {
      errors.push(error.message || "搜索失败");
    }
    if (found.length >= WEB_SEARCH_LIMIT * 2) break;
  }
  const seen = new Set();
  const rankedResults = found
    .filter((item) => {
      const key = item.url || item.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((item) => Number(item.score || 0) > -100)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(3, Math.min(6, WEB_SEARCH_LIMIT)));
  const enrichedResults = [];
  for (const result of rankedResults) {
    const enriched = await enrichWebSearchResultWithQuestion(result, question);
    if (isAcceptableOnlineQuestionResult(question, enriched)) enrichedResults.push(enriched);
    if (enrichedResults.length >= 6) break;
  }
  const ranked = enrichedResults
    .sort((a, b) => (b.questionText ? 20 : 0) + (b.score || 0) - ((a.questionText ? 20 : 0) + (a.score || 0)))
    .slice(0, 5);
  const rankedVariants = [];
  for (const item of ranked) {
    const variant = await onlineResultToVariant(question, item, rankedVariants.length, db, session);
    if (variant) rankedVariants.push(variant);
    if (rankedVariants.length >= 3) break;
  }
  const variants = normalizeVariants(rankedVariants, question, 3).map((item, index) => ({
    ...item,
    source: "AI查题·联网",
    questionImage: item.questionImageStoredName ? webVariantImageUrl(question.id, index) : item.questionImage
  }));
  if (!variants.length) {
    question.webVariants = [];
    question.variants = [
      ...normalizeVariants(question.aiVariants || [], question).map((item) => ({ ...item, source: item.source || "AI生成" })),
      ...normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }))
    ];
    const strictReason = webSearchNeedsImage(question)
      ? "联网结果已过滤：视频/小学/非同题型/无配图的几何题不会展示"
      : "联网结果已过滤：视频/小学/非同题型内容不会展示";
    const error = new Error(errors.length ? `联网查题失败：${[...new Set(errors)].slice(0, 2).join("；")}。${strictReason}` : `联网没有找到足够相似的题。${strictReason}`);
    error.statusCode = errors.length ? 502 : 422;
    throw error;
  }
  question.webVariants = variants;
  question.aiVariants = normalizeVariants(question.aiVariants || [], question).map((item) => ({ ...item, source: item.source || "AI生成" }));
  question.bankVariants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
  question.variants = [...question.webVariants, ...question.aiVariants, ...question.bankVariants];
  question.status = "pending";
  question.analysisError = "";
  question.updatedBy = sessionUserId(session);
  question.updatedAt = new Date().toISOString();
  return question;
}

function pendingQuestionsFromPages(db, upload, pages, defaults = {}) {
  return questionSourcesFromPages(pages).map((source) => {
    const pending = makePendingQuestion({
      ...defaults,
      stem: source.text,
      type: inferQuestionType(source.text),
      sourceUploadId: upload.id,
      sourceFilename: upload.filename,
      sourcePage: source.page,
      sourceImage: source.image || "",
      questionImage: "",
      sourceIndexOnPage: source.indexOnPage ?? "",
      sourceTotalOnPage: source.totalOnPage ?? "",
      sourceText: source.text,
      sourceTextLayout: source.sourceTextLayout || null,
      questionBBox: source.bbox || null,
      diagramBBoxes: source.diagramBBoxes || [],
      tenantId: upload.tenantId || DEFAULT_TENANT_ID,
      createdBy: upload.createdBy || DEFAULT_ADMIN_ID,
      updatedBy: upload.updatedBy || upload.createdBy || DEFAULT_ADMIN_ID,
      status: "needs_ai"
    });
    pending.variants = [];
    pending.aiVariants = [];
    pending.bankVariants = [];
    return pending;
  });
}

function reconcileAiCandidates(aiCandidates = [], fallbackCandidates = []) {
  if (!aiCandidates.length) return fallbackCandidates;
  if (fallbackCandidates.length <= aiCandidates.length) return aiCandidates;
  const merged = dedupeQuestionItems(aiCandidates);
  const missing = fallbackCandidates.filter((question) => {
    if (!duplicateFingerprint(question.stem)) return false;
    return !merged.some((candidate) => isLikelySameQuestionText(candidate.stem, question.stem));
  });
  return dedupeQuestionItems(merged.concat(missing));
}

async function enrichPendingQuestion(db, question, session = {}) {
  const prompt = `请把下面这道题补全为 JSON，不要 Markdown，不要额外解释。
字段只允许：answer, explanation, knowledge(array)。
knowledge 只写 1-2 个大知识点，不要写细分考点。例如“必然事件/不可能事件/随机事件/事件分类”统一写“概率”。
不要返回 stem、options、subject、stage、grade、chapter、level、type，也不要生成变式题；相似例题只在老师点击“生成相似例题”时再做。
不要把“选择题/填空题/解答题”标题、目录、页眉页脚、分值说明当成题目。不要把（1）（2）（3）小问拆成独立题，必须合并在同一道大题里。
数学符号必须全篇统一：角写 ∠1、∠ABC；平行写 m∥n；垂直写 AB⊥CD；平方写 x²；根号写 √2；分数写 1/2；不允许出现 LaTeX 命令、$、//、sqrt、^。
如果无法补全答案或解析，请在 explanation 中说明缺少的信息，不要编造成另一道题。

题目：
${formatQuestionBodyForAi(question)}`;
  const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.2, db, session, purpose: "pending_enrich" });
  const parsed = parseAiJson(content);
  const enriched = Array.isArray(parsed) ? parsed[0] || {} : parsed?.questions?.[0] || parsed || {};
  Object.assign(question, {
    answer: normalizeQuestionText(enriched.answer || question.answer),
    explanation: normalizeQuestionText(enriched.explanation || question.explanation),
    knowledge: normalizeKnowledgeTags(enriched.knowledge || question.knowledge, question.subject, question.stem),
    status: "pending",
    updatedAt: new Date().toISOString()
  });
  syncVariantGroups(question);
  applyQuestionQuality(question);
  return question;
}

async function generatePendingQuestionVariants(db, question, session = {}) {
  question.variantGenerationNonce = Number(question.variantGenerationNonce || 0) + 1;
  question.variantGeneratedAt = new Date().toISOString();
  question.aiVariants = [];
  question.webVariants = normalizeVariants(question.webVariants || [], question).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  question.bankVariants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
  question.variants = [...question.webVariants, ...question.bankVariants];
  question.analysisError = "";
  const templateResult = makeSystemTemplateVariants(question, { withDiagnostics: true });
  const templateVariants = templateResult.variants || [];
  question.variantDiagnostics = templateResult.diagnostics || null;
  if (templateVariants.length >= 3) {
    question.aiVariants = await polishSystemTemplateVariants(db, templateVariants.slice(0, 3), question, session);
    question.webVariants = normalizeVariants(question.webVariants || [], question).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
    question.bankVariants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
    question.variants = [...question.webVariants, ...question.aiVariants, ...question.bankVariants];
    question.status = "pending";
    question.analysisError = "";
    question.variantDiagnostics = templateVariantDiagnostics(question, {
      ...(question.variantDiagnostics || {}),
      templateId: question.variantDiagnostics?.templateId || detectedTemplateKey(question),
      candidateCount: question.variantDiagnostics?.candidateCount || templateVariants.length,
      normalizedCount: question.variantDiagnostics?.normalizedCount || templateVariants.length,
      valid: templateVariants,
      errors: question.variantDiagnostics?.failedReasons || [],
      selected: question.aiVariants
    });
    question.updatedBy = sessionUserId(session);
    question.updatedAt = new Date().toISOString();
    return question;
  }
  if (!ALLOW_AI_FREE_VARIANTS) {
    const error = new Error(templateOnlyVariantReason(question, templateVariants, question.variantDiagnostics));
    error.variantDiagnostics = question.variantDiagnostics;
    error.statusCode = 422;
    throw error;
  }
  const unsupportedReason = unsupportedVariantGenerationReason(question);
  if (unsupportedReason) {
    const error = new Error(unsupportedReason);
    error.variantDiagnostics = question.variantDiagnostics;
    error.statusCode = 422;
    throw error;
  }
  const prompt = `请根据下面原题生成 3 道“高度相似”的变式题，只输出 JSON，不要 Markdown。
JSON 格式：{"variants":[...]}。
每道相似例题字段：stem, options(array), answer, explanation, knowledge(array), level, type, diagramSpec, imageNote。
要求：
1. 相似例题必须和原题题型一致：选择题必须给出 A/B/C/D 选项，答案用选项字母；证明题/解答题/计算题必须设置 options=[]，answer 写完整结论或最终结果，不能写成 A/B/C/D，也不能强行改成选择题。
2. 先抽象原题模板，再做有限变化：必须保持同一大知识点、同题型、同难度、同解题方法、同图形结构类型、同选项数量、同答案形式。只允许改变量名、点名、角编号组合、数字、问法中的少量措辞；不要换成另一类题，不要扩展成新情境。
3. 数学符号必须全篇统一：角写 ∠1、∠ABC；平行写 m∥n；垂直写 AB⊥CD；平方写 x²，不写 x^2；根号写 √2；分数写 1/2；不允许出现 LaTeX 命令、$、//、sqrt、^。
4. 如果相似例题需要图，必须提供 diagramSpec，不能只写“如图”。不要复用原题配图。diagramSpec 只允许以下模板或结构：
   - 几何图：{"type":"geometry","width":420,"height":280,"points":[{"name":"A","x":120,"y":40},{"name":"B","x":320,"y":40}],"lines":[["A","B"]],"circles":[{"center":"O","r":60}],"polygons":[["A","B","C"]],"marks":[{"x":180,"y":120,"text":"∠1"},{"at":"A","dx":16,"dy":-14,"text":"60°"}]}
   - 平行线/截线/同位角/内错角/同旁内角题必须用专用模板：{"type":"geometry","template":"parallel_transversal","width":420,"height":280,"line1Label":"a","line2Label":"b","transversalLabel":"c"}，不要自由生成三条横线。
   - 三角形基础题优先用模板：{"type":"geometry","template":"triangle_basic","width":420,"height":280,"showMedian":false,"showHeight":false,"showBisector":false}
   - 三角形多线角标综合题优先用模板：{"type":"geometry","template":"triangle_cevians_angles","width":420,"height":280}，适合 D/E 在三角形边上、连接辅助线、比较 ∠1/∠2/∠3/∠4 的题。
   - 三角形中位线/中点/平行线题优先用模板：{"type":"geometry","template":"triangle_midline_parallel","width":420,"height":280}
   - 相似三角形/平行线分线段成比例题优先用模板：{"type":"geometry","template":"similar_triangles_parallel","width":420,"height":280}
   - 圆基础题优先用模板：{"type":"geometry","template":"circle_basic","width":420,"height":280,"showInscribedAngle":true}
   - 圆切线/割线/弦切角题优先用模板：{"type":"geometry","template":"circle_tangent_secant","width":420,"height":280}
   - 矩形/正方形/四边形折叠题优先用模板：{"type":"geometry","template":"quadrilateral_fold","width":420,"height":280}
   - 一次函数/坐标图优先用模板：{"type":"coordinate","template":"coordinate_linear","width":420,"height":280,"xMin":-4,"xMax":4,"yMin":-3,"yMax":5,"k":1,"b":1,"points":[{"name":"A","x":0,"y":1}]}
   - 统计图：{"type":"statistics","template":"bar_basic","width":420,"height":280,"bars":[{"label":"甲","value":12},{"label":"乙","value":18},{"label":"丙","value":15}]}
   - 全等证明、角平分线、动点最值、函数几何综合题必须优先复用以上标准模板或给出完整 points/lines/polygons/marks，不能只写“图略”。
   如果题目不需要图，diagramSpec=null。图中出现的点名、角名、线段名、坐标点必须和题干、解析一致。points 只能放真实点名，如 A、B、C、O；∠1、∠2、∠3 这类角编号必须放在 marks.text，绝不能写成点名 A1、E1、F2、G3。
5. 如果原题是平行线/截线角题，3 道变式都必须仍然是“两条直线被一条截线所截，判断平行条件/角关系”的题，必须继续使用 ∠1～∠8 的编号体系；选项应仍然是若干条件组合，不能改成计算角度、概率、面积或其他题型。
6. 整式运算、因式分解、一次函数应用、统计图计算、全等证明、角平分线、动点最值、函数几何综合必须保持同一计算/证明模型：只允许换数字、点名或少量条件，不允许换成其他题型。
7. 几何综合大题如果无法用上面列出的标准模板表达清楚点线关系，就返回 error，不要自由画图、不要硬生成。
8. 答案和解析必须自洽，选择题必须只有一个正确选项。
9. knowledge 只写 1-2 个大知识点，不要写细分考点。
10. subject 只能是：${SUBJECTS.join("、")}。
11. 不要从题库复制题，不要复用原题配图；若无法生成合格图题，请返回 {"variants":[],"error":"原因"}。

原题：
${formatQuestionBodyForAi(question)}

原题答案：${question.answer || ""}
原题解析：${question.explanation || ""}
知识点：${(question.knowledge || []).join("、")}`;
  const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.25, db, session, purpose: "pending_generate_variants" });
  const parsed = parseAiJson(content);
  if (parsed?.error) {
    const error = new Error(friendlyVariantGenerationError(parsed.error));
    error.variantDiagnostics = {
      status: "ai_refused",
      templateId: detectedTemplateKey(question),
      templateLabel: TEMPLATE_LABELS[detectedTemplateKey(question)] || detectedTemplateKey(question) || "AI自由生成",
      candidateCount: 0,
      normalizedCount: 0,
      passedCount: 0,
      failedCount: 0,
      selectedCount: 0,
      failedReasons: [normalizeQuestionText(parsed.error)],
      missingTemplate: "AI 拒绝生成或认为条件不足，需要新增对应系统模板",
      updatedAt: new Date().toISOString()
    };
    error.statusCode = 422;
    throw error;
  }
  const aiVariants = Array.isArray(parsed) ? parsed : parsed.variants || parsed.questions || [];
  const normalized = normalizeVariants(aiVariants, question).map((item) => ({ ...item, source: "AI生成" }));
  const { valid, errors } = validateGeneratedVariants(normalized, question);
  if (errors.length) {
    const error = new Error(friendlyVariantGenerationError(errors.join("；")));
    error.variantDiagnostics = {
      status: "ai_quality_failed",
      templateId: detectedTemplateKey(question),
      templateLabel: TEMPLATE_LABELS[detectedTemplateKey(question)] || detectedTemplateKey(question) || "AI自由生成",
      candidateCount: aiVariants.length,
      normalizedCount: normalized.length,
      passedCount: valid.length,
      failedCount: errors.length,
      selectedCount: 0,
      failedReasons: errors.slice(0, 8),
      missingTemplate: "AI自由生成结果未通过质检，需要新增对应系统模板",
      updatedAt: new Date().toISOString()
    };
    error.statusCode = 422;
    throw error;
  }
  if (valid.length < 3) {
    const error = new Error(`AI 只生成了 ${valid.length} 道合格题，请重试；也可以先用“题库找题”。`);
    error.variantDiagnostics = {
      status: "ai_insufficient",
      templateId: detectedTemplateKey(question),
      templateLabel: TEMPLATE_LABELS[detectedTemplateKey(question)] || detectedTemplateKey(question) || "AI自由生成",
      candidateCount: aiVariants.length,
      normalizedCount: normalized.length,
      passedCount: valid.length,
      failedCount: Math.max(0, normalized.length - valid.length),
      selectedCount: valid.length,
      failedReasons: errors.slice(0, 8),
      missingTemplate: "AI合格题不足 3 道，需要新增对应系统模板",
      updatedAt: new Date().toISOString()
    };
    error.statusCode = 422;
    throw error;
  }
  question.aiVariants = valid.slice(0, 3).map((item) => ({ ...item, source: "AI生成" }));
  question.webVariants = normalizeVariants(question.webVariants || [], question).map((item) => ({ ...item, source: item.source || "AI查题·联网" }));
  question.bankVariants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
  question.variants = [...question.webVariants, ...question.aiVariants, ...question.bankVariants];
  question.status = "pending";
  question.analysisError = "";
  question.variantDiagnostics = {
    status: "ai_passed",
    templateId: detectedTemplateKey(question),
    templateLabel: TEMPLATE_LABELS[detectedTemplateKey(question)] || detectedTemplateKey(question) || "AI自由生成",
    candidateCount: aiVariants.length,
    normalizedCount: normalized.length,
    passedCount: valid.length,
    failedCount: Math.max(0, normalized.length - valid.length),
    selectedCount: question.aiVariants.length,
    failedReasons: errors.slice(0, 8),
    missingTemplate: "",
    updatedAt: new Date().toISOString()
  };
  question.updatedBy = sessionUserId(session);
  question.updatedAt = new Date().toISOString();
  return question;
}

function formatQuestionBodyForAi(question) {
  const options = normalizeOptions(question.options).join("\n");
  return [question.stem, options].filter(Boolean).join("\n");
}

function unsupportedVariantGenerationReason(question = {}) {
  const body = [question.stem, normalizeOptions(question.options).join("\n"), question.answer, question.explanation].filter(Boolean).join("\n");
  const compact = normalizeQuestionText(body).replace(/\s+/g, "");
  const subQuestionCount = (compact.match(/[（(][一二三四五六七八九十\d]+[)）]/g) || []).length;
  const figureCount = (compact.match(/图\s*[一二三四五六七八九十\d]+/g) || []).length;
  const hasComplexGraph = /(多问|综合题|参数|表达式|过程|证明|函数关系式|动点|折叠|旋转|最值|分类讨论|共线|重合|交于|过点|点线关系|图形依赖)/.test(compact);
  const hasManualDiagramNeed = hasImageCue(compact) || Boolean(question.questionImage || question.questionImageStoredName || question.diagramSpec || question.diagramSvg);
  const supportedComplexTemplate = inferComplexGeometryTemplate(compact);
  if (supportedComplexTemplate) return "";
  if ((subQuestionCount >= 2 || figureCount >= 2) && hasComplexGraph && hasManualDiagramNeed) {
    return "复杂综合图形题暂不自动生成：当前模板库不能保证多图、多问、点线关系和过程书写完全一致。请先用“题库找题”，或把大题拆成单问后再点 AI 生成；若要生成整道大题，需要先新增专用图形模板。";
  }
  return "";
}

function templateOnlyVariantReason(question = {}, templateVariants = [], diagnostics = null) {
  const template = detectedTemplateKey(question);
  const templateLabel = template ? TEMPLATE_LABELS[template] || template : "";
  const diagnosticMessage = templateVariantDiagnosticsMessage(diagnostics);
  if (template && templateVariants.length > 0) {
    return `${diagnosticMessage || `已识别为「${templateLabel}」，但只有 ${templateVariants.length} 道通过系统校验的相似题`}。系统已停止 AI 自由编题，避免生成错题；请先用“题库找题”，或继续补这个题型模板。`;
  }
  if (template) {
    return `${diagnosticMessage || `已识别为「${templateLabel}」，但当前模板没有生成通过系统校验的相似题`}。系统已停止 AI 自由编题，避免生成错题；请先用“题库找题”，或继续补这个题型模板。`;
  }
  return `${diagnosticMessage || "当前题型还没有稳定的系统模板"}。系统已停止 AI 自由编题，避免生成错题；请先用“题库找题”，或把题目整理成更明确的题型后再生成。`;
}

function friendlyVariantGenerationError(error = "") {
  const message = normalizeQuestionText(error).replace(/\s+/g, " ").trim();
  if (!message) return "AI 生成失败，请稍后重试";
  if (/(命中模板|未命中系统模板|候选\s*\d+|通过校验|选出\s*\d+|缺口：|失败原因：)/.test(message)) {
    return message.length > 420 ? `${message.slice(0, 420)}...` : message;
  }
  if (/(证明题|解答题|题型冲突|options\/array|选项字母|强制为选择题|保持题型一致)/i.test(message)) {
    return "这类证明/解答题不能强制生成选择题。系统已优先走证明题模板；若仍出现此提示，说明当前题型暂未命中模板，请先用“题库找题”或把题干整理成完整证明题后重试。";
  }
  if (/(多问|综合题|人工绘制|无歧义|diagramSpec|标准化|不符合.*前提|点线关系|模板)/i.test(message)) {
    return "复杂综合图形题暂不自动生成：当前模板库不能保证配图、点线关系和解题过程完全一致。建议先用“题库找题”，或把大题拆成单问后再生成；需要整题变式时请先新增专用图形模板。";
  }
  return message.length > 140 ? `${message.slice(0, 140)}...` : message;
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  return String(value || "").split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean);
}

function fingerprint(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 180);
}

function duplicateFingerprint(text) {
  return normalizeQuestionText(text)
    .replace(/^题干[:：]?\s*/i, "")
    .replace(/^\s*(?:\d{1,3}\s*[.、．)]\s*|[一二三四五六七八九十]+[、.．]\s*)?/, "")
    .replace(/^\s*[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]\s*/, "")
    .replace(/^\s*\d+(?:\.\d+)?\s*分\s*/, "")
    .toLowerCase()
    .replace(/[|｜\-—_…·，。！？；：、,.!?;:()[\]{}（）【】《》<>“”"'`\s]/g, "")
    .slice(0, 260);
}

function textSimilarity(a = "", b = "") {
  const left = duplicateFingerprint(a);
  const right = duplicateFingerprint(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const min = Math.min(left.length, right.length);
  const max = Math.max(left.length, right.length);
  if (min >= 40 && (left.includes(right) || right.includes(left))) {
    return min / max >= 0.55 ? 0.96 : 0.72;
  }
  const grams = (value) => {
    const set = new Set();
    for (let index = 0; index <= value.length - 3; index += 1) set.add(value.slice(index, index + 3));
    return set;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }
  return shared / (leftGrams.size + rightGrams.size - shared);
}

function isLikelySameQuestionText(a = "", b = "") {
  const left = duplicateFingerprint(a);
  const right = duplicateFingerprint(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const min = Math.min(left.length, right.length);
  if (min < 28) return false;
  return textSimilarity(left, right) >= 0.84;
}

function questionCompletenessScore(question = {}) {
  let score = Math.min(6, duplicateFingerprint(question.stem).length / 80);
  if (normalizeQuestionText(question.answer).length > 1) score += 4;
  if (normalizeQuestionText(question.explanation).length > 8) score += 4;
  if (normalizeOptions(question.options).length) score += 2;
  if (question.status && question.status !== "needs_ai") score += 1;
  if (question.sourceImage) score += 0.5;
  return score;
}

function mergeDuplicateQuestion(primary = {}, duplicate = {}) {
  const merged = { ...primary };
  for (const key of ["answer", "explanation", "subject", "stage", "level", "grade", "chapter", "type", "sourceImage", "sourceText"]) {
    if (!merged[key] && duplicate[key]) merged[key] = duplicate[key];
  }
  if (!normalizeOptions(merged.options).length && normalizeOptions(duplicate.options).length) merged.options = duplicate.options;
  if (!parseTags(merged.knowledge).length && parseTags(duplicate.knowledge).length) merged.knowledge = duplicate.knowledge;
  if (!Array.isArray(merged.variants) || !merged.variants.length) merged.variants = duplicate.variants || [];
  return merged;
}

function dedupeQuestionItems(items = []) {
  const kept = [];
  for (const item of items) {
    const tenantId = item.tenantId || DEFAULT_TENANT_ID;
    const duplicateIndex = kept.findIndex((candidate) =>
      (candidate.tenantId || DEFAULT_TENANT_ID) === tenantId
      && isLikelySameQuestionText(candidate.stem, item.stem)
    );
    if (duplicateIndex === -1) {
      kept.push(item);
      continue;
    }
    const current = kept[duplicateIndex];
    kept[duplicateIndex] = questionCompletenessScore(item) > questionCompletenessScore(current)
      ? mergeDuplicateQuestion(item, current)
      : mergeDuplicateQuestion(current, item);
  }
  return kept;
}

function addActivity(db, action, detail, session = {}) {
  db.activity.unshift(stampTenant({
    id: randomUUID(),
    action,
    detail,
    createdAt: new Date().toISOString()
  }, session));
  db.activity = db.activity.slice(0, 80);
}

function fileHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function uploadKey(upload) {
  return `${upload.tenantId || DEFAULT_TENANT_ID}:${upload.hash || `${upload.filename || ""}:${upload.size || 0}`}`;
}

function dedupeUploads(uploads = []) {
  const seen = new Map();
  for (const upload of uploads) {
    const key = uploadKey(upload);
    if (!seen.has(key)) {
      seen.set(key, { ...upload, uploadCount: upload.uploadCount || 1 });
      continue;
    }
    const kept = seen.get(key);
    const count = (kept.uploadCount || 1) + (upload.uploadCount || 1);
    const keptTime = new Date(kept.updatedAt || kept.createdAt || 0).getTime();
    const nextTime = new Date(upload.updatedAt || upload.createdAt || 0).getTime();
    if (nextTime > keptTime) {
      seen.set(key, { ...upload, uploadCount: count });
    } else {
      kept.uploadCount = count;
    }
  }
  return [...seen.values()].sort((a, b) => {
    const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bt - at;
  });
}

function aiMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function textForTokenEstimate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textForTokenEstimate).join("\n");
  if (typeof value === "object") {
    if (value.type === "image_url") return "[image]";
    return Object.entries(value)
      .filter(([key]) => key !== "image_url" && key !== "url")
      .map(([, entry]) => textForTokenEstimate(entry))
      .join("\n");
  }
  return String(value);
}

function estimateAiTokens(messages = [], output = "") {
  const inputText = messages.map((message) => textForTokenEstimate(message.content || message)).join("\n");
  return {
    inputTokens: Math.max(1, Math.ceil(inputText.length / 2)),
    outputTokens: Math.max(0, Math.ceil(String(output || "").length / 2))
  };
}

function tenantAiLimit(db, tenantId) {
  const org = tenantOrg(db, tenantId);
  return Number(org.limits?.monthlyAiTokens || DEFAULT_MONTHLY_AI_TOKENS);
}

function tenantAiPageLimit(db, tenantId) {
  const org = tenantOrg(db, tenantId);
  return Number(org.limits?.monthlyAiPages || DEFAULT_MONTHLY_AI_PAGES);
}

function tenantOrg(db, tenantId) {
  return normalizeOrganization(db.organizations.find((item) => item.id === tenantId) || defaultOrganization());
}

function ensureTenantEntitlement(db, session, feature = "general") {
  const org = tenantOrg(db, sessionTenantId(session));
  const status = subscriptionStatus(org);
  if (["disabled", "expired", "past_due"].includes(status)) {
    const label = {
      disabled: "机构已停用",
      expired: "套餐已到期",
      past_due: "套餐欠费"
    }[status] || "套餐不可用";
    throw httpError(402, `${label}，请续费或联系管理员后继续使用。`);
  }
  if (feature === "batch_analysis" && !org.limits?.allowBatchAnalysis) {
    throw httpError(402, "当前套餐不支持批量分析，请升级套餐后继续。");
  }
  return org;
}

function tenantUsageSummary(db, session) {
  const tenantId = sessionTenantId(session);
  const org = tenantOrg(db, tenantId);
  const month = aiMonthKey();
  const usedTokens = tenantAiUsed(db, tenantId, month);
  const usedPages = tenantAiPagesUsed(db, tenantId, month);
  const users = db.users.filter((user) => (user.tenantId || DEFAULT_TENANT_ID) === tenantId && user.status !== "disabled").length;
  const questions = db.questions.filter((question) => (question.tenantId || DEFAULT_TENANT_ID) === tenantId).length;
  return {
    month,
    plan: org.plan,
    planName: planConfig(org.plan).name,
    subscriptionStatus: subscriptionStatus(org),
    limits: org.limits,
    used: {
      aiTokens: usedTokens,
      aiPages: usedPages,
      users,
      questions
    },
    remaining: {
      aiTokens: Math.max(0, Number(org.limits.monthlyAiTokens || 0) - usedTokens),
      aiPages: Math.max(0, Number(org.limits.monthlyAiPages || 0) - usedPages),
      users: Math.max(0, Number(org.limits.maxUsers || 0) - users),
      questions: Math.max(0, Number(org.limits.maxQuestions || 0) - questions)
    }
  };
}

function ensureQuestionCapacity(db, session, incomingCount = 1) {
  const org = ensureTenantEntitlement(db, session, "questions");
  const tenantId = sessionTenantId(session);
  const existingCount = db.questions.filter((question) => (question.tenantId || DEFAULT_TENANT_ID) === tenantId).length;
  const limit = Number(org.limits?.maxQuestions || 0);
  if (limit && existingCount + incomingCount > limit) {
    throw httpError(402, `当前套餐题库容量为 ${limit} 题，已入库 ${existingCount} 题，请升级套餐或减少本次入库数量。`);
  }
  return org;
}

function tenantAiUsed(db, tenantId, month = aiMonthKey()) {
  return db.aiUsage
    .filter((item) => (item.tenantId || DEFAULT_TENANT_ID) === tenantId && item.month === month)
    .reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
}

function tenantAiPagesUsed(db, tenantId, month = aiMonthKey()) {
  return db.aiUsage
    .filter((item) => (item.tenantId || DEFAULT_TENANT_ID) === tenantId && item.month === month)
    .reduce((sum, item) => sum + Number(item.pages || 0), 0);
}

function ensureAiQuota(db, session, estimatedTokens, estimatedPages = 0) {
  ensureTenantEntitlement(db, session, "ai");
  const tenantId = sessionTenantId(session);
  const used = tenantAiUsed(db, tenantId);
  const limit = tenantAiLimit(db, tenantId);
  if (used + estimatedTokens > limit) {
    throw httpError(402, `本月 AI 额度不足：已用约 ${used} tokens，额度 ${limit} tokens`);
  }
  const pagesUsed = tenantAiPagesUsed(db, tenantId);
  const pageLimit = tenantAiPageLimit(db, tenantId);
  if (estimatedPages && pagesUsed + estimatedPages > pageLimit) {
    throw httpError(402, `本月 AI 分析页数不足：已用 ${pagesUsed} 页，额度 ${pageLimit} 页`);
  }
}

function recordAiUsage(db, session, usage = {}) {
  if (!db) return;
  db.aiUsage.unshift(stampTenant({
    id: randomUUID(),
    month: aiMonthKey(),
    provider: "qwen",
    model: usage.model || "",
    purpose: usage.purpose || "general",
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
    pages: usage.pages || 0,
    createdAt: new Date().toISOString()
  }, session));
  db.aiUsage = db.aiUsage.slice(0, 5000);
}

async function callQwen(messages, { vision = false, temperature = 0.35, db = null, session = {}, purpose = "general", pages = 0 } = {}) {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("尚未配置 QWEN_API_KEY");
  const estimated = estimateAiTokens(messages);
  if (db) ensureAiQuota(db, session, estimated.inputTokens, pages);
  const endpoint = `${QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
      body: JSON.stringify({
        model: vision ? QWEN_VISION_MODEL : QWEN_MODEL,
        messages,
        temperature
      })
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`千问接口 ${Math.round(QWEN_TIMEOUT_MS / 1000)} 秒内没有响应，请检查网络、Key、模型名或稍后重试`);
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `千问接口返回 ${response.status}`);
  }
  const content = payload.choices?.[0]?.message?.content || "";
  const outputEstimate = estimateAiTokens([], content);
  recordAiUsage(db, session, {
    model: vision ? QWEN_VISION_MODEL : QWEN_MODEL,
    purpose,
    pages,
    inputTokens: payload.usage?.prompt_tokens || estimated.inputTokens,
    outputTokens: payload.usage?.completion_tokens || outputEstimate.outputTokens
  });
  if (db) await writeDb(db);
  return content;
}

function parseAiJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] || raw;
  const start = Math.min(...["{", "["].map((char) => {
    const index = fenced.indexOf(char);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  }));
  const candidate = Number.isFinite(start) ? fenced.slice(start) : fenced;
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  const clipped = end > 0 ? candidate.slice(0, end + 1) : candidate;
  const attempts = [
    candidate,
    clipped,
    repairJsonEscapes(candidate),
    repairJsonEscapes(clipped)
  ];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next repair strategy.
    }
  }
  throw new Error("AI 返回内容不是可解析 JSON");
}

function repairJsonEscapes(value = "") {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function uploadAssetUrl(uploadId, name = "file") {
  return `/api/uploads/${uploadId}/${name}`;
}

function uploadPageAssetUrl(uploadId, page) {
  return `/api/uploads/${uploadId}/pages/${page}`;
}

function questionCropAssetUrl(uploadId, page, index = 0) {
  return `/api/uploads/${uploadId}/question-crops/${Number(page) || 1}/${Math.max(0, Number(index) || 0)}`;
}

function pageImageStoredNameForUpload(upload, page) {
  const renderedPage = upload.pageImages?.find((item) => Number(item.page) === Number(page.page));
  if (page.image?.startsWith("/api/uploads/")) {
    if (page.image.includes("/pages/")) {
      return renderedPage?.storedName
        || `pages/${upload.id}/page-${String(page.page).padStart(2, "0")}.png`;
    }
    return upload.storedName;
  }
  return "";
}

async function pageImagePathForUpload(upload, page) {
  const storedName = pageImageStoredNameForUpload(upload, page);
  if (!storedName) return "";
  try {
    return await readObjectToTemp(storedName, path.extname(storedName) || ".png");
  } catch {
    return "";
  }
}

async function readImageSize(imagePath) {
  const buffer = await fs.readFile(imagePath);
  if (buffer.length >= 24 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeQuestionBBox(input = null, imageSize = null, pageNumber = null, source = "") {
  if (!input || typeof input !== "object") return null;
  const imageWidth = Number(imageSize?.width || input.imageWidth || input.pageWidth || 0);
  const imageHeight = Number(imageSize?.height || input.imageHeight || input.pageHeight || 0);
  let x = input.x ?? input.left ?? 0;
  let y = input.y ?? input.top ?? 0;
  let width = input.width;
  let height = input.height;
  if ((width === undefined || height === undefined) && input.right !== undefined && input.bottom !== undefined) {
    width = Number(input.right) - Number(x);
    height = Number(input.bottom) - Number(y);
  }
  x = Number(x);
  y = Number(y);
  width = Number(width);
  height = Number(height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  const looksNormalized = Math.max(Math.abs(x), Math.abs(y), Math.abs(width), Math.abs(height)) <= 1.05;
  if (looksNormalized && imageWidth && imageHeight) {
    x *= imageWidth;
    y *= imageHeight;
    width *= imageWidth;
    height *= imageHeight;
  }

  if (imageWidth && imageHeight) {
    x = clampNumber(x, 0, imageWidth - 1);
    y = clampNumber(y, 0, imageHeight - 1);
    width = clampNumber(width, 1, imageWidth - x);
    height = clampNumber(height, 1, imageHeight - y);
  }

  return {
    page: Number(input.page || pageNumber || 0) || "",
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    imageWidth: imageWidth ? Math.round(imageWidth) : Number(input.imageWidth || 0) || "",
    imageHeight: imageHeight ? Math.round(imageHeight) : Number(input.imageHeight || 0) || "",
    unit: "px",
    source: source || input.source || "unknown",
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : ""
  };
}

function bboxSlug(bbox = null) {
  if (!bbox) return "";
  return `-bbox-${Math.round(Number(bbox.x || 0))}-${Math.round(Number(bbox.y || 0))}-${Math.round(Number(bbox.width || 0))}-${Math.round(Number(bbox.height || 0))}`;
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(stderr || `${command} failed`));
    });
  });
}

async function cropImageToFile(sourcePath, outputPath, rect) {
  try {
    const sharpModule = await import("sharp");
    await sharpModule.default(sourcePath)
      .extract({
        left: Math.max(0, Math.round(rect.left || 0)),
        top: Math.max(0, Math.round(rect.top || 0)),
        width: Math.max(1, Math.round(rect.width || 1)),
        height: Math.max(1, Math.round(rect.height || 1))
      })
      .png()
      .toFile(outputPath);
    return;
  } catch (error) {
    if (process.platform !== "darwin") throw error;
  }
  await runProcess("sips", [
    "-c", String(Math.round(rect.height)), String(Math.round(rect.width)),
    "--cropOffset", String(Math.round(rect.top)), String(Math.round(rect.left)),
    sourcePath,
    "--out", outputPath
  ]);
}

async function pageImageSizeForUpload(upload, pageNumber) {
  const page = (upload.pages || []).find((item) => Number(item.page) === Number(pageNumber)) || { page: pageNumber };
  const sourcePath = await pageImagePathForUpload(upload, page);
  if (!sourcePath) return { sourcePath: "", width: 0, height: 0 };
  const size = await readImageSize(sourcePath);
  return { sourcePath, ...size };
}

function estimateQuestionBBoxFromLayout(question = {}, size = {}) {
  const width = Number(size.width || 0);
  const height = Number(size.height || 0);
  if (!width || !height) return null;
  const layout = question.sourceTextLayout || {};
  const topMargin = Math.round(height * 0.045);
  const bottomMargin = Math.round(height * 0.035);
  const left = Math.round(width * 0.025);
  const cropWidth = Math.round(width * 0.95);
  const usableHeight = Math.max(1, height - topMargin - bottomMargin);

  if (Number.isFinite(Number(layout.startLine)) && Number.isFinite(Number(layout.endLine)) && Number(layout.totalLines) > 1) {
    const totalLines = Math.max(2, Number(layout.totalLines));
    const lineHeight = usableHeight / totalLines;
    const startLine = clampNumber(layout.startLine, 0, totalLines - 1);
    const endLine = clampNumber(layout.endLine, startLine, totalLines - 1);
    const pad = Math.max(18, lineHeight * 1.4);
    const y = Math.max(0, Math.round(topMargin + startLine * lineHeight - pad));
    const bottom = Math.min(height, Math.round(topMargin + (endLine + 1) * lineHeight + pad * 1.8));
    return normalizeQuestionBBox({
      page: firstPageNumber(question.sourcePage),
      x: left,
      y,
      width: cropWidth,
      height: Math.max(24, bottom - y),
      source: "text-layout",
      confidence: 0.68
    }, size, firstPageNumber(question.sourcePage), "text-layout");
  }

  const index = Math.max(0, Number(question.sourceIndexOnPage) || 0);
  const total = Math.max(1, Math.min(Number(question.sourceTotalOnPage) || 1, 10));
  const bandHeight = Math.ceil(usableHeight / total);
  const cropHeight = Math.min(height, Math.ceil(bandHeight * 1.22));
  const y = Math.max(0, Math.min(height - cropHeight, topMargin + index * bandHeight - Math.round(bandHeight * 0.1)));
  return normalizeQuestionBBox({
    page: firstPageNumber(question.sourcePage),
    x: left,
    y,
    width: cropWidth,
    height: cropHeight,
    source: "index-estimate",
    confidence: 0.45
  }, size, firstPageNumber(question.sourcePage), "index-estimate");
}

function unionQuestionBBoxes(boxes = [], imageSize = {}) {
  const normalized = boxes
    .map((box) => normalizeQuestionBBox(box, imageSize, box?.page || 0, box?.source || "union"))
    .filter(Boolean);
  if (!normalized.length) return null;
  const left = Math.min(...normalized.map((box) => Number(box.x || 0)));
  const top = Math.min(...normalized.map((box) => Number(box.y || 0)));
  const right = Math.max(...normalized.map((box) => Number(box.x || 0) + Number(box.width || 0)));
  const bottom = Math.max(...normalized.map((box) => Number(box.y || 0) + Number(box.height || 0)));
  return normalizeQuestionBBox({
    page: normalized[0].page || "",
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    imageWidth: imageSize.width || normalized[0].imageWidth,
    imageHeight: imageSize.height || normalized[0].imageHeight,
    source: normalized.some((box) => box.source === "manual") ? "manual" : normalized.some((box) => box.source === "ocr-layout") ? "ocr-layout" : "bbox-union",
    confidence: Math.min(...normalized.map((box) => Number(box.confidence || 0.6)))
  }, imageSize, normalized[0].page, "bbox-union");
}

function bboxCenter(box = {}) {
  return {
    x: Number(box.x || 0) + Number(box.width || 0) / 2,
    y: Number(box.y || 0) + Number(box.height || 0) / 2
  };
}

function attachDiagramBBoxes(question = {}, regions = [], questionRegion = null) {
  if (!regions.length) return [];
  const number = extractTopQuestionNumber(question.stem || question.sourceText || "");
  const qbox = normalizeQuestionBBox(question.questionBBox || questionRegion?.bbox || null);
  const qcenter = qbox ? bboxCenter(qbox) : null;
  return regions.filter((region) => {
    if (!region?.bbox) return false;
    if (number && region.questionNumber && String(region.questionNumber) === String(number)) return true;
    if (questionRegion?.questionNumber && region.questionNumber && String(region.questionNumber) === String(questionRegion.questionNumber)) return true;
    if (!qbox || !qcenter) return false;
    const dbox = region.bbox;
    const dcenter = bboxCenter(dbox);
    const verticalNear = dcenter.y >= qbox.y - qbox.height * 0.35 && dcenter.y <= qbox.y + qbox.height * 1.25;
    const horizontalNear = dcenter.x >= qbox.x - qbox.width * 0.2 && dcenter.x <= qbox.x + qbox.width * 1.2;
    return verticalNear && horizontalNear;
  }).map((region) => region.bbox);
}

async function ensureQuestionBBox(upload, question) {
  const page = firstPageNumber(question.sourcePage);
  if (!page) return null;
  const size = await pageImageSizeForUpload(upload, page);
  if (!size.width || !size.height) return null;
  const existing = normalizeQuestionBBox(question.questionBBox || question.bbox || null, size, page, question.questionBBox?.source || "imported");
  if (existing) {
    const diagramBoxes = Array.isArray(question.diagramBBoxes) ? question.diagramBBoxes : [];
    const merged = diagramBoxes.length ? unionQuestionBBoxes([existing, ...diagramBoxes], size) : existing;
    question.questionBBox = merged || existing;
    return question.questionBBox;
  }
  const estimated = estimateQuestionBBoxFromLayout(question, size);
  if (estimated) question.questionBBox = estimated;
  return estimated;
}

async function ensureQuestionCrop(upload, pageNumber, index = 0, total = 1, bbox = null) {
  const safeIndex = Math.max(0, Number(index) || 0);
  const safePage = Number(pageNumber) || 1;
  const storedName = `question-images/crops/${upload.id}/page-${safePage}-q-${safeIndex}${bboxSlug(bbox)}.png`;
  if (await objectExists(storedName)) return storedName;

  const outputDir = FILE_STORAGE_DRIVER === "s3"
    ? path.join(dataDir, ".tmp", "question-crops", upload.id)
    : path.dirname(localObjectPath(storedName));
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `page-${safePage}-q-${safeIndex}.png`);

  const { sourcePath, width, height } = await pageImageSizeForUpload(upload, safePage);
  if (!width || !height) return "";

  const normalizedBBox = normalizeQuestionBBox(bbox, { width, height }, safePage, bbox?.source || "auto");
  if (normalizedBBox) {
    await cropImageToFile(sourcePath, outputPath, {
      left: normalizedBBox.x,
      top: normalizedBBox.y,
      width: normalizedBBox.width,
      height: normalizedBBox.height
    });
    await saveObject(storedName, await fs.readFile(outputPath), "image/png");
    return storedName;
  }

  const count = Math.max(1, Math.min(Number(total) || 1, 8));
  const topMargin = Math.round(height * 0.05);
  const bottomMargin = Math.round(height * 0.04);
  const usableHeight = Math.max(1, height - topMargin - bottomMargin);
  const bandHeight = Math.ceil(usableHeight / count);
  const cropHeight = Math.min(height, Math.ceil(bandHeight * 1.25));
  const y = Math.max(0, Math.min(height - cropHeight, topMargin + safeIndex * bandHeight - Math.round(bandHeight * 0.12)));
  const cropWidth = width;
  const x = 0;

  await cropImageToFile(sourcePath, outputPath, { left: x, top: y, width: cropWidth, height: cropHeight });
  await saveObject(storedName, await fs.readFile(outputPath), "image/png");
  return storedName;
}

function firstPageNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function pendingQuestionImageUrl(question) {
  return `/api/pending-questions/${question.id}/image`;
}

async function autoBindQuestionCrop(upload, question, { force = false } = {}) {
  if (!upload || !question || (!force && question.questionImageStoredName)) return false;
  const page = firstPageNumber(question.sourcePage);
  if (!page) return false;
  const index = Number.isFinite(Number(question.sourceIndexOnPage)) ? Number(question.sourceIndexOnPage) : 0;
  const total = Number.isFinite(Number(question.sourceTotalOnPage)) ? Number(question.sourceTotalOnPage) : 1;
  try {
    const bbox = await ensureQuestionBBox(upload, question);
    const storedName = await ensureQuestionCrop(upload, page, index, total, bbox);
    if (!storedName) return false;
    question.questionImageStoredName = storedName;
    question.questionImage = pendingQuestionImageUrl(question);
    question.questionImageManual = false;
    question.questionImageSource = bbox?.source === "ocr-layout"
      ? "bbox-ocr-layout"
      : bbox?.source === "text-layout"
        ? "bbox-text-layout"
        : bbox
          ? "bbox-crop"
          : "auto-crop";
    question.updatedAt = new Date().toISOString();
    applyQuestionQuality(question);
    return true;
  } catch {
    return false;
  }
}

async function bindCandidateQuestionImages(upload, questions = []) {
  let bound = 0;
  for (const question of questions) {
    if (await autoBindQuestionCrop(upload, question)) bound += 1;
  }
  return bound;
}

function isTextReliable(text) {
  const cleaned = normalizeExtractedText(text);
  const withoutPdfMarkers = cleaned
    .replace(/\*+/g, "")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "")
    .replace(/第\s*\d+\s*页/g, "")
    .trim();
  const useful = (withoutPdfMarkers.match(/[\p{Script=Han}A-Za-z0-9=+\-×÷*/().,，。？！：；、]/gu) || []).length;
  return withoutPdfMarkers.length >= 80 && useful >= 50 && !looksLikeGarbledText(withoutPdfMarkers);
}

function chunkPagesForAi(pages) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const page of pages) {
    const text = normalizeExtractedText(page.text || "");
    if (!text) continue;
    const block = `【第 ${page.page} 页】\n${text}`;
    if (current.length && size + block.length > MAX_TEXT_AI_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ ...page, block });
    size += block.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function questionSourcesFromPages(pages) {
  const sources = [];
  for (const page of pages) {
    if (isSkippableMaterialPage(page)) continue;
    const pageSources = [];
    const parts = splitQuestionsFromText(page.text || "");
    let searchCursor = 0;
    if (parts.length > 1) {
      for (const text of parts) {
        if (!looksLikeQuestionCandidate(text)) continue;
        const sourceTextLayout = locateSourceTextInPage(page.text || "", text, searchCursor);
        if (sourceTextLayout?.endOffset) searchCursor = sourceTextLayout.endOffset;
        pageSources.push({ page: page.page, text, image: page.image || "", sourceTextLayout });
      }
    } else if (isTextReliable(page.text) && looksLikeQuestionCandidate(page.text)) {
      pageSources.push({
        page: page.page,
        text: page.text,
        image: page.image || "",
        sourceTextLayout: locateSourceTextInPage(page.text || "", page.text || "", 0)
      });
    }
    const layoutRegions = normalizedLayoutQuestionRegions(page);
    const diagramRegions = normalizedLayoutDiagramRegions(page);
    const usedRegions = new Set();
    pageSources.forEach((source, index) => {
      const region = matchLayoutRegionToSource(source, index, layoutRegions, usedRegions);
      const diagramBBoxes = attachDiagramBBoxes(
        { stem: source.text, sourceText: source.text, questionBBox: region?.bbox || source.bbox || null },
        diagramRegions,
        region
      );
      const mergedBBox = diagramBBoxes.length && region?.bbox
        ? unionQuestionBBoxes([region.bbox, ...diagramBBoxes], { width: region.bbox.imageWidth, height: region.bbox.imageHeight })
        : region?.bbox || source.bbox || null;
      sources.push({
        ...source,
        bbox: mergedBBox,
        diagramBBoxes,
        layoutRegion: region || null,
        indexOnPage: index,
        totalOnPage: pageSources.length
      });
    });
  }
  return sources;
}

function normalizedLayoutQuestionRegions(page = {}) {
  const layout = page.layoutBlocks || page.layout || {};
  const regions = Array.isArray(layout.questionRegions) ? layout.questionRegions : [];
  return regions
    .map((region, index) => ({
      ...region,
      index: Number.isFinite(Number(region.index)) ? Number(region.index) : index,
      questionNumber: String(region.questionNumber || "").trim(),
      textHint: String(region.textHint || "").trim(),
      bbox: normalizeQuestionBBox(region.bbox || region.questionBBox || null, {
        width: layout.imageWidth || region.imageWidth || 0,
        height: layout.imageHeight || region.imageHeight || 0
      }, page.page, "ocr-layout"),
      confidence: Number.isFinite(Number(region.confidence)) ? Number(region.confidence) : ""
    }))
    .filter((region) => region.bbox)
    .sort((a, b) => Number(a.index) - Number(b.index));
}

function normalizedLayoutDiagramRegions(page = {}) {
  const layout = page.layoutBlocks || page.layout || {};
  const regions = Array.isArray(layout.diagramRegions) ? layout.diagramRegions : [];
  return regions
    .map((region, index) => ({
      ...region,
      index: Number.isFinite(Number(region.index)) ? Number(region.index) : index,
      questionNumber: String(region.questionNumber || region.belongsToQuestionNumber || "").trim(),
      kind: String(region.kind || "diagram"),
      bbox: normalizeQuestionBBox(region.bbox || null, {
        width: layout.imageWidth || region.imageWidth || 0,
        height: layout.imageHeight || region.imageHeight || 0
      }, page.page, "ocr-diagram"),
      confidence: Number.isFinite(Number(region.confidence)) ? Number(region.confidence) : ""
    }))
    .filter((region) => region.bbox)
    .sort((a, b) => Number(a.index) - Number(b.index));
}

function extractTopQuestionNumber(text = "") {
  const value = normalizeQuestionText(text).trim();
  const match = /^(?:第\s*)?(\d{1,3})\s*[.、)]/.exec(value);
  if (match) return match[1];
  const chinese = /^([一二三四五六七八九十]{1,3})[、.．]/.exec(value);
  return chinese ? chinese[1] : "";
}

function matchLayoutRegionToSource(source = {}, sourceIndex = 0, regions = [], used = new Set()) {
  if (!regions.length) return null;
  const number = extractTopQuestionNumber(source.text);
  if (number) {
    const byNumber = regions.find((region) => !used.has(region.index) && region.questionNumber === number);
    if (byNumber) {
      used.add(byNumber.index);
      return byNumber;
    }
  }
  const byIndex = regions.find((region) => !used.has(region.index) && Number(region.index) === Number(sourceIndex));
  if (byIndex) {
    used.add(byIndex.index);
    return byIndex;
  }
  const fallback = regions.find((region) => !used.has(region.index));
  if (fallback) {
    used.add(fallback.index);
    return fallback;
  }
  return null;
}

function locateSourceTextInPage(pageText = "", sourceText = "", startOffset = 0) {
  const pageValue = String(pageText || "");
  const sourceValue = String(sourceText || "").trim();
  if (!pageValue || !sourceValue) return null;
  let start = pageValue.indexOf(sourceValue, Math.max(0, Number(startOffset) || 0));
  if (start === -1) {
    const compactNeedle = sourceValue.replace(/\s+/g, "").slice(0, 50);
    if (compactNeedle.length >= 12) {
      const lines = pageValue.split(/\n/);
      let offset = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const compactLine = lines.slice(index, Math.min(lines.length, index + 6)).join("").replace(/\s+/g, "");
        if (compactLine.includes(compactNeedle)) {
          start = offset;
          break;
        }
        offset += lines[index].length + 1;
      }
    }
  }
  if (start === -1) return null;
  const end = Math.min(pageValue.length, start + sourceValue.length);
  const before = pageValue.slice(0, start);
  const inside = pageValue.slice(start, end);
  const totalLines = Math.max(1, pageValue.split(/\n/).length);
  const startLine = before ? before.split(/\n/).length - 1 : 0;
  const lineCount = Math.max(1, inside.split(/\n/).length);
  return {
    startOffset: start,
    endOffset: end,
    startLine,
    endLine: Math.min(totalLines - 1, startLine + lineCount - 1),
    totalLines
  };
}

function isSkippableMaterialPage(page = {}) {
  const value = normalizeExtractedText(page.text || "");
  if (!value) return false;
  const hasQuestion = looksLikeQuestionCandidate(value);
  const catalogLike = /(?:^|\n)\s*(?:目录|目\s*录|contents?|前言|序言|编写说明|使用说明|图书在版|版权信息|责任编辑|出版发行)\s*(?:\n|$)/i.test(value)
    || /(?:第[一二三四五六七八九十]+章|专题[一二三四五六七八九十\d]+).{0,30}\.{2,}\s*\d+/.test(value);
  const coverLike = value.length < 160 && /(?:名校题库|测试卷|练习册|目录|主编|出版社|班级|姓名)/.test(value) && !hasQuestion;
  return (catalogLike && !hasQuestion) || coverLike;
}

function isAnswerMaterialPage(page = {}) {
  const value = normalizeExtractedText(page.text || "");
  if (!value) return false;
  return /(?:^|\n)\s*(?:参考答案|答案解析|答案与解析|参考答案与解析|答案详解)\b/.test(value)
    || /(?:^|\n)\s*(?:一、|二、|三、)?\s*(?:选择题|填空题|解答题)?\s*答案[:：]/.test(value);
}

function suggestedAnalysisRange(pages = []) {
  const candidates = pages.filter((page) => !isSkippableMaterialPage(page));
  const usable = candidates.length ? candidates : pages;
  const numbers = usable.map((page) => Number(page.page)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return "";
  const start = numbers[0];
  const end = numbers[numbers.length - 1];
  return start === end ? String(start) : `${start}-${end}`;
}

function looksLikeQuestionCandidate(text = "") {
  const value = normalizeExtractedText(text);
  if (value.length < 12) return false;
  if (/^[一二三四五六七八九十]+[、.．]\s*[^，。！？\n]{0,24}题(?:\s*[（(][^）)]*分[^）)]*[）)])?\s*$/i.test(value)) {
    return false;
  }
  if (/^[A-Z]卷\s*(?:[（(].*?[）)])?\s*$/i.test(value)) return false;
  if (/^(?:第[一二三四五六七八九十]+章|.*测试卷|.*试卷|A卷|B卷|满分|时间|班级|姓名|学号|得分)/.test(value) && !/\d+[.、)]/.test(value)) {
    return false;
  }
  if (/名校题库|第\s*\d+\s*页|--\s*\d+\s+of\s+\d+\s*--/i.test(value) && value.length < 80) return false;
  return /\d{1,3}[.、)]|[（(]\d{1,3}[)）]|A[.、]|B[.、]|C[.、]|D[.、]|（\s*）|\(\s*\)|求|计算|证明|解答|选择|填空/.test(value);
}

function chunkQuestionSources(sources) {
  const chunks = [];
  for (let index = 0; index < sources.length; index += AI_QUESTIONS_PER_BATCH) {
    chunks.push(sources.slice(index, index + AI_QUESTIONS_PER_BATCH));
  }
  return chunks;
}

function parsePageRange(value, maxPage = 0) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const pages = new Set();
  for (const part of raw.split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-~到]\s*(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.max(start, Number(range[2]));
      for (let page = start; page <= end; page += 1) {
        if (!maxPage || page <= maxPage) pages.add(page);
      }
      continue;
    }
    const page = Number(part);
    if (Number.isInteger(page) && page > 0 && (!maxPage || page <= maxPage)) pages.add(page);
  }
  return pages.size ? [...pages].sort((a, b) => a - b) : null;
}

async function extractPdfWithPdfParse(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const all = await parser.getText();
    const total = all.total || all.pages || 0;
    const pages = [];
    if (total && total <= 120) {
      for (let page = 1; page <= total; page += 1) {
        const result = await parser.getText({ first: page, last: page });
        pages.push({ page, text: normalizeExtractedText(result.text) });
      }
    }
    const text = normalizeExtractedText(pages.map((p) => p.text).join("\n\n") || all.text);
    return { text, pages, pageCount: total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeExtractedText(result.value || "");
}

async function renderPdfPageImages(filePath, uploadId) {
  const outputDir = FILE_STORAGE_DRIVER === "s3"
    ? path.join(dataDir, ".tmp", "pages", uploadId, randomUUID())
    : path.join(pageImageDir, uploadId);
  await fs.mkdir(outputDir, { recursive: true });
  const prefix = path.join(outputDir, "page");
  const args = ["-png", "-r", String(PDF_RENDER_DPI), filePath, prefix];
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dataDir, ".cache") };
  await fs.mkdir(env.XDG_CACHE_HOME, { recursive: true });
  await new Promise((resolve) => {
    const child = spawn("pdftoppm", args, { stdio: ["ignore", "ignore", "ignore"], env });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
  const files = (await fs.readdir(outputDir).catch(() => []))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (files.length) {
    const pages = [];
    for (let index = 0; index < files.length; index += 1) {
      const name = files[index];
      const storedName = `pages/${uploadId}/${name}`;
      if (FILE_STORAGE_DRIVER === "s3") {
        await saveObject(storedName, await fs.readFile(path.join(outputDir, name)), "image/png");
      }
      pages.push({
        page: index + 1,
        storedName,
        url: uploadPageAssetUrl(uploadId, index + 1)
      });
    }
    return pages;
  }

  return renderPdfPageImagesWithPdfParse(filePath, uploadId, outputDir);
}

async function renderPdfPageImagesWithPdfParse(filePath, uploadId, outputDir) {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const pages = [];
  try {
    const info = await parser.getInfo().catch(() => ({ total: 0, pages: 0 }));
    const total = Number(info.total || info.pages || 0);
    if (!total) return [];
    for (let page = 1; page <= total; page += 1) {
      const screenshot = await parser.getScreenshot({
        first: page,
        last: page,
        desiredWidth: 1200,
        imageBuffer: true,
        imageDataUrl: false
      });
      const image = screenshot.pages?.[0];
      if (!image?.data?.length) continue;
      const name = `page-${String(page).padStart(String(total).length, "0")}.png`;
      const bytes = Buffer.from(image.data);
      await fs.writeFile(path.join(outputDir, name), bytes);
      await saveObject(`pages/${uploadId}/${name}`, bytes, "image/png");
      pages.push({
        page,
        storedName: `pages/${uploadId}/${name}`,
        url: uploadPageAssetUrl(uploadId, page)
      });
    }
  } finally {
    await parser.destroy().catch(() => {});
  }
  return pages;
}

async function ocrImageFile(filePath, mimeType, context = {}) {
  const result = await ocrProvider.recognizeImage(filePath, mimeType, context);
  if (context.diagnostics && context.page) {
    upsertPageDiagnostic(context.diagnostics, context.page, {
      usedOcr: true,
      ocrProvider: result.provider || ocrProvider.name,
      ocrMs: result.durationMs || 0,
      textLength: result.text.length,
      preprocessing: result.preprocessing || {}
    });
  }
  return result.text;
}

function isLikelyTwoPageSpread(size = {}) {
  const width = Number(size.width || 0);
  const height = Number(size.height || 0);
  return width >= 900 && height >= 500 && width / Math.max(1, height) >= 1.25;
}

async function ocrImageSpread(filePath, mimeType, context = {}) {
  const result = await ocrProvider.recognizeSpread(filePath, mimeType, context);
  if (!result?.text) return "";
  if (context.diagnostics && context.page) {
    upsertPageDiagnostic(context.diagnostics, context.page, {
      usedOcr: true,
      ocrProvider: result.provider || ocrProvider.name,
      ocrMs: result.durationMs || 0,
      source: "spread",
      textLength: result.text.length,
      imageSize: result.size || {},
      ocrRegions: result.regions || []
    });
  }
  return result.text;
}

async function ocrImageBatch(items, context = {}) {
  const spreadResults = new Map();
  const normalItems = [];
  for (const item of items) {
    const spreadText = await ocrImageSpread(item.imagePath, item.mimeType, context).catch(() => "");
    if (spreadText) {
      spreadResults.set(Number(item.page), spreadText);
      if (context.diagnostics) {
        upsertPageDiagnostic(context.diagnostics, item.page, {
          usedOcr: true,
          ocrProvider: ocrProvider.name,
          source: "spread",
          textLength: spreadText.length
        });
      }
    } else {
      normalItems.push(item);
    }
  }
  if (!normalItems.length) {
    return items.map((item) => ({ page: item.page, text: spreadResults.get(Number(item.page)) || "" }));
  }
  const batchResult = await ocrProvider.recognizeBatch(normalItems, context);
  const raw = batchResult.raw;
  const parsed = parseAiJson(raw);
  const pages = Array.isArray(parsed) ? parsed : parsed.pages || [];
  const byPage = new Map(pages.map((page, index) => [Number(page.page || normalItems[index]?.page), normalizeExtractedText(page.text || page.content || "")]));
  return items.map((item, index) => {
    const text = spreadResults.get(Number(item.page)) || byPage.get(Number(item.page)) || normalizeExtractedText(pages[index]?.text || "");
    if (context.diagnostics) {
      upsertPageDiagnostic(context.diagnostics, item.page, {
        usedOcr: true,
        ocrProvider: ocrProvider.name,
        ocrMs: batchResult.durationMs || 0,
        textLength: text.length
      });
    }
    return { page: item.page, text };
  });
}

function normalizeLayoutBlocks(rawResult = {}, pageNumber = 1) {
  const parsed = typeof rawResult.raw === "string" ? parseAiJson(rawResult.raw) : rawResult;
  const payload = Array.isArray(parsed) ? { questionRegions: parsed } : parsed || {};
  const size = rawResult.size || {};
  const imageWidth = Number(payload.imageWidth || size.width || 0);
  const imageHeight = Number(payload.imageHeight || size.height || 0);
  const normalizeRegion = (region = {}, index = 0, source = "ocr-layout") => {
    const bbox = normalizeQuestionBBox(region.bbox || region.questionBBox || region, { width: imageWidth, height: imageHeight }, pageNumber, source);
    if (!bbox) return null;
    return {
      index: Number.isFinite(Number(region.index)) ? Number(region.index) : index,
      questionNumber: String(region.questionNumber || region.belongsToQuestionNumber || "").trim(),
      textHint: normalizeQuestionText(region.textHint || region.hint || "").slice(0, 80),
      kind: region.kind || "",
      bbox,
      confidence: Number.isFinite(Number(region.confidence)) ? Number(region.confidence) : ""
    };
  };
  const questionRegions = (Array.isArray(payload.questionRegions) ? payload.questionRegions : [])
    .map((region, index) => normalizeRegion(region, index, "ocr-layout"))
    .filter(Boolean);
  const diagramRegions = (Array.isArray(payload.diagramRegions) ? payload.diagramRegions : [])
    .map((region, index) => normalizeRegion(region, index, "ocr-diagram"))
    .filter(Boolean);
  return {
    provider: rawResult.provider || layoutProvider.name,
    durationMs: rawResult.durationMs || 0,
    page: Number(payload.page || pageNumber),
    imageWidth,
    imageHeight,
    questionRegions,
    diagramRegions,
    createdAt: new Date().toISOString()
  };
}

async function recognizePageLayouts(upload, pages, context = {}) {
  if (!OCR_LAYOUT_ENABLED || !process.env.QWEN_API_KEY || !layoutProvider.recognizeLayout) return pages;
  const output = pages.map((page) => ({ ...page }));
  for (const page of output.slice(0, MAX_VISION_PAGES)) {
    if (page.layoutBlocks?.questionRegions?.length) continue;
    const imagePath = await pageImagePathForUpload(upload, page);
    if (!imagePath) continue;
    try {
      const result = await layoutProvider.recognizeLayout(imagePath, page.image?.includes("/pages/") ? "image/png" : upload.type, {
        ...context,
        page: Number(page.page),
        purpose: context.purpose || "layout_bbox",
        pages: 1
      });
      if (!result) continue;
      const layoutBlocks = normalizeLayoutBlocks(result, Number(page.page));
      page.layoutBlocks = layoutBlocks;
      if (context.diagnostics) {
        upsertPageDiagnostic(context.diagnostics, page.page, {
          layoutProvider: layoutBlocks.provider,
          layoutMs: layoutBlocks.durationMs,
          layoutQuestionRegions: layoutBlocks.questionRegions.length,
          layoutDiagramRegions: layoutBlocks.diagramRegions.length
        });
      }
    } catch (error) {
      if (context.diagnostics) {
        upsertPageDiagnostic(context.diagnostics, page.page, {
          layoutError: error.message || "版面坐标识别失败"
        });
      }
    }
  }
  return output;
}

async function extractDocument(file, filePath, upload) {
  const filename = upload.filename || "";
  const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(filename);
  const isDocx = /officedocument|wordprocessingml/i.test(file.type) || /\.docx$/i.test(filename);
  const isImage = /^image\//i.test(file.type);
  const isText = /^text\//i.test(file.type) || /\.txt$/i.test(filename);
  let extractedText = "";
  let pages = [];
  let pageImages = [];
  let extractionNote = "已保存文件。";

  if (isPdf) {
    const parsed = await extractPdfWithPdfParse(file.body).catch(() => ({ text: extractPdfText(file.body), pages: [], pageCount: 0 }));
    extractedText = parsed.text || "";
    pages = parsed.pages?.length ? parsed.pages : [{ page: 1, text: extractedText }];
    pageImages = await renderPdfPageImages(filePath, upload.id);
    pages = pages.length ? pages : pageImages.map((image) => ({ page: image.page, text: "", image }));
    pages = pages.map((page) => ({
      ...page,
      image: pageImages.find((image) => image.page === page.page)?.url || ""
    }));
    extractionNote = isTextReliable(extractedText)
      ? "已从 PDF 文本层提取内容，并生成页面截图供审核。"
      : pageImages.length
        ? "PDF 文本层不可靠，已生成页面截图，后续将用千问视觉 OCR 兜底。"
        : "PDF 文本层不可靠，且当前环境没有可用页面截图工具。";
  } else if (isDocx) {
    extractedText = await extractDocxText(file.body);
    pages = [{ page: 1, text: extractedText }];
    extractionNote = extractedText ? "已读取 Word 文档文本。" : "Word 文档没有提取到可靠文本。";
  } else if (isText) {
    extractedText = normalizeExtractedText(file.body.toString("utf8"));
    pages = [{ page: 1, text: extractedText }];
    extractionNote = "已读取文本内容。";
  } else if (isImage) {
    pages = [{ page: 1, text: "", image: uploadAssetUrl(upload.id) }];
    extractionNote = "图片已保存，将用千问视觉 OCR 识别。";
  }

  return { extractedText, pages, pageImages, extractionNote };
}

async function ensurePageTextWithOcr(upload, pages, context = {}) {
  const output = pages.map((page) => ({ ...page }));
  const forceVision = /文本层不可靠|乱码|扫描|截图/i.test(upload.extractionNote || "");
  const ocrItems = [];
  for (const page of pages.slice(0, MAX_VISION_PAGES)) {
    if (!forceVision && isTextReliable(page.text)) {
      continue;
    }
    const imagePath = await pageImagePathForUpload(upload, page);
    if (!imagePath) {
      continue;
    }
    ocrItems.push({
      page: Number(page.page),
      imagePath,
      mimeType: page.image?.includes("/pages/") ? "image/png" : upload.type
    });
  }

  for (let index = 0; index < ocrItems.length; index += VISION_BATCH_SIZE) {
    const batch = ocrItems.slice(index, index + VISION_BATCH_SIZE);
    try {
      const results = await ocrImageBatch(batch, { ...context, purpose: context.purpose || "ocr_batch", pages: batch.length });
      for (const result of results) {
        const page = output.find((item) => Number(item.page) === Number(result.page));
        if (page) page.text = result.text;
      }
    } catch {
      for (const item of batch) {
        const page = output.find((candidate) => Number(candidate.page) === Number(item.page));
        if (!page) continue;
        page.text = await ocrImageFile(item.imagePath, item.mimeType, { ...context, purpose: context.purpose || "ocr_fallback", pages: 1, page: Number(item.page) });
      }
    }
  }
  return output;
}

function analysisPrompt(sourceText, defaults = {}) {
  return `你是家教老师的试卷入库助手。请从下面材料中抽取完整题目，并补全答案、解析和知识点。

要求：
1. 只输出 JSON，不要 Markdown，不要额外解释。
2. JSON 格式：{"questions":[...]}。
3. 每道题字段：stem, options(array), answer, explanation, subject, stage, grade, chapter, knowledge(array), level, type, sourcePage, bbox, needsImage(boolean), imageNote, answerSource。
4. 不要生成变式题，variants 必须省略或返回空数组。变式题只在老师点击生成时再做。
5. subject 只能是：${SUBJECTS.join("、")}。
6. stage 只能是：小学、初中。level 只能是：基础、提高、压轴。
7. 原题没有答案时，请自己解题并补答案与解析。题干里如有“如图/图中/下图/阴影/表格”等图形信息，必须在 stem 中保留原题文字，并追加“图形说明：...”描述关键图形关系；不要删掉图形条件。
8. 如果材料中有答案区，请把答案和解析合并回对应题目。
9. 保持原题题号、选项、公式信息；不要把一道大题拆成多个小问，（1）（2）（3）等小问必须留在同一道题里。
10. knowledge 只保留 1-2 个大知识点，不要拆成很细的小考点。例如“必然事件、不可能事件、随机事件、事件分类”统一写“概率”。
11. 不要输出题型标题、目录、页眉页脚、分值说明、试卷说明作为题目；不完整的候选块直接跳过。
12. 如果判断为选择题，必须把 A/B/C/D 放到 options 数组；如果没有选项，不要标为选择题。
13. 如果题干说“如图/图中/阴影”等但材料里无法得到图形条件，请设置 needsImage=true，并在 imageNote 写明缺少什么图；explanation 开头写“需人工绑定配图：...”，不要假装题目完整。
14. sourcePage 必须使用材料中出现的页码。answerSource 写“材料答案区”“AI解题”或“人工待补”。
15. 遇到答案页、解析页时，不要把答案页文字单独输出为题目，只能把它绑定回前面的题目。
16. 同一页或同一个候选块里可能有多道题；遇到顶层题号 1.、2.、3.、1、2、3、或“一、二、三、”时，每个顶层题号必须输出为独立题目，不能合并成一道题。
17. 只有括号小问（1）（2）（3）属于同一道大题；顶层题号后的另一段完整题干属于下一道题。
18. 如果材料标注了“候选题 1/2/3”，通常每个候选题都要输出一条 questions 记录，除非它明显不是题目。
19. 如果材料中提供了题目区域坐标或你能从图片判断题目区域，请返回 bbox：{"x":0到1,"y":0到1,"width":0到1,"height":0到1}，表示该题在来源页截图中的归一化位置；不确定则返回 null，不要编造。

默认信息：
科目：${defaults.subject || "初中数学"}
学段：${defaults.stage || "初中"}
年级：${defaults.grade || ""}
章节：${defaults.chapter || ""}

材料：
${sourceText}`;
}

async function analyzePagesWithAi(db, upload, pages, defaults = {}) {
  const reliablePages = pages.filter((page) => isTextReliable(page.text));
  if (!reliablePages.length) return [];
  const answerPages = reliablePages.filter(isAnswerMaterialPage);
  const questionPages = reliablePages.filter((page) => !isAnswerMaterialPage(page));
  if (!questionPages.length) return [];
  const manualAnswerContext = normalizeExtractedText(defaults.answerText || defaults.answers || "");
  const answerContext = [
    answerPages.length ? normalizeExtractedText(answerPages.map((page) => `【第 ${page.page} 页答案参考】\n${page.text}`).join("\n\n")) : "",
    manualAnswerContext ? `【手动上传答案参考】\n${manualAnswerContext}` : ""
  ].filter(Boolean).join("\n\n").slice(0, 9000);
  const sources = questionSourcesFromPages(questionPages);
  const chunks = questionPages.map((page) => {
    const pageSources = sources.filter((source) => Number(source.page) === Number(page.page));
    return pageSources.length ? pageSources : [{ page: page.page, text: page.text, image: page.image }];
  });
  const questions = [];
  for (const chunk of chunks) {
    const sourceText = [
      chunk.map((item, index) => item.block || `【第 ${item.page} 页 / 候选题 ${index + 1}】\n${item.text}`).join("\n\n"),
      answerContext ? `【答案页参考，只用于绑定答案解析，不要单独输出为题目】\n${answerContext}` : ""
    ].filter(Boolean).join("\n\n");
    const aiSession = { tenantId: upload.tenantId || DEFAULT_TENANT_ID, userId: upload.createdBy || DEFAULT_ADMIN_ID };
    let items = [];
    try {
      const content = await callQwen([{ role: "user", content: analysisPrompt(sourceText, defaults) }], { temperature: 0.2, db, session: aiSession, purpose: "analyze_questions", pages: new Set(chunk.map((item) => item.page)).size });
      const parsed = parseAiJson(content);
      items = Array.isArray(parsed) ? parsed : parsed.questions || [];
    } catch {
      items = [];
    }
    for (const item of items) {
      const sourcePage = Number(item.sourcePage || chunk[0]?.page || 1);
      const sourceInfo = chunk.find((candidate) => Number(candidate.page) === sourcePage) || chunk[0];
      const page = pages.find((p) => Number(p.page) === sourcePage) || sourceInfo;
      const pending = makePendingQuestion({
        ...defaults,
        ...item,
        sourceUploadId: upload.id,
        sourceFilename: upload.filename,
        sourcePage,
        sourceImage: page?.image || uploadAssetUrl(upload.id),
        questionImage: "",
        sourceIndexOnPage: sourceInfo?.indexOnPage ?? "",
        sourceTotalOnPage: sourceInfo?.totalOnPage ?? "",
        sourceText: item.sourceText || item.stem || "",
        sourceTextLayout: sourceInfo?.sourceTextLayout || null,
        questionBBox: item.questionBBox || item.bbox || sourceInfo?.bbox || null,
        diagramBBoxes: item.diagramBBoxes || sourceInfo?.diagramBBoxes || []
      });
      pending.variants = [];
      pending.aiVariants = [];
      pending.bankVariants = [];
      questions.push(pending);
    }
  }
  return questions;
}

function markDuplicates(db, candidates) {
  const uniqueCandidates = dedupeQuestionItems(candidates);
  const existingQuestions = db.questions || [];
  const pendingQuestions = db.pendingQuestions || [];
  const accepted = [];
  let skipped = Math.max(0, candidates.length - uniqueCandidates.length);
  for (const question of uniqueCandidates) {
    const tenantId = question.tenantId || DEFAULT_TENANT_ID;
    const key = duplicateFingerprint(question.stem);
    const existingMatch = existingQuestions.find((q) =>
      (q.tenantId || DEFAULT_TENANT_ID) === tenantId
      && isLikelySameQuestionText(q.stem, question.stem)
    );
    const pendingMatch = pendingQuestions.find((q) =>
      (q.tenantId || DEFAULT_TENANT_ID) === tenantId
      && isLikelySameQuestionText(q.stem, question.stem)
    );
    const acceptedMatch = accepted.find((q) =>
      (q.tenantId || DEFAULT_TENANT_ID) === tenantId
      && isLikelySameQuestionText(q.stem, question.stem)
    );
    if (!key || existingMatch || pendingMatch || acceptedMatch) {
      skipped += 1;
      continue;
    }
    accepted.push(applyQuestionQuality({
      ...question,
      tenantId,
      duplicateOf: existingMatch?.id || ""
    }));
  }
  return { accepted, skipped };
}

async function analyzeUploadToPending(db, upload, pages, defaults = {}, session = {}) {
  let workingPages = pages;
  let diagnostics = createAnalysisDiagnostics(upload, {
    provider: OCR_PROVIDER,
    promptVersion: PROMPT_VERSION,
    totalPages: pages.length
  });
  addDiagnosticEvent(diagnostics, "direct.start", "上传后直接分析图片");
  for (const page of workingPages) {
    upsertPageDiagnostic(diagnostics, page.page, {
      status: "selected",
      source: page.image ? "page_image" : "text",
      textReliable: isTextReliable(page.text),
      textLength: normalizeExtractedText(page.text).length
    });
  }
  const needsVision = Boolean(process.env.QWEN_API_KEY) && workingPages.some((page) => !isTextReliable(page.text) && page.image);
  if (needsVision) {
    workingPages = await ensurePageTextWithOcr(upload, workingPages, { db, session, purpose: "upload_ocr", diagnostics });
  }
  workingPages = await recognizePageLayouts(upload, workingPages, { db, session, purpose: "upload_layout", diagnostics });
  const extractedText = normalizeExtractedText(workingPages.map((page) => page.text).join("\n\n"));
  const aiCandidates = process.env.QWEN_API_KEY
    ? await analyzePagesWithAi(db, upload, workingPages, defaults)
    : [];
  const fallbackCandidates = pendingQuestionsFromPages(db, upload, workingPages, defaults);
  const candidates = reconcileAiCandidates(aiCandidates, fallbackCandidates);
  const { accepted, skipped } = markDuplicates(db, candidates);
  const autoBoundImages = await bindCandidateQuestionImages(upload, accepted);
  const localCountByPage = new Map();
  for (const source of questionSourcesFromPages(workingPages)) {
    const page = Number(source.page || 1);
    localCountByPage.set(page, (localCountByPage.get(page) || 0) + 1);
  }
  const aiCountByPage = new Map();
  for (const question of aiCandidates) {
    const page = Number(question.sourcePage || 1);
    aiCountByPage.set(page, (aiCountByPage.get(page) || 0) + 1);
  }
  const acceptedCountByPage = new Map();
  for (const question of accepted) {
    const page = Number(question.sourcePage || 1);
    acceptedCountByPage.set(page, (acceptedCountByPage.get(page) || 0) + 1);
  }
  for (const page of workingPages) {
    upsertPageDiagnostic(diagnostics, page.page, {
      status: "done",
      textReliable: isTextReliable(page.text),
      textLength: normalizeExtractedText(page.text).length,
      localCandidates: localCountByPage.get(Number(page.page)) || 0,
      aiCandidates: aiCountByPage.get(Number(page.page)) || 0,
      acceptedCandidates: acceptedCountByPage.get(Number(page.page)) || 0
    });
  }
  diagnostics = finalizeAnalysisDiagnostics(diagnostics, {
    status: "succeeded",
    summary: {
      totalPages: pages.length,
      localCandidateCount: fallbackCandidates.length,
      aiCandidateCount: aiCandidates.length,
      acceptedCount: accepted.length,
      autoBoundQuestionImages: autoBoundImages,
      duplicateSkippedCount: skipped
    }
  });
  db.pendingQuestions.unshift(...accepted);
  if (accepted.length) addAuditLog(db, session, "analysis.pending.create", "upload", upload.id, `生成 ${accepted.length} 道待审核题`);
  return {
    extractedText,
    pendingQuestions: accepted,
    skippedDuplicates: skipped,
    pages: workingPages,
    analysisDiagnostics: compactAnalysisDiagnostics(diagnostics)
  };
}

async function updateUploadRecord(uploadId, updater) {
  const db = await readDb();
  const upload = db.uploads.find((item) => item.id === uploadId);
  if (!upload) throw new Error("文件不存在");
  await updater(upload, db);
  upload.updatedAt = new Date().toISOString();
  await writeDb(db);
  return { db, upload };
}

function upsertJobRecord(db, session, jobId, type, status, targetId = "", message = "") {
  if (!jobId) return;
  const now = new Date().toISOString();
  let job = db.jobs.find((item) => item.id === jobId);
  if (!job) {
    job = stampTenant({
      id: jobId,
      type,
      status,
      targetId,
      message,
      startedAt: now,
      createdAt: now
    }, session);
    db.jobs.unshift(job);
  }
  Object.assign(job, {
    type,
    status,
    targetId,
    message,
    updatedAt: now,
    finishedAt: ["done", "failed"].includes(status) ? now : job.finishedAt || ""
  });
  db.jobs = db.jobs.slice(0, 500);
}

function startUploadAnalysisJob(uploadId, options = {}) {
  if (analysisJobs.has(uploadId)) return analysisJobs.get(uploadId);
  const job = {
    id: randomUUID(),
    uploadId,
    pageRange: options.pageRange || "",
    tenantId: options.tenantId || DEFAULT_TENANT_ID,
    userId: options.userId || DEFAULT_ADMIN_ID,
    startedAt: new Date().toISOString()
  };
  analysisJobs.set(uploadId, job);
  job.promise = runUploadAnalysisJob(uploadId, { ...options, jobId: job.id, tenantId: job.tenantId, userId: job.userId })
    .catch(() => {})
    .finally(() => analysisJobs.delete(uploadId));
  return job;
}

async function runUploadAnalysisJob(uploadId, options = {}) {
  const defaults = options.defaults || {};
  const requestedRange = options.pageRange || "";
  let diagnostics = null;
  const jobSession = {
    tenantId: options.tenantId || DEFAULT_TENANT_ID,
    userId: options.userId || DEFAULT_ADMIN_ID,
    username: options.username || ADMIN_USER,
    role: options.role || "owner"
  };
  try {
    await updateUploadRecord(uploadId, async (upload, db) => {
      if (!belongsToTenant(upload, jobSession)) throw new Error("无权分析该资料");
      diagnostics = createAnalysisDiagnostics(upload, {
        provider: OCR_PROVIDER,
        promptVersion: PROMPT_VERSION,
        pageRange: requestedRange,
        totalPages: upload.pages?.length || 0
      });
      addDiagnosticEvent(diagnostics, "job.start", "开始分析资料", { pageRange: requestedRange });
      upload.analysisStatus = "processing";
      upload.analysisError = "";
      upload.analysisProgress = {
        phase: "prepare",
        message: "正在准备资料...",
        completedPages: 0,
        totalPages: upload.pages?.length || 0,
        pendingQuestions: 0,
        pageRange: requestedRange,
        startedAt: new Date().toISOString()
      };
      upload.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
      upsertJobRecord(db, jobSession, options.jobId || "", "analysis", "processing", upload.id, "正在准备资料...");
    });

    let { db, upload } = await updateUploadRecord(uploadId, async (record) => {
      const filePath = await readObjectToTemp(record.storedName, path.extname(record.storedName));
      const pages = Array.isArray(record.pages) && record.pages.length ? record.pages : [];
      const needsRenderedPages = /\.pdf$/i.test(record.filename || "")
        && (!record.pageImages?.length || pages.every((page) => !page.image));
      if (!pages.length || needsRenderedPages) {
        record.analysisProgress = {
          ...record.analysisProgress,
          phase: "render",
          message: "正在生成 PDF 页面截图...",
          completedPages: 0,
          totalPages: pages.length || 0
        };
        const bytes = await readObject(record.storedName);
        const extracted = await extractDocument({ type: record.type, body: bytes }, filePath, record);
        record.pageImages = extracted.pageImages;
        record.extractionNote = extracted.extractionNote;
        record.pages = extracted.pages;
        record.extractedText = extracted.extractedText || record.extractedText || "";
        record.analysisProgress.totalPages = extracted.pages.length;
      }
    });

    const allPages = (upload.pages || []).map((page) => ({ ...page }));
    const selectedPageNumbers = parsePageRange(requestedRange, allPages.length);
    const selectedPages = selectedPageNumbers
      ? allPages.filter((page) => selectedPageNumbers.includes(Number(page.page)))
      : allPages;
    diagnostics = createAnalysisDiagnostics(upload, {
      provider: OCR_PROVIDER,
      promptVersion: PROMPT_VERSION,
      pageRange: requestedRange,
      totalPages: allPages.length
    });
    addDiagnosticEvent(diagnostics, "pages.selected", "已选择待分析页", {
      selectedPages: selectedPages.length,
      totalPages: allPages.length
    });
    for (const page of selectedPages) {
      const skipped = isSkippableMaterialPage(page);
      upsertPageDiagnostic(diagnostics, page.page, {
        status: skipped ? "skipped" : "selected",
        source: page.image ? "page_image" : "text",
        textReliable: isTextReliable(page.text),
        textLength: normalizeExtractedText(page.text).length,
        skippedReason: skipped ? "目录/说明/答案页，已自动跳过" : ""
      });
    }
    let workingPages = selectedPages;
    const initiallySkippedPages = workingPages.filter(isSkippableMaterialPage).length;
    workingPages = workingPages.filter((page) => !isSkippableMaterialPage(page));
    const forceVisionForUpload = /文本层不可靠|乱码|扫描|截图/i.test(upload.extractionNote || "");
    const ocrTargets = [];
    for (const page of workingPages.slice(0, MAX_VISION_PAGES)) {
      if (!forceVisionForUpload && isTextReliable(page.text)) continue;
      if (pageImageStoredNameForUpload(upload, page)) ocrTargets.push(page);
    }

    await updateUploadRecord(uploadId, async (record) => {
      record.analysisStatus = "processing";
      record.analysisProgress = {
        ...record.analysisProgress,
        phase: ocrTargets.length ? "ocr" : "split",
        message: ocrTargets.length ? `正在 OCR 第 1 / ${ocrTargets.length} 页...` : "正在拆分题目...",
        completedPages: 0,
        totalPages: ocrTargets.length,
        pendingQuestions: 0,
        pageRange: requestedRange
      };
      record.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
    });

    let completed = 0;
    for (const page of ocrTargets) {
      const imagePath = await pageImagePathForUpload(upload, page);
      if (!imagePath) {
        completed += 1;
        continue;
      }
      const outputPage = workingPages.find((item) => Number(item.page) === Number(page.page));
      try {
        const [result] = await ocrImageBatch([{
          page: Number(page.page),
          imagePath,
          mimeType: page.image?.includes("/pages/") ? "image/png" : upload.type
        }], { db, session: jobSession, purpose: "analysis_ocr", pages: 1, diagnostics });
        if (outputPage) {
          outputPage.text = result?.text || "";
          delete outputPage.ocrError;
          upsertPageDiagnostic(diagnostics, outputPage.page, {
            status: "ocr_done",
            textReliable: isTextReliable(outputPage.text),
            textLength: normalizeExtractedText(outputPage.text).length
          });
        }
      } catch (error) {
        try {
          const fallbackText = await ocrImageFile(imagePath, page.image?.includes("/pages/") ? "image/png" : upload.type, { db, session: jobSession, purpose: "analysis_ocr_fallback", pages: 1, diagnostics, page: Number(page.page) });
          if (outputPage) {
            outputPage.text = fallbackText;
            delete outputPage.ocrError;
            upsertPageDiagnostic(diagnostics, outputPage.page, {
              status: "ocr_done",
              textReliable: isTextReliable(outputPage.text),
              textLength: normalizeExtractedText(outputPage.text).length
            });
          }
        } catch (fallbackError) {
          if (outputPage) outputPage.ocrError = fallbackError.message || error.message || "OCR 失败";
          upsertPageDiagnostic(diagnostics, page.page, {
            status: "ocr_failed",
            error: fallbackError.message || error.message || "OCR 失败"
          });
        }
      }
      completed += 1;
      const extractedText = normalizeExtractedText(workingPages.map((item) => item.text).join("\n\n"));
      await updateUploadRecord(uploadId, async (record) => {
        const merged = (record.pages || []).map((page) => workingPages.find((item) => Number(item.page) === Number(page.page)) || page);
        record.pages = merged;
        record.extractedText = normalizeExtractedText(merged.map((item) => item.text).join("\n\n"));
        record.analysisProgress = {
          ...record.analysisProgress,
          phase: "ocr",
          message: completed < ocrTargets.length
            ? `正在 OCR 第 ${completed + 1} / ${ocrTargets.length} 页...`
            : "OCR 完成，正在拆分题目...",
          completedPages: completed,
          totalPages: ocrTargets.length,
          pendingQuestions: questionSourcesFromPages(workingPages).length
        };
        record.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
      });
    }

    const skippedAfterOcr = workingPages.filter(isSkippableMaterialPage).length;
    for (const page of workingPages.filter(isSkippableMaterialPage)) {
      upsertPageDiagnostic(diagnostics, page.page, {
        status: "skipped",
        skippedReason: "OCR 后判断为目录/说明/答案页，已自动跳过"
      });
    }
    workingPages = workingPages.filter((page) => !isSkippableMaterialPage(page));
    workingPages = await recognizePageLayouts(upload, workingPages, { db, session: jobSession, purpose: "analysis_layout", diagnostics });
    const localSourcesBeforeAi = questionSourcesFromPages(workingPages);
    const localCountByPage = new Map();
    for (const source of localSourcesBeforeAi) {
      const page = Number(source.page || 1);
      localCountByPage.set(page, (localCountByPage.get(page) || 0) + 1);
    }
    for (const page of workingPages) {
      upsertPageDiagnostic(diagnostics, page.page, {
        status: "split_ready",
        localCandidates: localCountByPage.get(Number(page.page)) || 0
      });
    }

    ({ db, upload } = await updateUploadRecord(uploadId, async (record) => {
      record.analysisProgress = {
        ...record.analysisProgress,
        phase: "split",
        message: process.env.QWEN_API_KEY ? "AI 正在抽题并补答案解析..." : "正在拆分题目...",
        pendingQuestions: questionSourcesFromPages(workingPages).length
      };
      record.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
    }));

    const aiCandidates = process.env.QWEN_API_KEY
      ? await analyzePagesWithAi(db, upload, workingPages, defaults)
      : [];
    const fallbackCandidates = pendingQuestionsFromPages(db, upload, workingPages, defaults);
    const candidates = reconcileAiCandidates(aiCandidates, fallbackCandidates);
    const { accepted, skipped } = markDuplicates(db, candidates);
    const autoBoundImages = await bindCandidateQuestionImages(upload, accepted);
    const aiCountByPage = new Map();
    for (const question of aiCandidates) {
      const page = Number(question.sourcePage || 1);
      aiCountByPage.set(page, (aiCountByPage.get(page) || 0) + 1);
    }
    const acceptedCountByPage = new Map();
    for (const question of accepted) {
      const page = Number(question.sourcePage || 1);
      acceptedCountByPage.set(page, (acceptedCountByPage.get(page) || 0) + 1);
    }
    for (const page of workingPages) {
      upsertPageDiagnostic(diagnostics, page.page, {
        status: "done",
        aiCandidates: aiCountByPage.get(Number(page.page)) || 0,
        acceptedCandidates: acceptedCountByPage.get(Number(page.page)) || 0
      });
    }
    diagnostics = finalizeAnalysisDiagnostics(diagnostics, {
      status: "succeeded",
      summary: {
        totalPages: allPages.length,
        localCandidateCount: fallbackCandidates.length,
        aiCandidateCount: aiCandidates.length,
        acceptedCount: accepted.length,
        autoBoundQuestionImages: autoBoundImages,
        duplicateSkippedCount: skipped,
        skippedPages: initiallySkippedPages + skippedAfterOcr
      }
    });
    db.pendingQuestions.unshift(...accepted);
    upload.pages = (upload.pages || []).map((page) => workingPages.find((item) => Number(item.page) === Number(page.page)) || page);
    upload.extractedText = normalizeExtractedText(upload.pages.map((page) => page.text).join("\n\n"));
    upload.analysisPageRange = requestedRange;
    upload.analysisStatus = "done";
    upload.analysisError = "";
    upload.analysisProgress = {
      phase: "done",
      message: `分析完成，生成 ${accepted.length} 道待审核题，跳过 ${skipped} 道重复题，自动跳过 ${initiallySkippedPages + skippedAfterOcr} 页目录/说明。`,
      completedPages: ocrTargets.length,
      totalPages: ocrTargets.length,
      pendingQuestions: accepted.length,
      skippedDuplicates: skipped,
      skippedPages: initiallySkippedPages + skippedAfterOcr,
      finishedAt: new Date().toISOString()
    };
    upload.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
    upsertJobRecord(db, jobSession, options.jobId || "", "analysis", "done", upload.id, upload.analysisProgress.message);
    addActivity(db, "重新分析资料", `${upload.filename}，生成 ${accepted.length} 道待审核题`, jobSession);
    addAuditLog(db, jobSession, "analysis.complete", "upload", upload.id, upload.analysisProgress.message);
    await writeDb(db);
  } catch (error) {
    await updateUploadRecord(uploadId, async (upload, db) => {
      diagnostics = finalizeAnalysisDiagnostics(diagnostics || createAnalysisDiagnostics(upload, {
        provider: OCR_PROVIDER,
        promptVersion: PROMPT_VERSION,
        pageRange: requestedRange,
        totalPages: upload.pages?.length || 0
      }), {
        status: "failed",
        error: error.message || "重新分析失败"
      });
      addDiagnosticEvent(diagnostics, "job.failed", error.message || "重新分析失败");
      upload.analysisStatus = "failed";
      upload.analysisError = error.message || "重新分析失败";
      upload.analysisProgress = {
        ...upload.analysisProgress,
        phase: "failed",
        message: upload.analysisError,
        finishedAt: new Date().toISOString()
      };
      upload.analysisDiagnostics = compactAnalysisDiagnostics(diagnostics);
      upsertJobRecord(db, jobSession, options.jobId || "", "analysis", "failed", upload.id, upload.analysisError);
      addAuditLog(db, jobSession, "analysis.failed", "upload", upload.id, upload.analysisError);
    }).catch(() => {});
  }
}

function createQuestionsFromPending(db, pendingItems, { includeVariants = true, force = false } = {}) {
  const existing = new Map(db.questions.map((q) => [`${q.tenantId || DEFAULT_TENANT_ID}:${fingerprint(q.stem)}`, q.id]));
  const created = [];
  let skipped = 0;
  for (const item of pendingItems) {
    applyQuestionQuality(item);
    if (item.qualityErrors?.length && !force) {
      skipped += 1;
      continue;
    }
    const key = fingerprint(item.stem);
    const scopedKey = `${item.tenantId || DEFAULT_TENANT_ID}:${key}`;
    if (!key || existing.has(scopedKey)) {
      skipped += 1;
      continue;
    }
    const original = makeQuestion({
      ...item,
      sourceImage: "",
      questionImage: item.questionImageStoredName ? "" : (item.questionImage || ""),
      questionImageManual: Boolean(item.questionImageManual),
      questionImageStoredName: item.questionImageStoredName || "",
        explanationImage: item.explanationImageStoredName ? "" : (item.explanationImage || ""),
        explanationImageManual: Boolean(item.explanationImageManual),
        explanationImageStoredName: item.explanationImageStoredName || "",
        diagramSpec: item.diagramSpec || null,
        diagramSvg: item.diagramSvg || "",
        forceApproved: Boolean(force && item.qualityErrors?.length),
      variants: item.variants || [],
      aiVariants: item.aiVariants || [],
      bankVariants: item.bankVariants || [],
      webVariants: item.webVariants || []
    });
    if (original.questionImageStoredName) original.questionImage = `/api/questions/${original.id}/image`;
    if (original.explanationImageStoredName) original.explanationImage = `/api/questions/${original.id}/explanation-image`;
    existing.set(scopedKey, original.id);
    created.push(original);
    if (!includeVariants) continue;
    for (const variant of splitVariantGroups(item, original).variants) {
      const variantKey = fingerprint(variant.stem);
      const scopedVariantKey = `${original.tenantId || DEFAULT_TENANT_ID}:${variantKey}`;
      if (!variantKey || existing.has(scopedVariantKey)) {
        skipped += 1;
        continue;
      }
      const variantImageStoredName = variant.questionImageStoredName || "";
      const variantImage = variant.questionImage || "";
      const question = makeQuestion({
        ...original,
        ...variant,
        sourceUploadId: original.sourceUploadId,
        sourceFilename: original.sourceFilename,
        sourcePage: original.sourcePage,
        sourceImage: "",
        questionImage: variantImageStoredName ? "" : variantImage,
        questionImageManual: Boolean(variant.questionImageManual),
        questionImageStoredName: variantImageStoredName,
        explanationImage: "",
        explanationImageManual: false,
        explanationImageStoredName: "",
        diagramSpec: variant.diagramSpec || null,
        diagramSvg: variant.diagramSvg || renderDiagramSvg(variant.diagramSpec),
        variantOf: original.id,
        variants: [],
        aiVariants: [],
        bankVariants: [],
        webVariants: []
      });
      if (question.questionImageStoredName) question.questionImage = `/api/questions/${question.id}/image`;
      existing.set(scopedVariantKey, question.id);
      created.push(question);
    }
  }
  return { created, skipped };
}

function escapeHtmlDoc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function imageDataUriForQuestion(question = {}) {
  if (!question.questionImageStoredName) return "";
  try {
    const bytes = await readObject(question.questionImageStoredName);
    const ext = path.extname(question.questionImageStoredName).toLowerCase();
    const mime = MIME_TYPES[ext]?.split(";")[0] || "image/png";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

async function imageAttachmentForStoredName(storedName = "", cidPrefix = "question-image", index = 0) {
  if (!storedName) return null;
  try {
    const bytes = await readObject(storedName);
    const ext = path.extname(storedName).toLowerCase() || ".png";
    const mime = MIME_TYPES[ext]?.split(";")[0] || "image/png";
    return {
      cid: `${cidPrefix}-${index}${ext}`,
      filename: `${cidPrefix}-${index}${ext}`,
      bytes,
      ext,
      mime,
      base64: bytes.toString("base64").replace(/.{1,76}/g, "$&\r\n").trim()
    };
  } catch {
    return null;
  }
}

async function imageAttachmentForQuestion(question = {}, index = 0) {
  const stored = await imageAttachmentForStoredName(question.questionImageStoredName, "question-image", index);
  if (stored) return stored;
  const svg = question.diagramSvg || renderDiagramSvg(question.diagramSpec);
  if (!svg) return null;
  const bytes = Buffer.from(svg, "utf8");
  return {
    cid: `question-diagram-${index}.svg`,
    filename: `question-diagram-${index}.svg`,
    bytes,
    ext: ".svg",
    mime: "image/svg+xml",
    base64: bytes.toString("base64").replace(/.{1,76}/g, "$&\r\n").trim()
  };
}

async function explanationImageAttachmentForQuestion(question = {}, index = 0) {
  return imageAttachmentForStoredName(question.explanationImageStoredName, "solution-image", index);
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDosTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (date.getFullYear() - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function makeStoredZip(entries = []) {
  const now = zipDosTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function imageSize(buffer, ext = "") {
  if (ext === ".svg") {
    const svg = buffer.toString("utf8", 0, Math.min(buffer.length, 1000));
    const width = Number(/(?:width|viewBox)="(?:[^"]*\s+){0,2}(\d+(?:\.\d+)?)/i.exec(svg)?.[1]) || 520;
    const height = Number(/height="(\d+(?:\.\d+)?)/i.exec(svg)?.[1]) || 260;
    return { width, height };
  }
  if (ext === ".png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return { width: 520, height: 260 };
}

function docxText(text = "") {
  return escapeHtmlDoc(text);
}

function docxParagraph(text = "", { bold = false, size = 24 } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const runProps = `<w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const runs = lines.map((line, index) => {
    const br = index ? "<w:br/>" : "";
    return `<w:r>${runProps}${br}<w:t xml:space="preserve">${docxText(line)}</w:t></w:r>`;
  }).join("");
  return `<w:p>${runs}</w:p>`;
}

function docxImageParagraph(relId, attachment, index) {
  const size = imageSize(attachment.bytes, attachment.ext);
  const scale = Math.min(2.4, 560 / Math.max(size.width, 1), 300 / Math.max(size.height, 1));
  const cx = Math.max(1, Math.round(size.width * scale * 9525));
  const cy = Math.max(1, Math.round(size.height * scale * 9525));
  return `
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:docPr id="${index}" name="本题配图 ${index}"/>
            <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr><pic:cNvPr id="${index}" name="${docxText(attachment.filename)}"/><pic:cNvPicPr/></pic:nvPicPr>
                  <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                  <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`;
}

async function assignmentWordDocx(db, body = {}, session = {}) {
  const selectedIds = Array.isArray(body.questionIds) ? body.questionIds : [];
  const selected = selectedIds
    .map((id) => db.questions.find((q) => q.id === id && belongsToTenant(q, session)))
    .filter(Boolean);
  const generated = Array.isArray(body.generatedQuestions) ? body.generatedQuestions : [];
  const questions = selected.concat(generated);
  const exportMode = ["student", "answer", "solution"].includes(body.exportMode) ? body.exportMode : "student";
  const date = new Date().toLocaleDateString("zh-CN");
  const bodyParts = [
    docxParagraph(body.title || "未命名作业", { bold: true, size: 36 }),
    docxParagraph(`姓名：${body.studentName || "________"}    日期：${date}    科目：${body.subject || ""}    年级：${body.grade || ""}    用时：${body.duration || "40 分钟"}    总分：${body.score || "100"}`)
  ];
  const rels = [];
  const mediaEntries = [];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const options = normalizeOptions(question.options).join("\n");
    const text = [question.stem, options].filter(Boolean).join("\n");
    bodyParts.push(docxParagraph(`${index + 1}. ${text}`));
    const image = await imageAttachmentForQuestion(question, index + 1);
    if (image) {
      const relId = `rId${rels.length + 2}`;
      const filename = `question-image-${index + 1}${image.ext}`;
      rels.push({ id: relId, target: `media/${filename}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" });
      mediaEntries.push({ name: `word/media/${filename}`, data: image.bytes });
      bodyParts.push(docxImageParagraph(relId, { ...image, filename }, index + 1));
    }
  }

  if (exportMode !== "student") {
    bodyParts.push(docxParagraph(exportMode === "answer" ? "答案" : "答案与解析", { bold: true, size: 30 }));
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const solution = exportMode === "solution" ? `\n解析：${question.explanation || "待补充"}` : "";
      bodyParts.push(docxParagraph(`${index + 1}. 答案：${question.answer || "待补充"}${solution}`));
      if (exportMode === "solution") {
        const solutionImage = await explanationImageAttachmentForQuestion(question, index + 1);
        if (solutionImage) {
          const relId = `rId${rels.length + 2}`;
          const filename = `solution-image-${index + 1}${solutionImage.ext}`;
          rels.push({ id: relId, target: `media/${filename}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" });
          mediaEntries.push({ name: `word/media/${filename}`, data: solutionImage.bytes });
          bodyParts.push(docxImageParagraph(relId, { ...solutionImage, filename }, index + 1));
        }
      }
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
    xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
    xmlns:v="urn:schemas-microsoft-com:vml"
    xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:w10="urn:schemas-microsoft-com:office:word"
    xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
    xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
    xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
    xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
    xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
    mc:Ignorable="w14 wp14">
    <w:body>
      ${bodyParts.join("")}
      <w:sectPr>
        <w:pgSz w:w="11906" w:h="16838"/>
        <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
      </w:sectPr>
    </w:body>
  </w:document>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${rels.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"/>`).join("")}
  </Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Default Extension="png" ContentType="image/png"/>
    <Default Extension="jpg" ContentType="image/jpeg"/>
    <Default Extension="jpeg" ContentType="image/jpeg"/>
    <Default Extension="svg" ContentType="image/svg+xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  </Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  </Relationships>`;
  return makeStoredZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: documentRels },
    ...mediaEntries
  ]);
}

async function assignmentWordMhtml(db, body = {}, session = {}) {
  const selectedIds = Array.isArray(body.questionIds) ? body.questionIds : [];
  const selected = selectedIds
    .map((id) => db.questions.find((q) => q.id === id && belongsToTenant(q, session)))
    .filter(Boolean);
  const generated = Array.isArray(body.generatedQuestions) ? body.generatedQuestions : [];
  const questions = selected.concat(generated);
  const date = new Date().toLocaleDateString("zh-CN");
  const questionItems = [];
  const answerItems = [];
  const attachments = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const options = normalizeOptions(question.options).join("\n");
    const bodyText = [question.stem, options].filter(Boolean).join("\n");
    const image = await imageAttachmentForQuestion(question, index + 1);
    if (image) attachments.push(image);
    const solutionImage = await explanationImageAttachmentForQuestion(question, index + 1);
    if (solutionImage) attachments.push(solutionImage);
    questionItems.push(`
      <li>
        <div>${escapeHtmlDoc(bodyText).replace(/\n/g, "<br>")}</div>
        ${image ? `<p><img src="cid:${image.cid}" style="max-width:520px; max-height:260px;" /></p>` : ""}
      </li>
    `);
    answerItems.push(`
      <li>
        <b>答案：</b>${escapeHtmlDoc(question.answer || "待补充")}<br>
        <b>解析：</b>${escapeHtmlDoc(question.explanation || "待补充").replace(/\n/g, "<br>")}
        ${solutionImage ? `<p><img src="cid:${solutionImage.cid}" style="max-width:520px; max-height:260px;" /></p>` : ""}
      </li>
    `);
  }
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: "Microsoft YaHei", Arial, sans-serif; line-height: 1.7; color: #222; }
        h1 { text-align: center; }
        .meta { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 18px; }
        li { margin: 0 0 14px; page-break-inside: avoid; }
        img { display: block; margin: 8px 0; border: 1px solid #ddd; }
        .answers { margin-top: 28px; border-top: 1px solid #ddd; padding-top: 12px; }
      </style>
    </head>
    <body>
      <h1>${escapeHtmlDoc(body.title || "未命名作业")}</h1>
      <div class="meta">
        <span>姓名：${escapeHtmlDoc(body.studentName || "________")}</span>
        <span>日期：${escapeHtmlDoc(date)}</span>
        <span>科目：${escapeHtmlDoc(body.subject || "")}</span>
        <span>年级：${escapeHtmlDoc(body.grade || "")}</span>
        <span>用时：${escapeHtmlDoc(body.duration || "40 分钟")}</span>
        <span>总分：${escapeHtmlDoc(body.score || "100")}</span>
      </div>
      <ol>${questionItems.join("")}</ol>
      <section class="answers">
        <h2>答案与解析</h2>
        <ol>${answerItems.join("")}</ol>
      </section>
    </body>
  </html>`;
  const boundary = `----=_ZenoX_${randomUUID().replaceAll("-", "")}`;
  const parts = [
    `MIME-Version: 1.0`,
    `Content-Type: multipart/related; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Location: assignment.htm`,
    ``,
    html
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mime}`,
      `Content-Transfer-Encoding: base64`,
      `Content-ID: <${attachment.cid}>`,
      `Content-Location: ${attachment.filename}`,
      ``,
      attachment.base64
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

async function handleUpload(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!enforceRateLimit(req, res, "upload", UPLOAD_RATE_LIMIT)) return;
  const db = await readDb();
  const org = ensureTenantEntitlement(db, session, "upload");
  const maxUploadMb = Math.min(Number(org.limits?.maxUploadSizeMb || MAX_UPLOAD_MB), MAX_UPLOAD_MB);
  const maxUploadBytes = Math.max(1, maxUploadMb) * 1024 * 1024;
  const body = await readBody(req, maxUploadBytes + 2 * 1024 * 1024);
  const parts = parseMultipart(body, req.headers["content-type"]);
  const file = parts.find((part) => part.filename);
  if (!file || !file.body.length) return json(res, 400, { error: "没有收到文件" });
  validateUploadFile(file, { purpose: "document", maxBytes: maxUploadBytes });

  const filename = safeName(file.filename);
  const hash = fileHash(file.body);
  const now = new Date().toISOString();
  let deduplicated = false;
  let upload = db.uploads.find((item) => belongsToTenant(item, session) && item.hash === hash)
    || db.uploads.find((item) => belongsToTenant(item, session) && item.filename === filename && item.size === file.body.length);
  let filePath;

  if (upload) {
    deduplicated = true;
    filePath = await readObjectToTemp(upload.storedName, path.extname(upload.storedName));
  } else {
    const id = randomUUID();
    const storedName = `${id}-${filename}`;
    await saveObject(storedName, file.body, file.type || "application/octet-stream");
    filePath = await readObjectToTemp(storedName, path.extname(storedName));
    upload = stampTenant({
      id,
      filename,
      storedName,
      storageDriver: FILE_STORAGE_DRIVER,
      hash,
      type: file.type,
      size: file.body.length,
      extractedText: "",
      extractionNote: "已保存文件。",
      uploadCount: 0,
      pageImages: [],
      analysisDiagnostics: null,
      createdAt: now,
      updatedAt: now
    }, session);
    db.uploads.unshift(upload);
  }

  const extracted = await extractDocument(file, filePath, upload);
  const shouldAnalyzeImmediately = /^image\//i.test(file.type);
  let directAnalysis = { pendingQuestions: [], skippedDuplicates: 0, extractedText: extracted.extractedText, pages: extracted.pages };
  let directAnalysisError = "";
  if (shouldAnalyzeImmediately) {
    try {
      directAnalysis = await analyzeUploadToPending(db, upload, extracted.pages, {}, session);
    } catch (error) {
      directAnalysisError = error.message || "图片分析失败";
    }
  }
  const pageRange = suggestedAnalysisRange(extracted.pages);
  const pageCount = Math.max(extracted.pages.length, extracted.pageImages.length);
  const skippedPages = extracted.pages.filter(isSkippableMaterialPage).length;

  if (deduplicated) {
    Object.assign(upload, {
      hash,
      type: file.type,
      size: file.body.length,
      extractedText: directAnalysis.extractedText || extracted.extractedText,
      extractionNote: shouldAnalyzeImmediately
        ? `${extracted.extractionNote} ${directAnalysisError ? directAnalysisError : `已直接分析图片，生成 ${directAnalysis.pendingQuestions.length} 道待审核题。`} 已识别为同一份资料，未新增重复资料记录。`
        : `${extracted.extractionNote} 已识别到 ${pageCount || 1} 页，请选择页码后点击开始分析。${skippedPages ? ` 已建议跳过 ${skippedPages} 页目录/说明。` : ""} 已识别为同一份资料，未新增重复资料记录。`,
      pageImages: extracted.pageImages,
      pages: directAnalysis.pages,
      analysisPageRange: pageRange,
      analysisStatus: shouldAnalyzeImmediately ? (directAnalysisError ? "failed" : "done") : "ready",
      analysisError: directAnalysisError,
      analysisDiagnostics: directAnalysis.analysisDiagnostics || upload.analysisDiagnostics || null,
      analysisProgress: {
        phase: shouldAnalyzeImmediately ? (directAnalysisError ? "failed" : "done") : "ready",
        message: shouldAnalyzeImmediately
          ? (directAnalysisError || `图片分析完成，生成 ${directAnalysis.pendingQuestions.length} 道待审核题。`)
          : `已识别 ${pageCount || 1} 页，请选择页码后开始分析。`,
        totalPages: pageCount || 1,
        completedPages: shouldAnalyzeImmediately ? 1 : 0,
        pendingQuestions: directAnalysis.pendingQuestions.length,
        skippedPages
      },
      updatedAt: now,
      uploadCount: (upload.uploadCount || 1) + 1
    });
    addActivity(db, "更新资料", shouldAnalyzeImmediately ? `${filename} 已直接分析图片` : `${filename} 已存在，已刷新页码信息`, session);
    addAuditLog(db, session, "upload.update", "upload", upload.id, filename);
  } else {
    Object.assign(upload, {
      extractedText: directAnalysis.extractedText || extracted.extractedText,
      extractionNote: shouldAnalyzeImmediately
        ? `${extracted.extractionNote} ${directAnalysisError ? directAnalysisError : `已直接分析图片，生成 ${directAnalysis.pendingQuestions.length} 道待审核题。`}`
        : `${extracted.extractionNote} 已识别到 ${pageCount || 1} 页，请选择页码后点击开始分析。${skippedPages ? ` 已建议跳过 ${skippedPages} 页目录/说明。` : ""}`,
      pageImages: extracted.pageImages,
      pages: directAnalysis.pages,
      analysisPageRange: pageRange,
      analysisStatus: shouldAnalyzeImmediately ? (directAnalysisError ? "failed" : "done") : "ready",
      analysisError: directAnalysisError,
      analysisDiagnostics: directAnalysis.analysisDiagnostics || upload.analysisDiagnostics || null,
      analysisProgress: {
        phase: shouldAnalyzeImmediately ? (directAnalysisError ? "failed" : "done") : "ready",
        message: shouldAnalyzeImmediately
          ? (directAnalysisError || `图片分析完成，生成 ${directAnalysis.pendingQuestions.length} 道待审核题。`)
          : `已识别 ${pageCount || 1} 页，请选择页码后开始分析。`,
        totalPages: pageCount || 1,
        completedPages: shouldAnalyzeImmediately ? 1 : 0,
        pendingQuestions: directAnalysis.pendingQuestions.length,
        skippedPages
      },
      uploadCount: 1,
      updatedAt: now
    });
    addActivity(db, shouldAnalyzeImmediately ? "上传并分析图片" : "上传资料", shouldAnalyzeImmediately ? `${filename}，生成 ${directAnalysis.pendingQuestions.length} 道待审核题` : `${filename}，已识别 ${pageCount || 1} 页`, session);
    addAuditLog(db, session, "upload.create", "upload", upload.id, filename);
  }
  db.uploads = dedupeUploads(db.uploads);
  await writeDb(db);
  json(res, deduplicated ? 200 : 201, {
    upload,
    deduplicated,
    pendingQuestions: directAnalysis.pendingQuestions,
    skippedDuplicates: directAnalysis.skippedDuplicates,
    suggestions: isTextReliable(upload.extractedText) ? splitQuestionsFromText(upload.extractedText || "") : [],
    analysisError: directAnalysisError
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === "/api/health" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        env: NODE_ENV,
        storage: STORAGE_DRIVER,
        fileStorage: FILE_STORAGE_DRIVER,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    }

    if (!enforceRateLimit(req, res, "api", API_RATE_LIMIT)) return;

    if (pathname === "/api/login" && req.method === "POST") {
      if (!enforceRateLimit(req, res, "login", LOGIN_RATE_LIMIT)) return;
      const body = await readJson(req);
      const db = await readDb();
      const user = db.users.find((item) => item.username === body.username && item.status !== "disabled");
      if (!user || !verifyPassword(body.password || "", user.passwordHash)) {
        return json(res, 401, { error: "账号或密码不正确" });
      }
      user.lastLoginAt = new Date().toISOString();
      if (shouldUpgradePasswordHash(user.passwordHash)) {
        user.passwordHash = hashPassword(body.password || "");
        user.updatedAt = new Date().toISOString();
      }
      await writeDb(db);
      const token = makeSession(user);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookie(token)
      });
      return res.end(JSON.stringify({ ok: true, username: user.username, tenantId: user.tenantId, role: user.role }));
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookie("", 0)
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const session = requireAuth(req, res);
      if (!session) return;
      const db = await readDb();
      const org = db.organizations.find((item) => item.id === sessionTenantId(session));
      return json(res, 200, {
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        tenantId: sessionTenantId(session),
        organization: org ? { id: org.id, name: org.name, plan: org.plan, limits: org.limits } : null
      });
    }

    if (pathname === "/api/uploads" && req.method === "POST") return handleUpload(req, res);

    const session = requireAuth(req, res);
    if (!session) return;

    if (pathname === "/api/questions/backfill-match-profiles" && req.method === "POST") {
      const db = await readDb();
      const summary = backfillQuestionMatchProfiles(db, session);
      addActivity(db, "题库画像补齐", `补齐 ${summary.updated}/${summary.total} 道题的匹配画像`, session);
      addAuditLog(db, session, "question.backfillMatchProfiles", "question", "", `补齐 ${summary.updated}/${summary.total} 道题`);
      await writeDb(db);
      return json(res, 200, { ok: true, summary });
    }

    const questionCropMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/question-crops\/(\d+)\/(\d+)$/);
    if (questionCropMatch && req.method === "GET") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === questionCropMatch[1] && belongsToTenant(item, session));
      if (!upload) return text(res, 404, "Not found");
      const pendingOnPage = db.pendingQuestions
        .filter((q) => q.sourceUploadId === upload.id && Number(q.sourcePage) === Number(questionCropMatch[2]))
        .sort((a, b) => Number(a.sourceIndexOnPage || 0) - Number(b.sourceIndexOnPage || 0));
      const question = pendingOnPage[Number(questionCropMatch[3]) || 0];
      const bbox = question ? await ensureQuestionBBox(upload, question) : null;
      const storedName = await ensureQuestionCrop(upload, Number(questionCropMatch[2]), Number(questionCropMatch[3]), pendingOnPage.length || 1, bbox);
      if (!storedName) return text(res, 404, "Not found");
      return sendObject(res, storedName, "image/png");
    }

    const uploadAssetMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/(file|pages\/\d+)$/);
    if (uploadAssetMatch && req.method === "GET") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadAssetMatch[1] && belongsToTenant(item, session));
      if (!upload) return text(res, 404, "Not found");
      const asset = uploadAssetMatch[2];
      const pageNumber = asset.startsWith("pages/") ? Number(asset.split("/")[1]) : 0;
      const pageImage = pageNumber ? upload.pageImages?.find((item) => Number(item.page) === pageNumber) : null;
      const storedName = asset === "file"
        ? upload.storedName
        : pageImage?.storedName || `pages/${upload.id}/page-${String(pageNumber).padStart(2, "0")}.png`;
      const ext = path.extname(storedName).toLowerCase();
      return sendObject(res, storedName, MIME_TYPES[ext] || upload.type || "application/octet-stream");
    }

    const uploadAnalyzeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/analyze$/);
    if (uploadAnalyzeMatch && req.method === "POST") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadAnalyzeMatch[1] && belongsToTenant(item, session));
      if (!upload) return json(res, 404, { error: "文件不存在" });
      const body = await readJson(req);
      const org = ensureTenantEntitlement(db, session, "analysis");
      const selectedPages = parsePageRange(String(body.pageRange || "").trim(), upload.pages?.length || 0);
      const analysisPageCount = selectedPages ? selectedPages.length : Math.max(upload.pages?.length || 0, upload.pageImages?.length || 0, 1);
      if (analysisPageCount > 1 && !org.limits?.allowBatchAnalysis) {
        throw httpError(402, "当前套餐不支持多页批量分析，请选择单页或升级套餐。");
      }
      upload.analysisStatus = "processing";
      upload.analysisError = "";
      upload.analysisPageRange = String(body.pageRange || "").trim();
      const jobId = randomUUID();
      upload.analysisProgress = {
        phase: "queued",
        message: "已进入后台分析队列...",
        completedPages: 0,
        totalPages: upload.pages?.length || 0,
        pendingQuestions: 0,
        pageRange: upload.analysisPageRange,
        jobId,
        startedAt: new Date().toISOString()
      };
      upload.updatedAt = new Date().toISOString();
      await writeDb(db);
      const job = startUploadAnalysisJob(upload.id, {
        defaults: body.defaults || {},
        pageRange: upload.analysisPageRange,
        tenantId: sessionTenantId(session),
        userId: sessionUserId(session),
        username: session.username,
        role: session.role
      });
      upload.analysisProgress.jobId = job.id;
      upload.analysisProgress.startedAt = job.startedAt;
      return json(res, 202, { upload, jobId: job.id, started: true });
    }

    const uploadAnalyzeStatusMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/analyze-status$/);
    if (uploadAnalyzeStatusMatch && req.method === "GET") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadAnalyzeStatusMatch[1] && belongsToTenant(item, session));
      if (!upload) return json(res, 404, { error: "文件不存在" });
      return json(res, 200, {
        upload,
        running: analysisJobs.has(upload.id),
        pendingQuestions: db.pendingQuestions.filter((q) => q.sourceUploadId === upload.id).length
      });
    }

    const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
    if (uploadMatch && req.method === "DELETE") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadMatch[1] && belongsToTenant(item, session));
      if (!upload) return json(res, 404, { error: "资料不存在" });
      if (analysisJobs.has(upload.id)) {
        return json(res, 409, { error: "资料正在分析中，请稍后再删" });
      }
      await deleteUploadCascade(db, upload, session);
      await writeDb(db);
      return json(res, 200, { ok: true, removedId: upload.id });
    }

    if (pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, scopedDb(await readDb(), session));
    }

    if (pathname === "/api/billing" && req.method === "GET") {
      const db = await readDb();
      return json(res, 200, {
        organization: tenantOrg(db, sessionTenantId(session)),
        plans: PLAN_CATALOG,
        usage: tenantUsageSummary(db, session)
      });
    }

    if (pathname === "/api/billing" && req.method === "PATCH") {
      if (!canManageUsers(session)) return json(res, 403, { error: "没有管理套餐的权限" });
      const body = await readJson(req);
      const db = await readDb();
      const index = db.organizations.findIndex((item) => item.id === sessionTenantId(session));
      if (index === -1) return json(res, 404, { error: "机构不存在" });
      const current = tenantOrg(db, sessionTenantId(session));
      const nextPlan = PLAN_CATALOG[body.plan] ? body.plan : current.plan;
      const config = planConfig(nextPlan);
      const customLimits = body.limits && typeof body.limits === "object" ? body.limits : {};
      const nextLimits = {
        monthlyAiTokens: Number(customLimits.monthlyAiTokens || config.monthlyAiTokens),
        monthlyAiPages: Number(customLimits.monthlyAiPages || config.monthlyAiPages),
        maxUploadSizeMb: Number(customLimits.maxUploadSizeMb || config.maxUploadSizeMb),
        maxUsers: Number(customLimits.maxUsers || config.maxUsers),
        maxQuestions: Number(customLimits.maxQuestions || config.maxQuestions),
        allowBatchAnalysis: customLimits.allowBatchAnalysis !== undefined ? Boolean(customLimits.allowBatchAnalysis) : Boolean(config.allowBatchAnalysis)
      };
      const subscription = {
        ...current.subscription,
        status: ["trialing", "active", "past_due", "expired", "disabled"].includes(body.status) ? body.status : current.subscription.status,
        trialEndsAt: body.trialEndsAt !== undefined ? billingDate(body.trialEndsAt) : current.subscription.trialEndsAt,
        renewsAt: body.renewsAt !== undefined ? billingDate(body.renewsAt) : current.subscription.renewsAt,
        canceledAt: body.canceledAt !== undefined ? billingDate(body.canceledAt) : current.subscription.canceledAt,
        pastDueAt: body.pastDueAt !== undefined ? billingDate(body.pastDueAt) : current.subscription.pastDueAt,
        note: body.note !== undefined ? String(body.note || "") : current.subscription.note
      };
      db.organizations[index] = normalizeOrganization({
        ...current,
        plan: nextPlan,
        limits: nextLimits,
        subscription,
        updatedAt: new Date().toISOString()
      });
      addActivity(db, "调整套餐", `${db.organizations[index].name}：${planConfig(nextPlan).name}`, session);
      addAuditLog(db, session, "billing.update", "organization", db.organizations[index].id, `套餐 ${nextPlan}，状态 ${subscription.status}`);
      await writeDb(db);
      return json(res, 200, {
        organization: {
          ...db.organizations[index],
          subscriptionStatus: subscriptionStatus(db.organizations[index])
        },
        usage: tenantUsageSummary(db, session)
      });
    }

    if (pathname === "/api/users" && req.method === "POST") {
      if (!canManageUsers(session)) return json(res, 403, { error: "没有管理账号的权限" });
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "").trim();
      if (!username || !password) return json(res, 400, { error: "账号和密码不能为空" });
      const db = await readDb();
      const org = ensureTenantEntitlement(db, session, "users");
      const activeUsers = db.users.filter((user) => (user.tenantId || DEFAULT_TENANT_ID) === sessionTenantId(session) && user.status !== "disabled").length;
      if (activeUsers >= Number(org.limits?.maxUsers || 1)) {
        throw httpError(402, `当前套餐最多 ${org.limits.maxUsers} 个账号，请升级套餐后再添加。`);
      }
      if (db.users.some((user) => user.username === username)) return json(res, 409, { error: "账号已存在" });
      const user = {
        id: randomUUID(),
        tenantId: sessionTenantId(session),
        username,
        displayName: body.displayName || username,
        role: ["admin", "teacher", "reviewer"].includes(body.role) ? body.role : "teacher",
        passwordHash: hashPassword(password),
        status: "active",
        createdBy: sessionUserId(session),
        updatedBy: sessionUserId(session),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.users.unshift(user);
      addAuditLog(db, session, "user.create", "user", user.id, username);
      await writeDb(db);
      const { passwordHash, ...safeUser } = user;
      return json(res, 201, { user: safeUser });
    }

    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === "PATCH") {
      if (!canManageUsers(session)) return json(res, 403, { error: "没有管理账号的权限" });
      const body = await readJson(req);
      const db = await readDb();
      const user = db.users.find((item) => item.id === userMatch[1] && item.tenantId === sessionTenantId(session));
      if (!user) return json(res, 404, { error: "账号不存在" });
      if (body.password) user.passwordHash = hashPassword(body.password);
      if (body.displayName !== undefined) user.displayName = body.displayName;
      if (["admin", "teacher", "reviewer", "disabled"].includes(body.role)) user.role = body.role === "disabled" ? user.role : body.role;
      if (["active", "disabled"].includes(body.status)) user.status = body.status;
      user.updatedBy = sessionUserId(session);
      user.updatedAt = new Date().toISOString();
      addAuditLog(db, session, "user.update", "user", user.id, user.username);
      await writeDb(db);
      const { passwordHash, ...safeUser } = user;
      return json(res, 200, { user: safeUser });
    }

    const pendingImageMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/image$/);
    if (pendingImageMatch && req.method === "GET") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingImageMatch[1] && belongsToTenant(q, session));
      if (!question?.questionImageStoredName) return text(res, 404, "Not found");
      const ext = path.extname(question.questionImageStoredName).toLowerCase();
      return sendObject(res, question.questionImageStoredName, MIME_TYPES[ext] || "image/png");
    }

    const pendingWebVariantImageMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/web-variants\/(\d+)\/image$/);
    if (pendingWebVariantImageMatch && req.method === "GET") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingWebVariantImageMatch[1] && belongsToTenant(q, session));
      const index = Number(pendingWebVariantImageMatch[2]);
      const variant = Array.isArray(question?.webVariants) ? question.webVariants[index] : null;
      if (!variant?.questionImageStoredName) return text(res, 404, "Not found");
      const ext = path.extname(variant.questionImageStoredName).toLowerCase();
      return sendObject(res, variant.questionImageStoredName, MIME_TYPES[ext] || "image/png");
    }

    if (pendingImageMatch && req.method === "POST") {
      const body = await readBody(req, MAX_IMAGE_UPLOAD_MB * 1024 * 1024 + 512 * 1024);
      const parts = parseMultipart(body, req.headers["content-type"]);
      const file = parts.find((part) => part.filename);
      if (!file || !file.body.length) return json(res, 400, { error: "没有收到图片" });
      validateUploadFile(file, { purpose: "image", maxBytes: MAX_IMAGE_UPLOAD_MB * 1024 * 1024 });
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingImageMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const bboxPart = parts.find((part) => part.name === "bbox" && !part.filename);
      let manualBBox = null;
      if (bboxPart?.body?.length) {
        try {
          manualBBox = normalizeQuestionBBox(JSON.parse(bboxPart.body.toString("utf8")), null, firstPageNumber(question.sourcePage), "manual");
        } catch {
          manualBBox = null;
        }
      }
      const ext = path.extname(safeName(file.filename)).toLowerCase() || ".png";
      const storedName = `question-images/manual/${question.id}-${Date.now()}${ext}`;
      const before = revisionSnapshot(question);
      await saveObject(storedName, file.body, file.type || MIME_TYPES[ext] || "image/png");
      question.questionImageStoredName = storedName;
      question.questionImage = `/api/pending-questions/${question.id}/image?t=${Date.now()}`;
      question.questionImageManual = true;
      question.questionImageSource = "manual";
      if (manualBBox) question.questionBBox = manualBBox;
      question.updatedAt = new Date().toISOString();
      applyQuestionQuality(question);
      addRevision(question, session, "image.update", before, revisionSnapshot(question), "更新本题配图");
      await writeDb(db);
      return json(res, 200, { question });
    }

    const pendingExplanationImageMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/explanation-image$/);
    if (pendingExplanationImageMatch && req.method === "GET") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingExplanationImageMatch[1] && belongsToTenant(q, session));
      if (!question?.explanationImageStoredName) return text(res, 404, "Not found");
      const ext = path.extname(question.explanationImageStoredName).toLowerCase();
      return sendObject(res, question.explanationImageStoredName, MIME_TYPES[ext] || "image/png");
    }

    if (pendingExplanationImageMatch && req.method === "POST") {
      const body = await readBody(req, MAX_IMAGE_UPLOAD_MB * 1024 * 1024 + 512 * 1024);
      const parts = parseMultipart(body, req.headers["content-type"]);
      const file = parts.find((part) => part.filename);
      if (!file || !file.body.length) return json(res, 400, { error: "没有收到图片" });
      validateUploadFile(file, { purpose: "image", maxBytes: MAX_IMAGE_UPLOAD_MB * 1024 * 1024 });
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingExplanationImageMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const ext = path.extname(safeName(file.filename)).toLowerCase() || ".png";
      const storedName = `question-images/explanations/${question.id}-${Date.now()}${ext}`;
      const before = revisionSnapshot(question);
      await saveObject(storedName, file.body, file.type || MIME_TYPES[ext] || "image/png");
      question.explanationImageStoredName = storedName;
      question.explanationImage = `/api/pending-questions/${question.id}/explanation-image?t=${Date.now()}`;
      question.explanationImageManual = true;
      question.updatedAt = new Date().toISOString();
      addRevision(question, session, "explanation.image.update", before, revisionSnapshot(question), "更新解析图片");
      await writeDb(db);
      return json(res, 200, { question });
    }

    const pendingAutoImageMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/auto-image$/);
    if (pendingAutoImageMatch && req.method === "POST") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingAutoImageMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const upload = db.uploads.find((item) => item.id === question.sourceUploadId && belongsToTenant(item, session));
      if (!upload) return json(res, 400, { error: "没有找到来源资料，无法自动补截图" });
      const before = revisionSnapshot(question);
      const ok = await autoBindQuestionCrop(upload, question, { force: true });
      if (!ok) return json(res, 422, { error: "自动补截图失败，请从原页手动框选" });
      addRevision(question, session, "image.auto", before, revisionSnapshot(question), "自动生成本题截图");
      addAuditLog(db, session, "pending.auto_image", "pendingQuestion", question.id, "自动生成本题截图");
      await writeDb(db);
      return json(res, 200, { question });
    }

    const questionImageMatch = pathname.match(/^\/api\/questions\/([^/]+)\/image$/);
    if (questionImageMatch && req.method === "GET") {
      const db = await readDb();
      const question = db.questions.find((q) => q.id === questionImageMatch[1] && belongsToTenant(q, session));
      if (!question?.questionImageStoredName) return text(res, 404, "Not found");
      const ext = path.extname(question.questionImageStoredName).toLowerCase();
      return sendObject(res, question.questionImageStoredName, MIME_TYPES[ext] || "image/png");
    }

    const questionExplanationImageMatch = pathname.match(/^\/api\/questions\/([^/]+)\/explanation-image$/);
    if (questionExplanationImageMatch && req.method === "GET") {
      const db = await readDb();
      const question = db.questions.find((q) => q.id === questionExplanationImageMatch[1] && belongsToTenant(q, session));
      if (!question?.explanationImageStoredName) return text(res, 404, "Not found");
      const ext = path.extname(question.explanationImageStoredName).toLowerCase();
      return sendObject(res, question.explanationImageStoredName, MIME_TYPES[ext] || "image/png");
    }

    if (pathname === "/api/analyze-text" && req.method === "POST") {
      const { text: sourceText = "", defaults = {} } = await readJson(req);
      const db = await readDb();
      ensureTenantEntitlement(db, session, "analysis");
      const sourceFilename = normalizeQuestionText(defaults.sourceFilename || "粘贴文本") || "粘贴文本";
      const upload = {
        id: `text-${randomUUID()}`,
        filename: sourceFilename,
        type: "text/plain",
        storedName: "",
        tenantId: sessionTenantId(session),
        createdBy: sessionUserId(session),
        updatedBy: sessionUserId(session)
      };
      const pages = [{ page: 1, text: normalizeExtractedText(sourceText), image: "" }];
      const candidates = process.env.QWEN_API_KEY
        ? await analyzePagesWithAi(db, upload, pages, defaults)
        : splitQuestionsFromText(sourceText).map((stem) => makePendingQuestion({ ...defaults, stem, sourceFilename, tenantId: sessionTenantId(session), createdBy: sessionUserId(session), updatedBy: sessionUserId(session) }));
      const { accepted, skipped } = markDuplicates(db, candidates);
      db.pendingQuestions.unshift(...accepted);
      addActivity(db, "分析粘贴文本", `生成 ${accepted.length} 道待审核题`, session);
      addAuditLog(db, session, "analysis.text", "pendingQuestion", "", `生成 ${accepted.length} 道待审核题`);
      await writeDb(db);
      return json(res, 201, { pendingQuestions: accepted, skippedDuplicates: skipped });
    }

    if (pathname === "/api/questions/split" && req.method === "POST") {
      const { text: sourceText = "", defaults = {}, sourceUploadId = "" } = await readJson(req);
      const db = await readDb();
      const existing = new Map(db.questions.filter((q) => belongsToTenant(q, session)).map((q) => [fingerprint(q.stem), q.id]));
      const questions = splitQuestionsFromText(sourceText).map((stem) => {
        const q = makeQuestion(stampTenant({ ...defaults, stem, sourceUploadId }, session));
        q.duplicateOf = existing.get(fingerprint(q.stem)) || "";
        return q;
      });
      return json(res, 200, { questions });
    }

    if (pathname === "/api/questions" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const incoming = Array.isArray(body.questions) ? body.questions : [body];
      ensureQuestionCapacity(db, session, incoming.length);
      const existing = new Map(db.questions.filter((q) => belongsToTenant(q, session)).map((q) => [fingerprint(q.stem), q.id]));
      const candidates = incoming.map((item) => applyQuestionQuality(makePendingQuestion(stampTenant(item, session))));
      const invalid = candidates.filter((q) => q.qualityErrors?.length);
      if (invalid.length) {
        return json(res, 422, {
          error: `${invalid.length} 道题未通过质检，请先修正`,
          invalidQuestions: invalid.map((q) => ({ stem: q.stem, errors: q.qualityErrors }))
        });
      }
      const created = candidates.map((item) => {
        const q = makeQuestion(item);
        q.duplicateOf = existing.get(fingerprint(q.stem)) || "";
        existing.set(fingerprint(q.stem), q.id);
        return q;
      }).filter((q) => q.stem);
      db.questions.unshift(...created);
      addActivity(db, "题目录入", `新增 ${created.length} 道题`, session);
      addAuditLog(db, session, "question.create", "question", "", `新增 ${created.length} 道题`);
      await writeDb(db);
      return json(res, 201, { questions: created });
    }

    const pendingEnrichMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/enrich$/);
    if (pendingEnrichMatch && req.method === "POST") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingEnrichMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      try {
        const before = revisionSnapshot(question);
        await enrichPendingQuestion(db, question, session);
        addRevision(question, session, "ai.enrich", before, revisionSnapshot(question), "AI 补全待审核题");
        addAuditLog(db, session, "pending.enrich", "pendingQuestion", question.id, "AI 补全待审核题");
        await writeDb(db);
        return json(res, 200, { question });
      } catch (error) {
        question.status = "ai_failed";
        question.analysisError = error.message || "AI 补全失败";
        question.updatedAt = new Date().toISOString();
        await writeDb(db);
        return json(res, 500, { error: question.analysisError, question });
      }
    }

    const pendingVariantMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/generate-variants$/);
    if (pendingVariantMatch && req.method === "POST") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingVariantMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      try {
        const before = revisionSnapshot(question);
        await generatePendingQuestionVariants(db, question, session);
        addRevision(question, session, "ai.variants", before, revisionSnapshot(question), "AI 生成相似例题");
        addAuditLog(db, session, "pending.variants", "pendingQuestion", question.id, "AI 生成相似例题");
        await writeDb(db);
        return json(res, 200, { question });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        question.status = statusCode === 422 ? "pending" : "ai_failed";
        question.variantDiagnostics = error.variantDiagnostics || question.variantDiagnostics || null;
        question.analysisError = error.variantDiagnostics
          ? normalizeQuestionText(error.message || templateVariantDiagnosticsMessage(error.variantDiagnostics) || "AI 生成相似例题失败")
          : friendlyVariantGenerationError(error.message || "AI 生成相似例题失败");
        question.updatedAt = new Date().toISOString();
        await writeDb(db);
        return json(res, statusCode, { error: question.analysisError, diagnostics: question.variantDiagnostics, question });
      }
    }

    const pendingOnlineVariantMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/search-online-variants$/);
    if (pendingOnlineVariantMatch && req.method === "POST") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingOnlineVariantMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      try {
        const before = revisionSnapshot(question);
        await findPendingQuestionOnlineVariants(db, question, session);
        addRevision(question, session, "web.variants", before, revisionSnapshot(question), "AI 联网查找相似题");
        addAuditLog(db, session, "pending.web_variants", "pendingQuestion", question.id, "AI 联网查找相似题");
        await writeDb(db);
        return json(res, 200, { question });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        question.status = "pending";
        question.analysisError = error.message || "AI查题失败";
        question.updatedAt = new Date().toISOString();
        await writeDb(db);
        return json(res, statusCode, { error: question.analysisError, question });
      }
    }

    const pendingBankVariantMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/find-bank-variants$/);
    if (pendingBankVariantMatch && req.method === "POST") {
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingBankVariantMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      try {
        const before = revisionSnapshot(question);
        findPendingQuestionBankVariants(db, question, session);
        addRevision(question, session, "bank.variants", before, revisionSnapshot(question), "从题库查找同类题");
        addAuditLog(db, session, "pending.bank_variants", "pendingQuestion", question.id, "从题库查找同类题");
        await writeDb(db);
        return json(res, 200, { question });
      } catch (error) {
        question.status = "bank_variant_failed";
        question.analysisError = error.message || "题库找题失败";
        question.updatedAt = new Date().toISOString();
        await writeDb(db);
        return json(res, 422, { error: question.analysisError, question });
      }
    }

    const pendingBankVariantFeedbackMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/bank-variants\/(\d+)\/feedback$/);
    if (pendingBankVariantFeedbackMatch && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingBankVariantFeedbackMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const index = Number(pendingBankVariantFeedbackMatch[2]);
      const feedback = normalizeQuestionText(body.feedback || "");
      if (!["很相似", "不相似", "同母题"].includes(feedback)) return json(res, 400, { error: "反馈类型无效" });
      const variants = normalizeVariants(question.bankVariants || [], question, 5).map((item) => ({ ...item, source: item.source || "题库找题" }));
      if (!variants[index]) return json(res, 404, { error: "题库相似题不存在" });
      variants[index].feedback = feedback;
      variants[index].feedbackAt = new Date().toISOString();
      variants[index].feedbackBy = sessionUserId(session);
      question.bankVariants = variants;
      question.variants = [...normalizeVariants(question.webVariants || [], question), ...normalizeVariants(question.aiVariants || [], question), ...question.bankVariants];
      question.updatedBy = sessionUserId(session);
      question.updatedAt = new Date().toISOString();
      addAuditLog(db, session, "pending.bank_variant_feedback", "pendingQuestion", question.id, `${feedback}：${variants[index].sourceQuestionId || variants[index].stem.slice(0, 40)}`);
      await writeDb(db);
      return json(res, 200, { question });
    }

    const pendingMergeMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/merge$/);
    if (pendingMergeMatch && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const target = db.pendingQuestions.find((q) => q.id === pendingMergeMatch[1] && belongsToTenant(q, session));
      const source = db.pendingQuestions.find((q) => q.id === body.withId && belongsToTenant(q, session));
      if (!target || !source) return json(res, 404, { error: "待审核题目不存在" });
      if (target.id === source.id) return json(res, 400, { error: "不能合并同一道题" });
      const before = revisionSnapshot(target);
      const sourceBefore = revisionSnapshot(source);
      const merged = mergePendingQuestionData(target, source, body.order === "before" ? "before" : "after");
      Object.assign(target, merged, {
        updatedBy: sessionUserId(session),
        updatedAt: new Date().toISOString()
      });
      addRevision(target, session, "question.merge", before, revisionSnapshot(target), `合并待审核题：${source.id}`);
      addRevision(target, session, "question.merge.source", sourceBefore, null, `被合并题快照：${source.id}`);
      db.pendingQuestions = db.pendingQuestions.filter((q) => q.id !== source.id);
      addAuditLog(db, session, "pending.merge", "pendingQuestion", target.id, `合并 ${source.id} 到 ${target.id}`);
      await writeDb(db);
      return json(res, 200, { question: target, removedId: source.id });
    }

    const pendingSplitMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)\/split$/);
    if (pendingSplitMatch && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingSplitMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const parts = Array.isArray(body.parts)
        ? body.parts.map(normalizeExtractedText).filter((item) => item.length >= 6)
        : String(body.text || "").split(/\n-{3,}\n|\n={3,}\n|---+|===+/).map(normalizeExtractedText).filter((item) => item.length >= 6);
      if (parts.length < 2) return json(res, 400, { error: "至少需要拆成两段题目" });
      const before = revisionSnapshot(question);
      const base = { ...question };
      Object.assign(question, makePendingQuestion({
        ...base,
        id: question.id,
        stem: parts[0],
        options: [],
        answer: "",
        explanation: "",
        variants: [],
        aiVariants: [],
        bankVariants: [],
        webVariants: [],
        questionImage: "",
        questionImageStoredName: "",
        questionImageManual: false,
        questionImageSource: "",
        questionBBox: null,
        sourceTextLayout: null,
        revisions: question.revisions,
        updatedBy: sessionUserId(session)
      }), {
        id: question.id,
        createdAt: base.createdAt,
        updatedAt: new Date().toISOString()
      });
      addRevision(question, session, "question.split.primary", before, revisionSnapshot(question), `拆分为 ${parts.length} 道题的第 1 道`);
      const created = parts.slice(1).map((stem, index) => {
        const next = makePendingQuestion({
          ...base,
          stem,
          options: [],
          answer: "",
          explanation: "",
          variants: [],
          aiVariants: [],
          bankVariants: [],
          webVariants: [],
          sourceIndexOnPage: Number(base.sourceIndexOnPage || 0) + index + 1,
          questionImage: "",
          questionImageStoredName: "",
          questionImageManual: false,
          questionImageSource: "",
          questionBBox: null,
          sourceTextLayout: null,
          status: "pending",
          createdBy: sessionUserId(session),
          updatedBy: sessionUserId(session)
        });
        addRevision(next, session, "question.split.created", before, revisionSnapshot(next), `由 ${question.id} 拆分出的第 ${index + 2} 道`);
        return next;
      });
      const upload = db.uploads.find((item) => item.id === base.sourceUploadId && belongsToTenant(item, session));
      if (upload) await bindCandidateQuestionImages(upload, [question, ...created]);
      const insertIndex = db.pendingQuestions.findIndex((q) => q.id === question.id);
      db.pendingQuestions.splice(insertIndex + 1, 0, ...created);
      addAuditLog(db, session, "pending.split", "pendingQuestion", question.id, `拆分为 ${parts.length} 道题`);
      await writeDb(db);
      return json(res, 200, { question, created });
    }

    const pendingMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)$/);
    if (pendingMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const before = revisionSnapshot(question);
      Object.assign(question, {
        ...body,
        stem: body.stem === undefined ? question.stem : normalizeQuestionText(body.stem),
        options: body.options === undefined ? question.options : normalizeOptions(body.options),
        answer: body.answer === undefined ? question.answer : normalizeQuestionText(body.answer),
        explanation: body.explanation === undefined ? question.explanation : normalizeQuestionText(body.explanation),
        knowledge: body.knowledge === undefined ? normalizeKnowledgeTags(question.knowledge, question.subject, question.stem) : normalizeKnowledgeTags(body.knowledge, body.subject || question.subject, body.stem || question.stem),
        aiVariants: body.aiVariants === undefined ? question.aiVariants : normalizeVariants(body.aiVariants, question).map((item) => ({ ...item, source: item.source || "AI生成" })),
        bankVariants: body.bankVariants === undefined ? question.bankVariants : normalizeVariants(body.bankVariants, question, 5).map((item) => ({ ...item, source: item.source || "题库找题" })),
        webVariants: body.webVariants === undefined ? question.webVariants : normalizeVariants(body.webVariants, question).map((item) => ({ ...item, source: item.source || "AI查题·联网" })),
        questionBBox: body.questionBBox === undefined ? question.questionBBox : normalizeQuestionBBox(body.questionBBox, null, firstPageNumber(body.sourcePage || question.sourcePage), "manual"),
        updatedBy: sessionUserId(session),
        updatedAt: new Date().toISOString()
      });
      if (body.variants !== undefined || body.aiVariants !== undefined || body.bankVariants !== undefined || body.webVariants !== undefined) {
        const split = splitVariantGroups({
          variants: body.variants === undefined ? question.variants : body.variants,
          aiVariants: body.aiVariants === undefined ? question.aiVariants : body.aiVariants,
          bankVariants: body.bankVariants === undefined ? question.bankVariants : body.bankVariants,
          webVariants: body.webVariants === undefined ? question.webVariants : body.webVariants
        }, question);
        question.aiVariants = split.aiVariants;
        question.bankVariants = split.bankVariants;
        question.webVariants = split.webVariants;
        question.variants = split.variants;
      } else {
        question.variants = [...normalizeVariants(question.webVariants || [], question), ...normalizeVariants(question.aiVariants || [], question), ...normalizeVariants(question.bankVariants || [], question, 5)];
      }
      applyQuestionQuality(question);
      const after = revisionSnapshot(question);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        addRevision(question, session, "manual.edit", before, after, "人工编辑待审核题");
      }
      await writeDb(db);
      return json(res, 200, { question });
    }

    if (pendingMatch && req.method === "DELETE") {
      const db = await readDb();
      db.pendingQuestions = db.pendingQuestions.filter((q) => !(q.id === pendingMatch[1] && belongsToTenant(q, session)));
      addAuditLog(db, session, "pending.delete", "pendingQuestion", pendingMatch[1], "跳过待审核题");
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/pending-questions/approve" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const tenantPending = db.pendingQuestions.filter((q) => belongsToTenant(q, session));
      const ids = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids) : new Set(tenantPending.map((q) => q.id));
      const selected = tenantPending.filter((q) => ids.has(q.id));
      selected.forEach(applyQuestionQuality);
      const invalid = selected.filter((q) => q.qualityErrors?.length);
      if (invalid.length && !body.force) {
        await writeDb(db);
        return json(res, 422, {
          error: `${invalid.length} 道题未通过质检，已标红，请修好后再入库`,
          invalidQuestions: invalid.map((q) => ({ id: q.id, stem: q.stem, errors: q.qualityErrors, warnings: q.qualityWarnings }))
        });
      }
      const { created, skipped } = createQuestionsFromPending(db, selected, { includeVariants: body.includeVariants !== false, force: Boolean(body.force) });
      ensureQuestionCapacity(db, session, created.length);
      db.questions.unshift(...created);
      db.pendingQuestions = db.pendingQuestions.filter((q) => !(ids.has(q.id) && belongsToTenant(q, session)));
      addActivity(db, "审核入库", `保存 ${created.length} 道题，跳过 ${skipped} 道重复题`, session);
      addAuditLog(db, session, "question.approve", "question", "", `保存 ${created.length} 道题，跳过 ${skipped} 道重复题`);
      await writeDb(db);
      return json(res, 201, { questions: created, skippedDuplicates: skipped });
    }

    const questionMatch = pathname.match(/^\/api\/questions\/([^/]+)$/);
    if (questionMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.questions.find((q) => q.id === questionMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "题目不存在" });
      Object.assign(question, {
        ...body,
        stem: body.stem === undefined ? question.stem : normalizeQuestionText(body.stem),
        options: body.options === undefined ? question.options : normalizeOptions(body.options),
        answer: body.answer === undefined ? question.answer : normalizeQuestionText(body.answer),
        explanation: body.explanation === undefined ? question.explanation : normalizeQuestionText(body.explanation),
        knowledge: body.knowledge === undefined ? normalizeKnowledgeTags(question.knowledge, question.subject, question.stem) : normalizeKnowledgeTags(body.knowledge, body.subject || question.subject, body.stem || question.stem),
        sourceImage: "",
        updatedBy: sessionUserId(session),
        updatedAt: new Date().toISOString()
      });
      applyQuestionMatchProfile(question);
      addActivity(db, "更新题目", question.stem.slice(0, 40), session);
      addAuditLog(db, session, "question.update", "question", question.id, question.stem.slice(0, 80));
      await writeDb(db);
      return json(res, 200, { question });
    }

    if (questionMatch && req.method === "DELETE") {
      const db = await readDb();
      db.questions = db.questions.filter((q) => !(q.id === questionMatch[1] && belongsToTenant(q, session)));
      addAuditLog(db, session, "question.delete", "question", questionMatch[1], "删除题目");
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/students" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const student = stampTenant({
        id: randomUUID(),
        name: String(body.name || "").trim(),
        stage: body.stage || "小学",
        grade: body.grade || "",
        level: body.level || "基础",
        notes: body.notes || ""
      }, session);
      if (!student.name) return json(res, 400, { error: "学生姓名不能为空" });
      db.students.unshift(student);
      addActivity(db, "新增学生", student.name, session);
      addAuditLog(db, session, "student.create", "student", student.id, student.name);
      await writeDb(db);
      return json(res, 201, { student });
    }

    const studentMatch = pathname.match(/^\/api\/students\/([^/]+)$/);
    if (studentMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const student = db.students.find((s) => s.id === studentMatch[1] && belongsToTenant(s, session));
      if (!student) return json(res, 404, { error: "学生不存在" });
      Object.assign(student, body, { updatedBy: sessionUserId(session), updatedAt: new Date().toISOString() });
      await writeDb(db);
      return json(res, 200, { student });
    }

    if (studentMatch && req.method === "DELETE") {
      const db = await readDb();
      db.students = db.students.filter((s) => !(s.id === studentMatch[1] && belongsToTenant(s, session)));
      addAuditLog(db, session, "student.delete", "student", studentMatch[1], "删除学生");
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/mistakes" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const mistake = stampTenant({
        id: randomUUID(),
        studentId: body.studentId || "",
        questionId: body.questionId || "",
        reason: body.reason || "",
        note: body.note || "",
        date: body.date || new Date().toISOString().slice(0, 10),
        resolved: false
      }, session);
      db.mistakes.unshift(mistake);
      addActivity(db, "记录错题", mistake.reason || "未填写原因", session);
      addAuditLog(db, session, "mistake.create", "mistake", mistake.id, mistake.reason || "");
      await writeDb(db);
      return json(res, 201, { mistake });
    }

    const mistakeMatch = pathname.match(/^\/api\/mistakes\/([^/]+)$/);
    if (mistakeMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const mistake = db.mistakes.find((m) => m.id === mistakeMatch[1] && belongsToTenant(m, session));
      if (!mistake) return json(res, 404, { error: "错题记录不存在" });
      Object.assign(mistake, body, { updatedBy: sessionUserId(session), updatedAt: new Date().toISOString() });
      await writeDb(db);
      return json(res, 200, { mistake });
    }

    if (mistakeMatch && req.method === "DELETE") {
      const db = await readDb();
      const before = db.mistakes.length;
      db.mistakes = db.mistakes.filter((m) => !(m.id === mistakeMatch[1] && belongsToTenant(m, session)));
      if (db.mistakes.length === before) return json(res, 404, { error: "错题记录不存在" });
      addAuditLog(db, session, "mistake.delete", "mistake", mistakeMatch[1], "删除错题记录");
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/assignments" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const assignment = stampTenant({
        id: randomUUID(),
        title: body.title || `作业 ${new Date().toLocaleDateString("zh-CN")}`,
        studentId: body.studentId || "",
        studentName: body.studentName || "",
        subject: body.subject || "",
        grade: body.grade || "",
        duration: body.duration || "40 分钟",
        score: body.score || "100",
        exportMode: body.exportMode || "student",
        questionIds: Array.isArray(body.questionIds) ? body.questionIds : [],
        generatedQuestions: Array.isArray(body.generatedQuestions) ? body.generatedQuestions : []
      }, session);
      db.assignments.unshift(assignment);
      addActivity(db, "生成作业", assignment.title, session);
      addAuditLog(db, session, "assignment.create", "assignment", assignment.id, assignment.title);
      await writeDb(db);
      return json(res, 201, { assignment });
    }

    const assignmentMatch = pathname.match(/^\/api\/assignments\/([^/]+)$/);
    if (assignmentMatch && req.method === "DELETE") {
      const db = await readDb();
      const before = db.assignments.length;
      db.assignments = db.assignments.filter((assignment) => !(assignment.id === assignmentMatch[1] && belongsToTenant(assignment, session)));
      if (db.assignments.length === before) return json(res, 404, { error: "作业不存在" });
      addAuditLog(db, session, "assignment.delete", "assignment", assignmentMatch[1], "删除作业");
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/assignments/export-word" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const content = await assignmentWordDocx(db, body, session);
      const filename = safeName(`${body.title || "作业"}.docx`);
      addAuditLog(db, session, "assignment.export", "assignment", "", filename);
      await writeDb(db);
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      });
      return res.end(content);
    }

    if (pathname === "/api/ai/classify" && req.method === "POST") {
      const { stem = "" } = await readJson(req);
      const db = await readDb();
      const prompt = `请把下面题目分类为 JSON，不要输出多余文字。字段：subject, stage, grade, chapter, knowledge(array), level(基础/提高/压轴), type, answer, explanation。knowledge 只写 1-2 个大知识点，例如“必然事件/不可能事件/随机事件”统一写“概率”。\n题目：${stem}`;
      const content = await callQwen([{ role: "user", content: prompt }], { db, session, purpose: "classify" });
      const result = parseAiJson(content);
      result.knowledge = normalizeKnowledgeTags(result.knowledge, result.subject, stem);
      await writeDb(db);
      return json(res, 200, { result, raw: content });
    }

    if (pathname === "/api/ai/generate" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const count = Math.max(1, Math.min(Number(body.count || 5), 20));
      const target = {
        stem: body.reference || "",
        subject: body.subject || "初中数学",
        stage: body.stage || (String(body.subject || "").includes("小学") ? "小学" : "初中"),
        grade: body.grade || "",
        chapter: body.chapter || "",
        knowledge: normalizeKnowledgeTags(body.knowledge || body.chapter || "", body.subject || "初中数学", body.reference || ""),
        level: body.level || "基础",
        type: body.type || "",
        tenantId: sessionTenantId(session)
      };
      const reusable = findReusableQuestions(db, target, { limit: count });
      if (reusable.length >= count) {
        return json(res, 200, { questions: reusable.slice(0, count), reused: reusable.length, generated: 0, raw: "" });
      }
      const needed = count - reusable.length;
      const prompt = `你是家教老师的出题助手。请基于要求生成练习题，输出 JSON 数组，不要输出多余文字。每项字段：stem, answer, explanation, subject, stage, grade, chapter, knowledge(array), level, type。knowledge 只写 1-2 个大知识点，不要写细分考点。如果生成看图题，不能只写“如图”却不给图，必须用“图形说明：...”把图形关系写完整，使题目不依赖外部图片也能做。
要求：
科目：${target.subject}
学段：${target.stage}
年级：${body.grade || ""}
难度：${body.level || "基础"}
章节/知识点：${body.knowledge || body.chapter || ""}
数量：${needed}
参考题：
${body.reference || ""}`;
      const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.5, db, session, purpose: "generate_questions" });
      const result = parseAiJson(content);
      const generated = (Array.isArray(result) ? result : [result]).map((item) => ({
        ...target,
        ...item,
        options: normalizeOptions(item.options),
        knowledge: normalizeKnowledgeTags(item.knowledge || target.knowledge, item.subject || target.subject, item.stem || ""),
        sourceImage: "",
        source: "AI 生成"
      }));
      await writeDb(db);
      return json(res, 200, {
        questions: reusable.concat(generated).slice(0, count),
        reused: reusable.length,
        generated: generated.length,
        raw: content
      });
    }

    if (pathname === "/api/ai/ocr" && req.method === "POST") {
      const { uploadId } = await readJson(req);
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadId && belongsToTenant(item, session));
      if (!upload) return json(res, 404, { error: "文件不存在" });
      if (!/^image\//i.test(upload.type)) return json(res, 400, { error: "AI OCR 目前支持图片文件。扫描版 PDF 请先转成图片再上传，或复制 PDF 文本后粘贴拆题。" });
      const bytes = await readObject(upload.storedName);
      const dataUrl = `data:${upload.type};base64,${bytes.toString("base64")}`;
      const content = await callQwen([{
        role: "user",
        content: [
          { type: "text", text: "请识别图片中的练习题，保留题号、公式、选项和表格结构。只输出可复制文本。数学指数写成 a^2、10^-6；如果题目含图，请补一句“图形说明：...”描述关键关系。" },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }], { vision: true, temperature: 0.1, db, session, purpose: "manual_ocr", pages: 1 });
      upload.extractedText = normalizeExtractedText(content);
      upload.extractionNote = "已通过千问视觉 OCR 识别，请校对后入库。";
      await writeDb(db);
      return json(res, 200, { text: upload.extractedText, suggestions: splitQuestionsFromText(upload.extractedText) });
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    return json(res, status, { error: error.message || "服务器错误" });
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.normalize(path.join(publicDir, requested));
  if (!target.startsWith(publicDir)) return text(res, 403, "Forbidden");
  try {
    const file = await fs.readFile(target);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    const index = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(index);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
});

if (process.argv.includes("--backfill-match-profiles")) {
  const db = await readDb();
  const summary = backfillQuestionMatchProfiles(db);
  await writeDb(db);
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
  process.exit(0);
}

server.listen(PORT, () => {
  console.log(`ZenoX Exercise running at http://127.0.0.1:${PORT}`);
});
