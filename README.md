# 我的账本

单人使用的个人理财 Web 应用。记录各账户资产，消费时自动更新余额与净资产。
可以添加到 iPhone 主屏幕，像原生 App 一样打开。

零外部依赖，只用 Node.js 内置模块（`node:http`、`node:sqlite`、`node:crypto`）。
数据存在本机的一个 SQLite 文件里，不上传任何服务器。

## 快速开始

```bash
npm start          # 启动，默认 http://localhost:12000
```

首次打开网页会引导你设置用户名和密码。之后所有数据都属于这一个账号。

想先看看界面长什么样，可以写入演示数据：

```bash
npm run seed-demo  # 6 个账户 + 最近 3 个月的示例交易，账号 me / demo123456
npm start
```

演示数据会清空已有账户和交易，只在空库上使用。想彻底清空重来，用 `npm run reset`。

## 在 iPhone 上打开

### 方式一：局域网直连（推荐，数据不出家门）

1. 确保手机和跑服务的电脑连同一个 Wi-Fi。
2. 查电脑的局域网 IP：macOS/Linux 用 `hostname -I` 或 `ipconfig getifaddr en0`，Windows 用 `ipconfig`。
3. 服务默认监听 `0.0.0.0:12000`，直接用 Safari 打开 `http://<局域网IP>:12000`。

会话 Cookie 会按实际协议决定是否加 `Secure`：走 http 时自动不加，否则 Safari 会拒收 Cookie、登录后立刻掉线。

### 方式二：公网地址

如果服务跑在云主机或有域名，直接访问 `https://<你的域名>`。HTTPS 下 Cookie 自动带 `Secure`。
建议放在 Nginx/Caddy 后面并配好 TLS，反代记得传 `X-Forwarded-Proto: https`。

### 添加到主屏幕（变成本地 App）

1. Safari 打开上面的地址，先登录一次。
2. 点底部中间的「分享」按钮（方框加向上箭头）。
3. 在列表里向下找到「添加到主屏幕」，改个名字，点「添加」。
4. 从主屏幕图标打开，就是全屏无地址栏的独立 App。

注意：必须是 **Safari**。Chrome、微信内置浏览器都加不了主屏幕，也不会全屏运行。
另外 PWA 的「独立运行」和 Service Worker 离线缓存只在 HTTPS（或 `localhost`）下生效。
走局域网 http 时能正常使用和加到主屏幕，但离线缓存不启用。

## 功能

- 总览：净资产、本月收支、账户余额、支出构成、近 6 个月趋势、分类排行
- 明细：按月查看流水，支持搜索、按账户和分类筛选
- 记账：支出 / 收入 / 转账，快捷金额按钮，可改可删
- 账户：储蓄卡、现金、信用卡、支付宝、微信、投资、贷款等类型；信用卡和欠款填负数
- 预算：给分类设置月度上限，超支有提醒
- 导入：支付宝 / 微信 / 银行导出的 CSV，自动识别列名；也支持 JSON。重复记录自动跳过
- 导出：CSV 和 JSON 备份，随时把数据带走

## 消费时自动记账（iPhone 快捷指令）

生成一个长期令牌后，任何消费都能用一条链接记账，不必打开网页。

1. 设置页 → 「自动化（iPhone 快捷指令）」→ 生成令牌
2. 复制页面给出的示例，在「快捷指令」里用「获取 URL 内容」调用：

```
POST http://<服务器IP>:12000/api/quick?token=<令牌>
{"amount":38.5,"category":"餐饮","note":"午饭"}
```

也可以直接用 GET，方便做成小组件或 Siri 短语：

```
http://<服务器IP>:12000/api/quick?token=<令牌>&amount=38.5&category=餐饮&note=午饭
```

金额传正数默认记为支出。令牌等价于密码，只放在自己的设备上；不用了可以在设置页撤销。

## 配置

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `12000` |
| `HOST` | 监听地址，默认允许局域网访问 | `0.0.0.0` |
| `MONEY_DB` | SQLite 文件路径 | `data/money.db` |
| `MONEY_INSECURE_COOKIE` | 设为 `1` 时强制不加 Secure Cookie（正常情况无需设置，程序会自动判断 http/https） | 自动判断 |

## 开发

```bash
npm test           # 端到端冒烟测试，起一个临时库跑完整流程
npm run make-icons # 由 icon.svg 重新生成各尺寸 PNG 图标
```

代码结构：

```
server/db.js      SQLite 表结构与查询
server/auth.js    密码哈希、会话、API 令牌
server/index.js   HTTP 服务与全部接口
public/           前端（原生 HTML/CSS/JS，无构建步骤）
scripts/          演示数据、图标生成、冒烟测试
```

## 数据安全

- 密码用 scrypt 加盐哈希，登录靠 HttpOnly 会话 Cookie
- 生产使用请放在 HTTPS 后面（Cookie 默认带 `Secure`），或只在内网访问
- 备份就是把 `data/money.db` 复制走，或者用设置页的导出功能
