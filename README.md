# ZenoX Exercise

面向家教老师的题目整理与作业生成工作台。第一版重点覆盖：

- Word / PDF / 图片资料上传留档
- 文本型 PDF 粗提取、粘贴文本拆题、图片千问 OCR
- PDF / DOCX / 图片 / 文本上传后自动分析，题目、知识点、答案解析和同类题先进入待审核
- 题目按科目、学段、年级、章节、知识点、难度、题型分类
- 疑似重复题提醒
- 题库筛选、勾选组卷、AI 生成同类题
- 作业 A4 预览，并导出 Word `.docx`
- 学生档案和错题原因记录
- SaaS 基础能力：机构、用户、租户隔离、AI 用量、任务记录、审计日志
- Docker 部署，数据和上传文件持久化，支持 S3/OSS/MinIO 兼容对象存储

## 本地运行

```bash
npm install
npm start
```

打开 `http://127.0.0.1:8080`。

`npm start` 会先检查当前端口，自动停掉占用该端口的旧后端进程，再启动最新代码。开发时也可以用：

```bash
npm run dev
```

## 在 IDEA 中打开

1. 用 IDEA 打开项目根目录 `ZenoX-exercise`。
2. 在根目录创建 `.env`，按 `.env.example` 填好管理员密码和 `QWEN_API_KEY`。
3. 打开 IDEA 的 Terminal，执行 `npm install`。
4. 执行 `npm start`。
5. 浏览器访问 `http://127.0.0.1:8080`。

这是一个前后端同仓库项目，不是两个独立服务：`server/index.js` 是后端，同时托管 `public/` 里的前端页面。你只需要启动一次后端，前端就会一起可访问。

默认账号来自环境变量：

- `ADMIN_USER=admin`
- `ADMIN_PASSWORD=admin123`

生产环境请务必修改密码和 `APP_SECRET`。如果 `NODE_ENV=production`，服务会检查关键配置，缺少安全配置时会直接拒绝启动。

## Docker 部署

复制环境变量示例：

```bash
copy .env.example .env
```

编辑 `.env` 后启动：

```bash
docker compose up -d --build
```

数据保存在：

- `data/db.json`
- `uploads/`

这两个目录已经在 `docker-compose.yml` 中挂载为持久化目录。`docker-compose.yml` 也内置了 MinIO，后续切对象存储时可以直接使用。

## 存储模式

本地开发默认使用 JSON 文件：

```env
STORAGE_DRIVER=json
```

准备做网站或多人试用时，可以切到 PostgreSQL：

```env
STORAGE_DRIVER=postgres
DATABASE_URL=postgres://zenox:password@postgres:5432/zenox_exercise
POSTGRES_STATE_ID=zenox-app-state
POSTGRES_SYNC_RELATIONAL=true
```

迁移当前本地数据到 PostgreSQL：

```bash
npm run migrate:postgres
```

当前 PostgreSQL 存储采用“双轨”模式：

- `zenox_app_state` 保存完整应用状态，保证现有功能平滑切换。
- `organizations / users / questions / uploads / assignments / ai_usage / audit_logs` 等关系表会自动同步，方便后续逐步把接口改成真正表查询。

如果生产环境临时不想同步关系表，可以设置：

```env
POSTGRES_SYNC_RELATIONAL=false
```

## 安全配置

当前后端已经内置这些基础安全能力：

- 登录密码使用强哈希保存；旧 sha256 密码首次登录后会自动升级。
- 登录、普通接口、上传接口都有基础限流，防止暴力登录和刷接口。
- 上传会校验文件大小、后缀、MIME 和文件头，只允许 PDF、DOCX、图片和 TXT。
- 上传文件、页面截图、题目配图都需要登录后通过后端鉴权访问，不直接暴露对象存储地址。
- `GET /api/health` 可用于 Docker、负载均衡或服务器探活。

常用安全参数：

```env
NODE_ENV=production
APP_SECRET=至少32位随机字符串
ADMIN_PASSWORD=强密码
COOKIE_SECURE=true
MAX_UPLOAD_MB=80
MAX_IMAGE_UPLOAD_MB=12
RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT=240
LOGIN_RATE_LIMIT=12
UPLOAD_RATE_LIMIT=20
```

生产环境默认要求配置 `QWEN_API_KEY`。如果你确实要先关闭 AI 能力，可以设置：

```env
ALLOW_MISSING_QWEN_API_KEY=true
```

## 套餐与试用

系统内置 `free / starter / pro / school` 四档套餐，控制：

- 每月 AI tokens
- 每月 AI 分析页数
- 最大上传大小
- 最大账号数
- 题库容量
- 是否允许多页批量分析

当前版本先做“手动开通/续费”，还没有接真实支付。管理员登录后进入“部署设置”，可以在“套餐与用量”里切换套餐、设置试用截止、续费截止、欠费/停用状态和备注。

新机构默认会进入试用，试用天数可配置：

```env
DEFAULT_TRIAL_DAYS=14
```

## 文件对象存储

默认文件仍保存在本地 `uploads/`：

```env
FILE_STORAGE_DRIVER=local
```

准备上线或多人使用时，建议把 PDF、页面截图、题目配图切到对象存储：

```env
FILE_STORAGE_DRIVER=s3
S3_BUCKET=zenox-exercise
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY_ID=zenox
S3_SECRET_ACCESS_KEY=zenox-password
S3_FORCE_PATH_STYLE=true
```

这套配置兼容 MinIO，也可以换成阿里 OSS、腾讯 COS、七牛云、AWS S3 等 S3-compatible 服务；替换 `S3_ENDPOINT / S3_BUCKET / Key / Secret` 即可。

如果已有本地上传文件，要迁移到对象存储：

```bash
npm run migrate:uploads:s3
```

迁移脚本只上传，不删除本地 `uploads/`，确认线上图片和文件正常后再清理。

## 千问配置

项目使用千问 / DashScope 的 OpenAI-compatible 接口：

```env
QWEN_API_KEY=你的Key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
QWEN_VISION_MODEL=qwen-vl-plus
```

未配置 `QWEN_API_KEY` 时，上传、拆题、分类编辑、组卷、打印、学生错题仍然可用；AI OCR、AI 分类、AI 出题会提示需要配置 Key。

## 当前边界

- PDF：支持从部分“可复制文本”的 PDF 中粗提取；扫描版 PDF 建议先转成图片后用 AI OCR。
- PDF：会先尝试本地文本层解析；文本层不可靠时，若系统有 Poppler 会生成页面截图，并用千问视觉 OCR 兜底。
- Word：支持 `.docx` 文本解析；老 `.doc` 建议先另存为 `.docx`。
- 作业导出：在作业页点击“导出 Word”，会下载 `.docx` 文件，题目配图会一起写入文档。

后续产品化建议是接入专业文档解析服务、支付套餐、风控限流和正式版权/隐私合规模块。
