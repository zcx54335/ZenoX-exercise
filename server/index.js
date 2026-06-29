import http from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
const dbPath = path.join(dataDir, "db.json");

const PORT = Number(process.env.PORT || 8080);
const APP_SECRET = process.env.APP_SECRET || "dev-secret-change-me";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen-plus";
const QWEN_VISION_MODEL = process.env.QWEN_VISION_MODEL || "qwen-vl-plus";

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
  questions: [],
  students: [],
  assignments: [],
  mistakes: [],
  uploads: [],
  activity: []
};

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadDir, { recursive: true });
if (!existsSync(dbPath)) {
  await fs.writeFile(dbPath, JSON.stringify(seedDb, null, 2), "utf8");
}

async function readDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    const db = { ...seedDb, ...JSON.parse(raw) };
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
    return db;
  } catch {
    return structuredClone(seedDb);
  }
}

async function writeDb(db) {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
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

function makeSession(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    nonce: randomBytes(12).toString("hex"),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
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
  const session = verifySession(parseCookies(req).session);
  if (!session) {
    json(res, 401, { error: "请先登录" });
    return null;
  }
  return session;
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体太大");
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

function splitQuestionsFromText(text) {
  const cleaned = normalizeExtractedText(text);
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\n(?=\s*(?:\d{1,3}[.、)]|[（(]\d{1,3}[)）]|[一二三四五六七八九十]+[、.]))/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 8);
  if (parts.length > 1) return parts;
  return cleaned
    .split(/(?<=。|？|\?|!|！)\s+(?=\d{1,3}[.、)]|\S{6,})/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 8);
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
  return {
    id: randomUUID(),
    stem: String(input.stem || "").trim(),
    answer: String(input.answer || "").trim(),
    explanation: String(input.explanation || "").trim(),
    subject: input.subject || "小学数学",
    stage: input.stage || "小学",
    level: input.level || "基础",
    grade: input.grade || "",
    chapter: input.chapter || "",
    knowledge: Array.isArray(input.knowledge) ? input.knowledge : parseTags(input.knowledge),
    type: input.type || inferQuestionType(input.stem || ""),
    studentName: input.studentName || "",
    mistakeReason: input.mistakeReason || "",
    sourceUploadId: input.sourceUploadId || "",
    duplicateOf: input.duplicateOf || "",
    createdAt: now,
    updatedAt: now
  };
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

function addActivity(db, action, detail) {
  db.activity.unshift({
    id: randomUUID(),
    action,
    detail,
    createdAt: new Date().toISOString()
  });
  db.activity = db.activity.slice(0, 80);
}

function fileHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function uploadKey(upload) {
  return upload.hash || `${upload.filename || ""}:${upload.size || 0}`;
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

async function callQwen(messages, { vision = false, temperature = 0.35 } = {}) {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("尚未配置 QWEN_API_KEY");
  const endpoint = `${QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: vision ? QWEN_VISION_MODEL : QWEN_MODEL,
      messages,
      temperature
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `千问接口返回 ${response.status}`);
  }
  return payload.choices?.[0]?.message?.content || "";
}

function parseAiJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] || raw;
  const start = Math.min(...["{", "["].map((char) => {
    const index = fenced.indexOf(char);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  }));
  const candidate = Number.isFinite(start) ? fenced.slice(start) : fenced;
  return JSON.parse(candidate);
}

async function handleUpload(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const body = await readBody(req, 40 * 1024 * 1024);
  const parts = parseMultipart(body, req.headers["content-type"]);
  const file = parts.find((part) => part.filename);
  if (!file || !file.body.length) return json(res, 400, { error: "没有收到文件" });

  const id = randomUUID();
  const filename = safeName(file.filename);
  const hash = fileHash(file.body);
  const storedName = `${id}-${filename}`;
  const filePath = path.join(uploadDir, storedName);

  let extractedText = "";
  let extractionNote = "已保存文件。";
  if (/pdf/i.test(file.type) || /\.pdf$/i.test(filename)) {
    extractedText = extractPdfText(file.body);
    extractionNote = extractedText
      ? "已从文本型 PDF 中提取到可靠内容，请校对后入库。"
      : "这份 PDF 没有提取到可靠文本，可能是扫描版、图片版或使用了特殊字体。系统已阻止乱码显示，请转成图片后用 AI OCR，或复制 PDF 文本后粘贴拆题。";
  } else if (/^text\//i.test(file.type)) {
    extractedText = normalizeExtractedText(file.body.toString("utf8"));
    extractionNote = "已读取文本内容。";
  } else if (/image\//i.test(file.type)) {
    extractionNote = "图片已保存，可点击 AI OCR 让千问识别。";
  } else if (/word|officedocument/i.test(file.type) || /\.docx?$/i.test(filename)) {
    extractionNote = "Word 文件已保存。当前无外部解析依赖，请复制文本粘贴拆题，或后续接入文档解析服务。";
  }

  const db = await readDb();
  const now = new Date().toISOString();
  let deduplicated = false;
  let upload = db.uploads.find((item) => item.hash === hash)
    || db.uploads.find((item) => item.filename === filename && item.size === file.body.length);

  if (upload) {
    deduplicated = true;
    Object.assign(upload, {
      hash,
      type: file.type,
      size: file.body.length,
      extractedText,
      extractionNote: `${extractionNote} 已识别为同一份资料，未新增重复记录。`,
      updatedAt: now,
      uploadCount: (upload.uploadCount || 1) + 1
    });
    addActivity(db, "更新资料", `${filename} 已存在，更新解析结果`);
  } else {
    await fs.writeFile(filePath, file.body);
    upload = {
      id,
      filename,
      storedName,
      hash,
      type: file.type,
      size: file.body.length,
      extractedText,
      extractionNote,
      uploadCount: 1,
      createdAt: now,
      updatedAt: now
    };
    db.uploads.unshift(upload);
    addActivity(db, "上传资料", `${filename} (${Math.round(file.body.length / 1024)} KB)`);
  }
  db.uploads = dedupeUploads(db.uploads);
  await writeDb(db);
  json(res, deduplicated ? 200 : 201, { upload, deduplicated, suggestions: splitQuestionsFromText(extractedText) });
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      if (body.username !== ADMIN_USER || body.password !== ADMIN_PASSWORD) {
        return json(res, 401, { error: "账号或密码不正确" });
      }
      const token = makeSession(body.username);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`
      });
      return res.end(JSON.stringify({ ok: true, username: body.username }));
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const session = requireAuth(req, res);
      if (!session) return;
      return json(res, 200, { username: session.username });
    }

    if (pathname === "/api/uploads" && req.method === "POST") return handleUpload(req, res);

    const session = requireAuth(req, res);
    if (!session) return;

    if (pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, await readDb());
    }

    if (pathname === "/api/questions/split" && req.method === "POST") {
      const { text: sourceText = "", defaults = {}, sourceUploadId = "" } = await readJson(req);
      const db = await readDb();
      const existing = new Map(db.questions.map((q) => [fingerprint(q.stem), q.id]));
      const questions = splitQuestionsFromText(sourceText).map((stem) => {
        const q = makeQuestion({ ...defaults, stem, sourceUploadId });
        q.duplicateOf = existing.get(fingerprint(q.stem)) || "";
        return q;
      });
      return json(res, 200, { questions });
    }

    if (pathname === "/api/questions" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const incoming = Array.isArray(body.questions) ? body.questions : [body];
      const existing = new Map(db.questions.map((q) => [fingerprint(q.stem), q.id]));
      const created = incoming
        .map((item) => {
          const q = makeQuestion(item);
          q.duplicateOf = existing.get(fingerprint(q.stem)) || "";
          existing.set(fingerprint(q.stem), q.id);
          return q;
        })
        .filter((q) => q.stem);
      db.questions.unshift(...created);
      addActivity(db, "题目录入", `新增 ${created.length} 道题`);
      await writeDb(db);
      return json(res, 201, { questions: created });
    }

    const questionMatch = pathname.match(/^\/api\/questions\/([^/]+)$/);
    if (questionMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const question = db.questions.find((q) => q.id === questionMatch[1]);
      if (!question) return json(res, 404, { error: "题目不存在" });
      Object.assign(question, {
        ...body,
        knowledge: body.knowledge === undefined ? question.knowledge : parseTags(body.knowledge),
        updatedAt: new Date().toISOString()
      });
      addActivity(db, "更新题目", question.stem.slice(0, 40));
      await writeDb(db);
      return json(res, 200, { question });
    }

    if (questionMatch && req.method === "DELETE") {
      const db = await readDb();
      db.questions = db.questions.filter((q) => q.id !== questionMatch[1]);
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/students" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const student = {
        id: randomUUID(),
        name: String(body.name || "").trim(),
        stage: body.stage || "小学",
        grade: body.grade || "",
        level: body.level || "基础",
        notes: body.notes || "",
        createdAt: new Date().toISOString()
      };
      if (!student.name) return json(res, 400, { error: "学生姓名不能为空" });
      db.students.unshift(student);
      addActivity(db, "新增学生", student.name);
      await writeDb(db);
      return json(res, 201, { student });
    }

    const studentMatch = pathname.match(/^\/api\/students\/([^/]+)$/);
    if (studentMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const student = db.students.find((s) => s.id === studentMatch[1]);
      if (!student) return json(res, 404, { error: "学生不存在" });
      Object.assign(student, body);
      await writeDb(db);
      return json(res, 200, { student });
    }

    if (studentMatch && req.method === "DELETE") {
      const db = await readDb();
      db.students = db.students.filter((s) => s.id !== studentMatch[1]);
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/mistakes" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const mistake = {
        id: randomUUID(),
        studentId: body.studentId || "",
        questionId: body.questionId || "",
        reason: body.reason || "",
        note: body.note || "",
        date: body.date || new Date().toISOString().slice(0, 10),
        resolved: false,
        createdAt: new Date().toISOString()
      };
      db.mistakes.unshift(mistake);
      addActivity(db, "记录错题", mistake.reason || "未填写原因");
      await writeDb(db);
      return json(res, 201, { mistake });
    }

    const mistakeMatch = pathname.match(/^\/api\/mistakes\/([^/]+)$/);
    if (mistakeMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const db = await readDb();
      const mistake = db.mistakes.find((m) => m.id === mistakeMatch[1]);
      if (!mistake) return json(res, 404, { error: "错题记录不存在" });
      Object.assign(mistake, body);
      await writeDb(db);
      return json(res, 200, { mistake });
    }

    if (pathname === "/api/assignments" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const assignment = {
        id: randomUUID(),
        title: body.title || `作业 ${new Date().toLocaleDateString("zh-CN")}`,
        studentId: body.studentId || "",
        studentName: body.studentName || "",
        subject: body.subject || "",
        grade: body.grade || "",
        duration: body.duration || "40 分钟",
        score: body.score || "100",
        questionIds: Array.isArray(body.questionIds) ? body.questionIds : [],
        generatedQuestions: Array.isArray(body.generatedQuestions) ? body.generatedQuestions : [],
        createdAt: new Date().toISOString()
      };
      db.assignments.unshift(assignment);
      addActivity(db, "生成作业", assignment.title);
      await writeDb(db);
      return json(res, 201, { assignment });
    }

    if (pathname === "/api/ai/classify" && req.method === "POST") {
      const { stem = "" } = await readJson(req);
      const prompt = `请把下面题目分类为 JSON，不要输出多余文字。字段：subject, stage, grade, chapter, knowledge(array), level(基础/提高/压轴), type, answer, explanation。\n题目：${stem}`;
      const content = await callQwen([{ role: "user", content: prompt }]);
      return json(res, 200, { result: parseAiJson(content), raw: content });
    }

    if (pathname === "/api/ai/generate" && req.method === "POST") {
      const body = await readJson(req);
      const prompt = `你是家教老师的出题助手。请基于要求生成练习题，输出 JSON 数组，不要输出多余文字。每项字段：stem, answer, explanation, subject, stage, grade, chapter, knowledge(array), level, type。
要求：
科目：${body.subject || "数学"}
学段：${body.stage || ""}
年级：${body.grade || ""}
难度：${body.level || "基础"}
章节/知识点：${body.knowledge || body.chapter || ""}
数量：${body.count || 5}
参考题：
${body.reference || ""}`;
      const content = await callQwen([{ role: "user", content: prompt }], { temperature: 0.5 });
      const result = parseAiJson(content);
      return json(res, 200, { questions: Array.isArray(result) ? result : [result], raw: content });
    }

    if (pathname === "/api/ai/ocr" && req.method === "POST") {
      const { uploadId } = await readJson(req);
      const db = await readDb();
      const upload = db.uploads.find((item) => item.id === uploadId);
      if (!upload) return json(res, 404, { error: "文件不存在" });
      if (!/^image\//i.test(upload.type)) return json(res, 400, { error: "AI OCR 目前支持图片文件。扫描版 PDF 请先转成图片再上传，或复制 PDF 文本后粘贴拆题。" });
      const bytes = await fs.readFile(path.join(uploadDir, upload.storedName));
      const dataUrl = `data:${upload.type};base64,${bytes.toString("base64")}`;
      const content = await callQwen([{
        role: "user",
        content: [
          { type: "text", text: "请识别图片中的练习题，保留题号、公式、选项和表格结构。只输出可复制文本。" },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }], { vision: true, temperature: 0.1 });
      upload.extractedText = normalizeExtractedText(content);
      upload.extractionNote = "已通过千问视觉 OCR 识别，请校对后入库。";
      await writeDb(db);
      return json(res, 200, { text: upload.extractedText, suggestions: splitQuestionsFromText(upload.extractedText) });
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    return json(res, 500, { error: error.message || "服务器错误" });
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.normalize(path.join(publicDir, requested));
  if (!target.startsWith(publicDir)) return text(res, 403, "Forbidden");
  try {
    const file = await fs.readFile(target);
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    const index = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
