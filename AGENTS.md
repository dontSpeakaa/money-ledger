# AGENTS.md

## 项目概述

个人理财账本（PWA）。零外部依赖：Node 原生 `http` + `node:sqlite` + 原生 JS 前端。
单用户、自托管，数据存在本机 SQLite。

## 常用命令

```bash
npm start          # 启动服务，默认 PORT=12000，监听 0.0.0.0
npm test           # 冒烟测试（scripts/smoke-test.sh），会启动临时实例
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
- `data/money.db` — 运行时数据，已 gitignore。

## 注意事项

- 删除数据库时必须同时删掉 `-wal` 和 `-shm`，否则新库会被旧 WAL 干扰（见 `scripts/reset.js`）。
- 会话 Cookie 默认带 `Secure`；本地用 http 调试需要 `MONEY_INSECURE_COOKIE=1`。
- 测试用例数变化时同步更新 README 中的数字。
