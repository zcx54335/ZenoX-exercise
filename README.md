# ZenoX Exercise

面向家教老师的题目整理与作业生成工作台。第一版重点覆盖：

- Word / PDF / 图片资料上传留档
- 文本型 PDF 粗提取、粘贴文本拆题、图片千问 OCR
- 题目按科目、学段、年级、章节、知识点、难度、题型分类
- 疑似重复题提醒
- 题库筛选、勾选组卷、AI 生成同类题
- 作业 A4 排版打印，可在浏览器里另存为 PDF
- 学生档案和错题原因记录
- Docker 部署，数据和上传文件持久化

## 本地运行

```bash
npm start
```

打开 `http://127.0.0.1:8080`。

默认账号来自环境变量：

- `ADMIN_USER=admin`
- `ADMIN_PASSWORD=admin123`

生产环境请务必修改密码和 `APP_SECRET`。

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

这两个目录已经在 `docker-compose.yml` 中挂载为持久化目录。

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
- Word：当前会保存文件，但不解析 `.doc/.docx` 内容；可复制文本到“拆题与入库”区域处理。
- 打印 PDF：在作业页点击“打印 / 导出 PDF”，浏览器打印目标选择“另存为 PDF”。

后续产品化建议是接入 PostgreSQL、对象存储、专业文档解析服务和多账号权限。
