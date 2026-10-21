# AGENTS.md

## 项目概述

个人理财账本（PWA）。零外部依赖：Node 原生 `http` + `node:sqlite` + 原生 JS 前端。
单用户、自托管，数据存在本机 SQLite。

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
npm test           # 全量测试：冒烟 + 本地模式 + 合同一致性
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
- `public/local-api.js` — 本地模式的后端（`createLocalApi(driver)`），driver 可换：
  浏览器用 `idbDriver`（IndexedDB），node 测试用 `memoryDriver`。
- `scripts/contract-test.mjs` — 服务端 vs 本地模式的返回结构对比。
- `data/money.db` — 运行时数据，已 gitignore。
- `docs/` — `build:static` 产物，GitHub Pages 直接发布这个目录。

## 注意事项

- 删除数据库时必须同时删掉 `-wal` 和 `-shm`，否则新库会被旧 WAL 干扰（见 `scripts/reset.js`）。
- 会话 Cookie 的 `Secure` 由 `setCookie(req, ...)` 按实际协议判断：`req.socket.encrypted`
  或 `X-Forwarded-Proto: https` 才加。局域网 http 访问必须不加，否则 Safari 拒收 Cookie、
  登录后立刻掉线。`MONEY_INSECURE_COOKIE=1` 可强制不加（仅调试用）。
- 测试用例数变化时同步更新 README 中的数字。

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
