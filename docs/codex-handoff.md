# Codex Handoff

最后更新：2026-06-30

这份文档给另一台电脑上的 Codex 使用，用来快速接上当前项目上下文。

## 当前项目状态

项目是一个前后端同仓库的 Node.js 应用：

- 后端入口：`server/index.js`
- 前端页面：`public/index.html`
- 前端逻辑：`public/app.js`
- 样式：`public/styles.css`
- 本地启动脚本：`scripts/start.js`
- 默认端口：`8080`

现在不是前后端分离项目。启动一次后端即可同时访问前端页面。

## 已完成的主要能力

### 资料上传与解析

- 支持上传 PDF、图片、`.docx`、文本。
- 上传 PDF / Word 后先识别页数，再让用户选择页码范围分析。
- PDF 优先本地文本层解析。
- 文本层不可靠时生成页面截图，再调用千问视觉 OCR。
- 支持多页后台分析任务和进度轮询。
- 自动跳过目录、封面、说明页、答案页等非题目页面。
- 支持重新分析。
- 上传文件去重。

### 拆题、审核、质检

- 题目先进入“待审核”，确认后再入库。
- 拆题字段包含：题干、选项、答案、解析、科目、学段、年级、章节、知识点、难度、题型、来源页码/文件。
- AI 可补全答案、解析、知识点、变式题。
- 每题支持 3 道同知识点同难度变式题。
- 已有质量检查：
  - 没有题干
  - 只有标题/页眉页脚
  - 小问片段被单独拆出
  - 选择题没有选项
  - 选择题选项不完整
  - 答案和题型明显不匹配
  - 题干说“如图/图中/阴影”等但没有绑定本题配图
  - 复杂公式未绑定截图时提示核对
- 质检未通过禁止直接入库。
- 手动上传/粘贴/拖拽“本题配图”，图片会随题目入库，并在作业导出时保留。

### 题库

- 题库筛选支持搜索、科目、学段、难度、题型、知识点。
- 题库页有当前结果数、题库总量、已选题数、知识点数。
- 知识点快捷标签可快速筛选。
- 题库题目可编辑、AI 分类、删除。
- 生成同类题时优先复用题库相似题，不足再调用 AI。

### 作业生成

- 勾选题库题目生成作业。
- 可基于条件或参考题 AI 生成同类题。
- 作业页面可预览。
- 支持导出 Word `.docx`。
- 题目配图会一起导出到 Word。

### 学生和错题

- 支持学生档案。
- 支持记录错题原因、备注。

### SaaS 基础

- 多机构租户隔离。
- 多用户与角色：`owner / admin / teacher / reviewer`。
- 审计日志。
- 后台任务记录。
- AI tokens 和 AI 页数统计。
- 套餐雏形：`free / starter / pro / school`。
- 套餐限制：
  - AI tokens
  - AI 页数
  - 上传大小
  - 账号数
  - 题库容量
  - 是否允许多页批量分析
- 设置页可手动切套餐、设试用截止、续费截止、欠费/停用状态和备注。

### 存储与部署

- 默认本地 JSON 存储：`data/db.json`。
- 支持 PostgreSQL state 存储。
- 支持 PostgreSQL 关系表同步，schema 在 `docs/saas-postgres-schema.sql`。
- 默认本地文件存储：`uploads/`。
- 支持 S3-compatible 对象存储：MinIO、阿里 OSS、腾讯 COS、七牛、AWS S3 等。
- 迁移本地上传文件到对象存储：`npm run migrate:uploads:s3`。
- Dockerfile、docker-compose、MinIO、PostgreSQL 已配置。
- Docker 模式默认读取本机 `deploy/docker.env`，并直接使用 PostgreSQL + MinIO：
  - 业务数据在 Docker volume `postgres-data`。
  - 上传文件、页面截图、题目配图在 Docker volume `minio-data`。
  - `deploy/docker.env` 不提交到 Git；用 `npm run docker:config` 在每台电脑生成。
  - 换电脑后拉代码即可启动同样的服务结构；若要同步旧电脑里的真实题库和图片，需要迁移 Docker volume，或改成外部云 PostgreSQL + 云对象存储。
- 健康检查：`GET /api/health`。

### 安全

- 密码使用 scrypt 强哈希。
- 旧 sha256 密码首次登录后自动升级。
- 登录/API/上传限流。
- 上传大小、后缀、MIME、文件头校验。
- 上传文件、页面截图、题目配图都必须登录后经后端鉴权访问。
- `NODE_ENV=production` 时会检查关键环境变量，不完整会拒绝启动。

## 最近一轮 UI 优化

用户要求优化 1、2、3、4，即：

1. 资料上传与解析
2. 题目拆解与质检
3. 待审核流程
4. 题库管理

最近已完成：

- 侧边栏、顶部栏、卡片、按钮、背景色统一成更像 SaaS 后台的视觉风格。
- 顶部新增套餐/订阅状态。
- 资料整理页新增“本地优先 / 疑难再 AI / 先审核”的处理能力卡。
- 待审核区新增“可入库 / 需核对 / 已拦截”统计。
- 题库页新增统计卡和知识点快捷筛选。
- 拆题规则进一步过滤题型标题、页眉页脚、章节标题、封面文字。
- 选择题选项不完整会被质检拦截。

验证过：

- `node --check server/index.js`
- `node --check public/app.js`
- `GET /api/health`
- 浏览器检查总览、资料整理、题库三页，无明显横向溢出。

## 关键文件说明

- `server/index.js`
  - 所有后端接口、解析逻辑、AI 调用、质量检查、存储适配、套餐限制都在这里。
  - 后续如果继续变大，建议拆分为模块。

- `public/app.js`
  - 单页前端的全部交互逻辑。
  - 包含上传、分析轮询、审核、题库筛选、作业生成、设置页套餐管理。

- `public/styles.css`
  - 当前 UI 的主要视觉风格。
  - 已尽量按后台工具风格处理，避免营销页式大 Hero。

- `scripts/start.js`
  - `npm start` 会先处理 8080 端口占用，再启动服务。

- `scripts/reset-data.js`
  - 清空数据和上传文件。

- `scripts/migrate-json-to-postgres.js`
  - 把本地 `data/db.json` 迁移到 PostgreSQL state。

- `scripts/migrate-uploads-to-s3.js`
  - 把本地 `uploads/` 上传到 S3-compatible 对象存储。

## 另一台电脑启动方式

### 1. 拉代码

```bash
git pull
```

如果是首次克隆：

```bash
git clone <你的仓库地址>
cd ZenoX-exercise
```

### 2. 安装依赖

需要 Node.js 20 或更高版本。

```bash
npm install
```

### 3. 创建环境变量

复制示例：

```bash
cp .env.example .env
```

本地开发最少建议改：

```env
APP_SECRET=本地开发也建议填一个长随机字符串
ADMIN_USER=admin
ADMIN_PASSWORD=admin123
QWEN_API_KEY=你的千问Key
```

如果暂时没有千问 Key，也可以先留空，非 AI 功能仍能用。

### 4. 启动

```bash
npm start
```

打开：

```text
http://127.0.0.1:8080
```

默认账号来自 `.env`：

```env
ADMIN_USER=admin
ADMIN_PASSWORD=admin123
```

### 5. 如果要用 Docker

```bash
npm run docker:config
# edit deploy/docker.env and set QWEN_API_KEY if AI is needed
docker compose up -d --build
```

默认会启动，并读取 `deploy/docker.env`：

- 应用服务
- PostgreSQL
- MinIO

本地开发如果不想用 PostgreSQL / MinIO，可以直接 `npm start`。

## 当前边界和下一步建议

### 当前边界

- PDF 拆题仍然依赖文本层质量和 OCR 效果；复杂版式、双栏、表格题、图形题仍需要人工审核。
- 自动绑定题目局部配图还不是完全可靠，所以保留了人工截图/粘贴本题配图流程。
- Word 导出可用，但不是专业排版引擎，复杂公式和几何图仍建议用题目截图兜底。
- 真实支付还没接入，目前是后台手动开通/续费/停用。
- 后端和前端目前仍在大文件中，后续商业化建议模块化。

### 建议下一步

1. 做生产部署包：
   - `docker-compose.prod.yml`
   - Nginx 反向代理示例
   - `.env.production.example`
   - 备份与恢复脚本
   - `docs/deploy-checklist.md`

2. 继续优化 PDF 题目配图：
   - 做更精确的题目区域截图
   - 或做“人工框选截图”工作流

3. 拆分代码结构：
   - `server/storage.js`
   - `server/ai.js`
   - `server/parser.js`
   - `server/billing.js`
   - `server/routes.js`

4. 接真实支付前，先完善订单模型：
   - plans
   - subscriptions
   - invoices
   - payment_events
