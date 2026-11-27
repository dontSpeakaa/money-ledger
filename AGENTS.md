# AGENTS.md

## 项目概述

个人理财账本（PWA）。零外部依赖：Node 原生 `http` + `node:sqlite` + 原生 JS 前端。
单用户、自托管，数据存在本机 SQLite。

主页是 AI 对话页：用户说「午饭 38」，模型通过工具调用把账记进账本。
**没有手动记账面板，也没有手动新增账户的入口**——记账和账户配置都走对话，
不要把这些入口加回来。

## 两种运行模式（同一份前端）

1. **服务器模式**（`npm start`）：数据存 SQLite，多设备可访问，带登录密码。
2. **本地模式**（`npm run build:static` 产物，或 `?local=1`）：没有服务器，
   业务逻辑跑在浏览器里，数据存 IndexedDB。适合传到 GitHub Pages 后加到 iPhone 主屏。

两种模式的接口返回必须**完全一致**，靠 `scripts/contract-test.mjs` 强制校验：
它同时跑服务端（真 SQLite）和本地模式（内存 driver），逐字段比较返回结构。
**改任何一边的返回字段，都要同步另一边**，否则合同测试会红。

约定：本地模式只暴露服务端 `SELECT` 出来的字段。例如 `listAccounts()` 只 SELECT
`id/name/type/currency/initial_balance/archived/sort_order` 加派生的 `balance/tx_count`，
本地实现就不能把 `created_at` 一起返回（历史 bug：本地多返回 `created_at`/`updated_at`）。

## 常用命令

```bash
npm start          # 启动服务，默认 PORT=12000，监听 0.0.0.0
npm test           # 全量测试：冒烟 + 本地模式 + AI 助手 + 合同一致性
npm run build:static  # 生成 docs/（GitHub Pages 用，相对路径 + 本地模式）
npm run seed-demo  # 写入演示数据 + 演示账号 me / demo123456（会清空账户与交易）
npm run reset      # 清空数据库（含 -wal / -shm）
npm run make-icons # 重新生成 PWA 图标
```

## 结构

- `server/db.js` — 建表与数据访问；`DB_PATH` 可用 `MONEY_DB` 覆盖。SQLite 开 WAL。
- `server/auth.js` — scrypt 口令哈希、会话、长期 API 令牌。
- `server/index.js` — 路由表 + 鉴权。`requireApiAuth(req, url, body)` 依次尝试
  `Authorization: Bearer`、`X-Api-Token`、`?token=`、JSON body 的 `token`。
- `public/` — 前端。`app.js` 里 `refreshAll()` 拉账户/分类/汇总，`reloadMonth()` 拉明细。
- `public/ai-tools.js` — AI 工具定义（`AI_TOOLS`）、系统提示词（`buildSystemPrompt`）、
  执行函数（`runTool`）。**纯逻辑，不许碰 DOM**：前端 `app.js` 和 `scripts/ai-test.mjs`
  跑同一份代码，才能在没有浏览器的情况下测真实路径。
- `public/local-api.js` — 本地模式的后端（`createLocalApi(driver)`），driver 可换：
  浏览器用 `idbDriver`（IndexedDB），node 测试用 `memoryDriver`。
- `scripts/ai-test.mjs` — AI 工具 + 配置接口测试。只有「服务商 HTTP 响应」是 stub
  （`globalThis.fetch`），其余走真实业务逻辑。
- `scripts/contract-test.mjs` — 服务端 vs 本地模式的返回结构对比。
- `data/money.db` — 运行时数据，已 gitignore。
- `docs/` — `build:static` 产物，GitHub Pages 直接发布这个目录。

## AI 对话的约定

- 工具循环跑在**前端**（`runChatTurn`）：模型返回 `tool_calls` → `runTool` 执行 →
  结果以 `role: 'tool'` 喂回去，最多 6 轮。服务端只做转发，不参与循环。
- 每个工具都落在已有的 `/api/*` 接口上，所以服务器模式和纯手机模式行为天然一致。
  加新工具时：`AI_TOOLS` 里写 schema、`runTool` 里实现、`buildSystemPrompt` 里补一条规则、
  `scripts/ai-test.mjs` 里加断言。
- **API Key 永远不回传浏览器**。`GET /api/ai/config` 只给
  `base_url / model / transcribe_model / transcribe_base_url / has_key / ready`；
  `POST` 时 `api_key` 为空表示「不修改」，`clear_key: true` 才是清空。两边（server/local）必须一致，
  合同测试会比对结构。
- 服务器模式由服务端 `fetch` 服务商（Key 不出服务端）；纯手机模式浏览器直连，要求对方允许 CORS。
  错误信息里不要带 Key 或 Authorization 头。
- 日期沿用全项目的 UTC 口径（`toISOString().slice(0,10)`），别在 AI 层单独换成本地时区。

## 语音输入的约定

- 录音在浏览器（`MediaRecorder`），转文字在 `/api/ai/transcribe`。服务端模式由服务端拼
  multipart 转发给服务商的 `/audio/transcriptions`（Key 不出服务端）；纯手机模式浏览器直接
  `FormData` 请求。两边的字段（model / file 名 / 音频类型）必须一致，合同测试会比对。
- `transcribe_model` 默认 `whisper-1`，`transcribe_base_url` 留空表示沿用聊天地址
  （聊天模型不支持 Whisper 时，用户可以单独填一个支持语音的地址）。
- 录音接口的请求体是**二进制**，走 `readRawBody`（路由表第 4 项 `{ raw: true }`）。
  别用 `readBody`，它会把音频当 utf8 解码，文件就废了。
- 识别完直接 `sendChat(text)` 自动发送；录满 60 秒自动停。

## 注意事项

- 删除数据库时必须同时删掉 `-wal` 和 `-shm`，否则新库会被旧 WAL 干扰（见 `scripts/reset.js`）。
- 会话 Cookie 的 `Secure` 由 `setCookie(req, ...)` 按实际协议判断：`req.socket.encrypted`
  或 `X-Forwarded-Proto: https` 才加。局域网 http 访问必须不加，否则 Safari 拒收 Cookie、
  登录后立刻掉线。`MONEY_INSECURE_COOKIE=1` 可强制不加（仅调试用）。
- 测试用例数变化时同步更新 README 中的数字（冒烟 / 本地 / AI / 合同，跑一次 `npm test` 看尾部输出）。
- 改静态资源时要同时改 `public/sw.js` 和 `scripts/build-static.js` 里的内联版本，
  并把两处 `CACHE` 版本号各加一；`docs/` 是 `npm run build:static` 的产物，改完要重新生成。

## 启动速度与版本一致性

`sw.js` 分两段策略：

- **静态资源**：缓存优先 + 后台更新（stale-while-revalidate），首屏直接读本地缓存。
  前提是 `index.html` 里的资源都带 `?v=N`，缓存命中的一定和 HTML 同一版本。
- **页面导航**：网络优先，离线才回退缓存。这条不能改回缓存优先 —— 曾经因为导航走缓存，
  手机上出现「旧 index.html + 新 app.js」，`navigate('chat')` 拿不到 `#chat-composer` 直接抛错，
  页面永远停在启动页（只显示「我的账本」）。

发版时**必须同时**改这几处的版本号：`public/index.html`（`styles.css?v=` / `app.js?v=`）、
`public/app.js` 顶部两个 `import ...?v=`、`public/sw.js` 的 `SHELL` 与 `CACHE`、
`scripts/build-static.js` 里的替换字符串与内联 SW 的 `SHELL` / `CACHE`，最后跑
`npm run build:static` 重新生成 `docs/`。

对话页是整页滚动的，进入对话（启动、切回标签、刷新）都要停在最下面：
`renderChat()` 末尾调 `scrollChatToBottom()`（滚窗口，分几拍补偿排版抖动），
`navigate()` 里只有**非**对话视图才 `scrollTo({ top: 0 })`，
并且启动时把 `history.scrollRestoration` 设成 `manual`，否则刷新会被浏览器恢复的旧位置盖掉。

`index.html` 里还有一段 5 秒兜底脚本：`window.__booted` 没被 `boot()` 置为 true 就把启动页
换成「加载失败 + 重新加载」，模块加载失败时用户不会对着空白页。改启动流程时别删它。

其他几处不能回退的点：

- `index.html` 的 `#splash` 保证 JS 就绪前不白屏；`boot()` 失败路径也要 `hideSplash()`，
  否则会一直卡在 logo。
- `app.js` 顶部的 `localApiReady` 让 `local-api.js` 的 import 提前开始，和启动流程并行。
- `enterApp()` 里 `refreshAll()` 与 `loadTransactions()` 用 `Promise.all` 并发，
  两者互不依赖。
- `loadToken()` 不要 `await`，只有设置页用得到。
- `controllerchange` 只在「本来就有旧 SW 控制」时才 reload，否则首次访问会白等一次完整加载。

## 部署到 GitHub Pages

```bash
GITHUB_TOKEN=ghp_xxx ./scripts/deploy-pages.sh money-ledger
```

脚本会：生成 `docs/` → 推送 `main` → 开启 Pages（源 = `main` 的 `/docs`）。
推送失败会立即中止（`die`），不会误报成功。

令牌要求：classic PAT，勾 `repo` 即可（`x-oauth-scopes: repo`）。注意：

- 环境里托管的 `GITHUB_TOKEN`（`ghu_` 前缀）**只有只读权限**：`git ls-remote` 能过，
  但 `git push` 和 `PUT /contents/...` 都返回 403 / `Resource not accessible by integration`，
  且 `/user/installations` 为空、限流 5000。要推送必须用户自备 classic PAT。
- 仓库已存在时脚本会跳过创建。`POST /repos/{owner}/{repo}/pages` 重复调用会返回 409，
  脚本按「已开启」处理。
- 推送完成后记得把 remote 里的令牌去掉：
  `git remote set-url origin https://github.com/<owner>/<repo>.git`。
