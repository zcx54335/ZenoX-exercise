export function createAnalysisDiagnostics(upload = {}, options = {}) {
  const now = new Date().toISOString();
  return {
    version: 1,
    uploadId: upload.id || "",
    filename: upload.filename || "",
    provider: options.provider || "qwen",
    promptVersion: options.promptVersion || "analysis-v2",
    pageRange: options.pageRange || "",
    startedAt: now,
    finishedAt: "",
    status: "processing",
    summary: {
      totalPages: Number(options.totalPages || 0),
      selectedPages: 0,
      skippedPages: 0,
      ocrPages: 0,
      localCandidateCount: 0,
      aiCandidateCount: 0,
      acceptedCount: 0,
      duplicateSkippedCount: 0,
      failedPages: 0
    },
    pages: [],
    events: []
  };
}

export function addDiagnosticEvent(diagnostics, type, message, detail = {}) {
  if (!diagnostics) return diagnostics;
  diagnostics.events = Array.isArray(diagnostics.events) ? diagnostics.events : [];
  diagnostics.events.push({
    at: new Date().toISOString(),
    type,
    message,
    detail
  });
  diagnostics.events = diagnostics.events.slice(-80);
  return diagnostics;
}

export function upsertPageDiagnostic(diagnostics, pageNumber, patch = {}) {
  if (!diagnostics) return diagnostics;
  diagnostics.pages = Array.isArray(diagnostics.pages) ? diagnostics.pages : [];
  const page = Number(pageNumber) || 1;
  let item = diagnostics.pages.find((entry) => Number(entry.page) === page);
  if (!item) {
    item = {
      page,
      status: "pending",
      source: "text",
      textReliable: false,
      usedOcr: false,
      ocrProvider: "",
      ocrMs: 0,
      textLength: 0,
      localCandidates: 0,
      aiCandidates: 0,
      acceptedCandidates: 0,
      skippedReason: "",
      error: ""
    };
    diagnostics.pages.push(item);
  }
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  diagnostics.pages.sort((a, b) => Number(a.page || 0) - Number(b.page || 0));
  return diagnostics;
}

export function finalizeAnalysisDiagnostics(diagnostics, patch = {}) {
  if (!diagnostics) return diagnostics;
  const pages = Array.isArray(diagnostics.pages) ? diagnostics.pages : [];
  const summary = {
    ...diagnostics.summary,
    selectedPages: pages.filter((page) => !page.skippedReason).length,
    skippedPages: pages.filter((page) => page.skippedReason).length,
    ocrPages: pages.filter((page) => page.usedOcr).length,
    failedPages: pages.filter((page) => page.error).length,
    ...patch.summary
  };
  return {
    ...diagnostics,
    ...patch,
    summary,
    status: patch.status || diagnostics.status || "succeeded",
    finishedAt: patch.finishedAt || new Date().toISOString()
  };
}

export function compactAnalysisDiagnostics(diagnostics = {}) {
  return {
    ...diagnostics,
    events: Array.isArray(diagnostics.events) ? diagnostics.events.slice(-40) : [],
    pages: Array.isArray(diagnostics.pages) ? diagnostics.pages.slice(0, 200) : []
  };
}
