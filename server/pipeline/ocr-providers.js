import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

let sharpPromise = null;

async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((module) => module.default || module).catch(() => null);
  }
  return sharpPromise;
}

function nowMs() {
  return Date.now();
}

function dataUrl(mimeType, bytes) {
  return `data:${mimeType || "image/png"};base64,${bytes.toString("base64")}`;
}

export function createOcrProvider(options = {}) {
  const provider = String(options.provider || "qwen").toLowerCase();
  if (provider === "mathpix") {
    return createPlaceholderProvider({
      name: "mathpix",
      reason: "Mathpix provider 已预留，当前尚未配置实现；请先使用 qwen。"
    });
  }
  return createQwenProvider(options);
}

function createPlaceholderProvider({ name, reason }) {
  return {
    name,
    async preprocessImage(imagePath) {
      return {
        imagePath,
        mimeType: "image/png",
        preprocessing: { enabled: false, provider: name, warning: reason }
      };
    },
    async recognizeImage() {
      throw new Error(reason);
    },
    async recognizeSpread() {
      return null;
    },
    async recognizeBatch() {
      throw new Error(reason);
    },
    async recognizeLayout() {
      return null;
    }
  };
}

function createQwenProvider(options = {}) {
  const {
    callQwen,
    normalizeText = (value) => String(value || "").trim(),
    readImageSize = async () => ({ width: 0, height: 0 }),
    isLikelyTwoPageSpread = () => false,
    tmpDir = ".",
    preprocess = true
  } = options;

  async function preprocessImage(imagePath, mimeType = "image/png") {
    const sharp = await loadSharp();
    const originalSize = await readImageSize(imagePath).catch(() => ({ width: 0, height: 0 }));
    if (!preprocess || !sharp) {
      return {
        imagePath,
        mimeType,
        preprocessing: {
          enabled: false,
          sharpAvailable: Boolean(sharp),
          originalSize
        }
      };
    }
    await fs.mkdir(tmpDir, { recursive: true });
    const outputPath = path.join(tmpDir, `ocr-${randomUUID()}.png`);
    const started = nowMs();
    try {
      const image = sharp(imagePath, { failOn: "none" }).rotate();
      const metadata = await image.metadata().catch(() => ({}));
      await image
        .grayscale()
        .normalize()
        .sharpen()
        .png({ compressionLevel: 6 })
        .toFile(outputPath);
      const processedSize = await readImageSize(outputPath).catch(() => ({ width: metadata.width || 0, height: metadata.height || 0 }));
      return {
        imagePath: outputPath,
        mimeType: "image/png",
        cleanupPath: outputPath,
        preprocessing: {
          enabled: true,
          sharpAvailable: true,
          durationMs: nowMs() - started,
          originalSize,
          processedSize,
          operations: ["autoRotate", "grayscale", "normalize", "sharpen"]
        }
      };
    } catch (error) {
      return {
        imagePath,
        mimeType,
        preprocessing: {
          enabled: false,
          sharpAvailable: true,
          originalSize,
          error: error.message || "图片预处理失败"
        }
      };
    }
  }

  async function recognizeImage(imagePath, mimeType, context = {}) {
    const prepared = await preprocessImage(imagePath, mimeType);
    const started = nowMs();
    try {
      const bytes = await fs.readFile(prepared.imagePath);
      const text = await callQwen([{
        role: "user",
        content: [
          { type: "text", text: "请识别图片中的练习题，保留题号、公式、选项、表格和图形说明。只输出可复制文本，不要解释。数学指数写成 a^2、10^-6，分式写成 (a+b)/(c+d)，根号写成 sqrt(x)；如果题目含图，请补一句“图形说明：...”描述关键关系。" },
          { type: "image_url", image_url: { url: dataUrl(prepared.mimeType, bytes) } }
        ]
      }], { vision: true, temperature: 0.1, ...context, purpose: context.purpose || "ocr_image", pages: context.pages || 1 });
      return {
        provider: "qwen",
        text: normalizeText(text),
        durationMs: nowMs() - started,
        preprocessing: prepared.preprocessing
      };
    } finally {
      if (prepared.cleanupPath) fs.rm(prepared.cleanupPath, { force: true }).catch(() => {});
    }
  }

  async function recognizeSpread(imagePath, mimeType, context = {}) {
    const size = await readImageSize(imagePath).catch(() => ({ width: 0, height: 0 }));
    if (!isLikelyTwoPageSpread(size)) return null;
    const bytes = await fs.readFile(imagePath);
    const url = dataUrl(mimeType || "image/png", bytes);
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
    const started = nowMs();
    const parts = [];
    const regionResults = [];
    for (const region of regions) {
      const text = await callQwen([{
        role: "user",
        content: [
          {
            type: "text",
            text: `${region.instruction}

这是一张横向扫描页，可能同时包含左右两页或左右两栏。请逐行识别 ${region.label}。只输出可复制文本，不要解释。数学指数写成 a^2，分式写成 (a+b)/(c+d)，根号写成 sqrt(x)。如果有统计图、几何图或表格，请用“图形说明：...”补充关键关系。`
          },
          { type: "image_url", image_url: { url } }
        ]
      }], { vision: true, temperature: 0.1, ...context, purpose: `${context.purpose || "ocr_spread"}_${region.label}`, pages: 1 });
      const cleaned = normalizeText(text);
      regionResults.push({ label: region.label, textLength: cleaned.length });
      if (cleaned && !/^无|没有|未识别/i.test(cleaned)) parts.push(`【${region.label}】\n${cleaned}`);
    }
    return {
      provider: "qwen",
      text: normalizeText(parts.join("\n\n")),
      durationMs: nowMs() - started,
      spread: true,
      size,
      regions: regionResults
    };
  }

  async function recognizeBatch(items, context = {}) {
    const content = [{
      type: "text",
      text: `请按图片顺序识别每一页练习题。只输出 JSON 数组，不要 Markdown。格式：[{"page":页码,"text":"识别文本"}]。保留题号、公式、选项、表格和图形说明。遇到左右两页合在一张图、左右分栏或右侧有题时，必须先读左半区再读右半区，不能漏掉右边的题。数学指数写成 a^2、10^-6，分式写成 (a+b)/(c+d)，根号写成 sqrt(x)。如果题目含图，请在题干中补一句“图形说明：...”描述关键关系。`
    }];
    for (const item of items) {
      const prepared = await preprocessImage(item.imagePath, item.mimeType);
      const bytes = await fs.readFile(prepared.imagePath);
      if (prepared.cleanupPath) fs.rm(prepared.cleanupPath, { force: true }).catch(() => {});
      content.push({ type: "text", text: `第 ${item.page} 页：` });
      content.push({ type: "image_url", image_url: { url: dataUrl(prepared.mimeType, bytes) } });
    }
    const started = nowMs();
    const raw = await callQwen([{ role: "user", content }], { vision: true, temperature: 0.1, ...context, purpose: context.purpose || "ocr_batch", pages: context.pages || items.length });
    return {
      provider: "qwen",
      raw,
      durationMs: nowMs() - started
    };
  }

  async function recognizeLayout(imagePath, mimeType, context = {}) {
    const size = await readImageSize(imagePath).catch(() => ({ width: 0, height: 0 }));
    const bytes = await fs.readFile(imagePath);
    const started = nowMs();
    const raw = await callQwen([{
      role: "user",
      content: [
        {
          type: "text",
          text: `你是试卷版面分析助手。请识别这张页面上的完整题目区域，并输出严格 JSON，不要 Markdown，不要解释。

页面信息：
- page: ${context.page || 1}
- imageWidth: ${size.width || "unknown"}
- imageHeight: ${size.height || "unknown"}

输出格式：
{
  "page": ${context.page || 1},
  "imageWidth": ${size.width || 0},
  "imageHeight": ${size.height || 0},
  "questionRegions": [
    {
      "index": 0,
      "questionNumber": "1",
      "textHint": "题干前 20 个字",
      "bbox": {"x":0到1,"y":0到1,"width":0到1,"height":0到1},
      "confidence": 0到1
    }
  ],
  "diagramRegions": [
    {
      "index": 0,
      "belongsToQuestionNumber": "1",
      "kind": "diagram/table/chart/formula",
      "bbox": {"x":0到1,"y":0到1,"width":0到1,"height":0到1},
      "confidence": 0到1
    }
  ]
}

规则：
1. questionRegions 必须是顶层题号对应的完整题目区域，包含题干、选项、小问、题内图形和空白作答区中必要部分。
2. 不要把“一、选择题”“二、填空题”等题型标题当题目。
3. （1）（2）（3）是同一道大题的小问，不要单独输出成 questionRegions。
4. 双栏或左右两页扫描时，先输出左侧从上到下，再输出右侧从上到下。
5. bbox 使用 0-1 归一化坐标，相对于整张图片左上角。
6. 不确定的区域也可以输出，但 confidence 要低；完全看不清则返回空数组。`
        },
        { type: "image_url", image_url: { url: dataUrl(mimeType || "image/png", bytes) } }
      ]
    }], { vision: true, temperature: 0.05, ...context, purpose: context.purpose || "layout_bbox", pages: context.pages || 1 });
    return {
      provider: "qwen",
      raw,
      durationMs: nowMs() - started,
      size
    };
  }

  return {
    name: "qwen",
    preprocessImage,
    recognizeImage,
    recognizeSpread,
    recognizeBatch,
    recognizeLayout
  };
}
