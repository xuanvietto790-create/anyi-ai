# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 定位

独立中文 AI 聊天站：Python FastAPI 后端 + 原生前端（HTML/CSS/JS，**无构建工具、无前端框架**）。主模型 `deepseek-v4-pro`，走 **Anthropic 兼容接口**（`POST /v1/messages`，`x-api-key` 头，`anthropic-version: 2023-06-01`），不是 OpenAI 格式。本目录是 `Anyi-project` 工作区四个独立 Git 仓库之一，与 `anyi-node`/`anyi-h5`/`anyi-admin` 互不依赖，只有账号接口复用 `anyi-node`。

功能细节、附件/语音/上下文的限制参数都在 `README.md` 和 `VERIFICATION.md` 里写得很全，改参数前先读它们；本文件只讲「改代码要从哪下手」的架构。

## 常用命令

venv 在 `E:\Codex\work\anyi-ai-venv`，依赖只装在这里，不在系统 Python。以下用 `<PY>` 代指该 venv 的 python。

```bash
# 首次/日常启动（建 venv + 装依赖 + 下载本地模型 + 起服务）
powershell -ExecutionPolicy Bypass -File .\start.ps1

# 已有 venv 时直接启动
E:\Codex\work\anyi-ai-venv\Scripts\python.exe -B -m uvicorn main:app --host 127.0.0.1 --port 8000

# 全部测试（unittest，用 httpx.MockTransport 替身上游，不消耗模型额度、不发真实短信）
E:\Codex\work\anyi-ai-venv\Scripts\python.exe -B -m unittest discover -s tests -v

# 单个测试（类名：AppTests / AuthTests / PdfOcrTests / ProgressTests）
E:\Codex\work\anyi-ai-venv\Scripts\python.exe -B -m unittest tests.test_app.AppTests.test_health_and_static

# 前端 JS 语法检查（无 lint/build，只有 node --check）
node --check static/app.js

# 下载/校验本地模型（Vosk 中文语音 + V4 分词器，start.ps1 会自动跑）
E:\Codex\work\anyi-ai-venv\Scripts\python.exe -B setup_assets.py
```

依赖：`requirements.txt` 是宽松范围，`requirements-lock.txt` 是锁定版本（start.ps1 装的是 lock）。装新依赖要同步两个文件。

## 架构大图

### 后端（根目录平铺的 `.py`，没有 package）

- `main.py` — FastAPI 入口和全部业务路由。`app = FastAPI(dependencies=[Depends(protect_api)])` 是全局依赖，但 `protect_api` 内部只对**受保护路径白名单**做鉴权（见下）。聊天在 `/api/chat` 用 `StreamingResponse`（`text/event-stream`）逐条 yield SSE 事件。
- `auth_service.py` — **账号会话网关**。自己不做注册/密码/短信，全部 `httpx` 转发给 `anyi-node` 的 `/api/auth/*`；本地用 SQLite + Fernet 加密存会话，只给浏览器发 HttpOnly Cookie `anyi_ai_session`（access/refresh 凭证不落地浏览器）。
- `attachments.py` — 附件解析与存储（图片/PDF/DOCX/文本），扫描 PDF 回退到 `pdf_ocr.py` 的 RapidOCR。
- `context_window.py` — 用官方 V4 分词器数 Token，算 1M 窗口预算（`budget()`）。
- `speech_service.py` / `speech_worker.py` — Vosk 本地 ASR + Windows SAPI 朗读；朗读在**独立子进程** `speech_worker.py` 里跑，隔离 SAPI 的 COM 线程。
- `upload_progress.py` — 上传解析进度的进程内内存存储。
- `setup_assets.py` — 下载本地模型到 E 盘（不下载 LLM 权重）。

### 前端（`static/`，无框架、无路由）

`index.html` 是单页，一个 `#auth-screen`（登录）+ 一个 `#chat-app`（聊天），靠 JS 切换显隐。三个脚本按序加载：

- `history-store.js` — `window.anyiHistory`，IndexedDB 按账号 `scope` 分库存聊天记录（带墓碑，支持多标签页合并）。
- `auth-client.js` — `window.anyiAuth`，登录注册 UI + 图形验证码 + 倒计时。
- `app.js` — 聊天主逻辑（623 行，SSE 消费、Markdown/代码/公式渲染、附件、语音、编辑分支、重新生成都在这里）。

第三方库（marked/highlight/DOMPurify/KaTeX）全在 `static/vendor/`，运行时**不访问 CDN**。

### 数据与模型位置（关键，全部默认 E 盘）

这些路径是**硬编码默认值**，可用同名环境变量覆盖（见 `.env.example`）：

| 内容 | 默认位置 | 环境变量 |
|---|---|---|
| 附件原件/提取文本 | `E:\Codex\work\anyi-ai-data\attachments` | `ANYI_DATA_DIR` |
| 会话 SQLite + `session.key` | `E:\Codex\work\anyi-ai-data\auth` | `ANYI_DATA_DIR` |
| 临时文件/音频 | `E:\Codex\tmp\anyi-ai` | `ANYI_TEMP_DIR` |
| Vosk 模型 + V4 分词器 | `E:\Codex\tool-cache\models` | `ANYI_VOSK_MODEL` / `DEEPSEEK_TOKENIZER_PATH` |

`session.key` 与会话库必须一起保留，已加入 `.gitignore`，不要提交。

## 关键机制（需要跨文件才能理解）

### 鉴权与账号 scope

- `protect_api` 的白名单硬编码为 `/api/chat`、`/api/context`、`/api/speech/transcribe`、`/api/speech/synthesize`、`/api/attachments*`。**新增受保护路由要改这里**，否则不会做登录校验。
- 非 GET 请求额外走 `check_origin`（比对 `origin` 和 `sec-fetch-site`，防 CSRF）。
- 账号 `scope` = `sha256(api_base)[:12] + '-' + user_id`，用于附件归属校验和 IndexedDB 分库。前端通过 `X-Anyi-Account` 头传 scope，后端校验其与会话 scope 一致（防多账号串数据）。
- 登录态过期：前端 `apiFetch` 收到 401 调 `window.anyiAuth.expire()`，收到 `X-Anyi-Auth-State: changed` 调 `recheck()`，组件不直接处理鉴权。

### 聊天 SSE 协议

`/api/chat` 逐条产出 SSE 事件，`app.js` 按 `event:` 名分发：`status`（进度提示）、`sources`（联网来源）、`notice`（非错误提示）、`context`（Token 预算）、`usage`、`thinking`/`delta`（思考/正文增量）、`error`、`done`。改后端流式逻辑或前端渲染时，两边要对着这个协议改。

### 上下文预算

`context_window.py` 的 `budget(messages, system)` 用本地 V4 分词器统计总 Token，为输出预留 8192、协议误差预留 1024。超限时 `/api/chat` 直接 `error` 事件拒绝，**不自动截断旧消息**。前端输入框下的「上下文 1M」用量靠 `/api/context` 单独估算。

### 图片识别

图片不进主模型上下文，而是先调 `DEEPSEEK_VISION_MODEL`（`deepseek-flash`）转成文字描述，结果缓存到 `<identifier>.vision.txt`，后续追问复用缓存（见 `main.py` 的 `prepare_messages`）。所以改图片流程时，缓存文件的存在与否会影响行为。

### 测试约定

测试不连真实上游：`test_app.py` 用 `httpx.MockTransport` 替换 `main.httpx.AsyncClient`，通过 `main.app.dependency_overrides[protect_api]` 注入假账号绕过登录；临时目录建在 `E:/Codex/tmp`。新增测试沿用这套替身方式，不要碰真实模型/短信/账号服务。
