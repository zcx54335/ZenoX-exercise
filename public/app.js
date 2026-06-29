const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  db: { questions: [], students: [], assignments: [], mistakes: [], uploads: [], activity: [] },
  view: "dashboard",
  selected: new Set(),
  splitDrafts: [],
  currentUploadId: "",
  generatedQuestions: []
};

const titles = {
  dashboard: ["今日工作", "总览"],
  import: ["资料入库", "资料整理"],
  bank: ["分类筛选", "题库"],
  assignments: ["打印与导出", "作业生成"],
  students: ["学生跟踪", "学生错题"],
  settings: ["云端部署", "部署设置"]
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
  submit.textContent = isBusy ? "处理中..." : "上传并分析";
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
}

function renderAll() {
  renderChrome();
  renderDashboard();
  renderUploads();
  renderFilters();
  renderQuestionList();
  renderStudents();
  renderMistakes();
  renderAssignmentControls();
  renderPaper();
}

function renderChrome() {
  const [eyebrow, title] = titles[state.view];
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $$(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === state.view));
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

function renderUploads() {
  $("#uploadList").innerHTML = state.db.uploads.length
    ? state.db.uploads.slice(0, 8).map((upload) => `
      <div class="upload-item">
        <strong>${escapeHtml(upload.filename)}</strong>
        <p class="muted">${escapeHtml(upload.extractionNote || "")}</p>
        <div class="row-actions">
          <span class="tag">${Math.round((upload.size || 0) / 1024)} KB</span>
          ${upload.uploadCount > 1 ? `<span class="tag duplicate">重复上传 ${upload.uploadCount} 次</span>` : ""}
          <button class="ghost" data-load-upload="${upload.id}">载入文本</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">上传 PDF、图片或 Word 后会出现在这里。</p>`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function renderFilters() {
  fillSelect($("#filterSubject"), ["全部科目", ...unique(state.db.questions.map((q) => q.subject))], true);
  fillSelect($("#filterType"), ["全部题型", ...unique(state.db.questions.map((q) => q.type))], true);
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
  const text = [q.stem, q.chapter, q.type, q.subject, ...(q.knowledge || [])].join(" ").toLowerCase();
  return (!search || text.includes(search))
    && (!subject || q.subject === subject)
    && (!stage || q.stage === stage)
    && (!level || q.level === level)
    && (!type || q.type === type);
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
        <p>${escapeHtml(q.stem)}</p>
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
    ? questions.map((q) => `<li>${escapeHtml(q.stem).replace(/\n/g, "<br>")}</li>`).join("")
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
  toast(`AI 已生成 ${payload.questions.length} 道题并加入预览`);
}

async function createAssignment() {
  const student = state.db.students.find((s) => s.id === $("#assignmentStudent").value);
  const questions = selectedQuestions();
  if (!questions.length) return toast("请先选择或生成题目");
  const payload = await api("/api/assignments", {
    method: "POST",
    body: {
      title: $("#assignmentTitle").value,
      studentId: student?.id || "",
      studentName: student?.name || "",
      subject: $("#assignmentSubject").value,
      grade: $("#assignmentGrade").value,
      duration: $("#assignmentDuration").value,
      score: $("#assignmentScore").value,
      questionIds: [...state.selected],
      generatedQuestions: state.generatedQuestions
    }
  });
  await loadState();
  toast(`已保存作业：${payload.assignment.title}`);
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
});

document.addEventListener("change", (event) => {
  if (event.target.matches(".select-question")) {
    const id = event.target.closest(".question-item").dataset.questionId;
    event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    renderAssignmentControls();
    renderPaper();
  }
  if (["assignmentStudent", "assignmentDuration", "assignmentScore"].includes(event.target.id)) renderPaper();
});

document.addEventListener("input", (event) => {
  if (event.target.closest(".filters")) renderQuestionList();
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
  const progressTimers = [
    setTimeout(() => setProgressStep("extract", "正在转换 PDF / 图片内容，请稍候..."), 450),
    setTimeout(() => setProgressStep("split", "正在整理可拆分文本..."), 1400)
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
    setProgressStep("split", extractedText ? `完成：已提取文本，并拆出 ${state.splitDrafts.length} 条候选题目。` : "完成：没有提取到可靠文本，已避免显示乱码。");
    if (payload.deduplicated) {
      toast("这份资料已存在，已更新解析状态");
    } else if (extractedText) {
      toast(`上传完成，拆出 ${state.splitDrafts.length} 条候选题目`);
    } else {
      toast("上传完成，但没有提取到可靠文本");
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
$("#createAssignmentBtn").addEventListener("click", () => createAssignment().catch((error) => toast(error.message)));
$("#printAssignmentBtn").addEventListener("click", () => window.print());
$("#quickPrintBtn").addEventListener("click", () => {
  state.view = "assignments";
  renderChrome();
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

document.addEventListener("submit", async (event) => {
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
