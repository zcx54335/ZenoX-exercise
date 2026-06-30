const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  db: { organizations: [], users: [], questions: [], pendingQuestions: [], students: [], assignments: [], mistakes: [], uploads: [], jobs: [], aiUsage: [], auditLogs: [], activity: [] },
  view: "dashboard",
  selected: new Set(),
  splitDrafts: [],
  currentUploadId: "",
  generatedQuestions: [],
  analysisPollers: new Map(),
  reviewPage: 1,
  reviewPageSize: 1,
  crop: {
    pendingId: "",
    imageUrl: "",
    startX: 0,
    startY: 0,
    rect: null,
    dragging: false
  }
};

const subjects = ["初中数学", "初中物理", "初中化学", "初中英语", "小学数学"];
const stages = ["小学", "初中"];
const levels = ["基础", "提高", "压轴"];
const types = ["选择题", "填空题", "解答题", "判断题", "完形填空", "阅读理解", "作文", "实验题", "计算题", "未分类"];

const titles = {
  dashboard: ["今日工作", "数据看板"],
  import: ["资料入库", "资料解析"],
  bank: ["分类筛选", "题库管理"],
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
    headers: options.body instanceof FormData ? {} : { "content-type": "application/json" },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
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
  renderAll();
  ensureAnalysisPolling();
}

function renderAll() {
  renderChrome();
  renderDashboard();
  renderUploads();
  renderReviewList();
  renderFilters();
  renderBankSummary();
  renderQuestionList();
  renderStudents();
  renderMistakes();
  renderAssignmentControls();
  renderPaper();
  renderSettings();
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

function sourceImageLink(q, label = "查看本题图片") {
  const image = q.questionImage;
  if (!image) return "";
  return `<a class="source-link" href="${escapeHtml(image)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function sourceFigure(q, className = "question-source") {
  if (!q.sourceImage) return "";
  return `
    <a class="${className}" href="${escapeHtml(q.sourceImage)}" target="_blank" rel="noreferrer">
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
    <a class="${className} question-image-figure" href="${escapeHtml(imageUrl)}" target="_blank" rel="noreferrer">
      <strong>本题配图</strong>
      <img src="${escapeHtml(imageUrl)}" alt="本题图片" />
      <span>点击放大</span>
    </a>
  `;
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

function renderChrome() {
  const [eyebrow, title] = titles[state.view];
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $$(".nav button, .route-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === state.view));
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
  $("#metricQuestions").textContent = state.db.questions.length;
  $("#metricStudents").textContent = state.db.students.length;
  $("#metricAssignments").textContent = state.db.assignments.length;
  $("#metricMistakes").textContent = state.db.mistakes.length;
  $("#activityList").innerHTML = state.db.activity.length
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
  const list = state.db.pendingQuestions || [];
  const count = $("#reviewCount");
  if (count) count.textContent = `待审核 ${list.length} 题`;
  const box = $("#reviewList");
  if (!box) return;
  const blocked = list.filter((q) => q.qualityErrors?.length).length;
  const warnings = list.filter((q) => !q.qualityErrors?.length && q.qualityWarnings?.length).length;
  const ok = Math.max(0, list.length - blocked - warnings);
  const totalPages = Math.max(1, Math.ceil(list.length / state.reviewPageSize));
  if (state.reviewPage < 1) state.reviewPage = 1;
  if (state.reviewPage > totalPages) state.reviewPage = totalPages;
  const start = (state.reviewPage - 1) * state.reviewPageSize;
  const pageItems = list.slice(start, start + state.reviewPageSize);
  box.innerHTML = list.length
    ? `
      <div class="review-summary">
        <article><strong>${ok}</strong><span>可入库</span></article>
        <article class="${warnings ? "warn" : ""}"><strong>${warnings}</strong><span>需核对</span></article>
        <article class="${blocked ? "danger" : ""}"><strong>${blocked}</strong><span>已拦截</span></article>
      </div>
      <div class="review-pager">
        <div>
          <strong>第 ${state.reviewPage} / ${totalPages} 题</strong>
          <span class="muted">逐题审核，共 ${list.length} 题</span>
        </div>
        <div class="row-actions">
          <button class="ghost" data-review-page="prev" ${state.reviewPage <= 1 ? "disabled" : ""}>上一页</button>
          <button class="ghost" data-review-page="next" ${state.reviewPage >= totalPages ? "disabled" : ""}>下一页</button>
        </div>
      </div>
      <div class="review-workbench">
        <aside class="review-index">
          ${list.map((q, index) => {
            const status = q.qualityErrors?.length ? "danger" : q.qualityWarnings?.length ? "warn" : "ok";
            return `
              <button class="${index + 1 === state.reviewPage ? "active" : ""} ${status}" data-review-jump="${index + 1}">
                <strong>${index + 1}</strong>
                <span>${escapeHtml((q.stem || "未命名题目").slice(0, 34))}</span>
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
}

function pendingCard(q) {
  const variants = Array.isArray(q.variants) ? q.variants : [];
  const visibleVariants = variants.filter((item) => item?.stem || item?.answer || item?.explanation);
  const bodyText = `${q.stem}\n${(q.options || []).join("\n")}`;
  const displayImage = q.questionImage;
  const needsBoundImage = /(如图|下图|图中|图形|图示|阴影|表格|几何|圆形花坛|统计图|条形图|折线图|扇形图|图形说明|图表|坐标图|频数\/个|频率图|示意图|\\frac|\\dfrac|\$|sqrt|\\sqrt|_|\^)/.test(bodyText);
  const qualityErrors = Array.isArray(q.qualityErrors) ? q.qualityErrors : [];
  const qualityWarnings = Array.isArray(q.qualityWarnings) ? q.qualityWarnings : [];
  return `
    <article class="review-item ${qualityErrors.length ? "has-quality-errors" : qualityWarnings.length ? "has-quality-warnings" : ""}" data-pending-id="${q.id}">
      <form class="pending-editor">
        <div class="review-topline">
          <div class="tag-row">
            <span class="tag">${escapeHtml(q.sourceFilename || "粘贴文本")}</span>
            ${q.sourcePage ? `<span class="tag">第 ${escapeHtml(q.sourcePage)} 页</span>` : ""}
            <span class="tag">${escapeHtml(q.type || "待分类")}</span>
            ${qualityErrors.length ? `<span class="tag quality-error-tag">质检未通过</span>` : ""}
            ${qualityWarnings.length && !qualityErrors.length ? `<span class="tag quality-warning-tag">需核对</span>` : ""}
          </div>
          <div class="row-actions">
            ${sourceImageLink(q)}
            <button class="ghost enrich-pending" type="button">AI 补全</button>
            <button class="primary" type="submit">更新</button>
            <button class="primary approve-pending" type="button">${qualityErrors.length ? "修好后入库" : "入库本题"}</button>
            ${qualityErrors.length ? `<button class="ghost force-approve-pending" type="button">强制入库</button>` : ""}
            <button class="ghost skip-pending" type="button">跳过</button>
          </div>
        </div>
        ${qualityPanel(q)}
        <div class="review-main">
          ${displayImage && !needsBoundImage ? `
            <div class="review-source-row">
              <a class="source-shot source-shot-wide" href="${escapeHtml(displayImage)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(displayImage)}" alt="本题图片" /><span>本题图片，点击查看大图</span></a>
            </div>
          ` : ""}
          <div class="review-fields">
            <label class="full">题干<textarea name="stem">${escapeHtml(q.stem)}</textarea></label>
            ${needsBoundImage ? `
              <div class="bound-source full">
                <div>
                  <strong>本题图片</strong>
                  <span>请把这道题真正用到的小图绑定到这里；右侧原页只用于截图参考，不会入库。</span>
                </div>
                <div class="question-image-workspace">
                  <div class="manual-image-panel">
                    ${displayImage ? `
                      <a class="source-shot source-shot-bound" href="${escapeHtml(displayImage)}" target="_blank" rel="noreferrer">
                        <img src="${escapeHtml(displayImage)}" alt="本题图片" />
                        <span>已绑定本题图片，点击放大</span>
                      </a>
                    ` : `<div class="image-empty">暂无本题图片</div>`}
                    <div class="paste-question-image" tabindex="0" role="button" aria-label="粘贴或拖拽本题图片">
                      <strong>粘贴截图到这里</strong>
                      <span>截图后点这里按 Cmd+V，也可以拖拽图片进来。</span>
                    </div>
                    <div class="row-actions">
                      <button class="ghost upload-question-image" type="button">${displayImage ? "替换本题图片" : "上传本题图片"}</button>
                      ${q.sourceImage ? `<button class="ghost crop-question-image" type="button" data-source-image="${escapeHtml(q.sourceImage)}">框选原页配图</button>` : ""}
                      <input class="manual-question-image hidden" type="file" accept="image/*" />
                    </div>
                  </div>
                  ${q.sourceImage ? `
                    <div class="source-reference-panel">
                      <div>
                        <strong>原页参考图</strong>
                        <span>从这里截取题目里的小图，再粘贴到左侧。</span>
                      </div>
                      <a class="source-shot source-reference-shot" href="${escapeHtml(q.sourceImage)}" target="_blank" rel="noreferrer">
                        <img src="${escapeHtml(q.sourceImage)}" alt="原页参考图" />
                        <span>第 ${escapeHtml(q.sourcePage || "")} 页参考图，点击放大截图</span>
                      </a>
                    </div>
                  ` : ""}
                </div>
              </div>
            ` : ""}
            <label class="full">选项<textarea name="options">${escapeHtml((q.options || []).join("\n"))}</textarea></label>
            <details class="review-details full">
              <summary>答案、解析与分类</summary>
              <div class="review-detail-grid">
                <label>科目<select name="subject">${optionTags(subjects, q.subject)}</select></label>
                <label>学段<select name="stage">${optionTags(stages, q.stage)}</select></label>
                <label>难度<select name="level">${optionTags(levels, q.level)}</select></label>
                <label>年级<input name="grade" value="${escapeHtml(q.grade || "")}" /></label>
                <label>章节<input name="chapter" value="${escapeHtml(q.chapter || "")}" /></label>
                <label>题型<select name="type">${optionTags(types, q.type)}</select></label>
                <label class="full">知识点<input name="knowledge" value="${escapeHtml((q.knowledge || []).join("，"))}" /></label>
                <label class="full">答案<textarea name="answer">${escapeHtml(q.answer || "")}</textarea></label>
                <label class="full">解析<textarea name="explanation">${escapeHtml(q.explanation || "")}</textarea></label>
              </div>
            </details>
          </div>
        </div>
        ${visibleVariants.length ? `<details class="variant-list full">
          <summary>变式题（点击 AI 补全后可编辑）</summary>
          <div class="variant-grid">
            ${visibleVariants.slice(0, 3).map((v, index) => {
              return `
                <div class="variant-card" data-variant-index="${index}">
                  <strong>变式 ${index + 1}${v.source ? ` · ${escapeHtml(v.source)}` : ""}</strong>
                  <label>题干<textarea name="variantStem">${escapeHtml(v.stem || "")}</textarea></label>
                  <label>选项<textarea name="variantOptions">${escapeHtml((v.options || []).join("\n"))}</textarea></label>
                  <label>答案<textarea name="variantAnswer">${escapeHtml(v.answer || "")}</textarea></label>
                  <label>解析<textarea name="variantExplanation">${escapeHtml(v.explanation || "")}</textarea></label>
                </div>
              `;
            }).join("")}
          </div>
        </details>` : ""}
      </form>
    </article>
  `;
}

function renderUploads() {
  $("#uploadList").innerHTML = state.db.uploads.length
    ? state.db.uploads.slice(0, 8).map((upload) => `
      <div class="upload-item">
        <strong>${escapeHtml(upload.filename)}</strong>
        <p class="muted">${escapeHtml(upload.analysisError || upload.extractionNote || "")}</p>
        ${upload.analysisStatus === "processing" ? analysisProgressMarkup(upload) : ""}
        ${uploadPageStatusMarkup(upload)}
        <div class="upload-meta-row">
          <span class="tag">${Math.round((upload.size || 0) / 1024)} KB</span>
          <span class="tag">${pageCount(upload) || 1} 页</span>
          ${upload.uploadCount > 1 ? `<span class="tag duplicate">重复上传 ${upload.uploadCount} 次</span>` : ""}
        </div>
        <div class="upload-analyze-row">
          ${pageRangeControls(upload)}
          <button class="primary" data-analyze-upload="${upload.id}">${upload.analysisStatus === "done" ? "重新分析" : "开始分析"}</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">上传 PDF、图片或 Word 后会出现在这里。</p>`;
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
                ${page.image ? `<a class="source-link" href="${escapeHtml(page.image)}" target="_blank" rel="noreferrer">预览</a>` : ""}
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
  fillSelect($("#filterStudent"), ["全部学生", ...unique(state.db.students.map((s) => s.name))], true);
  fillSelect($("#filterMistakeReason"), ["全部错因", ...unique(state.db.mistakes.map((m) => m.reason))], true);
  fillSelect($("#filterSourceFile"), ["全部来源", ...unique(state.db.questions.map((q) => q.sourceFilename))], true);
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
      <article><strong>${numberText(state.selected.size)}</strong><span>已选题目</span></article>
      <article><strong>${numberText(knowledgeCounts.size)}</strong><span>知识点</span></article>
    `;
  }
  const chips = $("#knowledgeChips");
  if (chips) {
    chips.innerHTML = topTags.length
      ? [`<button class="${$("#filterKnowledge").value ? "" : "active"}" data-knowledge-chip="">全部知识点</button>`]
        .concat(topTags.map(([tag, count]) => `<button class="${$("#filterKnowledge").value === tag ? "active" : ""}" data-knowledge-chip="${escapeHtml(tag)}">${escapeHtml(tag)} <span>${count}</span></button>`))
        .join("")
      : "";
  }
}

function fillSelect(select, values, firstIsEmpty = false) {
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
  const student = $("#filterStudent").value;
  const mistakeReason = $("#filterMistakeReason").value;
  const sourceFile = $("#filterSourceFile").value;
  const sourcePage = $("#filterSourcePage").value.trim();
  const hasImage = $("#filterHasImage").value;
  const used = $("#filterUsed").value;
  const mistakes = (state.db.mistakes || []).filter((m) => m.questionId === q.id);
  const mistakeStudents = mistakes
    .map((m) => state.db.students.find((s) => s.id === m.studentId)?.name || "")
    .filter(Boolean);
  const assignmentIds = new Set((state.db.assignments || []).flatMap((a) => a.questionIds || []));
  const questionHasImage = Boolean(q.questionImage || q.questionImageStoredName);
  const text = [q.stem, q.chapter, q.type, q.subject, q.sourceFilename, q.sourcePage, ...(q.knowledge || [])].join(" ").toLowerCase();
  return (!search || text.includes(search))
    && (!subject || q.subject === subject)
    && (!stage || q.stage === stage)
    && (!level || q.level === level)
    && (!type || q.type === type)
    && (!knowledge || (q.knowledge || []).includes(knowledge))
    && (!student || mistakeStudents.includes(student))
    && (!mistakeReason || mistakes.some((m) => m.reason === mistakeReason))
    && (!sourceFile || q.sourceFilename === sourceFile)
    && (!sourcePage || String(q.sourcePage || "") === sourcePage)
    && (!hasImage || (hasImage === "yes" ? questionHasImage : !questionHasImage))
    && (!used || (used === "yes" ? assignmentIds.has(q.id) : !assignmentIds.has(q.id)));
}

function renderQuestionList() {
  const list = state.db.questions.filter(questionMatches);
  $("#questionList").innerHTML = list.length
    ? list.map((q) => questionCard(q)).join("")
    : `<p class="muted">没有匹配题目。可以先去“资料整理”上传并拆题。</p>`;
  $("#selectedCount").textContent = `已选 ${state.selected.size} 题`;
}

function questionCard(q) {
  const checked = state.selected.has(q.id) ? "checked" : "";
  const dup = q.duplicateOf ? `<span class="tag duplicate">疑似重复</span>` : "";
  return `
    <article class="question-item" data-question-id="${q.id}">
      <input type="checkbox" class="select-question" ${checked} aria-label="选择题目" />
      <div class="question-main">
        <p>${escapeHtml(formatQuestionBody(q)).replace(/\n/g, "<br>")}</p>
        ${questionImageFigure(q, "question-source")}
        <div class="tag-row">
          <span class="tag">${escapeHtml(q.subject || "未分类")}</span>
          <span class="tag">${escapeHtml(q.stage || "")}</span>
          <span class="tag">${escapeHtml(q.level || "")}</span>
          <span class="tag">${escapeHtml(q.type || "")}</span>
          ${(q.knowledge || []).map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join("")}
          ${dup}
        </div>
      </div>
      <div class="row-actions">
        <button class="ghost edit-question">编辑</button>
        <button class="ghost ai-classify">AI 分类</button>
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
          ${q.duplicateOf ? `<span class="tag duplicate">疑似重复</span>` : ""}
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
  $("#selectedCount").textContent = `已选 ${state.selected.size} 题`;
  if (!$("#assignmentTitle").value) $("#assignmentTitle").value = `课后练习 ${new Date().toLocaleDateString("zh-CN")}`;
}

function selectedQuestions() {
  const picked = state.db.questions.filter((q) => state.selected.has(q.id));
  return picked.concat(state.generatedQuestions);
}

function renderPaper() {
  const student = state.db.students.find((s) => s.id === $("#assignmentStudent").value);
  $("#paperTitle").textContent = $("#assignmentTitle").value || "未命名作业";
  $("#paperStudent").textContent = student?.name || "________";
  $("#paperDate").textContent = new Date().toLocaleDateString("zh-CN");
  $("#paperDuration").textContent = $("#assignmentDuration").value || "40 分钟";
  $("#paperScore").textContent = $("#assignmentScore").value || "100";
  const questions = selectedQuestions();
  $("#paperQuestions").innerHTML = questions.length
    ? questions.map((q) => `<li>${escapeHtml(formatQuestionBody(q)).replace(/\n/g, "<br>")}${questionImageFigure(q, "paper-source")}</li>`).join("")
    : `<li>请从题库选择题目，或使用 AI 生成同类题。</li>`;
  $("#paperAnswers").innerHTML = questions.length
    ? questions.map((q) => `
      <li>
        <strong>答案：</strong>${escapeHtml(q.answer || "待补充")}<br>
        <strong>解析：</strong>${escapeHtml(q.explanation || "待补充").replace(/\n/g, "<br>")}
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
    questionIds: [...state.selected],
    generatedQuestions: state.generatedQuestions
  };
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
  renderPaper();
  toast(`已加入 ${payload.questions.length} 道题：题库复用 ${payload.reused || 0} 道，AI 生成 ${payload.generated ?? payload.questions.length} 道`);
}

function collectPendingPayload(form) {
  const base = formObject(form);
  const variants = $$(".variant-card", form).map((card) => ({
    stem: $("[name='variantStem']", card).value,
    options: $("[name='variantOptions']", card).value,
    answer: $("[name='variantAnswer']", card).value,
    explanation: $("[name='variantExplanation']", card).value,
    subject: base.subject,
    stage: base.stage,
    grade: base.grade,
    chapter: base.chapter,
    knowledge: base.knowledge,
    level: base.level,
    type: base.type
  })).filter((item) => item.stem.trim());
  return { ...base, variants };
}

async function uploadQuestionImage(reviewItem, file) {
  if (!reviewItem || !file) return;
  if (!file.type?.startsWith("image/")) return toast("请上传图片文件");
  const data = new FormData();
  data.append("file", file);
  await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/image`, {
    method: "POST",
    body: data
  });
  await loadState();
  toast("本题图片已绑定");
}

function openCropModal(reviewItem, imageUrl) {
  if (!reviewItem || !imageUrl) return toast("没有可框选的原页截图");
  state.crop = {
    pendingId: reviewItem.dataset.pendingId,
    imageUrl,
    startX: 0,
    startY: 0,
    rect: null,
    dragging: false
  };
  const modal = $("#cropModal");
  const image = $("#cropImage");
  const selection = $("#cropSelection");
  image.src = imageUrl;
  selection.classList.add("hidden");
  selection.removeAttribute("style");
  modal.classList.remove("hidden");
}

function closeCropModal() {
  $("#cropModal").classList.add("hidden");
  $("#cropImage").removeAttribute("src");
  $("#cropSelection").classList.add("hidden");
  state.crop = { pendingId: "", imageUrl: "", startX: 0, startY: 0, rect: null, dragging: false };
}

function cropPoint(event) {
  const stage = $("#cropStage");
  const rect = stage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(stage.scrollWidth, event.clientX - rect.left + stage.scrollLeft)),
    y: Math.max(0, Math.min(stage.scrollHeight, event.clientY - rect.top + stage.scrollTop))
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

async function saveCropSelection() {
  const crop = state.crop;
  if (!crop.pendingId || !crop.rect || crop.rect.width < 12 || crop.rect.height < 12) {
    return toast("请先框选一个更大的区域");
  }
  const image = $("#cropImage");
  if (!image.complete || !image.naturalWidth) return toast("原图还没有加载完成");
  const display = image.getBoundingClientRect();
  const stage = $("#cropStage").getBoundingClientRect();
  const stageEl = $("#cropStage");
  const imageOffsetX = display.left - stage.left + stageEl.scrollLeft;
  const imageOffsetY = display.top - stage.top + stageEl.scrollTop;
  const sx = Math.max(0, (crop.rect.x - imageOffsetX) * image.naturalWidth / display.width);
  const sy = Math.max(0, (crop.rect.y - imageOffsetY) * image.naturalHeight / display.height);
  const sw = Math.min(image.naturalWidth - sx, crop.rect.width * image.naturalWidth / display.width);
  const sh = Math.min(image.naturalHeight - sy, crop.rect.height * image.naturalHeight / display.height);
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
  await uploadQuestionImage(reviewItem, file);
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
  await loadState();
  toast(`已生成 ${payload.pendingQuestions.length} 道待审核题，跳过 ${payload.skippedDuplicates || 0} 道重复题`);
}

async function approveAllPending() {
  const ids = (state.db.pendingQuestions || []).map((q) => q.id);
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
  const nav = event.target.closest("[data-view]");
  if (nav) {
    state.view = nav.dataset.view;
    renderChrome();
    renderPaper();
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
      renderUploads();
      startAnalysisPolling(payload.upload.id);
    } catch (error) {
      toast(error.message);
    }
  }

  const reviewPage = event.target.closest("[data-review-page]");
  if (reviewPage) {
    const totalPages = Math.max(1, Math.ceil((state.db.pendingQuestions || []).length / state.reviewPageSize));
    if (reviewPage.dataset.reviewPage === "prev") state.reviewPage = Math.max(1, state.reviewPage - 1);
    if (reviewPage.dataset.reviewPage === "next") state.reviewPage = Math.min(totalPages, state.reviewPage + 1);
    renderReviewList();
  }

  const reviewJump = event.target.closest("[data-review-jump]");
  if (reviewJump) {
    state.reviewPage = Number(reviewJump.dataset.reviewJump) || 1;
    renderReviewList();
  }

  const knowledgeChip = event.target.closest("[data-knowledge-chip]");
  if (knowledgeChip) {
    $("#filterKnowledge").value = knowledgeChip.dataset.knowledgeChip || "";
    renderBankSummary();
    renderQuestionList();
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
  if (reviewItem && event.target.matches(".upload-question-image")) {
    reviewItem.querySelector(".manual-question-image")?.click();
  }

  if (reviewItem && event.target.matches(".crop-question-image")) {
    openCropModal(reviewItem, event.target.dataset.sourceImage);
  }

  if (reviewItem && event.target.matches(".skip-pending")) {
    const previousCount = (state.db.pendingQuestions || []).length;
    await api(`/api/pending-questions/${reviewItem.dataset.pendingId}`, { method: "DELETE" });
    clampReviewPageAfterRemoval(previousCount);
    await loadState();
    toast("已跳过这道题");
  }

  if (reviewItem && event.target.matches(".approve-pending")) {
    const form = reviewItem.querySelector(".pending-editor");
    try {
      await api(`/api/pending-questions/${reviewItem.dataset.pendingId}`, {
        method: "PATCH",
        body: collectPendingPayload(form)
      });
      const payload = await api("/api/pending-questions/approve", {
        method: "POST",
        body: { ids: [reviewItem.dataset.pendingId], includeVariants: true }
      });
      clampReviewPageAfterRemoval((state.db.pendingQuestions || []).length);
      await loadState();
      toast(`已入库 ${payload.questions.length} 道题`);
    } catch (error) {
      await loadState();
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".force-approve-pending")) {
    const form = reviewItem.querySelector(".pending-editor");
    try {
      await api(`/api/pending-questions/${reviewItem.dataset.pendingId}`, {
        method: "PATCH",
        body: collectPendingPayload(form)
      });
      const payload = await api("/api/pending-questions/approve", {
        method: "POST",
        body: { ids: [reviewItem.dataset.pendingId], includeVariants: true, force: true }
      });
      clampReviewPageAfterRemoval((state.db.pendingQuestions || []).length);
      await loadState();
      toast(`已强制入库 ${payload.questions.length} 道题，请后续复核`);
    } catch (error) {
      await loadState();
      toast(error.message);
    }
  }

  if (reviewItem && event.target.matches(".enrich-pending")) {
    const button = event.target;
    button.disabled = true;
    button.textContent = "补全中...";
    try {
      await api(`/api/pending-questions/${reviewItem.dataset.pendingId}/enrich`, { method: "POST" });
      await loadState();
      toast("AI 已补全这道题");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "AI 补全";
    }
  }
});

$("#closeCropBtn").addEventListener("click", closeCropModal);
$("#resetCropBtn").addEventListener("click", () => {
  state.crop.rect = null;
  $("#cropSelection").classList.add("hidden");
});
$("#saveCropBtn").addEventListener("click", () => saveCropSelection().catch((error) => toast(error.message)));
$("#cropStage").addEventListener("pointerdown", (event) => {
  if ($("#cropModal").classList.contains("hidden")) return;
  const point = cropPoint(event);
  state.crop.dragging = true;
  state.crop.startX = point.x;
  state.crop.startY = point.y;
  state.crop.rect = { x: point.x, y: point.y, width: 0, height: 0 };
  drawCropSelection(state.crop.rect);
});
$("#cropStage").addEventListener("pointermove", (event) => {
  if (!state.crop.dragging) return;
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

document.addEventListener("change", (event) => {
  if (event.target.closest(".filters")) {
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
  const pasteTarget = event.target.closest?.(".paste-question-image");
  if (!pasteTarget) return;
  const reviewItem = pasteTarget.closest(".review-item");
  const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (!file) return toast("剪贴板里没有图片");
  event.preventDefault();
  uploadQuestionImage(reviewItem, file).catch((error) => toast(error.message));
});

document.addEventListener("dragover", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image");
  if (!dropTarget) return;
  event.preventDefault();
  dropTarget.classList.add("dragging");
});

document.addEventListener("dragleave", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image");
  if (dropTarget) dropTarget.classList.remove("dragging");
});

document.addEventListener("drop", (event) => {
  const dropTarget = event.target.closest?.(".paste-question-image");
  if (!dropTarget) return;
  event.preventDefault();
  dropTarget.classList.remove("dragging");
  const file = Array.from(event.dataTransfer?.files || []).find((entry) => entry.type.startsWith("image/"));
  if (!file) return toast("请拖入图片文件");
  uploadQuestionImage(dropTarget.closest(".review-item"), file).catch((error) => toast(error.message));
});

document.addEventListener("input", (event) => {
  if (event.target.closest(".filters")) {
    renderBankSummary();
    renderQuestionList();
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

$("#refreshBtn").addEventListener("click", async () => {
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
$("#approveAllPendingBtn").addEventListener("click", () => approveAllPending().catch((error) => toast(error.message)));
$("#clearSelectionBtn").addEventListener("click", () => {
  state.selected.clear();
  renderQuestionList();
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
$("#exportPdfBtn").addEventListener("click", () => {
  if (!selectedQuestions().length) return toast("请先选择或生成题目");
  state.view = "assignments";
  renderChrome();
  renderPaper();
  setTimeout(() => window.print(), 50);
});
$("#quickPrintBtn").addEventListener("click", () => {
  if (!selectedQuestions().length) return toast("请先选择或生成题目");
  state.view = "assignments";
  renderChrome();
  renderPaper();
  setTimeout(() => window.print(), 50);
});

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
    const item = event.target.closest(".review-item");
    try {
      await api(`/api/pending-questions/${item.dataset.pendingId}`, {
        method: "PATCH",
        body: collectPendingPayload(event.target)
      });
      await loadState();
      toast("待审核题已更新");
    } catch (error) {
      toast(error.message);
    }
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
