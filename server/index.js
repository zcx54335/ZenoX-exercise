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

const analysisJobs = new Map();
const rateBuckets = new Map();

validateStartupConfig();
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(pageImageDir, { recursive: true });
await fs.mkdir(questionImageDir, { recursive: true });
initObjectStorage();
await initDbStorage();

function initObjectStorage() {
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
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
    if (POSTGRES_SYNC_RELATIONAL) {
      await applyPostgresRelationalSchema();
    }
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
        analysis_progress, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, $17, $18)
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
      asDate(upload.createdAt),
      asDate(upload.updatedAt)
    ]));

    await insertRows(client, `
      insert into questions (
        id, tenant_id, created_by, updated_by, stem, options, answer, explanation,
        subject, stage, grade, chapter, knowledge, level, type, source_upload_id,
        source_filename, source_page, question_image_stored_name, variant_of,
        quality_status, quality_errors, quality_warnings, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23::jsonb, $24, $25)
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
      question.variantOf || "",
      question.qualityStatus || "ok",
      asJson(question.qualityErrors || [], []),
      asJson(question.qualityWarnings || [], []),
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
      if (upload.extractedText && upload.extractedText.length > 20 && looksLikeGarbledText(upload.extractedText)) {
        return {
          ...upload,
          extractedText: "",
          extractionNote: "之前的提取结果疑似乱码，已自动隐藏。请转成图片后用 AI OCR，或复制 PDF 文本后粘贴拆题。"
        };
      }
      return upload;
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
      variants: [],
      variantOf: "",
      ...q,
      sourceImage: "",
      questionImage: q.questionImageStoredName ? `/api/questions/${q.id}/image` : (q.questionImage || ""),
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
      if (!next.questionImageStoredName && shouldUseSourcePageAsQuestionImage(next)) {
        next.questionImage = sourceImage;
      }
      return next;
    });
    db.pendingQuestions = dedupeQuestionItems(db.pendingQuestions.map((q) => applyQuestionQuality({
      options: [],
      variants: [],
      status: "pending",
      questionImage: "",
      sourceIndexOnPage: "",
      sourceTotalOnPage: "",
      ...q,
      stem: normalizeQuestionText(q.stem),
      options: normalizeOptions(q.options),
      answer: normalizeQuestionText(q.answer),
      explanation: normalizeQuestionText(q.explanation),
      sourceImage: q.sourceImage || sourceImageByQuestion.get(`${q.sourceUploadId}:${Number(q.sourcePage)}`) || "",
      knowledge: normalizeKnowledgeTags(q.knowledge, q.subject, q.stem)
    })));
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
        if (q.questionImageManual && q.questionImageStoredName) {
          q.questionImage = q.questionImage || `/api/pending-questions/${q.id}/image`;
        } else if (shouldUseSourcePageAsQuestionImage(q)) {
          q.questionImage = q.sourceImage;
        } else {
          q.questionImage = "";
        }
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
  if (FILE_STORAGE_DRIVER === "s3") {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return streamToBuffer(result.Body);
  }
  return fs.readFile(localObjectPath(key));
}

async function deleteObject(name) {
  const key = objectKey(name);
  if (FILE_STORAGE_DRIVER === "s3") {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => {});
    return;
  }
  await fs.rm(localObjectPath(key), { force: true }).catch(() => {});
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
    .replace(/\{([^{}]+)\}\^\{([^{}]+)\}/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
    .replace(/([A-Za-z0-9）)])\^\{([^{}]+)\}/g, (_, base, exp) => `${base}${toSuperscript(exp)}`)
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
  return {
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
    sourceImage: input.sourceImage || "",
    questionImage: input.questionImage || "",
    questionImageManual: Boolean(input.questionImageManual),
    questionImageStoredName: input.questionImageStoredName || "",
    sourceText: input.sourceText || "",
    variantOf: input.variantOf || "",
    variants: Array.isArray(input.variants) ? input.variants : [],
    duplicateOf: input.duplicateOf || "",
    forceApproved: Boolean(input.forceApproved),
    qualityStatus: input.qualityStatus || "ok",
    qualityErrors: Array.isArray(input.qualityErrors) ? input.qualityErrors : [],
    qualityWarnings: Array.isArray(input.qualityWarnings) ? input.qualityWarnings : [],
    tenantId: input.tenantId || DEFAULT_TENANT_ID,
    createdBy: input.createdBy || DEFAULT_ADMIN_ID,
    updatedBy: input.updatedBy || input.createdBy || DEFAULT_ADMIN_ID,
    createdAt: now,
    updatedAt: now
  };
}

function makePendingQuestion(input = {}) {
  const question = makeQuestion(input);
  return applyQuestionQuality({
    ...question,
    status: input.status || "pending",
    variants: normalizeVariants(input.variants, question),
    createdAt: input.createdAt || question.createdAt,
    updatedAt: new Date().toISOString()
  });
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

function normalizeVariants(variants = [], parent = {}) {
  return (Array.isArray(variants) ? variants : []).slice(0, 3).map((item) => normalizeVariant(item, parent)).filter(Boolean);
}

function normalizeVariant(item = {}, parent = {}) {
  const subject = normalizeOneOf(item.subject || parent.subject, SUBJECTS, parent.subject || "初中数学");
  const stem = normalizeQuestionText(item.stem);
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
    source: item.source || "",
    sourceQuestionId: item.sourceQuestionId || "",
    variantOf: parent.id || ""
  };
  if (!variant.stem) return null;
  if (!isVariantTypeConsistent(variant, parent)) return null;
  return variant;
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
  if ((parentIsChoice || variant.type === "选择题") && !hasVisibleChoiceOptions(variant)) return false;
  if (!variantIsChoice && isBareChoiceAnswer(variant.answer)) return false;
  return true;
}

function hasBoundQuestionImage(question = {}) {
  return Boolean(
    question.questionImageStoredName
    || question.questionImageManual
    || (question.questionImage && !String(question.questionImage).includes("/uploads/"))
    || shouldUseSourcePageAsQuestionImage(question)
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

function hasTextDiagramDescription(text = "") {
  return /图形说明[:：]\s*\S{6,}/.test(String(text));
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
  const type = question.type || inferQuestionType(body);
  const answer = normalizeQuestionText(question.answer);
  const choiceLike = type === "选择题" || hasVisibleChoiceOptions({ ...question, stem, options });

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
    errors.push("题干提到如图/图中/阴影，但没有绑定本题配图");
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

function findReusableQuestions(db, target = {}, { limit = 3, exclude = [] } = {}) {
  const excluded = new Set(exclude.filter(Boolean));
  const targetFingerprint = fingerprint(target.stem);
  const targetTenant = target.tenantId || DEFAULT_TENANT_ID;
  const scored = db.questions
    .filter((q) => (q.tenantId || DEFAULT_TENANT_ID) === targetTenant && q.stem && !excluded.has(q.id) && fingerprint(q.stem) !== targetFingerprint)
    .map((q) => ({ question: q, score: similarityScore(target, q) }))
    .filter(({ score }) => score >= 18)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ question }) => ({
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
    source: "题库复用",
    sourceQuestionId: question.id
  }));
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
      tenantId: upload.tenantId || DEFAULT_TENANT_ID,
      createdBy: upload.createdBy || DEFAULT_ADMIN_ID,
      updatedBy: upload.updatedBy || upload.createdBy || DEFAULT_ADMIN_ID,
      status: "needs_ai"
    });
    pending.variants = [];
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
  const bankVariants = findReusableQuestions(db, question, { limit: 3 });
  const prompt = `请把下面这道题补全为 JSON，不要 Markdown，不要额外解释。
字段：stem, options(array), answer, explanation, subject, stage, grade, chapter, knowledge(array), level(基础/提高/压轴), type, variants(array)。
knowledge 只写 1-2 个大知识点，不要写细分考点。例如“必然事件/不可能事件/随机事件/事件分类”统一写“概率”。
variants 生成 ${Math.max(0, 3 - bankVariants.length)} 道同知识点同难度变式题；每道变式含 stem, options(array), answer, explanation, knowledge(array), level, type。
变式必须和原题题型一致：选择题必须给出 A/B/C/D 选项，答案用选项字母；非选择题不能只把答案写成 A/B/C/D。
如果原题是看图题，变式不要只写“如图”却不给图；必须把图形关系完整写进 stem，例如用“图形说明：圆被平均分成4份，其中1份为阴影”等文字条件，让题目不依赖外部图片也能做。
不要把“选择题/填空题/解答题”标题、目录、页眉页脚、分值说明当成题目。不要把（1）（2）（3）小问拆成独立题，必须合并在同一道大题里。
如果无法补全为完整题目，请返回原题并在 explanation 中说明缺少的信息，不要编造成另一道题。
subject 只能是：${SUBJECTS.join("、")}。
如果已有选项，请保留；如果题干包含图形，请用文字描述关键关系。

题目：
${formatQuestionBodyForAi(question)}`;
  const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.2, db, session, purpose: "pending_enrich" });
  const parsed = parseAiJson(content);
  const enriched = Array.isArray(parsed) ? parsed[0] : parsed.questions?.[0] || parsed;
  Object.assign(question, {
    ...question,
    ...enriched,
    options: normalizeOptions(enriched.options || question.options),
    knowledge: normalizeKnowledgeTags(enriched.knowledge, enriched.subject || question.subject, enriched.stem || question.stem),
    variants: fillVariantsFromBank(db, { ...question, ...enriched }, enriched.variants),
    status: "pending",
    updatedAt: new Date().toISOString()
  });
  applyQuestionQuality(question);
  return question;
}

function formatQuestionBodyForAi(question) {
  const options = normalizeOptions(question.options).join("\n");
  return [question.stem, options].filter(Boolean).join("\n");
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

async function ensureQuestionCrop(upload, pageNumber, index = 0, total = 1) {
  const safeIndex = Math.max(0, Number(index) || 0);
  const safePage = Number(pageNumber) || 1;
  const storedName = `question-images/crops/${upload.id}/page-${safePage}-q-${safeIndex}.png`;
  if (await objectExists(storedName)) return storedName;

  const outputDir = FILE_STORAGE_DRIVER === "s3"
    ? path.join(dataDir, ".tmp", "question-crops", upload.id)
    : path.dirname(localObjectPath(storedName));
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `page-${safePage}-q-${safeIndex}.png`);

  const page = (upload.pages || []).find((item) => Number(item.page) === safePage) || { page: safePage };
  const sourcePath = await pageImagePathForUpload(upload, page);
  if (!sourcePath) return "";
  const { width, height } = await readImageSize(sourcePath);
  if (!width || !height) return "";

  const count = Math.max(1, Math.min(Number(total) || 1, 8));
  const topMargin = Math.round(height * 0.05);
  const bottomMargin = Math.round(height * 0.04);
  const usableHeight = Math.max(1, height - topMargin - bottomMargin);
  const bandHeight = Math.ceil(usableHeight / count);
  const cropHeight = Math.min(height, Math.ceil(bandHeight * 1.25));
  const y = Math.max(0, Math.min(height - cropHeight, topMargin + safeIndex * bandHeight - Math.round(bandHeight * 0.12)));
  const cropWidth = width;
  const x = 0;

  await runProcess("sips", [
    "-c", String(cropHeight), String(cropWidth),
    "--cropOffset", String(y), String(x),
    sourcePath,
    "--out", outputPath
  ]);
  await saveObject(storedName, await fs.readFile(outputPath), "image/png");
  return storedName;
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
    if (parts.length > 1) {
      for (const text of parts) {
        if (!looksLikeQuestionCandidate(text)) continue;
        pageSources.push({ page: page.page, text, image: page.image || "" });
      }
    } else if (isTextReliable(page.text) && looksLikeQuestionCandidate(page.text)) {
      pageSources.push({ page: page.page, text: page.text, image: page.image || "" });
    }
    pageSources.forEach((source, index) => {
      sources.push({
        ...source,
        indexOnPage: index,
        totalOnPage: pageSources.length
      });
    });
  }
  return sources;
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
  const args = ["-png", "-r", "130", filePath, prefix];
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
  const bytes = await fs.readFile(filePath);
  const dataUrl = `data:${mimeType || "image/png"};base64,${bytes.toString("base64")}`;
  return normalizeExtractedText(await callQwen([{
    role: "user",
    content: [
      { type: "text", text: "请识别图片中的练习题，保留题号、公式、选项、表格和图形说明。只输出可复制文本，不要解释。数学指数写成 a^2、10^-6，分式写成 (a+b)/(c+d)；如果题目含图，请补一句“图形说明：...”描述关键关系。" },
      { type: "image_url", image_url: { url: dataUrl } }
    ]
  }], { vision: true, temperature: 0.1, ...context, purpose: context.purpose || "ocr_image", pages: context.pages || 1 }));
}

function isLikelyTwoPageSpread(size = {}) {
  const width = Number(size.width || 0);
  const height = Number(size.height || 0);
  return width >= 900 && height >= 500 && width / Math.max(1, height) >= 1.25;
}

async function ocrImageSpread(filePath, mimeType, context = {}) {
  const size = await readImageSize(filePath).catch(() => ({ width: 0, height: 0 }));
  if (!isLikelyTwoPageSpread(size)) return "";
  const bytes = await fs.readFile(filePath);
  const dataUrl = `data:${mimeType || "image/png"};base64,${bytes.toString("base64")}`;
  const regions = [
    {
      label: "左半页",
      instruction: "只识别图片左半部分的题目。不要识别右半部分。保留题号、表格、公式、小问和图形说明。"
    },
    {
      label: "右半页",
      instruction: "只识别图片右半部分的题目。不要识别左半部分。尤其注意右上、右中位置的题号和图表题，不能因为左边已有题目就停止。保留题号、统计图、扇形图、公式、小问和图形说明。"
    }
  ];
  const parts = [];
  for (const region of regions) {
    const text = await callQwen([{
      role: "user",
      content: [
        {
          type: "text",
          text: `${region.instruction}

这是一张横向扫描页，可能同时包含左右两页或左右两栏。请逐行识别 ${region.label}。只输出可复制文本，不要解释。数学指数写成 a^2，分式写成 (a+b)/(c+d)，根号写成 sqrt(x)。如果有统计图、几何图或表格，请用“图形说明：...”补充关键关系。`
        },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }], { vision: true, temperature: 0.1, ...context, purpose: `${context.purpose || "ocr_spread"}_${region.label}`, pages: 1 });
    const cleaned = normalizeExtractedText(text);
    if (cleaned && !/^无|没有|未识别/i.test(cleaned)) parts.push(`【${region.label}】\n${cleaned}`);
  }
  return normalizeExtractedText(parts.join("\n\n"));
}

async function ocrImageBatch(items, context = {}) {
  const spreadResults = new Map();
  const normalItems = [];
  for (const item of items) {
    const spreadText = await ocrImageSpread(item.imagePath, item.mimeType, context).catch(() => "");
    if (spreadText) {
      spreadResults.set(Number(item.page), spreadText);
    } else {
      normalItems.push(item);
    }
  }
  if (!normalItems.length) {
    return items.map((item) => ({ page: item.page, text: spreadResults.get(Number(item.page)) || "" }));
  }
  const content = [{
    type: "text",
    text: `请按图片顺序识别每一页练习题。只输出 JSON 数组，不要 Markdown。格式：[{"page":页码,"text":"识别文本"}]。保留题号、公式、选项、表格和图形说明。遇到左右两页合在一张图、左右分栏或右侧有题时，必须先读左半区再读右半区，不能漏掉右边的题。数学指数写成 a^2、10^-6，分式写成 (a+b)/(c+d)，根号写成 sqrt(x)。如果题目含图，请在题干中补一句“图形说明：...”描述关键关系。`
  }];
  for (const item of normalItems) {
    const bytes = await fs.readFile(item.imagePath);
    content.push({ type: "text", text: `第 ${item.page} 页：` });
    content.push({
      type: "image_url",
      image_url: { url: `data:${item.mimeType || "image/png"};base64,${bytes.toString("base64")}` }
    });
  }
  const raw = await callQwen([{ role: "user", content }], { vision: true, temperature: 0.1, ...context, purpose: context.purpose || "ocr_batch", pages: context.pages || normalItems.length });
  const parsed = parseAiJson(raw);
  const pages = Array.isArray(parsed) ? parsed : parsed.pages || [];
  const byPage = new Map(pages.map((page, index) => [Number(page.page || normalItems[index]?.page), normalizeExtractedText(page.text || page.content || "")]));
  return items.map((item, index) => ({
    page: item.page,
    text: spreadResults.get(Number(item.page)) || byPage.get(Number(item.page)) || normalizeExtractedText(pages[index]?.text || "")
  }));
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
        page.text = await ocrImageFile(item.imagePath, item.mimeType, { ...context, purpose: context.purpose || "ocr_fallback", pages: 1 });
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
3. 每道题字段：stem, options(array), answer, explanation, subject, stage, grade, chapter, knowledge(array), level, type, sourcePage, needsImage(boolean), imageNote, answerSource。
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
  const answerContext = answerPages.length
    ? normalizeExtractedText(answerPages.map((page) => `【第 ${page.page} 页答案参考】\n${page.text}`).join("\n\n")).slice(0, 7000)
    : "";
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
        sourceText: item.sourceText || item.stem || ""
      });
      pending.variants = [];
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
  const needsVision = Boolean(process.env.QWEN_API_KEY) && workingPages.some((page) => !isTextReliable(page.text) && page.image);
  if (needsVision) {
    workingPages = await ensurePageTextWithOcr(upload, workingPages, { db, session, purpose: "upload_ocr" });
  }
  const extractedText = normalizeExtractedText(workingPages.map((page) => page.text).join("\n\n"));
  const aiCandidates = process.env.QWEN_API_KEY
    ? await analyzePagesWithAi(db, upload, workingPages, defaults)
    : [];
  const fallbackCandidates = pendingQuestionsFromPages(db, upload, workingPages, defaults);
  const candidates = reconcileAiCandidates(aiCandidates, fallbackCandidates);
  const { accepted, skipped } = markDuplicates(db, candidates);
  db.pendingQuestions.unshift(...accepted);
  if (accepted.length) addAuditLog(db, session, "analysis.pending.create", "upload", upload.id, `生成 ${accepted.length} 道待审核题`);
  return {
    extractedText,
    pendingQuestions: accepted,
    skippedDuplicates: skipped,
    pages: workingPages
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
  const jobSession = {
    tenantId: options.tenantId || DEFAULT_TENANT_ID,
    userId: options.userId || DEFAULT_ADMIN_ID,
    username: options.username || ADMIN_USER,
    role: options.role || "owner"
  };
  try {
    await updateUploadRecord(uploadId, async (upload, db) => {
      if (!belongsToTenant(upload, jobSession)) throw new Error("无权分析该资料");
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
    let workingPages = selectedPageNumbers
      ? allPages.filter((page) => selectedPageNumbers.includes(Number(page.page)))
      : allPages;
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
        }], { db, session: jobSession, purpose: "analysis_ocr", pages: 1 });
        if (outputPage) {
          outputPage.text = result?.text || "";
          delete outputPage.ocrError;
        }
      } catch (error) {
        try {
          const fallbackText = await ocrImageFile(imagePath, page.image?.includes("/pages/") ? "image/png" : upload.type, { db, session: jobSession, purpose: "analysis_ocr_fallback", pages: 1 });
          if (outputPage) {
            outputPage.text = fallbackText;
            delete outputPage.ocrError;
          }
        } catch (fallbackError) {
          if (outputPage) outputPage.ocrError = fallbackError.message || error.message || "OCR 失败";
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
      });
    }

    const skippedAfterOcr = workingPages.filter(isSkippableMaterialPage).length;
    workingPages = workingPages.filter((page) => !isSkippableMaterialPage(page));

    ({ db, upload } = await updateUploadRecord(uploadId, async (record) => {
      record.analysisProgress = {
        ...record.analysisProgress,
        phase: "split",
        message: process.env.QWEN_API_KEY ? "AI 正在抽题并补答案解析..." : "正在拆分题目...",
        pendingQuestions: questionSourcesFromPages(workingPages).length
      };
    }));

    const aiCandidates = process.env.QWEN_API_KEY
      ? await analyzePagesWithAi(db, upload, workingPages, defaults)
      : [];
    const fallbackCandidates = pendingQuestionsFromPages(db, upload, workingPages, defaults);
    const candidates = reconcileAiCandidates(aiCandidates, fallbackCandidates);
    const { accepted, skipped } = markDuplicates(db, candidates);
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
    upsertJobRecord(db, jobSession, options.jobId || "", "analysis", "done", upload.id, upload.analysisProgress.message);
    addActivity(db, "重新分析资料", `${upload.filename}，生成 ${accepted.length} 道待审核题`, jobSession);
    addAuditLog(db, jobSession, "analysis.complete", "upload", upload.id, upload.analysisProgress.message);
    await writeDb(db);
  } catch (error) {
    await updateUploadRecord(uploadId, async (upload, db) => {
      upload.analysisStatus = "failed";
      upload.analysisError = error.message || "重新分析失败";
      upload.analysisProgress = {
        ...upload.analysisProgress,
        phase: "failed",
        message: upload.analysisError,
        finishedAt: new Date().toISOString()
      };
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
      forceApproved: Boolean(force && item.qualityErrors?.length),
      variants: item.variants || []
    });
    if (original.questionImageStoredName) original.questionImage = `/api/questions/${original.id}/image`;
    existing.set(scopedKey, original.id);
    created.push(original);
    if (!includeVariants) continue;
    for (const variant of normalizeVariants(item.variants, original)) {
      const variantKey = fingerprint(variant.stem);
      const scopedVariantKey = `${original.tenantId || DEFAULT_TENANT_ID}:${variantKey}`;
      if (!variantKey || existing.has(scopedVariantKey)) {
        skipped += 1;
        continue;
      }
      const question = makeQuestion({
        ...original,
        ...variant,
        sourceUploadId: original.sourceUploadId,
        sourceFilename: original.sourceFilename,
        sourcePage: original.sourcePage,
        sourceImage: "",
        questionImage: "",
        questionImageManual: false,
        questionImageStoredName: "",
        variantOf: original.id,
        variants: []
      });
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

async function imageAttachmentForQuestion(question = {}, index = 0) {
  if (!question.questionImageStoredName) return null;
  try {
    const bytes = await readObject(question.questionImageStoredName);
    const ext = path.extname(question.questionImageStoredName).toLowerCase() || ".png";
    const mime = MIME_TYPES[ext]?.split(";")[0] || "image/png";
    return {
      cid: `question-image-${index}${ext}`,
      filename: `question-image-${index}${ext}`,
      bytes,
      ext,
      mime,
      base64: bytes.toString("base64").replace(/.{1,76}/g, "$&\r\n").trim()
    };
  } catch {
    return null;
  }
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

  bodyParts.push(docxParagraph("答案与解析", { bold: true, size: 30 }));
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    bodyParts.push(docxParagraph(`${index + 1}. 答案：${question.answer || "待补充"}\n解析：${question.explanation || "待补充"}`));
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
      hash,
      type: file.type,
      size: file.body.length,
      extractedText: "",
      extractionNote: "已保存文件。",
      uploadCount: 0,
      pageImages: [],
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

    const questionCropMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/question-crops\/(\d+)\/(\d+)$/);
    if (questionCropMatch && req.method === "GET") {
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === questionCropMatch[1] && belongsToTenant(item, session));
      if (!upload) return text(res, 404, "Not found");
      const pendingOnPage = db.pendingQuestions
        .filter((q) => q.sourceUploadId === upload.id && Number(q.sourcePage) === Number(questionCropMatch[2]))
        .sort((a, b) => Number(a.sourceIndexOnPage || 0) - Number(b.sourceIndexOnPage || 0));
      const storedName = await ensureQuestionCrop(upload, Number(questionCropMatch[2]), Number(questionCropMatch[3]), pendingOnPage.length || 1);
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

    if (pendingImageMatch && req.method === "POST") {
      const body = await readBody(req, MAX_IMAGE_UPLOAD_MB * 1024 * 1024 + 512 * 1024);
      const parts = parseMultipart(body, req.headers["content-type"]);
      const file = parts.find((part) => part.filename);
      if (!file || !file.body.length) return json(res, 400, { error: "没有收到图片" });
      validateUploadFile(file, { purpose: "image", maxBytes: MAX_IMAGE_UPLOAD_MB * 1024 * 1024 });
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingImageMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      const ext = path.extname(safeName(file.filename)).toLowerCase() || ".png";
      const storedName = `question-images/manual/${question.id}-${Date.now()}${ext}`;
      await saveObject(storedName, file.body, file.type || MIME_TYPES[ext] || "image/png");
      question.questionImageStoredName = storedName;
      question.questionImage = `/api/pending-questions/${question.id}/image?t=${Date.now()}`;
      question.questionImageManual = true;
      question.updatedAt = new Date().toISOString();
      applyQuestionQuality(question);
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

    if (pathname === "/api/analyze-text" && req.method === "POST") {
      const { text: sourceText = "", defaults = {} } = await readJson(req);
      const db = await readDb();
      ensureTenantEntitlement(db, session, "analysis");
      const upload = {
        id: `text-${randomUUID()}`,
        filename: "粘贴文本",
        type: "text/plain",
        storedName: "",
        tenantId: sessionTenantId(session),
        createdBy: sessionUserId(session),
        updatedBy: sessionUserId(session)
      };
      const pages = [{ page: 1, text: normalizeExtractedText(sourceText), image: "" }];
      const candidates = process.env.QWEN_API_KEY
        ? await analyzePagesWithAi(db, upload, pages, defaults)
        : splitQuestionsFromText(sourceText).map((stem) => makePendingQuestion({ ...defaults, stem, sourceFilename: "粘贴文本", tenantId: sessionTenantId(session), createdBy: sessionUserId(session), updatedBy: sessionUserId(session) }));
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
        await enrichPendingQuestion(db, question, session);
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

    const pendingMatch = pathname.match(/^\/api\/pending-questions\/([^/]+)$/);
    if (pendingMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.pendingQuestions.find((q) => q.id === pendingMatch[1] && belongsToTenant(q, session));
      if (!question) return json(res, 404, { error: "待审核题目不存在" });
      Object.assign(question, {
        ...body,
        options: body.options === undefined ? question.options : normalizeOptions(body.options),
        knowledge: body.knowledge === undefined ? normalizeKnowledgeTags(question.knowledge, question.subject, question.stem) : normalizeKnowledgeTags(body.knowledge, body.subject || question.subject, body.stem || question.stem),
        variants: body.variants === undefined ? question.variants : normalizeVariants(body.variants, question),
        updatedBy: sessionUserId(session),
        updatedAt: new Date().toISOString()
      });
      applyQuestionQuality(question);
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
        options: body.options === undefined ? question.options : normalizeOptions(body.options),
        knowledge: body.knowledge === undefined ? normalizeKnowledgeTags(question.knowledge, question.subject, question.stem) : normalizeKnowledgeTags(body.knowledge, body.subject || question.subject, body.stem || question.stem),
        sourceImage: "",
        updatedBy: sessionUserId(session),
        updatedAt: new Date().toISOString()
      });
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
        questionIds: Array.isArray(body.questionIds) ? body.questionIds : [],
        generatedQuestions: Array.isArray(body.generatedQuestions) ? body.generatedQuestions : []
      }, session);
      db.assignments.unshift(assignment);
      addActivity(db, "生成作业", assignment.title, session);
      addAuditLog(db, session, "assignment.create", "assignment", assignment.id, assignment.title);
      await writeDb(db);
      return json(res, 201, { assignment });
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

server.listen(PORT, () => {
  console.log(`ZenoX Exercise running at http://127.0.0.1:${PORT}`);
});
