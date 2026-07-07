const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
let confirmResolve = null;
let approveResolve = null;

const state = {
  db: { organizations: [], users: [], questions: [], pendingQuestions: [], students: [], assignments: [], mistakes: [], uploads: [], jobs: [], aiUsage: [], auditLogs: [], activity: [] },
  view: "import",
  selected: new Set(),
  selectedPending: new Set(),
  splitDrafts: [],
  currentUploadId: "",
  generatedQuestions: [],
  analysisPollers: new Map(),
  dismissedAnalysisErrors: new Set(),
  reviewUploadId: "all",
  reviewPage: 1,
  reviewPageSize: 1,
  reviewIndexScrollTop: 0,
  bankIssueFilter: "",
  bankUploadId: "",
  bankNavOpen: false,
  bankUploadMethod: "file",
  bankUploadStepOverride: 0,
  crop: {
    pendingId: "",
    imageUrl: "",
    questionBBox: null,
    sourcePage: "",
    startX: 0,
    startY: 0,
    rect: null,
    dragging: false
  }
};

const pendingActionTokens = new Map();
const imageViewerState = {
  scale: 1,
  fit: true,
  dragging: false,
  startX: 0,
  startY: 0,
  scrollLeft: 0,
  scrollTop: 0
};

const subjects = ["初中数学", "初中物理", "初中化学", "初中英语", "小学数学"];
const stages = ["小学", "初中"];
const levels = ["基础", "提高", "压轴"];
const types = ["选择题", "填空题", "解答题", "判断题", "完形填空", "阅读理解", "作文", "实验题", "计算题", "未分类"];

const titles = {
  import: ["资料入库", "资料解析"],
  bankSearch: ["题库管理", "题库搜索"],
  bankUpload: ["题库管理", "上传题库"],
  assignments: ["作业导出", "智能组卷"],
  students: ["学生跟踪", "学生画像"],
  settings: ["云端部署", "系统设置"]
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add("hidden"), 3200);
}

function confirmAction({ title = "确认操作", text = "这个操作不可撤销。", confirmText = "确认", cancelText = "取消" } = {}) {
  const modal = $("#confirmModal");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmOkBtn").textContent = confirmText;
  $("#confirmCancelBtn").textContent = cancelText;
  modal.classList.remove("hidden");
  $("#confirmCancelBtn").focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirmModal(result = false) {
  $("#confirmModal").classList.add("hidden");
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

function requestApproveMetadata(question = {}) {
  const modal = $("#approveModal");
  $("#approveSubject").innerHTML = optionTags(subjects, question.subject || $("#defaultSubject")?.value || "初中数学");
  $("#approveStage").innerHTML = optionTags(stages, question.stage || $("#defaultStage")?.value || "初中");
  $("#approveLevel").innerHTML = optionTags(levels, question.level || $("#defaultLevel")?.value || "基础");
  $("#approveType").innerHTML = optionTags(types, question.type || inferClientQuestionType(question.stem || ""));
  $("#approveGrade").value = question.grade || $("#defaultGrade")?.value || "";
  $("#approveChapter").value = question.chapter || $("#defaultChapter")?.value || "";
  modal.classList.remove("hidden");
  $("#approveGrade").focus();
  return new Promise((resolve) => {
    approveResolve = resolve;
  });
}

function closeApproveModal(result = false) {
  $("#approveModal").classList.add("hidden");
  const resolve = approveResolve;
  approveResolve = null;
  resolve?.(result);
}

function openImageViewer(src = "", title = "图片预览") {
  if (!src) return;
  $("#imageViewerTitle").textContent = title || "图片预览";
  $("#imageViewerMeta").textContent = "当前窗口查看 · 可缩放拖动";
  $("#imageViewerImg").src = src;
  $("#imageViewerImg").alt = title || "图片预览";
  imageViewerState.scale = 1;
  imageViewerState.fit = true;
  applyImageViewerScale();
  $("#imageViewerModal").classList.remove("hidden");
  $("#closeImageViewerBtn").focus();
}

function closeImageViewer() {
  $("#imageViewerModal").classList.add("hidden");
  $("#imageViewerImg").src = "";
  $("#imageViewerImg").alt = "";
  imageViewerState.dragging = false;
}

function applyImageViewerScale() {
  const img = $("#imageViewerImg");
  if (!img) return;
  img.classList.toggle("fit", imageViewerState.fit);
  img.style.transform = imageViewerState.fit ? "" : `scale(${imageViewerState.scale})`;
  img.style.transformOrigin = "top left";
  $("#imageViewerMeta").textContent = imageViewerState.fit
    ? "当前窗口查看 · 适应窗口"
    : `当前窗口查看 · ${Math.round(imageViewerState.scale * 100)}%`;
}

function setImageViewerScale(nextScale, fit = false) {
  imageViewerState.fit = fit;
  imageViewerState.scale = Math.min(4, Math.max(0.35, nextScale));
  applyImageViewerScale();
}

function inferClientQuestionType(stem = "") {
  if (/(^|\n)\s*A[.、．]\s*\S[\s\S]*(^|\n)\s*B[.、．]\s*\S/im.test(stem)) return "选择题";
  if (/____|_{2,}|\(\s*\)|（\s*）/.test(stem)) return "填空题";
  return "未分类";
}

function setProgressStep(step, message) {
  $("#progressText").textContent = message;
  $$("#uploadProgress [data-step]").forEach((item) => {
    item.classList.toggle("active", item.dataset.step === step);
  });
}

function setUploadBusy(isBusy, step = "upload", message = "上传文件中...") {
  const panel = $("#uploadProgress");
  const submit = $("#uploadForm button[type='submit']");
  const file = $("#fileInput");
  panel.classList.toggle("hidden", !isBusy);
  submit.disabled = isBusy;
  file.disabled = isBusy;
  submit.classList.toggle("loading", isBusy);
  submit.textContent = isBusy ? "处理中..." : "上传";
  if (isBusy) setProgressStep(step, message);
}

function isProbablyGarbledText(text = "") {
  const value = String(text);
  if (value.length < 20) return false;
  const bad = (value.match(/[□�@]{2,}|[\u0000-\u0008\u000b-\u001f]/g) || []).join("").length;
  const useful = (value.match(/[\u4e00-\u9fa5A-Za-z0-9=+\-×÷*/().,，。？！：；、]/g) || []).length;
  return bad > value.length * 0.08 || useful < value.length * 0.35;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    headers: options.body instanceof FormData ? {} : { "content-type": "application/json" },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.payload = payload;
    throw error;
  }
  return payload;
}

function fitTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight + 2, 78), 900);
  textarea.style.height = `${nextHeight}px`;
}

function autoFitTextareas(root = document) {
  $$("textarea", root).forEach(fitTextarea);
}

function replacePendingQuestionInState(question = {}) {
  if (!question.id) return;
  const list = Array.isArray(state.db.pendingQuestions) ? state.db.pendingQuestions : [];
  const index = list.findIndex((item) => item.id === question.id);
  if (index >= 0) {
    state.db.pendingQuestions = list.map((item, itemIndex) => itemIndex === index ? question : item);
  } else {
    state.db.pendingQuestions = [question, ...list];
  }
}

function beginPendingAction(pendingId = "", action = "") {
  const key = `${action}:${pendingId}`;
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingActionTokens.set(key, token);
  return { key, token };
}

function isLatestPendingAction(key, token) {
  return pendingActionTokens.get(key) === token;
}

function finishPendingAction(key, token) {
  if (isLatestPendingAction(key, token)) pendingActionTokens.delete(key);
}

function setButtonBusy(button, busy = false) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function applyPendingQuestionPayload(payload = {}, pendingId = "") {
  if (!payload.question || (pendingId && payload.question.id !== pendingId)) return false;
  replacePendingQuestionInState(payload.question);
  renderReviewList();
  renderAssignmentControls();
  autoFitTextareas($("#reviewList") || document);
  return true;
}

async function downloadFile(path, body, filename) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "导出失败");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function boot() {
  try {
    await api("/api/me");
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadState();
  } catch {
    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");
  }
}

async function loadState() {
  state.db = await api("/api/state");
  pruneSelection();
  renderAll();
  ensureAnalysisPolling();
}

function pruneSelection() {
  const questionIds = new Set((state.db.questions || []).map((q) => q.id));
  const pendingIds = new Set((state.db.pendingQuestions || []).map((q) => q.id));
  state.selected = new Set([...state.selected].filter((id) => questionIds.has(id)));
  state.selectedPending = new Set([...state.selectedPending].filter((id) => pendingIds.has(id)));
}

function renderAll() {
  renderChrome();
  renderDashboard();
  renderUploads();
  renderReviewList();
  renderFilters();
  renderBankSummary();
  renderBankWorkspace();
  renderQuestionList();
  renderStudents();
  renderMistakes();
  renderAssignmentControls();
  renderPaper();
  renderSettings();
  requestAnimationFrame(() => autoFitTextareas(document));
}

function optionTags(values, selected = "") {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

function formatQuestionBody(q) {
  const options = Array.isArray(q.options) && q.options.length
    ? `\n${q.options.join("\n")}`
    : "";
  return `${q.stem || ""}${options}`;
}

function imageViewerAttrs(src = "", title = "图片预览") {
  return `href="${escapeHtml(src)}" data-image-viewer="${escapeHtml(src)}" data-image-title="${escapeHtml(title)}"`;
}

function sourceImageLink(q, label = "查看本题图片") {
  const image = q.questionImage;
  if (!image) return "";
  return `<a class="source-link" ${imageViewerAttrs(image, label)}>${escapeHtml(label)}</a>`;
}

function sourceFigure(q, className = "question-source") {
  if (!q.sourceImage) return "";
  const title = `来源原图${q.sourcePage ? ` · 第 ${q.sourcePage} 页` : ""}`;
  return `
    <a class="${className}" ${imageViewerAttrs(q.sourceImage, title)}>
      <img src="${escapeHtml(q.sourceImage)}" alt="来源原图" />
      <span>来源原图${q.sourcePage ? ` · 第 ${escapeHtml(q.sourcePage)} 页` : ""}</span>
    </a>
  `;
}

function questionImageFigure(q, className = "question-source") {
  if (!q.questionImage) return "";
  const version = q.updatedAt ? `${q.questionImage.includes("?") ? "&" : "?"}v=${encodeURIComponent(q.updatedAt)}` : "";
  const imageUrl = `${q.questionImage}${version}`;
  return `
    <a class="${className} question-image-figure" ${imageViewerAttrs(imageUrl, "本题图片")}>
      <strong>本题配图</strong>
      <img src="${escapeHtml(imageUrl)}" alt="本题图片" />
      <span>点击放大</span>
    </a>
  `;
}

function svgDataUri(svg = "") {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function diagramFigure(q, className = "question-source") {
  const svg = q.diagramSvg || "";
  if (!svg) return "";
  const imageUrl = svgDataUri(svg);
  return `
    <a class="${className} question-image-figure diagram-figure" ${imageViewerAttrs(imageUrl, "系统生成配图")}>
      <strong>系统生成配图</strong>
      <img src="${imageUrl}" alt="系统生成配图" />
      <span>点击放大</span>
    </a>
  `;
}

function questionVisualFigure(q, className = "question-source") {
  return questionImageFigure(q, className) || diagramFigure(q, className);
}

function explanationImageFigure(q, className = "question-source") {
  if (!q.explanationImage) return "";
  const version = q.updatedAt ? `${q.explanationImage.includes("?") ? "&" : "?"}v=${encodeURIComponent(q.updatedAt)}` : "";
  const imageUrl = `${q.explanationImage}${version}`;
  return `
    <a class="${className} question-image-figure explanation-image-figure" ${imageViewerAttrs(imageUrl, "解析图片")}>
      <strong>解析图片</strong>
      <img src="${escapeHtml(imageUrl)}" alt="解析图片" />
      <span>点击放大</span>
    </a>
  `;
}

function analysisErrorKey(q = {}) {
  return `${q.id || ""}:${q.analysisError || ""}`;
}

function clearDismissedAnalysisError(pendingId = "") {
  if (!pendingId) return;
  for (const key of state.dismissedAnalysisErrors) {
    if (key.startsWith(`${pendingId}:`)) state.dismissedAnalysisErrors.delete(key);
  }
}

function qualityPanel(q) {
  const errors = Array.isArray(q.qualityErrors) ? q.qualityErrors : [];
  const warnings = Array.isArray(q.qualityWarnings) ? q.qualityWarnings : [];
  if (!errors.length && !warnings.length) return "";
  return `
    <div class="quality-panel ${errors.length ? "quality-blocked" : "quality-warning"}">
      <strong>${errors.length ? "未通过质检，暂不能入库" : "质检提醒"}</strong>
      ${errors.length ? `<ul>${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      ${warnings.length ? `<ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    </div>
  `;
}

function pageCount(upload) {
  return Math.max(upload.pages?.length || 0, upload.pageImages?.length || 0);
}

function pageOptions(total, selected = "") {
  const current = String(selected || "");
  return [`<option value="">全部</option>`].concat(
    Array.from({ length: total }, (_, index) => {
      const value = String(index + 1);
      return `<option value="${value}" ${value === current ? "selected" : ""}>第 ${value} 页</option>`;
    })
  ).join("");
}

function pageRangeControls(upload) {
  const total = pageCount(upload);
  if (!total) return `<span class="tag">页码待生成</span>`;
  const range = String(upload.analysisPageRange || "");
  const match = range.match(/^(\d+)(?:-(\d+))?$/);
  const start = match?.[1] || "";
  const end = match?.[2] || match?.[1] || "";
  return `
    <div class="page-range-selects" data-page-range="${upload.id}">
      <select data-page-start="${upload.id}" aria-label="起始页">${pageOptions(total, start)}</select>
      <span>到</span>
      <select data-page-end="${upload.id}" aria-label="结束页">${pageOptions(total, end)}</select>
    </div>
  `;
}

function selectedPageRange(uploadId) {
  const start = $(`[data-page-start="${CSS.escape(uploadId)}"]`)?.value || "";
  const end = $(`[data-page-end="${CSS.escape(uploadId)}"]`)?.value || "";
  if (!start && !end) return "";
  const first = Number(start || end);
  const last = Number(end || start);
  if (!first || !last) return "";
  return first === last ? String(first) : `${Math.min(first, last)}-${Math.max(first, last)}`;
}

function collapseFeatureGuides() {
  $$(".feature-guide[open]").forEach((guide) => guide.removeAttribute("open"));
}

function renderChrome() {
  if (!titles[state.view]) state.view = "import";
  const [eyebrow, title] = titles[state.view];
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $$(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $$(".nav-group").forEach((group) => {
    const isActive = group.dataset.navGroup === "bank" && ["bankSearch", "bankUpload"].includes(state.view);
    const isOpen = group.dataset.navGroup === "bank" && state.bankNavOpen;
    group.classList.toggle("active", isActive);
    group.classList.toggle("open", isOpen);
    group.querySelector(".nav-parent")?.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === state.view));
  collapseFeatureGuides();
  const org = state.db.organizations?.[0] || {};
  const usage = state.db.usage || {};
  const topStatus = $("#topStatus");
  if (topStatus) {
    topStatus.innerHTML = `
      <span>${escapeHtml(state.db.plans?.[org.plan]?.name || org.plan || "套餐")}</span>
      <strong>${escapeHtml(subscriptionLabel(org.subscriptionStatus || usage.subscriptionStatus))}</strong>
    `;
  }
}

function renderDashboard() {
  const metricQuestions = $("#metricQuestions");
  const metricStudents = $("#metricStudents");
  const metricAssignments = $("#metricAssignments");
  const metricMistakes = $("#metricMistakes");
  const activityList = $("#activityList");
  if (!metricQuestions || !metricStudents || !metricAssignments || !metricMistakes || !activityList) return;
  metricQuestions.textContent = state.db.questions.length;
  metricStudents.textContent = state.db.students.length;
  metricAssignments.textContent = state.db.assignments.length;
  metricMistakes.textContent = state.db.mistakes.length;
  activityList.innerHTML = state.db.activity.length
    ? state.db.activity.map((item) => `
      <div class="activity-item">
        <strong>${escapeHtml(item.action)}</strong>
        <p class="muted">${escapeHtml(item.detail || "")}</p>
        <span class="tag">${formatDateTime(item.createdAt)}</span>
      </div>
    `).join("")
    : `<p class="muted">还没有动态。先上传一份资料开始。</p>`;
}

function renderSettings() {
  const org = state.db.organizations?.[0] || {};
  const usage = state.db.usage || {};
  const limits = org.limits || {};
  const month = new Date().toISOString().slice(0, 7);
  const monthUsage = (state.db.aiUsage || []).filter((item) => item.month === month);
  const usedTokens = monthUsage.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0);
  const usedPages = monthUsage.reduce((sum, item) => sum + Number(item.pages || 0), 0);
  const tokenLimit = Number(limits.monthlyAiTokens || 0);
  const pageLimit = Number(limits.monthlyAiPages || 0);
  const quotaText = tokenLimit ? `${numberText(usedTokens)} / ${numberText(tokenLimit)}` : `${numberText(usedTokens)}`;
  const pageText = pageLimit ? `${numberText(usedPages)} / ${numberText(pageLimit)}` : `${numberText(usedPages)}`;
  const activeUsers = (state.db.users || []).filter((user) => user.status !== "disabled").length;
  const planName = state.db.plans?.[org.plan]?.name || org.plan || "starter";
  const orgBox = $("#tenantStatus");
  if (orgBox) {
    orgBox.innerHTML = `
      <article><strong>${escapeHtml(org.name || "默认机构")}</strong><span>当前机构</span></article>
      <article><strong>${escapeHtml(planName)}</strong><span>套餐</span></article>
      <article><strong>${escapeHtml(subscriptionLabel(org.subscriptionStatus))}</strong><span>订阅状态</span></article>
      <article><strong>${escapeHtml(quotaText)}</strong><span>本月 AI tokens</span></article>
      <article><strong>${escapeHtml(pageText)}</strong><span>本月 AI 页数</span></article>
      <article><strong>${activeUsers} / ${escapeHtml(limits.maxUsers || "-")}</strong><span>机构账号</span></article>
    `;
  }
  const readiness = $("#readinessList");
  if (readiness) {
    const checks = [
      ["AI Key", Boolean((state.db.aiUsage || []).length || usedTokens || usedPages), "已产生 AI 用量记录"],
      ["题库容量", (state.db.questions || []).length >= 20, "建议先沉淀 20 道以上样例题"],
      ["学生画像", (state.db.students || []).length > 0 && (state.db.mistakes || []).length > 0, "添加学生并记录错题"],
      ["作业导出", (state.db.assignments || []).length > 0, "保存过至少一份作业"],
      ["多人账号", activeUsers > 1 || Number(limits.maxUsers || 1) > 1, "机构版建议配置多账号"],
      ["对象存储", Boolean(state.db.uploads?.some((u) => u.storedName)), "上传资料后验证图片可访问"]
    ];
    readiness.innerHTML = checks.map(([label, ok, tip]) => `
      <div class="${ok ? "ready" : ""}">
        <strong>${ok ? "✓" : "!"} ${escapeHtml(label)}</strong>
        <span>${escapeHtml(tip)}</span>
      </div>
    `).join("");
  }
  const billingSummary = $("#billingSummary");
  if (billingSummary) {
    const rows = [
      ["AI tokens", usedTokens, tokenLimit],
      ["AI 页数", usedPages, pageLimit],
      ["账号数", activeUsers, limits.maxUsers],
      ["题库容量", state.db.questions?.length || 0, limits.maxQuestions]
    ];
    billingSummary.innerHTML = rows.map(([label, used, limit]) => `
      <div class="quota-row">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${numberText(used)} / ${limit ? numberText(limit) : "不限"}</span>
        </div>
        <div class="quota-bar"><span style="width:${percentText(used, limit)}"></span></div>
      </div>
    `).join("") + `
      <p class="muted">试用截止：${escapeHtml(formatDateInput(org.subscription?.trialEndsAt) || "未设置")} · 续费截止：${escapeHtml(formatDateInput(org.subscription?.renewsAt) || "未设置")}</p>
    `;
  }
  const billingForm = $("#billingForm");
  if (billingForm) {
    const plans = state.db.plans || {};
    const planSelect = $("#billingPlan");
    if (planSelect) {
      planSelect.innerHTML = Object.values(plans).map((plan) => `
        <option value="${escapeHtml(plan.id)}" ${plan.id === org.plan ? "selected" : ""}>${escapeHtml(plan.name)}（${escapeHtml(plan.id)}）</option>
      `).join("");
    }
    billingForm.status.value = org.subscription?.status || org.subscriptionStatus || "active";
    billingForm.trialEndsAt.value = formatDateInput(org.subscription?.trialEndsAt);
    billingForm.renewsAt.value = formatDateInput(org.subscription?.renewsAt);
    billingForm.note.value = org.subscription?.note || "";
  }
  const jobs = $("#jobList");
  if (jobs) {
    jobs.innerHTML = (state.db.jobs || []).length
      ? state.db.jobs.slice(0, 8).map((job) => `
        <div class="activity-item">
          <strong>${escapeHtml(job.type)} · ${escapeHtml(job.status)}</strong>
          <p class="muted">${escapeHtml(job.message || "")}</p>
          <span class="tag">${formatDateTime(job.updatedAt || job.createdAt)}</span>
        </div>
      `).join("")
      : `<p class="muted">暂无后台任务。</p>`;
  }
  const audits = $("#auditList");
  if (audits) {
    audits.innerHTML = (state.db.auditLogs || []).length
      ? state.db.auditLogs.slice(0, 8).map((log) => `
        <div class="activity-item">
          <strong>${escapeHtml(log.action)}</strong>
          <p class="muted">${escapeHtml(log.detail || log.targetType || "")}</p>
          <span class="tag">${formatDateTime(log.createdAt)}</span>
        </div>
      `).join("")
      : `<p class="muted">暂无审计记录。</p>`;
  }
}

function renderReviewList() {
  const previousIndex = $(".review-index");
  if (previousIndex) state.reviewIndexScrollTop = previousIndex.scrollTop;
  const groups = pendingReviewGroups();
  if (state.reviewUploadId !== "all" && !groups.some((group) => group.id === state.reviewUploadId)) state.reviewUploadId = "all";
  const list = activePendingQuestions();
  const totalPending = (state.db.pendingQuestions || []).length;
  const count = $("#reviewCount");
  if (count) count.textContent = state.reviewUploadId === "all" ? `待审核 ${totalPending} 题` : `当前资料 ${list.length} / 全部 ${totalPending} 题`;
  const box = $("#reviewList");
  if (!box) return;
  const totalPages = Math.max(1, Math.ceil(list.length / state.reviewPageSize));
  if (state.reviewPage < 1) state.reviewPage = 1;
  if (state.reviewPage > totalPages) state.reviewPage = totalPages;
  const start = (state.reviewPage - 1) * state.reviewPageSize;
  const pageItems = list.slice(start, start + state.reviewPageSize);
  box.innerHTML = totalPending
    ? `
      <div class="review-source-picker">
        <div>
          <strong>当前审核资料</strong>
          <span>${escapeHtml(activeReviewLabel())} · ${list.length} 题</span>
        </div>
        <select id="reviewSourceSelect" aria-label="选择待审核来源">
          <option value="all" ${state.reviewUploadId === "all" ? "selected" : ""}>全部待审核（${totalPending}）</option>
          ${groups.map((group) => `
            <option value="${escapeHtml(group.id)}" ${state.reviewUploadId === group.id ? "selected" : ""}>${escapeHtml(group.filename)}（${group.count}）</option>
          `).join("")}
        </select>
      </div>
      <div class="review-workbench">
        <aside class="review-index">
          ${list.map((q, index) => {
            const status = q.qualityErrors?.length ? "danger" : q.qualityWarnings?.length ? "warn" : "ok";
            const selected = state.selectedPending.has(q.id);
            const active = index + 1 === state.reviewPage;
            return `
              <button class="${active ? "active" : ""} ${selected ? "in-assignment" : ""} ${status}" data-review-jump="${index + 1}" aria-current="${active ? "true" : "false"}">
                <strong>${index + 1}</strong>
                <span>${escapeHtml((q.stem || "未命名题目").slice(0, 34))}</span>
                ${active ? `<em>当前</em>` : ""}
              </button>
            `;
          }).join("")}
        </aside>
        <div class="review-current">
          ${pageItems.map((q) => pendingCard(q)).join("")}
        </div>
      </div>
    `
    : `<p class="muted">上传或分析文本后，题目会先进入这里。确认无误后再批量入库。</p>`;
  const nextIndex = $(".review-index", box);
  if (nextIndex) {
    nextIndex.scrollTop = state.reviewIndexScrollTop || 0;
    nextIndex.addEventListener("scroll", () => {
      state.reviewIndexScrollTop = nextIndex.scrollTop;
    }, { passive: true });
  }
  requestAnimationFrame(() => autoFitTextareas(box));
}

function pendingReviewGroups() {
  const counts = new Map();
  for (const q of state.db.pendingQuestions || []) {
    const id = q.sourceUploadId || `text:${q.sourceFilename || "粘贴文本"}`;
    const filename = q.sourceFilename || "粘贴文本";
    const current = counts.get(id) || { id, filename, count: 0 };
    current.count += 1;
    counts.set(id, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.filename.localeCompare(b.filename, "zh-CN"));
}

function activePendingQuestions() {
  const all = state.db.pendingQuestions || [];
  if (state.reviewUploadId === "all") return all;
  return all.filter((q) => (q.sourceUploadId || `text:${q.sourceFilename || "粘贴文本"}`) === state.reviewUploadId);
}

function activeReviewLabel() {
  if (state.reviewUploadId === "all") return "全部来源";
  return pendingReviewGroups().find((group) => group.id === state.reviewUploadId)?.filename || "当前来源";
}

function variantSourceType(item = {}) {
  const source = String(item.source || "");
  if (/联网|AI查题|web|online/i.test(source)) return "web";
  if (/题库|复用|bank/i.test(source)) return "bank";
  if (/AI|生成|ai/i.test(source)) return "ai";
  return "";
}

function visibleVariantList(question, group) {
  const all = Array.isArray(question.variants) ? question.variants : [];
  const fieldName = group === "web" ? "webVariants" : group === "bank" ? "bankVariants" : "aiVariants";
  const grouped = Array.isArray(question[fieldName])
    ? question[fieldName]
    : [];
  const sourceMatched = all.filter((item) => variantSourceType(item) === group);
  const fallback = group === "ai" && !grouped.length && !sourceMatched.length
    ? all.filter((item) => !variantSourceType(item))
    : [];
  return [...grouped, ...sourceMatched, ...fallback]
    .filter((item, index, arr) => item?.stem || item?.answer || item?.explanation)
    .filter((item, index, arr) => arr.findIndex((other) => (other.id && item.id && other.id === item.id) || (other.stem || "") === (item.stem || "")) === index)
    .slice(0, group === "bank" ? 5 : 3);
}

function variantClientIssues(variant = {}) {
  const issues = [];
  const body = [variant.stem, (variant.options || []).join("\n"), variant.explanation, variant.imageNote].filter(Boolean).join("\n");
  if ((variant.generationMode === "system_template" || /系统模板/.test(variant.source || "")) && variant.verification && !variant.verification.passed) {
    issues.push(variant.verification.notes || "系统验答案未通过");
  }
  const angleNumbers = [...body.matchAll(/∠\s*(\d{1,2})/g)].map((match) => match[1]);
  const spec = variant.diagramSpec || null;
  const isTransversal = /(截线|所截|被[^。；，,]*截|同位角|内错角|同旁内角|平行线.*角|a\s*\/\/\s*b|a\s*∥\s*b)/i.test(body);
  if (spec?.type === "geometry" && angleNumbers.length) {
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
    ].includes(spec.template)) return issues;
    const pointNames = Array.isArray(spec.points) ? spec.points.map((point) => String(point.name || point.id || "")) : [];
    const markText = Array.isArray(spec.marks) ? spec.marks.map((mark) => String(mark.text || "")).join(" ") : "";
    if (isTransversal && spec.template !== "parallel_transversal") issues.push("截线角题需重新生成专用模板图");
    if (pointNames.some((name) => /\d/.test(name))) issues.push("配图疑似把角编号当成点名");
    if (angleNumbers.filter((number) => markText.includes(number)).length < Math.min(3, angleNumbers.length)) {
      issues.push("配图缺少对应角标");
    }
  }
  return issues;
}

function renderVariantPanel(q, variants, group, title, note, emptyText = "") {
  if (!variants.length && !emptyText) return "";
  const emptyTitle = group === "bank" ? "没有足够相似题" : "暂无结果";
  return `<details class="variant-list variant-list-${group} review-collapse full">
    <summary>${title}</summary>
    <p class="variant-note">${note}</p>
    ${!variants.length ? `<div class="variant-empty"><strong>${escapeHtml(emptyTitle)}</strong><span>${escapeHtml(emptyText)}</span></div>` : ""}
    <div class="variant-grid">
      ${variants.map((v, index) => {
        const variantBasketId = pendingVariantBasketId(q.id, group, index);
        const inBasket = state.generatedQuestions.some((item) => item.id === variantBasketId);
        const issues = variantClientIssues(v);
        const variantImage = v.questionImage || "";
        const diagramSpecData = encodeURIComponent(JSON.stringify(v.diagramSpec || null));
        const diagramSvgData = encodeURIComponent(v.diagramSvg || "");
        const verification = v.verification || null;
        const verificationData = encodeURIComponent(JSON.stringify(verification || null));
        const verificationLabel = verification?.passed ? "系统已验答案" : verification ? "系统验题未通过" : "";
        const matchInfo = v.matchInfo || null;
        const matchInfoData = encodeURIComponent(JSON.stringify(matchInfo || null));
        const matchReasons = Array.isArray(matchInfo?.reasons) ? matchInfo.reasons : [];
        const hardFacts = matchInfo ? [
          matchInfo.templateLabel ? `模板：${matchInfo.templateLabel}` : "",
          matchInfo.type ? `题型：${matchInfo.type}` : "",
          matchInfo.level ? `难度：${matchInfo.level}` : "",
          Number(matchInfo.knowledgeTotal || 0) ? `知识点：${(matchInfo.knowledgeMatched || []).length}/${matchInfo.knowledgeTotal}` : "",
          (matchInfo.sharedStructure || []).length ? `结构：${matchInfo.sharedStructure.slice(0, 2).join("、")}` : ""
        ].filter(Boolean) : [];
        const feedback = v.feedback || "";
        return `
          <div class="variant-card" data-variant-group="${group}" data-variant-index="${index}" data-source="${escapeHtml(v.source || "")}" data-source-url="${escapeHtml(v.sourceUrl || "")}" data-source-title="${escapeHtml(v.sourceTitle || "")}" data-search-query="${escapeHtml(v.searchQuery || "")}" data-source-question-id="${escapeHtml(v.sourceQuestionId || "")}" data-reuse-source-image="${v.reuseSourceImage ? "true" : ""}" data-question-image="${escapeHtml(variantImage || "")}" data-question-image-stored-name="${escapeHtml(v.questionImageStoredName || "")}" data-question-image-manual="${v.questionImageManual ? "true" : ""}" data-diagram-spec="${escapeHtml(diagramSpecData)}" data-diagram-svg="${escapeHtml(diagramSvgData)}" data-template-id="${escapeHtml(v.templateId || "")}" data-generation-mode="${escapeHtml(v.generationMode || "")}" data-verification="${escapeHtml(verificationData)}" data-match-info="${escapeHtml(matchInfoData)}" data-feedback="${escapeHtml(feedback)}" data-polish-status="${escapeHtml(v.polishStatus || "")}">
            <div class="variant-card-head">
              <strong>${group === "web" ? "查题" : group === "bank" ? "题库题" : "AI题"} ${index + 1}${v.source ? ` · ${escapeHtml(v.source)}` : ""}</strong>
              <button class="${inBasket ? "primary" : "ghost"} toggle-variant-assignment" type="button" ${issues.length ? "disabled" : ""}>${issues.length ? "配图需重生成" : inBasket ? "已加入组卷" : "加入组卷"}</button>
            </div>
            ${issues.length ? `<div class="quality-panel quality-blocked variant-quality-warning"><strong>暂不建议使用</strong><span>${issues.map(escapeHtml).join("；")}</span></div>` : ""}
            ${group === "bank" && matchInfo ? `
              <div class="bank-match-box ${matchInfo.duplicateCandidate ? "duplicate" : ""}">
                <strong>${matchInfo.duplicateCandidate ? "疑似原题/重复题" : `匹配度 ${Math.round(Number(matchInfo.score || 0))}`}</strong>
                ${hardFacts.length ? `<div class="bank-match-hard-row">${hardFacts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>` : ""}
                <div class="bank-match-reasons">
                  ${matchReasons.slice(0, 6).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
                </div>
              </div>
              <div class="bank-feedback-actions" data-current-feedback="${escapeHtml(feedback)}">
                ${["很相似", "同母题", "不相似"].map((item) => `<button class="ghost bank-variant-feedback ${feedback === item ? "active" : ""}" type="button" data-feedback="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}
              </div>
            ` : ""}
            ${v.sourceUrl ? `<a class="variant-source-link" href="${escapeHtml(v.sourceUrl)}" target="_blank" rel="noreferrer">打开来源：${escapeHtml(v.sourceTitle || v.sourceUrl)}</a>` : ""}
            ${variantImage ? questionImageFigure({ ...v, questionImage: variantImage, updatedAt: q.updatedAt }, "question-source variant-image-preview") : diagramFigure(v, "question-source variant-image-preview")}
            <div class="tag-row">
              ${v.imageNote ? `<span class="tag">${escapeHtml(v.imageNote)}</span>` : ""}
              ${v.templateId ? `<span class="tag">模板：${escapeHtml(v.templateId)}</span>` : ""}
              ${matchInfo?.templateLabel ? `<span class="tag quality-ok-tag">${escapeHtml(matchInfo.templateLabel)}</span>` : ""}
              ${feedback ? `<span class="tag">${escapeHtml(feedback)}</span>` : ""}
              ${verificationLabel ? `<span class="tag ${verification?.passed ? "quality-ok-tag" : "quality-error-tag"}">${escapeHtml(verificationLabel)}</span>` : ""}
              ${v.polishStatus === "ai_polished" ? `<span class="tag">AI已润色</span>` : ""}
            </div>
            <label>题干<textarea name="variantStem">${escapeHtml(v.stem || "")}</textarea></label>
            ${group === "web" ? "" : `<label>选项<textarea name="variantOptions">${escapeHtml((v.options || []).join("\n"))}</textarea></label>
            <label>答案<textarea name="variantAnswer">${escapeHtml(v.answer || "")}</textarea></label>`}
            ${group === "web" ? `<label>来源说明<textarea name="variantExplanation">${escapeHtml(v.explanation || "")}</textarea></label>` : `<label>解析<textarea name="variantExplanation">${escapeHtml(v.explanation || "")}</textarea></label>`}
          </div>
        `;
      }).join("")}
    </div>
  </details>`;
}

function analysisErrorPanel(q = {}) {
  const message = q.analysisError || "";
  if (!message) return "";
  if (/仍含 LaTeX 命令|数学符号未统一/.test(message)) return "";
  if (/没有足够相似题|请先补全.*相似题|题库相似题|题库找题/.test(message)) return "";
  const key = analysisErrorKey(q);
  if (state.dismissedAnalysisErrors.has(key)) return "";
  const title = message.includes("复杂综合图形题") ? "暂不自动生成" : "生成失败";
  return `
    <div class="quality-panel quality-blocked dismissible-panel">
      <button class="dismiss-panel-btn" type="button" data-dismiss-analysis-error="${escapeHtml(key)}" aria-label="关闭提示">×</button>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function pendingCard(q) {
  const aiVariants = visibleVariantList(q, "ai");
  const bankVariants = visibleVariantList(q, "bank");
  const webVariants = visibleVariantList(q, "web");
  const bodyText = `${q.stem}\n${(q.options || []).join("\n")}`;
  const stemWithOptions = [q.stem || "", ...(q.options || [])].filter(Boolean).join("\n");
  const displayImage = q.questionImage;
  const inAssignment = state.selectedPending.has(q.id);
  const imageSourceLabel = q.questionImageManual ? "手动配图" : q.questionImageStoredName ? "自动候选截图" : "未绑定";
  const bbox = q.questionBBox || null;
  const bboxLabel = bbox ? `${bbox.source === "manual" ? "手动坐标" : bbox.source === "ocr-layout" ? "版面坐标" : bbox.source === "ocr-diagram" ? "图形坐标" : bbox.source === "text-layout" ? "文本坐标" : bbox.source === "index-estimate" ? "估算坐标" : "题目坐标"}${bbox.confidence !== "" && bbox.confidence !== undefined ? ` · ${Math.round(Number(bbox.confidence) * 100)}%` : ""}` : "";
  const needsBoundImage = /(如图|下图|图中|图形|图示|阴影|表格|几何|圆形花坛|统计图|条形图|折线图|扇形图|图形说明|图表|坐标图|频数\/个|频率图|示意图|\\frac|\\dfrac|\$|sqrt|\\sqrt|_|\^)/.test(bodyText);
  const shouldShowImageWorkspace = Boolean(displayImage || q.sourceImage || needsBoundImage);
  const qualityErrors = Array.isArray(q.qualityErrors) ? q.qualityErrors : [];
  const qualityWarnings = Array.isArray(q.qualityWarnings) ? q.qualityWarnings : [];
  const webEmptyText = q.analysisError && /联网查题|AI查题|WEB_SEARCH|搜索/i.test(q.analysisError)
    ? q.analysisError
    : "还没有查题结果。点击上方「AI查题」会按知识点、题型和关键词查网页线索；没有配置搜索 Key 时，会先给可点击的搜索入口。";
  const aiEmptyText = q.analysisError && /AI ?生成|AI生题|生成相似|模板|diagramSpec|配图|复杂综合/i.test(q.analysisError)
    ? q.analysisError
    : "还没有生成题。点击上方「AI生题」后，系统会先命中题型模板、验答案，再展示可编辑结果。";
  const bankEmptyText = q.analysisError && /题库|相似题|重复题/i.test(q.analysisError)
    ? q.analysisError
    : "点击上方「题库相似题」后，只查正式题库；必须题型、难度、核心知识点和结构规则一致，找不到就显示没有足够相似题。";
  const qualityLabel = qualityErrors.length ? `质检未通过 ${qualityErrors.length}` : qualityWarnings.length ? `需核对 ${qualityWarnings.length}` : "质检通过";
  const qualityClass = qualityErrors.length ? "danger" : qualityWarnings.length ? "warn" : "ok";
  return `
    <article class="review-item ${qualityErrors.length ? "has-quality-errors" : qualityWarnings.length ? "has-quality-warnings" : ""}" data-pending-id="${q.id}">
      <form class="pending-editor">
        <div class="review-topline">
          <div class="review-card-title">
            <div class="tag-row">
              <span class="tag">${escapeHtml(q.sourceFilename || "粘贴文本")}</span>
              ${q.sourcePage ? `<span class="tag">第 ${escapeHtml(q.sourcePage)} 页</span>` : ""}
              <span class="tag">${escapeHtml(q.type || "待分类")}</span>
            </div>
            <div class="review-status-line">
              <span class="review-status ${qualityClass}">${escapeHtml(qualityLabel)}</span>
              <span>题库相似题 ${bankVariants.length}</span>
              <span>AI查题 ${webVariants.length}</span>
              <span>AI生题 ${aiVariants.length}</span>
            </div>
          </div>
          <div class="review-action-dock">
            <div class="row-actions review-primary-actions">
              <button class="primary approve-pending" type="button">入库本题</button>
              <button class="ghost toggle-pending-assignment" type="button">${inAssignment ? "移出组卷" : "加入组卷"}</button>
              <button class="danger delete-pending" type="button">删除</button>
            </div>
            <div class="row-actions review-tool-actions">
              ${sourceImageLink(q)}
              <button class="ghost find-bank-variants-pending" type="button">题库相似题</button>
              <button class="ghost search-online-variants-pending" type="button">AI查题</button>
              <button class="ghost generate-variants-pending" type="button">AI生题</button>
            </div>
          </div>
        </div>
        ${analysisErrorPanel(q)}
        <div class="review-main">
          <details class="review-panel review-fields-panel review-collapse" open>
            <summary>题目</summary>
            <p class="review-collapse-note">${shouldShowImageWorkspace ? "先核对题干和本题截图，答案解析在下方补充。" : "先核对题干，答案解析在下方补充。"}</p>
            <div class="review-question-panel ${shouldShowImageWorkspace ? "with-image" : "no-image"}">
              <div class="review-fields">
                <label class="full">题干<textarea name="stem">${escapeHtml(stemWithOptions)}</textarea></label>
                <input type="hidden" name="options" value="" />
              </div>
              ${shouldShowImageWorkspace ? `
                <div class="review-question-image">
                  <div class="tag-row">
                    <span class="tag">${escapeHtml(imageSourceLabel)}</span>
                    ${bboxLabel ? `<span class="tag">${escapeHtml(bboxLabel)}</span>` : ""}
                    ${needsBoundImage ? `<span class="tag quality-warning-tag">需核对配图/公式</span>` : ""}
                  </div>
                  ${displayImage ? `
                    <a class="source-shot source-shot-bound" ${imageViewerAttrs(displayImage, "本题截图")}>
                      <img src="${escapeHtml(displayImage)}" alt="本题图片" />
                      <span>本题截图，点击放大</span>
                    </a>
                  ` : `<div class="image-empty">暂无本题图片</div>`}
                  <div class="paste-question-image" tabindex="0" role="button" aria-label="粘贴或拖拽本题图片">
                    <strong>粘贴截图到这里</strong>
                    <span>截图后点这里按 Cmd+V，也可以拖拽图片进来。</span>
                  </div>
                  <div class="row-actions image-actions">
                    ${q.sourceImage ? `<button class="ghost crop-question-image" type="button" data-source-image="${escapeHtml(q.sourceImage)}">从原题截图</button>` : ""}
                    ${q.sourceImage ? `<button class="ghost auto-question-image" type="button">自动截图</button>` : ""}
                    <button class="ghost upload-question-image" type="button">${displayImage ? "替换图片" : "上传图片"}</button>
                    <input class="manual-question-image hidden" type="file" accept="image/*" />
                  </div>
                </div>
              ` : ""}
            </div>
          </details>
        </div>
        <details class="answer-edit-panel review-collapse full">
          <summary>答案、解析与知识点</summary>
          <div class="review-detail-grid">
            <label class="full">知识点<input name="knowledge" value="${escapeHtml((q.knowledge || []).join("，"))}" /></label>
            <label class="full">答案<textarea name="answer">${escapeHtml(q.answer || "")}</textarea></label>
            <label class="full">解析<textarea name="explanation">${escapeHtml(q.explanation || "")}</textarea></label>
            <div class="full explanation-image-box">
              ${q.explanationImage ? explanationImageFigure(q, "question-source explanation-image-preview") : `<div class="image-empty compact">暂无解析图片</div>`}
              <div class="paste-explanation-image" tabindex="0" role="button" aria-label="粘贴或拖拽解析图片">
                <strong>粘贴解析图片到这里</strong>
                <span>支持 Cmd+V、拖拽或本地上传。</span>
              </div>
              <div class="row-actions image-actions">
                <button class="ghost upload-explanation-image" type="button">${q.explanationImage ? "替换解析图片" : "上传解析图片"}</button>
                <input class="manual-explanation-image hidden" type="file" accept="image/*" />
              </div>
            </div>
          </div>
        </details>
        ${renderVariantPanel(q, bankVariants, "bank", "题库相似题", "只展示正式题库里题型、难度、核心知识点和结构规则都一致的题；不降级、不乱找。", bankEmptyText)}
        ${renderVariantPanel(q, webVariants, "web", "AI查题（联网相似题）", "按当前题的知识点、题型和关键词去网上查相似题；会保留来源链接，使用前请核对完整题干和答案。", webEmptyText)}
        ${renderVariantPanel(q, aiVariants, "ai", "AI生题（生成后可编辑）", "只基于当前题重新生成；不会从题库拿题，也不会复用原题配图。", aiEmptyText)}
      </form>
    </article>
  `;
}

function revisionLabel(action = "") {
  return ({
    "manual.edit": "人工编辑",
    "ai.enrich": "AI 补全",
    "image.update": "更新配图",
    "explanation.image.update": "更新解析图",
    "image.auto": "自动补截图",
    "web.variants": "AI查题",
    "ai.variants": "AI 生成题",
    "bank.variants": "题库找题",
    "question.merge": "合并题目",
    "question.merge.source": "合并来源",
    "question.split.primary": "拆分保留",
    "question.split.created": "拆分新题"
  })[action] || action || "修订";
}

function renderUploads() {
  $("#uploadList").innerHTML = state.db.uploads.length
    ? state.db.uploads.slice(0, 8).map((upload) => `
      <div class="upload-item">
        <div class="upload-simple-head">
          <div>
            <strong>${escapeHtml(upload.filename)}</strong>
            <p class="muted">${escapeHtml(uploadStatusText(upload))}</p>
          </div>
          <div class="row-actions upload-card-actions">
            <span class="tag ${upload.analysisStatus === "failed" ? "quality-error-tag" : upload.analysisStatus === "done" ? "quality-warning-tag" : ""}">${escapeHtml(uploadStatusLabel(upload))}</span>
            <button class="ghost delete-upload" type="button" data-upload-id="${upload.id}">删除</button>
          </div>
        </div>
        ${upload.analysisStatus === "processing" ? analysisProgressMarkup(upload) : ""}
        <div class="upload-analyze-row">
          ${pageRangeControls(upload)}
          <button class="primary" data-analyze-upload="${upload.id}">${upload.analysisStatus === "done" ? "重新分析" : "开始分析"}</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">上传 PDF、图片或 Word 后会出现在这里。</p>`;
}

function uploadStatusLabel(upload = {}) {
  if (upload.analysisStatus === "processing") return "分析中";
  if (upload.analysisStatus === "done") return "已完成";
  if (upload.analysisStatus === "failed") return "需处理";
  if (pageCount(upload)) return "待分析";
  return "已上传";
}

function uploadStatusText(upload = {}) {
  if (upload.analysisError) return upload.analysisError;
  if (upload.analysisStatus === "processing") return upload.analysisProgress?.message || "正在分析资料...";
  if (upload.analysisStatus === "done") return upload.analysisProgress?.message || "分析完成，题目已进入待审核。";
  if (upload.extractionNote) return upload.extractionNote;
  return "选择页码范围后点击开始分析。";
}

function analysisDiagnosticsMarkup(upload = {}) {
  const diagnostics = upload.analysisDiagnostics || {};
  const summary = diagnostics.summary || {};
  const pages = Array.isArray(diagnostics.pages) ? diagnostics.pages : [];
  if (!pages.length && !summary.acceptedCount && !summary.localCandidateCount) return "";
  return `
    <details class="diagnostics-panel">
      <summary>分析诊断 · ${escapeHtml(diagnostics.provider || "本地")} · ${escapeHtml(diagnostics.status || upload.analysisStatus || "ready")}</summary>
      <div class="diagnostics-summary">
        <span>选中 ${Number(summary.selectedPages || pages.length || 0)} 页</span>
        <span>OCR ${Number(summary.ocrPages || pages.filter((p) => p.usedOcr).length || 0)} 页</span>
        <span>本地候选 ${Number(summary.localCandidateCount || 0)} 题</span>
        <span>AI 返回 ${Number(summary.aiCandidateCount || 0)} 题</span>
        <span>入待审 ${Number(summary.acceptedCount || 0)} 题</span>
        <span>去重 ${Number(summary.duplicateSkippedCount || 0)} 题</span>
      </div>
      <div class="diagnostics-table">
        ${pages.slice(0, 80).map((page) => `
          <div class="diagnostics-row ${page.error ? "danger" : page.skippedReason ? "muted-row" : ""}">
            <strong>第 ${escapeHtml(page.page || "")} 页</strong>
            <span>${escapeHtml(page.status || "")}</span>
            <span>${page.usedOcr ? `OCR ${escapeHtml(page.ocrProvider || "")}` : page.textReliable ? "文本可靠" : "文本待核"}</span>
            <span>本地 ${Number(page.localCandidates || 0)} / AI ${Number(page.aiCandidates || 0)} / 待审 ${Number(page.acceptedCandidates || 0)}</span>
            <small>${escapeHtml(page.error || page.layoutError || page.skippedReason || (page.layoutQuestionRegions ? `版面框 ${page.layoutQuestionRegions} 个` : page.preprocessing?.enabled ? "已预处理图片" : ""))}</small>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function pageStatus(page = {}) {
  const text = String(page.text || "").trim();
  if (page.ocrError) return { label: "失败", tone: "danger", detail: page.ocrError };
  if (text && page.image) return { label: "已识别", tone: "ok", detail: "文本和截图已就绪" };
  if (text) return { label: "有文本", tone: "ok", detail: "已提取文本层" };
  if (page.image) return { label: "待 OCR", tone: "warn", detail: "有截图，可重试分析" };
  return { label: "待处理", tone: "", detail: "等待转换" };
}

function uploadPageStatusMarkup(upload = {}) {
  const pages = Array.isArray(upload.pages) ? upload.pages : [];
  if (!pages.length) return "";
  return `
    <details class="page-status-panel">
      <summary>页状态 · ${pages.length} 页</summary>
      <div class="page-status-grid">
        ${pages.slice(0, 80).map((page) => {
          const status = pageStatus(page);
          return `
            <div class="page-status-card ${status.tone}">
              <strong>第 ${escapeHtml(page.page || "")} 页</strong>
              <span>${escapeHtml(status.label)}</span>
              <small>${escapeHtml(status.detail)}</small>
              <div class="row-actions">
                ${page.image ? `<a class="source-link" ${imageViewerAttrs(page.image, `第 ${page.page || ""} 页截图`)}>预览</a>` : ""}
                ${(page.ocrError || (!page.text && page.image)) ? `<button class="ghost retry-page" data-retry-upload="${upload.id}" data-retry-page="${escapeHtml(page.page)}">重试本页</button>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

function analysisProgressMarkup(upload) {
  const progress = upload.analysisProgress || {};
  const total = Number(progress.totalPages || 0);
  const done = Number(progress.completedPages || 0);
  const percent = total ? Math.max(3, Math.min(100, Math.round((done / total) * 100))) : 8;
  return `
    <div class="inline-progress">
      <div class="inline-progress-bar"><span style="width:${percent}%"></span></div>
      <p>${escapeHtml(progress.message || "正在后台分析...")}</p>
    </div>
  `;
}

function ensureAnalysisPolling() {
  for (const upload of state.db.uploads || []) {
    if (upload.analysisStatus === "processing") startAnalysisPolling(upload.id);
  }
}

function startAnalysisPolling(uploadId) {
  if (state.analysisPollers.has(uploadId)) return;
  state.analysisPollers.set(uploadId, true);
  const poll = async () => {
    try {
      const payload = await api(`/api/uploads/${uploadId}/analyze-status`);
      const index = state.db.uploads.findIndex((item) => item.id === uploadId);
      if (index !== -1) state.db.uploads[index] = payload.upload;
      renderUploads();
      if (payload.upload.analysisStatus === "processing" || payload.running) {
        setTimeout(poll, 2000);
        return;
      }
      state.analysisPollers.delete(uploadId);
      await loadState();
      if (payload.upload.analysisStatus === "done") {
        toast(payload.upload.analysisProgress?.message || "分析完成");
      } else if (payload.upload.analysisStatus === "failed") {
        toast(payload.upload.analysisError || "分析失败");
      }
    } catch (error) {
      state.analysisPollers.delete(uploadId);
      toast(error.message);
    }
  };
  setTimeout(poll, 800);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function renderFilters() {
  fillSelect($("#filterSubject"), ["全部科目", ...unique(state.db.questions.map((q) => q.subject))], true);
  fillSelect($("#filterType"), ["全部题型", ...unique(state.db.questions.map((q) => q.type))], true);
  fillSelect($("#filterKnowledge"), ["全部知识点", ...unique(state.db.questions.flatMap((q) => q.knowledge || []))], true);
}

function renderBankSummary() {
  const all = state.db.questions || [];
  const filtered = all.filter(questionMatches);
  const knowledgeCounts = new Map();
  for (const question of all) {
    for (const tag of question.knowledge || []) {
      knowledgeCounts.set(tag, (knowledgeCounts.get(tag) || 0) + 1);
    }
  }
  const topTags = [...knowledgeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const summary = $("#bankSummary");
  if (summary) {
    summary.innerHTML = `
      <article><strong>${numberText(filtered.length)}</strong><span>当前结果</span></article>
      <article><strong>${numberText(all.length)}</strong><span>题库总量</span></article>
      <article><strong>${numberText(selectedQuestions().length)}</strong><span>组卷题篮</span></article>
      <article><strong>${numberText(knowledgeCounts.size)}</strong><span>知识点</span></article>
    `;
  }
  const chips = $("#knowledgeChips");
  if (chips) {
    chips.innerHTML = topTags.length
      ? [`<button type="button" class="${$("#filterKnowledge").value ? "" : "active"}" data-knowledge-chip="">全部知识点</button>`]
        .concat(topTags.map(([tag, count]) => `<button type="button" class="${$("#filterKnowledge").value === tag ? "active" : ""}" data-knowledge-chip="${escapeHtml(tag)}">${escapeHtml(tag)} <span>${count}</span></button>`))
        .join("")
      : "";
  }
  renderKnowledgeTree();
}

function renderKnowledgeTree() {
  const tree = $("#knowledgeTree");
  if (!tree) return;
  const grouped = new Map();
  for (const q of state.db.questions || []) {
    const subject = q.subject || "未分类";
    const chapter = q.chapter || q.grade || "未分章节";
    if (!grouped.has(subject)) grouped.set(subject, new Map());
    const chapters = grouped.get(subject);
    if (!chapters.has(chapter)) chapters.set(chapter, new Map());
    const tags = (q.knowledge || []).length ? q.knowledge : ["未标知识点"];
    for (const tag of tags) {
      const counts = chapters.get(chapter);
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  tree.innerHTML = grouped.size ? [...grouped.entries()].map(([subject, chapters]) => `
    <details class="knowledge-node">
      <summary>${escapeHtml(subject)} <span>${[...chapters.values()].reduce((sum, tags) => sum + [...tags.values()].reduce((a, b) => a + b, 0), 0)}</span></summary>
      ${[...chapters.entries()].map(([chapter, tags]) => `
        <details>
          <summary>${escapeHtml(chapter)} <span>${[...tags.values()].reduce((a, b) => a + b, 0)}</span></summary>
          <div class="knowledge-leaves">
            ${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => `
              <button type="button" data-knowledge-chip="${escapeHtml(tag)}" class="${$("#filterKnowledge").value === tag ? "active" : ""}">${escapeHtml(tag)} <span>${count}</span></button>
            `).join("")}
          </div>
        </details>
      `).join("")}
    </details>
  `).join("") : `<p class="muted">题目入库后会自动形成知识点树。</p>`;
}

function fillSelect(select, values, firstIsEmpty = false) {
  if (!select) return;
  const oldValue = select.value;
  select.innerHTML = values.map((value, index) => {
    const actual = firstIsEmpty && index === 0 ? "" : value;
    return `<option value="${escapeHtml(actual)}">${escapeHtml(value)}</option>`;
  }).join("");
  select.value = [...select.options].some((option) => option.value === oldValue) ? oldValue : "";
}

function questionMatches(q) {
  const search = $("#searchInput").value.trim().toLowerCase();
  const subject = $("#filterSubject").value;
  const stage = $("#filterStage").value;
  const level = $("#filterLevel").value;
  const type = $("#filterType").value;
  const knowledge = $("#filterKnowledge").value;
  const text = [q.stem, q.chapter, q.type, q.subject, ...(q.knowledge || [])].join(" ").toLowerCase();
  return (!search || text.includes(search))
    && (!subject || q.subject === subject)
    && (!stage || q.stage === stage)
    && (!level || q.level === level)
    && (!type || q.type === type)
    && (!knowledge || (q.knowledge || []).includes(knowledge));
}

function renderQuestionList() {
  const list = state.db.questions.filter(questionMatches);
  const all = state.db.questions || [];
  const head = $("#bankResultHead");
  if (head) {
    const selected = selectedQuestions().length;
    const knowledge = $("#filterKnowledge")?.value || "";
    head.innerHTML = `
      <div>
        <strong>搜索结果 ${numberText(list.length)} 道${knowledge ? ` · ${escapeHtml(knowledge)}` : ""}</strong>
        <span>勾选题目后可以生成作业；编辑只影响正式题库。</span>
      </div>
      <span class="pill">已选 ${numberText(selected)} 题</span>
    `;
  }
  $("#questionList").innerHTML = list.length
    ? list.map((q) => questionCard(q)).join("")
    : all.length
      ? `<div class="bank-empty-state"><strong>没有匹配题目</strong><span>可以清空筛选，或换一个知识点、题型、难度再试。</span><button class="ghost compact" type="button" data-clear-bank-filters>清空筛选</button></div>`
      : `<div class="bank-empty-state"><strong>题库还是空的</strong><span>先去上传题库，审核入库后这里才能搜索和组卷。</span><button class="primary compact" type="button" data-view="bankUpload">上传题库</button></div>`;
  $("#selectedCount").textContent = `已选 ${selectedQuestions().length} 题`;
}

function clearBankFilters() {
  const search = $("#searchInput");
  if (search) search.value = "";
  $$(".filters select").forEach((select) => {
    select.value = "";
  });
  $$(".filters input").forEach((input) => {
    input.value = "";
  });
  state.bankIssueFilter = "";
  renderBankSummary();
  renderQuestionList();
}

function questionCard(q) {
  const checked = state.selected.has(q.id) ? "checked" : "";
  const dup = q.duplicateOf ? `<span class="tag duplicate">疑似原题/重复题</span>` : "";
  const variantTag = q.variantOf ? `<span class="tag quality-warning-tag">相似例题</span>` : "";
  return `
    <article class="question-item" data-question-id="${q.id}">
      <input type="checkbox" class="select-question" ${checked} aria-label="选择题目" />
      <div class="question-main">
        <div class="tag-row">
          <span class="tag">${escapeHtml(q.subject || "未分类")}</span>
          <span class="tag">${escapeHtml(q.stage || "")}</span>
          <span class="tag">${escapeHtml(q.level || "")}</span>
          <span class="tag">${escapeHtml(q.type || "")}</span>
          ${q.sourceFilename ? `<span class="tag">${escapeHtml(q.sourceFilename)}</span>` : ""}
          ${q.sourcePage ? `<span class="tag">第 ${escapeHtml(q.sourcePage)} 页</span>` : ""}
          ${(q.knowledge || []).map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join("")}
          ${variantTag}
          ${dup}
        </div>
        <p>${escapeHtml(formatQuestionBody(q)).replace(/\n/g, "<br>")}</p>
        ${questionVisualFigure(q, "question-source")}
      </div>
      <div class="row-actions">
        <button class="ghost edit-question">编辑</button>
        <button class="ghost ai-classify">分类</button>
      </div>
      <form class="question-editor">
        <label class="full">题干<textarea name="stem">${escapeHtml(q.stem)}</textarea></label>
        <label class="full">选项<textarea name="options">${escapeHtml((q.options || []).join("\n"))}</textarea></label>
        <label>科目<input name="subject" value="${escapeHtml(q.subject)}" /></label>
        <label>学段<select name="stage"><option ${q.stage === "小学" ? "selected" : ""}>小学</option><option ${q.stage === "初中" ? "selected" : ""}>初中</option></select></label>
        <label>难度<select name="level"><option ${q.level === "基础" ? "selected" : ""}>基础</option><option ${q.level === "提高" ? "selected" : ""}>提高</option><option ${q.level === "压轴" ? "selected" : ""}>压轴</option></select></label>
        <label>年级<input name="grade" value="${escapeHtml(q.grade)}" /></label>
        <label>章节<input name="chapter" value="${escapeHtml(q.chapter)}" /></label>
        <label>题型<input name="type" value="${escapeHtml(q.type)}" /></label>
        <label class="full">知识点<input name="knowledge" value="${escapeHtml((q.knowledge || []).join("，"))}" /></label>
        <label class="full">答案<textarea name="answer">${escapeHtml(q.answer || "")}</textarea></label>
        <label class="full">解析<textarea name="explanation">${escapeHtml(q.explanation || "")}</textarea></label>
        ${explanationImageFigure(q, "question-source explanation-image-preview full")}
        <div class="row-actions full">
          <button class="primary" type="submit">保存</button>
          <button class="ghost delete-question" type="button">删除</button>
        </div>
      </form>
    </article>
  `;
}

function renderSplitPreview() {
  $("#splitPreview").innerHTML = state.splitDrafts.length
    ? state.splitDrafts.map((q, index) => `
      <article class="preview-item">
        <p><strong>${index + 1}.</strong> ${escapeHtml(q.stem)}</p>
        <div class="tag-row">
          <span class="tag">${escapeHtml(q.subject)}</span>
          <span class="tag">${escapeHtml(q.level)}</span>
          <span class="tag">${escapeHtml(q.type)}</span>
          ${q.duplicateOf ? `<span class="tag duplicate">疑似原题/重复题</span>` : ""}
        </div>
      </article>
    `).join("")
    : `<p class="muted">拆分结果会显示在这里。</p>`;
}

function renderStudents() {
  $("#studentList").innerHTML = state.db.students.length
    ? state.db.students.map((s) => `
      <div class="student-item">
        <strong>${escapeHtml(s.name)}</strong>
        <p class="muted">${escapeHtml([s.stage, s.grade, s.level].filter(Boolean).join(" / "))}</p>
        <span class="tag">${escapeHtml(s.notes || "无备注")}</span>
      </div>
    `).join("")
    : `<p class="muted">还没有学生档案。</p>`;

  const studentOptions = [`<option value="">不指定学生</option>`].concat(
    state.db.students.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · ${escapeHtml(s.grade || s.stage)}</option>`)
  ).join("");
  $("#assignmentStudent").innerHTML = studentOptions;
  $("#mistakeStudent").innerHTML = studentOptions;
  renderStudentWeakSummary();
}

function renderStudentWeakSummary() {
  const box = $("#studentWeakSummary");
  if (!box) return;
  const rows = (state.db.students || []).map((student) => {
    const mistakes = (state.db.mistakes || []).filter((m) => m.studentId === student.id);
    const tagCounts = new Map();
    const reasonCounts = new Map();
    for (const mistake of mistakes) {
      const q = state.db.questions.find((item) => item.id === mistake.questionId);
      for (const tag of q?.knowledge || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      const reason = mistake.reason || "未分类";
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    return { student, mistakes, topTags, topReason };
  }).filter((row) => row.mistakes.length);
  box.innerHTML = rows.length ? rows.map(({ student, mistakes, topTags, topReason }) => `
    <article>
      <strong>${escapeHtml(student.name)}</strong>
      <span>${mistakes.length} 道错题${topReason ? ` · 主要错因：${escapeHtml(topReason[0])}` : ""}</span>
      <div class="tag-row">
        ${topTags.length ? topTags.map(([tag, count]) => `<button type="button" data-knowledge-chip="${escapeHtml(tag)}">${escapeHtml(tag)} ${count}</button>`).join("") : `<span class="tag">暂无知识点</span>`}
      </div>
    </article>
  `).join("") : `<p class="muted">记录错题后，这里会生成学生薄弱点画像。</p>`;
}

function renderMistakes() {
  $("#mistakeQuestion").innerHTML = [`<option value="">选择题目</option>`].concat(
    state.db.questions.slice(0, 80).map((q) => `<option value="${q.id}">${escapeHtml(q.stem.slice(0, 48))}</option>`)
  ).join("");
  $("#mistakeList").innerHTML = state.db.mistakes.length
    ? state.db.mistakes.map((m) => {
      const student = state.db.students.find((s) => s.id === m.studentId);
      const question = state.db.questions.find((q) => q.id === m.questionId);
      return `
        <div class="mistake-item">
          <strong>${escapeHtml(student?.name || "未指定学生")}</strong>
          <p>${escapeHtml(question?.stem || "题目已删除")}</p>
          <div class="tag-row">
            <span class="tag">${escapeHtml(m.reason)}</span>
            <span class="tag">${escapeHtml(m.date)}</span>
          </div>
          ${m.note ? `<p class="muted">${escapeHtml(m.note)}</p>` : ""}
        </div>
      `;
    }).join("")
    : `<p class="muted">记录错题后会在这里形成学生薄弱点。</p>`;
}

function renderAssignmentControls() {
  const total = selectedQuestions().length;
  $("#selectedCount").textContent = `已选 ${total} 题`;
  const basket = $("#assignmentBasket");
  if (basket) {
    const rows = [
      ["题库题", state.selected.size],
      ["待审核题", state.selectedPending.size],
      ["AI 生成题", state.generatedQuestions.length]
    ];
    basket.innerHTML = total
      ? rows.map(([label, count]) => `
        <span class="${count ? "active" : ""}">
          <strong>${count}</strong>${escapeHtml(label)}
        </span>
      `).join("")
      : `<p class="muted">可以从“资料解析”的待审核题直接加入，也可以从题库勾选题目混合组卷。</p>`;
  }
  if (!$("#assignmentTitle").value) $("#assignmentTitle").value = `课后练习 ${new Date().toLocaleDateString("zh-CN")}`;
}

function pendingQuestionSnapshots() {
  return (state.db.pendingQuestions || [])
    .filter((q) => state.selectedPending.has(q.id))
    .map((q) => ({
      ...q,
      id: `pending-${q.id}`,
      sourceKind: "pending",
      variants: []
    }));
}

function pendingVariantBasketId(pendingId, groupOrIndex, maybeIndex) {
  const group = maybeIndex === undefined ? "ai" : groupOrIndex;
  const index = maybeIndex === undefined ? groupOrIndex : maybeIndex;
  return `pending-variant-${pendingId}-${group}-${index}`;
}

function removePendingVariantSelections(pendingId, group = "") {
  const prefix = group ? `pending-variant-${pendingId}-${group}-` : `pending-variant-${pendingId}-`;
  state.generatedQuestions = state.generatedQuestions.filter((q) => !String(q.id || "").startsWith(prefix));
}

function variantSnapshotFromCard(reviewItem, card) {
  const pending = (state.db.pendingQuestions || []).find((q) => q.id === reviewItem?.dataset.pendingId) || {};
  const index = Number(card?.dataset.variantIndex || 0);
  const group = card?.dataset.variantGroup || "ai";
  const diagramSvg = decodeURIComponent(card?.dataset.diagramSvg || "");
  let diagramSpec = null;
  try {
    diagramSpec = JSON.parse(decodeURIComponent(card?.dataset.diagramSpec || "null"));
  } catch {
    diagramSpec = null;
  }
  let verification = null;
  try {
    verification = JSON.parse(decodeURIComponent(card?.dataset.verification || "null"));
  } catch {
    verification = null;
  }
  let matchInfo = null;
  try {
    matchInfo = JSON.parse(decodeURIComponent(card?.dataset.matchInfo || "null"));
  } catch {
    matchInfo = null;
  }
  return {
    id: pendingVariantBasketId(pending.id, group, index),
    stem: $("[name='variantStem']", card)?.value || "",
    options: normalizeOptionLines($("[name='variantOptions']", card)?.value || ""),
    answer: $("[name='variantAnswer']", card)?.value || "",
    explanation: $("[name='variantExplanation']", card)?.value || "",
    subject: pending.subject || $("#assignmentSubject")?.value || $("#defaultSubject")?.value || "初中数学",
    stage: pending.stage || $("#defaultStage")?.value || "初中",
    grade: pending.grade || $("#assignmentGrade")?.value || $("#defaultGrade")?.value || "",
    chapter: pending.chapter || "",
    knowledge: Array.isArray(pending.knowledge) ? pending.knowledge : String(pending.knowledge || "").split(/[,，、]/).filter(Boolean),
    level: pending.level || $("#defaultLevel")?.value || "基础",
    type: pending.type || inferClientQuestionType($("[name='variantStem']", card)?.value || ""),
    sourceFilename: pending.sourceFilename || "待审核相似例题",
    sourcePage: pending.sourcePage || "",
    questionImage: card?.dataset.questionImage || "",
    questionImageStoredName: card?.dataset.questionImageStoredName || "",
    questionImageManual: card?.dataset.questionImageManual === "true",
    reuseSourceImage: card?.dataset.reuseSourceImage === "true",
    diagramSpec,
    diagramSvg,
    templateId: card?.dataset.templateId || "",
    generationMode: card?.dataset.generationMode || "",
    verification,
    matchInfo,
    sourceQuestionId: card?.dataset.sourceQuestionId || "",
    feedback: card?.dataset.feedback || "",
    polishStatus: card?.dataset.polishStatus || "",
    sourceKind: group === "web" ? "web_variant" : group === "bank" ? "bank_variant" : "pending_variant",
    source: card?.dataset.source || (group === "web" ? "AI查题·联网" : group === "bank" ? "题库找题" : "AI生成"),
    sourceUrl: card?.dataset.sourceUrl || "",
    sourceTitle: card?.dataset.sourceTitle || "",
    searchQuery: card?.dataset.searchQuery || "",
    variantOf: pending.id
  };
}

function normalizeOptionLines(value = "") {
  return String(value || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function selectedQuestions() {
  const picked = state.db.questions.filter((q) => state.selected.has(q.id));
  return picked.concat(pendingQuestionSnapshots(), state.generatedQuestions);
}

function renderPaper() {
  const student = state.db.students.find((s) => s.id === $("#assignmentStudent").value);
  $("#paperTitle").textContent = $("#assignmentTitle").value || "未命名作业";
  $("#paperStudent").textContent = student?.name || "________";
  $("#paperDate").textContent = new Date().toLocaleDateString("zh-CN");
  $("#paperDuration").textContent = $("#assignmentDuration").value || "40 分钟";
  $("#paperScore").textContent = $("#assignmentScore").value || "100";
  const questions = selectedQuestions();
  const exportMode = $("#assignmentExportMode")?.value || "student";
  $("#paperQuestions").innerHTML = questions.length
    ? questions.map((q) => `<li>${escapeHtml(formatQuestionBody(q)).replace(/\n/g, "<br>")}${questionVisualFigure(q, "paper-source")}</li>`).join("")
    : `<li>请从题库选择题目，或使用 AI 生成同类题。</li>`;
  $(".answer-section").classList.toggle("hidden", exportMode === "student");
  $(".answer-section h2").textContent = exportMode === "answer" ? "答案" : "答案与解析";
  $("#paperAnswers").innerHTML = questions.length
    ? questions.map((q) => `
      <li>
        <strong>答案：</strong>${escapeHtml(q.answer || "待补充")}<br>
        ${exportMode === "solution" ? `<strong>解析：</strong>${escapeHtml(q.explanation || "待补充").replace(/\n/g, "<br>")}${explanationImageFigure(q, "paper-source")}` : ""}
      </li>
    `).join("")
    : `<li>暂无答案。</li>`;
}

function assignmentPayload() {
  const student = state.db.students.find((s) => s.id === $("#assignmentStudent").value);
  return {
    title: $("#assignmentTitle").value,
    studentId: student?.id || "",
    studentName: student?.name || "",
    subject: $("#assignmentSubject").value,
    grade: $("#assignmentGrade").value,
    duration: $("#assignmentDuration").value,
    score: $("#assignmentScore").value,
    exportMode: $("#assignmentExportMode")?.value || "student",
    questionIds: [...state.selected],
    generatedQuestions: pendingQuestionSnapshots().concat(state.generatedQuestions)
  };
}

function printCurrentAssignment() {
  if (!selectedQuestions().length) return toast("请先选择或生成题目");
  state.view = "assignments";
  renderChrome();
  renderPaper();
  requestAnimationFrame(() => {
    const paper = $("#printArea");
    paper?.scrollIntoView({ block: "start" });
    setTimeout(() => window.print(), 120);
  });
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function defaultsFromImport() {
  return {
    subject: $("#defaultSubject").value,
    stage: $("#defaultStage").value,
    level: $("#defaultLevel").value,
    grade: $("#defaultGrade").value,
    chapter: $("#defaultChapter").value,
    knowledge: $("#defaultKnowledge").value
  };
}

function defaultsFromBank() {
  const answerText = state.bankUploadMethod === "text"
    ? $("#bankTextAnswerText")?.value || ""
    : $("#bankFileAnswerText")?.value || "";
  return {
    subject: $("#bankDefaultSubject")?.value || "初中数学",
    stage: $("#bankDefaultStage")?.value || "初中",
    level: $("#bankDefaultLevel")?.value || "基础",
    grade: $("#bankDefaultGrade")?.value || "",
    chapter: $("#bankDefaultChapter")?.value || "",
    knowledge: $("#bankDefaultKnowledge")?.value || "",
    type: $("#bankDefaultType")?.value || "",
    sourceFilename: $("#bankDefaultSource")?.value || "",
    answerText
  };
}

function renderBankWorkspace() {
  state.bankIssueFilter = "";
  $$(".bank-method-tab").forEach((button) => button.classList.toggle("active", button.dataset.bankUploadMethod === state.bankUploadMethod));
  $$("[data-bank-method-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.bankMethodPanel !== state.bankUploadMethod));
  renderBankUploadSteps();
  renderBankKnowledgeOptions();
  renderBankPagePicker();
  renderBankAnswerPanels();
}

function renderBankUploadSteps() {
  const hasQuestionSource = state.bankUploadMethod === "file"
    ? Boolean(state.bankUploadId)
    : Boolean($("#bankTextInput")?.value?.trim());
  const hasAnswer = state.bankUploadMethod === "file"
    ? Boolean($("#bankFileAnswerText")?.value?.trim())
    : Boolean($("#bankTextAnswerText")?.value?.trim());
  const activeStep = Math.max(state.bankUploadStepOverride || 0, hasAnswer ? 3 : hasQuestionSource ? 2 : 1);
  $("#bankDefaultsCard")?.classList.toggle("hidden", activeStep !== 3);
  $("#bankImportGrid")?.classList.toggle("tags-hidden", activeStep !== 3);
  const submit = $("#bankSubmitToReviewBtn");
  if (submit) submit.textContent = state.bankUploadMethod === "file" ? "分析所选页到待审核" : "文字拆题到待审核";
  const fileNext = $("#bankFileNextToTagsBtn");
  const textNext = $("#bankTextNextToTagsBtn");
  if (fileNext) fileNext.disabled = !$("#bankFileAnswerText")?.value?.trim();
  if (textNext) textNext.disabled = !$("#bankTextAnswerText")?.value?.trim();
  $$("[data-bank-upload-step]").forEach((item) => {
    const step = Number(item.dataset.bankUploadStep || 1);
    item.classList.toggle("active", step === activeStep);
    item.classList.toggle("done", step < activeStep);
  });
}

function renderBankAnswerPanels() {
  $("#bankFileAnswerPanel")?.classList.toggle("hidden", !state.bankUploadId);
  const hasText = Boolean($("#bankTextInput")?.value?.trim());
  $("#bankTextAnswerPanel")?.classList.toggle("hidden", !hasText);
}

function renderBankKnowledgeOptions() {
  const list = $("#bankKnowledgeOptions");
  if (!list) return;
  const tags = unique((state.db.questions || []).flatMap((q) => q.knowledge || []));
  list.innerHTML = tags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("");
}

function renderBankPagePicker() {
  const box = $("#bankPagePicker");
  if (!box) return;
  const upload = (state.db.uploads || []).find((item) => item.id === state.bankUploadId);
  if (!upload) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `
    <strong>${escapeHtml(upload.filename)}</strong>
    <p class="muted">选择要分析的页数</p>
    ${pageRangeControls(upload)}
  `;
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function numberText(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function percentText(used, limit) {
  if (!limit) return "0%";
  return `${Math.min(100, Math.round((Number(used || 0) / Number(limit || 1)) * 100))}%`;
}

function subscriptionLabel(status = "") {
  return {
    trialing: "试用中",
    active: "已开通",
    past_due: "欠费",
    expired: "已到期",
    disabled: "已停用"
  }[status] || "未设置";
}

async function splitImportText() {
  const text = $("#extractText").value.trim();
  if (!text) return toast("请先上传资料或粘贴题目文本");
  const payload = await api("/api/questions/split", {
    method: "POST",
    body: { text, defaults: defaultsFromImport(), sourceUploadId: state.currentUploadId }
  });
  state.splitDrafts = payload.questions;
  renderSplitPreview();
  toast(`拆出 ${state.splitDrafts.length} 道题，请校对后保存`);
}

async function saveSplitDrafts() {
  if (!state.splitDrafts.length) await splitImportText();
  if (!state.splitDrafts.length) return;
  const payload = await api("/api/questions", {
    method: "POST",
    body: { questions: state.splitDrafts }
  });
  state.splitDrafts = [];
  $("#splitPreview").innerHTML = "";
  await loadState();
  toast(`已保存 ${payload.questions.length} 道题`);
}

async function generateAiQuestions() {
  const referenceQuestions = selectedQuestions().slice(0, 3).map((q) => q.stem).join("\n");
  const payload = await api("/api/ai/generate", {
    method: "POST",
    body: {
      subject: $("#assignmentSubject").value || $("#defaultSubject").value,
      grade: $("#assignmentGrade").value || $("#defaultGrade").value,
      level: $("#defaultLevel").value,
      knowledge: $("#aiKnowledge").value,
      count: Number($("#aiCount").value || 5),
      reference: [$("#aiReference").value, referenceQuestions].filter(Boolean).join("\n")
    }
  });
  state.generatedQuestions.push(...payload.questions.map((q) => ({
    ...q,
    id: `generated-${crypto.randomUUID()}`,
    knowledge: Array.isArray(q.knowledge) ? q.knowledge : String(q.knowledge || "").split(/[,，、]/).filter(Boolean)
  })));
  renderAssignmentControls();
  renderPaper();
  toast(`已加入 ${payload.questions.length} 道题：题库复用 ${payload.reused || 0} 道，AI 生成 ${payload.generated ?? payload.questions.length} 道`);
}

function collectPendingPayload(form, metadata = {}) {
  const base = { ...formObject(form), ...metadata };
  const parsed = splitOptionsFromStem(base.stem || "");
  const variants = $$(".variant-card", form).map((card) => ({
    variantGroup: card.dataset.variantGroup || "ai",
    source: card.dataset.source || "",
    sourceUrl: card.dataset.sourceUrl || "",
    sourceTitle: card.dataset.sourceTitle || "",
    searchQuery: card.dataset.searchQuery || "",
    sourceQuestionId: card.dataset.sourceQuestionId || "",
    stem: $("[name='variantStem']", card)?.value || "",
    options: $("[name='variantOptions']", card)?.value || "",
    answer: $("[name='variantAnswer']", card)?.value || "",
    explanation: $("[name='variantExplanation']", card)?.value || "",
    subject: base.subject,
    stage: base.stage,
    grade: base.grade,
    chapter: base.chapter,
    knowledge: base.knowledge,
    level: base.level,
    type: base.type,
    reuseSourceImage: card.dataset.reuseSourceImage === "true",
    questionImage: card.dataset.questionImage || "",
    questionImageStoredName: card.dataset.questionImageStoredName || "",
    questionImageManual: card.dataset.questionImageManual === "true",
    templateId: card.dataset.templateId || "",
    generationMode: card.dataset.generationMode || "",
    verification: (() => {
      try {
        return JSON.parse(decodeURIComponent(card.dataset.verification || "null"));
      } catch {
        return null;
      }
    })(),
    matchInfo: (() => {
      try {
        return JSON.parse(decodeURIComponent(card.dataset.matchInfo || "null"));
      } catch {
        return null;
      }
    })(),
    feedback: card.dataset.feedback || "",
    polishStatus: card.dataset.polishStatus || "",
    diagramSpec: (() => {
      try {
        return JSON.parse(decodeURIComponent(card.dataset.diagramSpec || "null"));
      } catch {
        return null;
      }
    })(),
    diagramSvg: decodeURIComponent(card.dataset.diagramSvg || "")
  })).filter((item) => item.stem.trim());
  const aiVariants = variants
    .filter((item) => item.variantGroup === "ai")
    .map(({ variantGroup, ...item }) => ({ ...item, source: item.source || "AI生成" }));
  const bankVariants = variants
    .filter((item) => item.variantGroup === "bank")
    .map(({ variantGroup, ...item }) => ({ ...item, source: item.source || "题库找题" }));
  const webVariants = variants
    .filter((item) => item.variantGroup === "web")
    .map(({ variantGroup, ...item }) => ({ ...item, source: item.source || "AI查题·联网" }));
  return { ...base, stem: parsed.stem, options: parsed.options, variants: [...webVariants, ...aiVariants, ...bankVariants], aiVariants, bankVariants, webVariants };
}

function splitOptionsFromStem(text = "") {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const optionStart = lines.findIndex((line) => /^[A-D][.、．]\s*/i.test(line));
  if (optionStart < 0) return { stem: text, options: [] };
  const stem = lines.slice(0, optionStart).join("\n");
  const options = lines.slice(optionStart).filter((line) => /^[A-D][.、．]\s*/i.test(line));
  return { stem: stem || text, options };
}

async function uploadQuestionImage(reviewItem, file, metadata = {}) {
  if (!reviewItem || !file) return;
  if (!file.type?.startsWith("image/")) return toast("请上传图片文件");
  const data = new FormData();
  data.append("file", file);
  if (metadata.bbox) data.append("bbox", JSON.stringify(metadata.bbox));
  await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/image`, {
    method: "POST",
    body: data
  });
  await loadState();
  toast("本题图片已绑定");
}

async function uploadExplanationImage(reviewItem, file) {
  if (!reviewItem || !file) return;
  if (!file.type?.startsWith("image/")) return toast("请上传图片文件");
  const data = new FormData();
  data.append("file", file);
  await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/explanation-image`, {
    method: "POST",
    body: data
  });
  await loadState();
  toast("解析图片已绑定");
}

async function autoQuestionImage(reviewItem) {
  if (!reviewItem) return;
  const payload = await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/auto-image`, {
    method: "POST"
  });
  await loadState();
  toast(payload.question?.questionImageStoredName ? "已自动补截图，请核对是否准确" : "已尝试自动补截图");
}

async function mergePendingQuestion(reviewItem, direction = "down") {
  const list = state.db.pendingQuestions || [];
  const index = list.findIndex((q) => q.id === reviewItem?.dataset.pendingId);
  if (index === -1) return toast("没有找到当前题");
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  const neighbor = list[neighborIndex];
  if (!neighbor) return toast(direction === "up" ? "上面没有可合并的题" : "下面没有可合并的题");
  const current = list[index];
  const ok = await confirmAction({
    title: `合并${direction === "up" ? "上一题" : "下一题"}？`,
    text: `合并后会成为一道待审核题。当前题：${(current.stem || "").slice(0, 32)}；合并题：${(neighbor.stem || "").slice(0, 32)}`,
    confirmText: "确认合并",
    cancelText: "取消"
  });
  if (!ok) return;
  await api(`/api/pending-questions/${current.id}/merge`, {
    method: "POST",
    body: {
      withId: neighbor.id,
      order: direction === "up" ? "before" : "after"
    }
  });
  if (direction === "up") state.reviewPage = Math.max(1, state.reviewPage - 1);
  await loadState();
  toast("题目已合并");
}

async function splitPendingQuestion(reviewItem) {
  const question = (state.db.pendingQuestions || []).find((q) => q.id === reviewItem?.dataset.pendingId);
  if (!question) return toast("没有找到当前题");
  const template = `${formatQuestionBody(question)}\n\n---\n\n`;
  const text = prompt("请用单独一行 --- 分隔要拆成的多道题。拆分后会进入待审核并记录历史。", template);
  if (!text) return;
  const payload = await api(`/api/pending-questions/${question.id}/split`, {
    method: "POST",
    body: { text }
  });
  await loadState();
  toast(`已拆分，新增 ${payload.created.length} 道待审核题`);
}

function openCropModal(reviewItem, imageUrl) {
  if (!reviewItem || !imageUrl) return toast("没有可框选的原页截图");
  const question = (state.db.pendingQuestions || []).find((item) => item.id === reviewItem.dataset.pendingId) || {};
  state.crop = {
    pendingId: reviewItem.dataset.pendingId,
    imageUrl,
    questionBBox: question.questionBBox || null,
    sourcePage: question.sourcePage || "",
    startX: 0,
    startY: 0,
    rect: null,
    dragging: false
  };
  const modal = $("#cropModal");
  const image = $("#cropImage");
  const selection = $("#cropSelection");
  selection.classList.add("hidden");
  selection.removeAttribute("style");
  image.onload = () => drawExistingQuestionBBox();
  image.src = imageUrl;
  if (image.complete) setTimeout(() => drawExistingQuestionBBox(), 0);
  modal.classList.remove("hidden");
}

function closeCropModal() {
  $("#cropModal").classList.add("hidden");
  $("#cropImage").removeAttribute("src");
  $("#cropSelection").classList.add("hidden");
  state.crop = { pendingId: "", imageUrl: "", questionBBox: null, sourcePage: "", startX: 0, startY: 0, rect: null, dragging: false };
}

function cropImageRectInStage() {
  const stage = $("#cropStage");
  const image = $("#cropImage");
  const stageRect = stage.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  return {
    x: imageRect.left - stageRect.left + stage.scrollLeft,
    y: imageRect.top - stageRect.top + stage.scrollTop,
    width: imageRect.width,
    height: imageRect.height
  };
}

function cropPoint(event) {
  const stage = $("#cropStage");
  const rect = stage.getBoundingClientRect();
  const imageRect = cropImageRectInStage();
  const rawX = event.clientX - rect.left + stage.scrollLeft;
  const rawY = event.clientY - rect.top + stage.scrollTop;
  return {
    x: Math.max(imageRect.x, Math.min(imageRect.x + imageRect.width, rawX)),
    y: Math.max(imageRect.y, Math.min(imageRect.y + imageRect.height, rawY))
  };
}

function drawCropSelection(rect) {
  const selection = $("#cropSelection");
  selection.classList.remove("hidden");
  selection.style.left = `${rect.x}px`;
  selection.style.top = `${rect.y}px`;
  selection.style.width = `${rect.width}px`;
  selection.style.height = `${rect.height}px`;
}

function drawExistingQuestionBBox() {
  const bbox = state.crop.questionBBox;
  const image = $("#cropImage");
  if (!bbox || !image.complete || !image.naturalWidth) return;
  const imageRect = cropImageRectInStage();
  const imageWidth = Number(bbox.imageWidth || image.naturalWidth) || image.naturalWidth;
  const imageHeight = Number(bbox.imageHeight || image.naturalHeight) || image.naturalHeight;
  const rect = {
    x: imageRect.x + Number(bbox.x || 0) * imageRect.width / imageWidth,
    y: imageRect.y + Number(bbox.y || 0) * imageRect.height / imageHeight,
    width: Number(bbox.width || 0) * imageRect.width / imageWidth,
    height: Number(bbox.height || 0) * imageRect.height / imageHeight
  };
  if (rect.width < 8 || rect.height < 8) return;
  state.crop.rect = rect;
  drawCropSelection(rect);
}

async function saveCropSelection() {
  const crop = state.crop;
  if (!crop.pendingId || !crop.rect || crop.rect.width < 12 || crop.rect.height < 12) {
    return toast("请先框选一个更大的区域");
  }
  const image = $("#cropImage");
  if (!image.complete || !image.naturalWidth) return toast("原图还没有加载完成");
  const imageRect = cropImageRectInStage();
  const left = Math.max(imageRect.x, crop.rect.x);
  const top = Math.max(imageRect.y, crop.rect.y);
  const right = Math.min(imageRect.x + imageRect.width, crop.rect.x + crop.rect.width);
  const bottom = Math.min(imageRect.y + imageRect.height, crop.rect.y + crop.rect.height);
  const sx = Math.max(0, (left - imageRect.x) * image.naturalWidth / imageRect.width);
  const sy = Math.max(0, (top - imageRect.y) * image.naturalHeight / imageRect.height);
  const sw = Math.min(image.naturalWidth - sx, (right - left) * image.naturalWidth / imageRect.width);
  const sh = Math.min(image.naturalHeight - sy, (bottom - top) * image.naturalHeight / imageRect.height);
  if (sw < 8 || sh < 8) return toast("框选区域没有落在图片上");

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
  if (!blob) return toast("裁剪失败，请重试");
  const file = new File([blob], `question-crop-${crop.pendingId}.png`, { type: "image/png" });
  const reviewItem = $(`.review-item[data-pending-id="${CSS.escape(crop.pendingId)}"]`);
  await uploadQuestionImage(reviewItem, file, {
    bbox: {
      page: crop.sourcePage,
      x: Math.round(sx),
      y: Math.round(sy),
      width: Math.round(sw),
      height: Math.round(sh),
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      source: "manual",
      confidence: 1
    }
  });
  closeCropModal();
}

function clampReviewPageAfterRemoval(previousCount) {
  const nextCount = Math.max(0, previousCount - 1);
  const totalPages = Math.max(1, Math.ceil(nextCount / state.reviewPageSize));
  state.reviewPage = Math.min(Math.max(1, state.reviewPage), totalPages);
}

async function analyzeCurrentText() {
  const text = $("#extractText").value.trim();
  if (!text) return toast("请先粘贴或载入题目文本");
  const payload = await api("/api/analyze-text", {
    method: "POST",
    body: { text, defaults: defaultsFromImport() }
  });
  state.reviewUploadId = "text:粘贴文本";
  state.reviewPage = 1;
  await loadState();
  toast(`已生成 ${payload.pendingQuestions.length} 道待审核题，跳过 ${payload.skippedDuplicates || 0} 道重复题`);
}

async function uploadBankFile() {
  const input = $("#bankFileInput");
  const file = input?.files?.[0];
  if (!file) return toast("请选择题库文件");
  const data = new FormData();
  data.append("file", file);
  $("#bankImportStatus").textContent = "正在上传并生成页码...";
  const uploadPayload = await api("/api/uploads", { method: "POST", body: data });
  state.bankUploadId = uploadPayload.upload.id;
  state.bankUploadStepOverride = 2;
  state.reviewUploadId = uploadPayload.upload.id;
  await loadState();
  state.view = "bankUpload";
  renderChrome();
  renderBankWorkspace();
  $("#bankImportStatus").textContent = "已上传，请选择页数后点击分析。";
  toast("文件已上传，请选择要分析的页");
}

async function analyzeSelectedBankUploadPages() {
  const uploadId = state.bankUploadId;
  if (!uploadId) return toast("请先上传题库文件");
  const pageRange = selectedPageRange(uploadId);
  $("#bankImportStatus").textContent = "正在分析所选页...";
  const analyzePayload = await api(`/api/uploads/${uploadId}/analyze`, {
    method: "POST",
    body: { defaults: defaultsFromBank(), pageRange }
  });
  state.reviewUploadId = analyzePayload.upload.id;
  state.reviewPage = 1;
  startAnalysisPolling(analyzePayload.upload.id);
  await loadState();
  state.view = "bankSearch";
  renderChrome();
  renderBankWorkspace();
  $("#bankImportStatus").textContent = "已开始分析，结果会进入待审核。";
  toast("已开始分析，结果会进入待审核");
}

async function analyzeBankText() {
  const text = $("#bankTextInput")?.value?.trim() || "";
  if (!text) return toast("请先粘贴题目文本");
  const payload = await api("/api/analyze-text", {
    method: "POST",
    body: { text, defaults: defaultsFromBank() }
  });
  $("#bankTextInput").value = "";
  $("#bankTextAnswerText").value = "";
  state.reviewUploadId = "text:粘贴文本";
  state.reviewPage = 1;
  await loadState();
  state.view = "bankSearch";
  renderChrome();
  renderBankWorkspace();
  toast(`已生成 ${payload.pendingQuestions.length} 道待审核题，跳过 ${payload.skippedDuplicates || 0} 道重复题`);
}

async function submitBankUploadToReview() {
  const hasLabels = !$("#bankDefaultsCard")?.classList.contains("hidden");
  if (!hasLabels) return toast("请先完成题目和答案，再设置标签");
  if (state.bankUploadMethod === "file") return analyzeSelectedBankUploadPages();
  return analyzeBankText();
}

function selectedBankQuestions() {
  return (state.db.questions || []).filter((q) => state.selected.has(q.id));
}

async function batchPatchSelectedQuestions() {
  const picked = selectedBankQuestions();
  if (!picked.length) return toast("请先勾选题库题目");
  const payload = {};
  const knowledge = $("#batchKnowledge")?.value?.trim() || "";
  const level = $("#batchLevel")?.value || "";
  const type = $("#batchType")?.value || "";
  const chapter = $("#batchChapter")?.value?.trim() || "";
  if (knowledge) payload.knowledge = knowledge;
  if (level) payload.level = level;
  if (type) payload.type = type;
  if (chapter) payload.chapter = chapter;
  if (!Object.keys(payload).length) return toast("请先填写要批量修改的字段");
  const ok = await confirmAction({
    title: "批量修改题目？",
    text: `将修改 ${picked.length} 道题的字段。`,
    confirmText: "修改"
  });
  if (!ok) return;
  for (const question of picked) {
    await api(`/api/questions/${question.id}`, { method: "PATCH", body: payload });
  }
  await loadState();
  toast(`已批量修改 ${picked.length} 道题`);
}

async function batchDeleteSelectedQuestions() {
  const picked = selectedBankQuestions();
  if (!picked.length) return toast("请先勾选题库题目");
  const ok = await confirmAction({
    title: "批量删除题目？",
    text: `将删除 ${picked.length} 道正式题库题目，这个操作不可撤销。`,
    confirmText: "删除"
  });
  if (!ok) return;
  for (const question of picked) {
    await api(`/api/questions/${question.id}`, { method: "DELETE" });
  }
  state.selected.clear();
  await loadState();
  toast(`已删除 ${picked.length} 道题`);
}

async function backfillBankProfiles() {
  const payload = await api("/api/questions/backfill-match-profiles", { method: "POST" });
  await loadState();
  toast(`已补模板标签：${payload.summary?.updated || 0}/${payload.summary?.total || 0} 道题`);
}

function exportBankQuestions() {
  const rows = state.db.questions || [];
  if (!rows.length) return toast("题库为空，暂无可导出内容");
  const content = JSON.stringify(rows, null, 2);
  downloadBlob(new Blob([content], { type: "application/json;charset=utf-8" }), `题库导出-${new Date().toISOString().slice(0, 10)}.json`);
  toast(`已导出 ${rows.length} 道题`);
}

async function approveAllPending() {
  const ids = activePendingQuestions().map((q) => q.id);
  if (!ids.length) return toast("没有待审核题目");
  try {
    const payload = await api("/api/pending-questions/approve", {
      method: "POST",
      body: { ids, includeVariants: true }
    });
    state.selected = new Set(payload.questions.map((q) => q.id));
    await loadState();
    toast(`已入库 ${payload.questions.length} 道题，跳过 ${payload.skippedDuplicates || 0} 道重复题`);
  } catch (error) {
    await loadState();
    toast(error.message);
  }
}

async function approveSafePending() {
  const ids = activePendingQuestions()
    .filter((q) => !(q.qualityErrors || []).length && !(q.qualityWarnings || []).length)
    .map((q) => q.id);
  if (!ids.length) return toast("没有可直接通过的低风险题");
  const payload = await api("/api/pending-questions/approve", {
    method: "POST",
    body: { ids, includeVariants: true }
  });
  state.selected = new Set(payload.questions.map((q) => q.id));
  await loadState();
  toast(`已通过低风险题 ${payload.questions.length} 道`);
}

async function createAssignment() {
  const questions = selectedQuestions();
  if (!questions.length) return toast("请先选择或生成题目");
  const payload = await api("/api/assignments", {
    method: "POST",
    body: assignmentPayload()
  });
  await loadState();
  toast(`已保存作业：${payload.assignment.title}`);
}

function usedQuestionIds() {
  return new Set((state.db.assignments || []).flatMap((assignment) => assignment.questionIds || []));
}

function autoPickQuestions({ fromWeakness = false } = {}) {
  const count = Math.max(1, Number($("#autoPickCount").value || 10));
  const subject = ($("#assignmentSubject").value || $("#defaultSubject").value || "").trim();
  const grade = ($("#assignmentGrade").value || $("#defaultGrade").value || "").trim();
  const knowledgeInput = ($("#autoPickKnowledge").value || $("#aiKnowledge").value || "").trim();
  const avoidUsed = $("#autoPickAvoidUsed").value !== "no";
  const used = usedQuestionIds();
  let knowledgeTags = knowledgeInput.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);

  if (fromWeakness) {
    const studentId = $("#assignmentStudent").value;
    const mistakeQuestionIds = new Set((state.db.mistakes || [])
      .filter((m) => !studentId || m.studentId === studentId)
      .map((m) => m.questionId));
    const weakTags = state.db.questions
      .filter((q) => mistakeQuestionIds.has(q.id))
      .flatMap((q) => q.knowledge || []);
    knowledgeTags = unique(weakTags).slice(0, 8);
    if (!knowledgeTags.length) return toast("这个学生还没有可用的薄弱知识点");
  }

  const scored = (state.db.questions || [])
    .filter((q) => !avoidUsed || !used.has(q.id))
    .filter((q) => !subject || q.subject === subject)
    .filter((q) => !grade || q.grade === grade)
    .map((q) => {
      let score = 0;
      const tags = q.knowledge || [];
      if (knowledgeTags.length) {
        for (const tag of knowledgeTags) {
          if (tags.includes(tag) || tags.some((item) => item.includes(tag) || tag.includes(item))) score += 12;
        }
      } else {
        score += 1;
      }
      if (q.level === $("#defaultLevel").value) score += 3;
      if (q.questionImage || q.questionImageStoredName) score += 1;
      return { q, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.q.createdAt || 0) - new Date(a.q.createdAt || 0));

  const picked = scored.slice(0, count).map(({ q }) => q.id);
  if (!picked.length) return toast("没有找到符合条件的题目");
  picked.forEach((id) => state.selected.add(id));
  state.view = "assignments";
  renderChrome();
  renderBankSummary();
  renderQuestionList();
  renderAssignmentControls();
  renderPaper();
  toast(`已自动选择 ${picked.length} 道题`);
}

async function exportAssignmentWord() {
  if (!selectedQuestions().length) return toast("请先选择或生成题目");
  const title = $("#assignmentTitle").value || "未命名作业";
  await downloadFile("/api/assignments/export-word", assignmentPayload(), `${title}.docx`);
  toast("Word 已导出，题目配图已随文件保存");
}

document.addEventListener("click", async (event) => {
  const imageLink = event.target.closest("[data-image-viewer]");
  if (imageLink) {
    event.preventDefault();
    openImageViewer(imageLink.dataset.imageViewer || imageLink.getAttribute("href") || "", imageLink.dataset.imageTitle || "图片预览");
    return;
  }

  const navParent = event.target.closest(".nav-parent");
  if (navParent) {
    state.bankNavOpen = !state.bankNavOpen;
    renderChrome();
    return;
  }

  const nav = event.target.closest("[data-view]");
  if (nav) {
    state.view = nav.dataset.view;
    if (["bankSearch", "bankUpload"].includes(state.view)) state.bankNavOpen = true;
    renderChrome();
    renderPaper();
    return;
  }

  const clearBank = event.target.closest("[data-clear-bank-filters]");
  if (clearBank) {
    event.preventDefault();
    clearBankFilters();
    return;
  }

  const issueFilter = event.target.closest("[data-bank-issue-filter]");
  if (issueFilter) {
    state.bankIssueFilter = issueFilter.dataset.bankIssueFilter || "";
    renderBankWorkspace();
    renderBankSummary();
    renderQuestionList();
    return;
  }

  const uploadMethod = event.target.closest("[data-bank-upload-method]");
  if (uploadMethod) {
    state.bankUploadMethod = uploadMethod.dataset.bankUploadMethod || "file";
    state.bankUploadStepOverride = 0;
    renderBankWorkspace();
    return;
  }

  const jump = event.target.closest("[data-jump]");
  if (jump) {
    state.view = jump.dataset.jump;
    renderChrome();
  }

  const uploadLoad = event.target.closest("[data-load-upload]");
  if (uploadLoad) {
    const upload = state.db.uploads.find((item) => item.id === uploadLoad.dataset.loadUpload);
    state.currentUploadId = upload?.id || "";
    const text = isProbablyGarbledText(upload?.extractedText) ? "" : upload?.extractedText || "";
    $("#extractText").value = text;
    if (!text && upload?.extractionNote) {
      $("#extractText").placeholder = upload.extractionNote;
    }
    toast(text ? "已载入提取文本" : "已载入资料说明，暂无可用文本");
  }

  const uploadAnalyze = event.target.closest("[data-analyze-upload]");
  if (uploadAnalyze) {
    try {
      toast("已开始后台分析，可以继续操作");
      const pageRange = selectedPageRange(uploadAnalyze.dataset.analyzeUpload);
      const payload = await api(`/api/uploads/${uploadAnalyze.dataset.analyzeUpload}/analyze`, {
        method: "POST",
        body: { defaults: defaultsFromImport(), pageRange }
      });
      const index = state.db.uploads.findIndex((item) => item.id === payload.upload.id);
      if (index !== -1) state.db.uploads[index] = payload.upload;
      state.reviewUploadId = payload.upload.id;
      state.reviewPage = 1;
      renderUploads();
      startAnalysisPolling(payload.upload.id);
      await loadState();
    } catch (error) {
      toast(error.message);
    }
  }

  const retryPage = event.target.closest(".retry-page");
  if (retryPage) {
    try {
      toast(`正在重试第 ${retryPage.dataset.retryPage} 页`);
      const payload = await api(`/api/uploads/${retryPage.dataset.retryUpload}/analyze`, {
        method: "POST",
        body: { defaults: defaultsFromImport(), pageRange: retryPage.dataset.retryPage }
      });
      const index = state.db.uploads.findIndex((item) => item.id === payload.upload.id);
      if (index !== -1) state.db.uploads[index] = payload.upload;
      state.reviewUploadId = payload.upload.id;
      state.reviewPage = 1;
      renderUploads();
      startAnalysisPolling(payload.upload.id);
    } catch (error) {
      toast(error.message);
    }
  }

  const reviewPage = event.target.closest("[data-review-page]");
  if (reviewPage) {
    const totalPages = Math.max(1, Math.ceil(activePendingQuestions().length / state.reviewPageSize));
    if (reviewPage.dataset.reviewPage === "prev") state.reviewPage = Math.max(1, state.reviewPage - 1);
    if (reviewPage.dataset.reviewPage === "next") state.reviewPage = Math.min(totalPages, state.reviewPage + 1);
    renderReviewList();
  }

  const reviewJump = event.target.closest("[data-review-jump]");
  if (reviewJump) {
    event.preventDefault();
    const indexBox = reviewJump.closest(".review-index");
    if (indexBox) state.reviewIndexScrollTop = indexBox.scrollTop;
    state.reviewPage = Number(reviewJump.dataset.reviewJump) || 1;
    renderReviewList();
  }

  const knowledgeChip = event.target.closest("[data-knowledge-chip]");
  if (knowledgeChip) {
    event.preventDefault();
    $("#filterKnowledge").value = knowledgeChip.dataset.knowledgeChip || "";
    state.view = "bankSearch";
    renderChrome();
    renderBankSummary();
    renderQuestionList();
    return;
  }

  const uploadCard = event.target.closest(".delete-upload");
  if (uploadCard) {
    const ok = await confirmAction({
      title: "删除这份资料？",
      text: "会同时删除这份资料的页图、分析结果，以及由它生成的待审核题。",
      confirmText: "删除",
      cancelText: "取消"
    });
    if (!ok) return;
    try {
      await api(`/api/uploads/${uploadCard.dataset.uploadId}`, { method: "DELETE" });
      if (state.reviewUploadId === uploadCard.dataset.uploadId) state.reviewUploadId = "all";
      await loadState();
      toast("资料已删除");
    } catch (error) {
      toast(error.message);
    }
  }

  const dismissError = event.target.closest("[data-dismiss-analysis-error]");
  if (dismissError) {
    state.dismissedAnalysisErrors.add(dismissError.dataset.dismissAnalysisError || "");
    dismissError.closest(".dismissible-panel")?.remove();
    return;
  }

  const item = event.target.closest(".question-item");
  if (item && event.target.matches(".edit-question")) {
    item.classList.toggle("editing");
  }

  if (item && event.target.matches(".delete-question")) {
    await api(`/api/questions/${item.dataset.questionId}`, { method: "DELETE" });
    state.selected.delete(item.dataset.questionId);
    await loadState();
    toast("题目已删除");
  }

  if (item && event.target.matches(".ai-classify")) {
    const q = state.db.questions.find((question) => question.id === item.dataset.questionId);
    try {
      const payload = await api("/api/ai/classify", { method: "POST", body: { stem: q.stem } });
      await api(`/api/questions/${q.id}`, { method: "PATCH", body: payload.result });
      await loadState();
      toast("AI 分类已写入题目");
    } catch (error) {
      toast(error.message);
    }
  }

  const reviewItem = event.target.closest(".review-item");
  if (reviewItem && event.target.matches(".toggle-pending-assignment")) {
    const id = reviewItem.dataset.pendingId;
    if (state.selectedPending.has(id)) {
      state.selectedPending.delete(id);
      toast("已从组卷移除");
    } else {
      state.selectedPending.add(id);
      toast("已加入组卷");
    }
    renderReviewList();
    renderBankSummary();
    renderAssignmentControls();
    renderPaper();
  }

  if (reviewItem && event.target.matches(".toggle-variant-assignment")) {
    const card = event.target.closest(".variant-card");
    const snapshot = variantSnapshotFromCard(reviewItem, card);
    if (!snapshot.stem.trim()) return toast("这道相似例题还没有题干");
    const index = state.generatedQuestions.findIndex((q) => q.id === snapshot.id);
    if (index >= 0) {
      state.generatedQuestions.splice(index, 1);
      toast("已从组卷移除");
    } else {
      state.generatedQuestions.push(snapshot);
      toast("相似例题已加入组卷");
    }
    renderReviewList();
    renderBankSummary();
    renderAssignmentControls();
    renderPaper();
  }

  if (reviewItem && event.target.matches(".bank-variant-feedback")) {
    const card = event.target.closest(".variant-card");
    const index = Number(card?.dataset.variantIndex || 0);
    const feedback = event.target.dataset.feedback || "";
    try {
      const payload = await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/bank-variants/${index}/feedback`, {
        method: "POST",
        body: { feedback }
      });
      applyPendingQuestionPayload(payload, reviewItem.dataset.pendingId);
      toast(`已标记：${feedback}`);
    } catch (error) {
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".upload-question-image")) {
    reviewItem.querySelector(".manual-question-image")?.click();
  }

  if (reviewItem && event.target.matches(".upload-explanation-image")) {
    reviewItem.querySelector(".manual-explanation-image")?.click();
  }

  if (reviewItem && event.target.matches(".crop-question-image")) {
    openCropModal(reviewItem, event.target.dataset.sourceImage);
  }

  if (reviewItem && event.target.matches(".auto-question-image")) {
    try {
      await autoQuestionImage(reviewItem);
    } catch (error) {
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".split-pending")) {
    try {
      await splitPendingQuestion(reviewItem);
    } catch (error) {
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".delete-pending")) {
    const ok = await confirmAction({
      title: "是否删除？",
      text: "删除后不会进入题库。",
      confirmText: "删除",
      cancelText: "取消"
    });
    if (!ok) return;
    const previousCount = (state.db.pendingQuestions || []).length;
    state.selectedPending.delete(reviewItem.dataset.pendingId);
    await api(`/api/pending-questions/${reviewItem.dataset.pendingId}`, { method: "DELETE" });
    clampReviewPageAfterRemoval(previousCount);
    await loadState();
    toast("已删除这道待审核题");
  }

  if (reviewItem && event.target.matches(".approve-pending")) {
    const form = reviewItem.querySelector(".pending-editor");
    try {
      const pendingId = reviewItem.dataset.pendingId;
      const keepInAssignment = state.selectedPending.has(pendingId);
      const current = (state.db.pendingQuestions || []).find((q) => q.id === reviewItem.dataset.pendingId) || {};
      const draft = collectPendingPayload(form);
      const metadata = await requestApproveMetadata({ ...current, ...draft });
      if (!metadata) return;
      await api(`/api/pending-questions/${reviewItem.dataset.pendingId}`, {
        method: "PATCH",
        body: collectPendingPayload(form, metadata)
      });
      const payload = await api("/api/pending-questions/approve", {
        method: "POST",
        body: { ids: [reviewItem.dataset.pendingId], includeVariants: true }
      });
      state.selectedPending.delete(pendingId);
      if (keepInAssignment) {
        (payload.questions || []).forEach((q) => state.selected.add(q.id));
      }
      clampReviewPageAfterRemoval((state.db.pendingQuestions || []).length);
      await loadState();
      const variantCount = (payload.questions || []).filter((q) => q.variantOf).length;
      const originalCount = Math.max(0, (payload.questions || []).length - variantCount);
      toast(`已入库：本题 ${originalCount} 道，相似例题 ${variantCount} 道${payload.skippedDuplicates ? `，跳过重复 ${payload.skippedDuplicates} 道` : ""}`);
    } catch (error) {
      await loadState();
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".enrich-pending")) {
    const button = event.target;
    setButtonBusy(button, true);
    try {
      await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/enrich`, { method: "POST" });
      await loadState();
      toast("AI 已补全这道题");
    } catch (error) {
      toast(error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }

  if (reviewItem && event.target.matches(".generate-variants-pending")) {
    const button = event.target;
    const pendingId = reviewItem.dataset.pendingId;
    clearDismissedAnalysisError(pendingId);
    const action = beginPendingAction(pendingId, "generate-variants");
    setButtonBusy(button, true);
    try {
      removePendingVariantSelections(pendingId, "ai");
      const payload = await api(`/api/pending-questions/${pendingId}/generate-variants`, {
        method: "POST",
        body: { force: true, requestedAt: Date.now() }
      });
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(payload, pendingId);
      toast("AI 已重新生成相似例题");
    } catch (error) {
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(error.payload || {}, pendingId);
      toast(error.message);
    } finally {
      finishPendingAction(action.key, action.token);
      if (button.isConnected) setButtonBusy(button, false);
    }
  }

  if (reviewItem && event.target.matches(".search-online-variants-pending")) {
    const button = event.target;
    const pendingId = reviewItem.dataset.pendingId;
    clearDismissedAnalysisError(pendingId);
    const action = beginPendingAction(pendingId, "search-online-variants");
    setButtonBusy(button, true);
    try {
      removePendingVariantSelections(pendingId, "web");
      const payload = await api(`/api/pending-questions/${pendingId}/search-online-variants`, { method: "POST" });
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(payload, pendingId);
      const isSearchEntry = (payload.question?.webVariants || []).some((item) => /搜索入口/.test(item.source || ""));
      toast(isSearchEntry ? "已生成查题搜索入口" : "已联网查到相似题");
    } catch (error) {
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(error.payload || {}, pendingId);
      toast(error.message);
    } finally {
      finishPendingAction(action.key, action.token);
      if (button.isConnected) setButtonBusy(button, false);
    }
  }

  if (reviewItem && event.target.matches(".find-bank-variants-pending")) {
    const button = event.target;
    const pendingId = reviewItem.dataset.pendingId;
    clearDismissedAnalysisError(pendingId);
    const action = beginPendingAction(pendingId, "find-bank-variants");
    setButtonBusy(button, true);
    try {
      removePendingVariantSelections(pendingId, "bank");
      const payload = await api(`/api/pending-questions/${pendingId}/find-bank-variants`, { method: "POST" });
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(payload, pendingId);
      toast(`已找到 ${(payload.question?.bankVariants || []).length} 道题库相似题`);
    } catch (error) {
      if (!isLatestPendingAction(action.key, action.token)) return;
      applyPendingQuestionPayload(error.payload || {}, pendingId);
      toast(error.message);
    } finally {
      finishPendingAction(action.key, action.token);
      if (button.isConnected) setButtonBusy(button, false);
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target?.matches?.("textarea")) fitTextarea(event.target);
});

document.addEventListener("mousedown", (event) => {
  const reviewJump = event.target.closest("[data-review-jump]");
  if (!reviewJump) return;
  const indexBox = reviewJump.closest(".review-index");
  if (indexBox) state.reviewIndexScrollTop = indexBox.scrollTop;
  event.preventDefault();
});

$("#closeCropBtn").addEventListener("click", closeCropModal);
$("#resetCropBtn").addEventListener("click", () => {
  state.crop.rect = null;
  $("#cropSelection").classList.add("hidden");
});
$("#saveCropBtn").addEventListener("click", () => saveCropSelection().catch((error) => toast(error.message)));
$("#cropStage").addEventListener("pointerdown", (event) => {
  if ($("#cropModal").classList.contains("hidden")) return;
  event.preventDefault();
  $("#cropStage").setPointerCapture?.(event.pointerId);
  const point = cropPoint(event);
  state.crop.dragging = true;
  state.crop.startX = point.x;
  state.crop.startY = point.y;
  state.crop.rect = { x: point.x, y: point.y, width: 0, height: 0 };
  drawCropSelection(state.crop.rect);
});
$("#cropStage").addEventListener("pointermove", (event) => {
  if (!state.crop.dragging) return;
  event.preventDefault();
  const point = cropPoint(event);
  const rect = {
    x: Math.min(state.crop.startX, point.x),
    y: Math.min(state.crop.startY, point.y),
    width: Math.abs(point.x - state.crop.startX),
    height: Math.abs(point.y - state.crop.startY)
  };
  state.crop.rect = rect;
  drawCropSelection(rect);
});
document.addEventListener("pointerup", () => {
  state.crop.dragging = false;
});
$("#cropImage").addEventListener("dragstart", (event) => event.preventDefault());
$("#confirmCancelBtn").addEventListener("click", () => closeConfirmModal(false));
$("#confirmOkBtn").addEventListener("click", () => closeConfirmModal(true));
$("#confirmModal").addEventListener("click", (event) => {
  if (event.target.id === "confirmModal") closeConfirmModal(false);
});
$("#approveCancelBtn").addEventListener("click", () => closeApproveModal(false));
$("#approveModal").addEventListener("click", (event) => {
  if (event.target.id === "approveModal") closeApproveModal(false);
});
$("#closeImageViewerBtn").addEventListener("click", closeImageViewer);
$("#imageZoomOutBtn")?.addEventListener("click", () => setImageViewerScale(imageViewerState.scale - 0.25));
$("#imageZoomInBtn")?.addEventListener("click", () => setImageViewerScale(imageViewerState.scale + 0.25));
$("#imageFitBtn")?.addEventListener("click", () => setImageViewerScale(1, true));
$("#imageActualBtn")?.addEventListener("click", () => setImageViewerScale(1, false));
$("#imageViewerModal").addEventListener("click", (event) => {
  if (event.target.id === "imageViewerModal") closeImageViewer();
});
$("#imageViewerStage")?.addEventListener("mousedown", (event) => {
  if (imageViewerState.fit) return;
  const stage = event.currentTarget;
  imageViewerState.dragging = true;
  imageViewerState.startX = event.pageX;
  imageViewerState.startY = event.pageY;
  imageViewerState.scrollLeft = stage.scrollLeft;
  imageViewerState.scrollTop = stage.scrollTop;
  stage.classList.add("dragging");
});
document.addEventListener("mousemove", (event) => {
  if (!imageViewerState.dragging) return;
  const stage = $("#imageViewerStage");
  if (!stage) return;
  stage.scrollLeft = imageViewerState.scrollLeft - (event.pageX - imageViewerState.startX);
  stage.scrollTop = imageViewerState.scrollTop - (event.pageY - imageViewerState.startY);
});
document.addEventListener("mouseup", () => {
  imageViewerState.dragging = false;
  $("#imageViewerStage")?.classList.remove("dragging");
});
$("#approveForm").addEventListener("submit", (event) => {
  event.preventDefault();
  closeApproveModal(formObject(event.currentTarget));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#confirmModal").classList.contains("hidden")) closeConfirmModal(false);
  if (event.key === "Escape" && !$("#approveModal").classList.contains("hidden")) closeApproveModal(false);
  if (event.key === "Escape" && !$("#imageViewerModal").classList.contains("hidden")) closeImageViewer();
});

document.addEventListener("change", (event) => {
  if (event.target.id === "fileInput") {
    const preview = $("#fileNamePreview");
    if (preview) preview.textContent = event.target.files?.[0]?.name || "未选择文件";
  }
  if (event.target.id === "bankFileInput") {
    const preview = $("#bankFileNamePreview");
    if (preview) preview.textContent = event.target.files?.[0]?.name || "选择题库文件";
    state.bankUploadId = "";
    state.bankUploadStepOverride = 0;
    renderBankPagePicker();
  }
  if (event.target.id === "reviewSourceSelect") {
    state.reviewUploadId = event.target.value || "all";
    state.reviewPage = 1;
    renderReviewList();
  }
  if (event.target.closest(".filters") || event.target.id === "searchInput") {
    renderBankSummary();
    renderQuestionList();
  }
  if (event.target.matches(".manual-question-image")) {
    const file = event.target.files?.[0];
    const reviewItem = event.target.closest(".review-item");
    if (!file || !reviewItem) return;
    uploadQuestionImage(reviewItem, file).catch((error) => toast(error.message));
    event.target.value = "";
  }
  if (event.target.matches(".manual-explanation-image")) {
    const file = event.target.files?.[0];
    const reviewItem = event.target.closest(".review-item");
    if (!file || !reviewItem) return;
    uploadExplanationImage(reviewItem, file).catch((error) => toast(error.message));
    event.target.value = "";
  }
  if (event.target.matches(".select-question")) {
    const id = event.target.closest(".question-item").dataset.questionId;
    event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    renderBankSummary();
    renderAssignmentControls();
    renderPaper();
  }
  if (["assignmentStudent", "assignmentDuration", "assignmentScore"].includes(event.target.id)) renderPaper();
});

document.addEventListener("paste", (event) => {
  const pasteTarget = event.target.closest?.(".paste-question-image, .paste-explanation-image");
  if (!pasteTarget) return;
  const reviewItem = pasteTarget.closest(".review-item");
  const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (!file) return toast("剪贴板里没有图片");
  event.preventDefault();
  const upload = pasteTarget.classList.contains("paste-explanation-image") ? uploadExplanationImage : uploadQuestionImage;
  upload(reviewItem, file).catch((error) => toast(error.message));
});

document.addEventListener("dragover", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image, .paste-explanation-image");
  if (!dropTarget) return;
  event.preventDefault();
  dropTarget.classList.add("dragging");
});

document.addEventListener("dragleave", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image, .paste-explanation-image");
  if (dropTarget) dropTarget.classList.remove("dragging");
});

document.addEventListener("drop", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image, .paste-explanation-image");
  if (!dropTarget) return;
  event.preventDefault();
  dropTarget.classList.remove("dragging");
  const file = Array.from(event.dataTransfer?.files || []).find((entry) => entry.type.startsWith("image/"));
  if (!file) return toast("请拖入图片文件");
  const upload = dropTarget.classList.contains("paste-explanation-image") ? uploadExplanationImage : uploadQuestionImage;
  upload(dropTarget.closest(".review-item"), file).catch((error) => toast(error.message));
});

document.addEventListener("input", (event) => {
  if (event.target.closest(".filters") || event.target.id === "searchInput") {
    renderBankSummary();
    renderQuestionList();
  }
  if (["bankTextInput", "bankFileAnswerText", "bankTextAnswerText"].includes(event.target.id)) {
    renderBankAnswerPanels();
    renderBankUploadSteps();
  }
  const variantCard = event.target.closest?.(".variant-card");
  if (variantCard) {
    const reviewItem = variantCard.closest(".review-item");
    const snapshot = variantSnapshotFromCard(reviewItem, variantCard);
    const index = state.generatedQuestions.findIndex((q) => q.id === snapshot.id);
    if (index >= 0) {
      state.generatedQuestions[index] = snapshot;
      renderAssignmentControls();
      renderPaper();
    }
  }
  if (["assignmentTitle", "assignmentDuration", "assignmentScore"].includes(event.target.id)) renderPaper();
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#loginError").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: formObject(event.currentTarget) });
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadState();
  } catch (error) {
    $("#loginError").textContent = error.message;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

$("#refreshBtn")?.addEventListener("click", async () => {
  await loadState();
  toast("已刷新");
});

$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#fileInput");
  if (!input.files.length) return toast("请选择文件");
  const data = new FormData();
  data.append("file", input.files[0]);
  setUploadBusy(true, "upload", "正在上传文件...");
  $("#extractText").value = "";
  state.splitDrafts = [];
  renderSplitPreview();
  const isImageUpload = input.files[0]?.type?.startsWith("image/");
  const progressTimers = [
    setTimeout(() => setProgressStep("extract", isImageUpload ? "正在 OCR 并分析图片，请稍候..." : "正在识别页数和生成页面预览，请稍候..."), 450),
    setTimeout(() => setProgressStep("split", isImageUpload ? "正在整理图片里的题目..." : "正在准备页码选择..."), 1400)
  ];
  try {
    const payload = await api("/api/uploads", { method: "POST", body: data });
    state.currentUploadId = payload.upload.id;
    state.reviewUploadId = payload.upload.id;
    state.reviewPage = 1;
    const extractedText = isProbablyGarbledText(payload.upload.extractedText) ? "" : payload.upload.extractedText || "";
    $("#extractText").value = extractedText;
    if (!extractedText) {
      $("#extractText").placeholder = payload.upload.extractionNote || "没有提取到可靠文本，可以复制文本粘贴到这里。";
    }
    state.splitDrafts = payload.suggestions.map((stem) => ({ ...defaultsFromImport(), stem, type: "未分类" }));
    await loadState();
    renderSplitPreview();
    const count = pageCount(payload.upload) || 1;
    if (payload.upload.analysisStatus === "done" && payload.pendingQuestions.length) {
      setProgressStep("split", `完成：图片已分析，生成 ${payload.pendingQuestions.length} 道待审核题。`);
      toast(`图片分析完成，生成 ${payload.pendingQuestions.length} 道待审核题`);
    } else if (payload.deduplicated) {
      setProgressStep("split", `完成：已识别 ${count} 页，请在上传记录里选择页码后点“开始分析”。`);
      toast(`这份资料已存在，已更新页码信息，共 ${count} 页`);
    } else {
      setProgressStep("split", `完成：已识别 ${count} 页，请在上传记录里选择页码后点“开始分析”。`);
      toast(`上传完成，已识别 ${count} 页，请选择页码后开始分析`);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    progressTimers.forEach(clearTimeout);
    setTimeout(() => setUploadBusy(false), 700);
  }
});

$("#ocrBtn").addEventListener("click", async () => {
  if (!state.currentUploadId) return toast("请先选择一张已上传图片");
  try {
    const payload = await api("/api/ai/ocr", { method: "POST", body: { uploadId: state.currentUploadId } });
    $("#extractText").value = payload.text;
    state.splitDrafts = payload.suggestions.map((stem) => ({ ...defaultsFromImport(), stem, type: "未分类" }));
    renderSplitPreview();
    toast("OCR 完成，请校对");
  } catch (error) {
    toast(error.message);
  }
});

$("#splitBtn").addEventListener("click", () => splitImportText().catch((error) => toast(error.message)));
$("#saveSplitBtn").addEventListener("click", () => saveSplitDrafts().catch((error) => toast(error.message)));
$("#analyzeTextBtn").addEventListener("click", () => analyzeCurrentText().catch((error) => toast(error.message)));
$("#approveAllPendingBtn")?.addEventListener("click", () => approveAllPending().catch((error) => toast(error.message)));
$("#approveSafePendingBtn")?.addEventListener("click", () => approveSafePending().catch((error) => toast(error.message)));
$("#bankUploadForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  uploadBankFile().catch((error) => {
    $("#bankImportStatus").textContent = error.message;
    toast(error.message);
  });
});
$("#bankTextForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitBankUploadToReview().catch((error) => toast(error.message));
});
$("#bankSubmitToReviewBtn")?.addEventListener("click", () => submitBankUploadToReview().catch((error) => {
  $("#bankImportStatus").textContent = error.message;
  toast(error.message);
}));
$("#bankFileNextToTagsBtn")?.addEventListener("click", () => {
  if (!$("#bankFileAnswerText")?.value?.trim()) return toast("请先填写答案或解析");
  state.bankUploadStepOverride = 3;
  renderBankWorkspace();
});
$("#bankTextNextToTagsBtn")?.addEventListener("click", () => {
  if (!$("#bankTextAnswerText")?.value?.trim()) return toast("请先填写答案或解析");
  state.bankUploadStepOverride = 3;
  renderBankWorkspace();
});
$("#clearBankFiltersBtn")?.addEventListener("click", () => clearBankFilters());
$("#batchEditQuestionsBtn")?.addEventListener("click", () => batchPatchSelectedQuestions().catch((error) => toast(error.message)));
$("#batchDeleteQuestionsBtn")?.addEventListener("click", () => batchDeleteSelectedQuestions().catch((error) => toast(error.message)));
$("#backfillProfilesBtn")?.addEventListener("click", () => backfillBankProfiles().catch((error) => toast(error.message)));
$("#exportBankBtn")?.addEventListener("click", () => exportBankQuestions());
$("#clearSelectionBtn").addEventListener("click", () => {
  state.selected.clear();
  state.selectedPending.clear();
  state.generatedQuestions = [];
  renderQuestionList();
  renderReviewList();
  renderAssignmentControls();
  renderPaper();
});
$("#useSelectedBtn").addEventListener("click", () => {
  state.view = "assignments";
  renderChrome();
  renderPaper();
});
$("#aiGenerateBtn").addEventListener("click", () => generateAiQuestions().catch((error) => toast(error.message)));
$("#autoPickBtn").addEventListener("click", () => autoPickQuestions());
$("#studentWeakPickBtn").addEventListener("click", () => autoPickQuestions({ fromWeakness: true }));
$("#createAssignmentBtn").addEventListener("click", () => createAssignment().catch((error) => toast(error.message)));
$("#printAssignmentBtn").addEventListener("click", () => exportAssignmentWord().catch((error) => toast(error.message)));
$("#assignmentExportMode").addEventListener("change", () => renderPaper());
$("#exportPdfBtn").addEventListener("click", () => printCurrentAssignment());
$("#quickPrintBtn")?.addEventListener("click", () => printCurrentAssignment());

$("#studentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/students", { method: "POST", body: formObject(event.currentTarget) });
    event.currentTarget.reset();
    await loadState();
    toast("学生已新增");
  } catch (error) {
    toast(error.message);
  }
});

$("#mistakeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/mistakes", { method: "POST", body: formObject(event.currentTarget) });
    event.currentTarget.reset();
    await loadState();
    toast("错题已记录");
  } catch (error) {
    toast(error.message);
  }
});

$("#billingForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/billing", { method: "PATCH", body: formObject(event.currentTarget) });
    await loadState();
    toast("套餐已保存");
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.matches(".pending-editor")) {
    event.preventDefault();
    toast("修改会在入库本题时自动保存");
    return;
  }

  if (!event.target.matches(".question-editor")) return;
  event.preventDefault();
  const item = event.target.closest(".question-item");
  try {
    await api(`/api/questions/${item.dataset.questionId}`, {
      method: "PATCH",
      body: formObject(event.target)
    });
    await loadState();
    toast("题目已保存");
  } catch (error) {
    toast(error.message);
  }
});

boot();
