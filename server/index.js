import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  db,
  listAccounts,
  getAccount,
  accountBalance,
  netWorth,
  insertTransaction,
  categoryTotals,
  monthSummary,
  monthlyTrend,
  listBudgets,
  getMeta,
  setMeta,
  round2,
  nowIso,
} from './db.js';
import {
  hasUser,
  createUser,
  getUser,
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  userForToken,
  purgeExpiredSessions,
  rotateApiToken,
  getApiToken,
  revokeApiToken,
  checkApiToken,
  parseCookies,
} from './auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE = 'money_session';
const SECURE_COOKIE = process.env.MONEY_INSECURE_COOKIE !== '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, data, headers) {
  send(res, status, JSON.stringify(data), headers);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw bad('JSON 格式错误');
    }
  }
  return raw;
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return userForToken(cookies[COOKIE]);
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, '未登录');
  return user;
}

/** Auth for programmatic callers (Shortcuts, curl): Bearer / X-Api-Token / ?token=. */
function requireApiAuth(req, url, body) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token =
    bearer ||
    req.headers['x-api-token'] ||
    url.searchParams.get('token') ||
    body?.token ||
    body?.api_token;
  if (token && checkApiToken(token)) return { kind: 'api' };
  const user = currentUser(req);
  if (user) return { kind: 'session', user };
  throw new HttpError(401, '未授权');
}

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

function parseAmount(value) {
  const n = Number(String(value).replace(/[,\s¥$]/g, ''));
  if (!Number.isFinite(n) || n === 0) throw bad('金额必须是非 0 数字');
  return round2(n);
}

function parseDate(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw bad(`无法识别日期：${s || '(空)'}`);
}

// ---------------------------------------------------------------- transactions

function addTransaction(body) {
  const accountId = Number(body.account_id ?? body.accountId);
  if (!getAccount(accountId)) throw bad('账户不存在');
  const amount = parseAmount(body.amount);
  return insertTransaction({
    accountId,
    amount,
    category: String(body.category || '').trim(),
    note: String(body.note || '').trim(),
    date: parseDate(body.date || today()),
  });
}

function addTransfer(body) {
  const fromId = Number(body.from_account_id ?? body.fromAccountId);
  const toId = Number(body.to_account_id ?? body.toAccountId);
  if (!getAccount(fromId) || !getAccount(toId)) throw bad('账户不存在');
  if (fromId === toId) throw bad('转出与转入账户不能相同');
  const amount = Math.abs(parseAmount(body.amount));
  const date = parseDate(body.date || today());
  const note = String(body.note || '').trim();
  const transferId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  insertTransaction({ accountId: fromId, amount: -amount, category: '转账', note, date, transferId });
  insertTransaction({ accountId: toId, amount, category: '转账', note, date, transferId });
  return transferId;
}

function accountName(id) {
  const a = getAccount(id);
  return a ? a.name : '已删除账户';
}

function searchTransactions({ month, accountId, category, q, limit = 200, offset = 0 }) {
  const where = [];
  const params = [];
  if (month) {
    where.push('substr(t.date, 1, 7) = ?');
    params.push(month);
  }
  if (accountId) {
    where.push('t.account_id = ?');
    params.push(Number(accountId));
  }
  if (category) {
    where.push('t.category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(t.note LIKE ? OR t.category LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const sql = `SELECT t.*, a.name AS account_name FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY t.date DESC, t.id DESC
                LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, Number(limit), Number(offset));
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .get(...params);
  return { rows, total: countRow.n };
}

function upsertCategory(name, kind, icon) {
  const clean = String(name || '').trim();
  if (!clean) throw bad('分类名称不能为空');
  db.prepare(
    `INSERT INTO categories (name, kind, icon, sort_order)
     VALUES (?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM categories), 0))
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind,
       icon = CASE WHEN excluded.icon = '🏷️' THEN categories.icon ELSE excluded.icon END`,
  ).run(clean, kind === 'income' ? 'income' : 'expense', String(icon || '🏷️'));
  return clean;
}

// ------------------------------------------------------------------- CSV tools

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const CSV_HEADERS = {
  date: ['日期', 'date', '交易日期', 'time', '交易时间'],
  amount: ['金额', 'amount', '交易金额', '收支金额'],
  income: ['收入', 'income', '贷方发生额'],
  expense: ['支出', 'expense', '借方发生额'],
  category: ['分类', 'category', '交易类型', '类型'],
  note: ['备注', 'note', '摘要', '说明', '商品', '交易说明', 'memo'],
  account: ['账户', 'account', 'account_id', '账户名称'],
};

function mapHeader(headerRow) {
  const map = {};
  headerRow.forEach((cell, idx) => {
    const key = String(cell).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(CSV_HEADERS)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => a.toLowerCase() === key)) map[field] = idx;
    }
  });
  return map;
}

/** Import rows; each row is {date, amount, category, note, account_id?}. */
function importRows(rows, { defaultAccountId, dryRun = false, source = 'import' }) {
  const report = { imported: 0, skipped: 0, errors: [], preview: [] };
  const fallbackAccount = defaultAccountId ? Number(defaultAccountId) : null;
  const seen = new Set(
    db
      .prepare('SELECT account_id, date, amount, note FROM transactions')
      .all()
      .map((r) => `${r.account_id}|${r.date}|${round2(r.amount)}|${r.note}`),
  );

  const commit = !dryRun;
  if (commit) db.exec('BEGIN');
  try {
    rows.forEach((raw, i) => {
      const lineNo = i + 1;
      try {
        let accountId = Number(raw.account_id ?? raw.accountId ?? fallbackAccount);
        if (raw.account && !accountId) {
          const found = db
            .prepare('SELECT id FROM accounts WHERE name = ?')
            .get(String(raw.account).trim());
          if (found) accountId = found.id;
        }
        if (!getAccount(accountId)) throw new Error('找不到账户');

        let amount;
        if (raw.amount !== undefined && raw.amount !== '') amount = parseAmount(raw.amount);
        else {
          const inc = Number(raw.income || 0);
          const exp = Number(raw.expense || 0);
          amount = round2(inc - exp);
          if (!amount) throw new Error('金额为 0 或缺失');
        }
        const date = parseDate(raw.date || today());
        const note = String(raw.note || '').trim();
        const key = `${accountId}|${date}|${amount}|${note}`;
        if (seen.has(key)) {
          report.skipped += 1;
          report.preview.push({ line: lineNo, status: '重复跳过', date, amount, note });
          return;
        }
        seen.add(key);
        const category =
          String(raw.category || '').trim() || (amount > 0 ? '其他收入' : '其他支出');
        if (commit) {
          insertTransaction({ accountId, amount, category, note: note || source, date });
        }
        report.imported += 1;
        if (report.preview.length < 50) {
          report.preview.push({ line: lineNo, status: '导入', date, amount, category, note });
        }
      } catch (err) {
        report.skipped += 1;
        if (report.errors.length < 50) report.errors.push({ line: lineNo, message: err.message });
      }
    });
    if (commit) db.exec('COMMIT');
  } catch (err) {
    if (commit) db.exec('ROLLBACK');
    throw err;
  }
  return report;
}

// --------------------------------------------------------------------- routing

const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, time: nowIso() })],

  ['GET', /^\/api\/me$/, async (ctx) => {
    const user = currentUser(ctx.req);
    return {
      setup_required: !hasUser(),
      authenticated: !!user,
      username: user ? user.username : null,
      has_api_token: !!getApiToken(),
    };
  }],

  ['POST', /^\/api\/setup$/, async ({ req, res, body }) => {
    if (hasUser()) throw new HttpError(409, '已完成初始化');
    const username = String(body.username || 'me').trim();
    const password = String(body.password || '');
    if (password.length < 6) throw bad('密码至少 6 位');
    const id = createUser(username, password);
    const { token, expires } = createSession(id);
    setCookie(req, res, token, expires);
    return { ok: true, username };
  }],

  ['POST', /^\/api\/login$/, async ({ req, res, body }) => {
    const user = getUser(String(body.username || '').trim());
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, '用户名或密码错误');
    }
    const { token, expires } = createSession(user.id);
    setCookie(req, res, token, expires);
    return { ok: true, username: user.username };
  }],

  ['POST', /^\/api\/logout$/, async ({ req, res }) => {
    destroySession(parseCookies(req.headers.cookie || '')[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return { ok: true };
  }],

  ['POST', /^\/api\/password$/, async ({ req, body }) => {
    const user = requireUser(req);
    if (!verifyPassword(body.current_password, user.password_hash)) {
      throw new HttpError(401, '当前密码不正确');
    }
    const next = String(body.new_password || '');
    if (next.length < 6) throw bad('新密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return { ok: true, relogin: true };
  }],

  ['GET', /^\/api\/summary$/, async ({ req, url }) => {
    requireUser(req);
    const month = url.searchParams.get('month') || currentMonth();
    const budgets = listBudgets();
    const spentByCategory = Object.fromEntries(
      categoryTotals(month).map((r) => [r.category, -r.total]),
    );
    return {
      month,
      net_worth: netWorth(),
      month_summary: monthSummary(month),
      accounts: listAccounts(),
      by_category: categoryTotals(month).filter((r) => r.total < 0),
      trend: monthlyTrend(6),
      budgets: budgets.map((b) => ({
        ...b,
        spent: round2(spentByCategory[b.category] || 0),
        ratio: b.monthly_limit > 0 ? round2((spentByCategory[b.category] || 0) / b.monthly_limit) : 0,
      })),
    };
  }],

  ['GET', /^\/api\/accounts$/, async ({ req, url }) => {
    requireUser(req);
    return { accounts: listAccounts({ includeArchived: url.searchParams.get('all') === '1' }) };
  }],

  ['POST', /^\/api\/accounts$/, async ({ req, body }) => {
    requireUser(req);
    const name = String(body.name || '').trim();
    if (!name) throw bad('账户名称不能为空');
    const info = db
      .prepare(
        `INSERT INTO accounts (name, type, currency, initial_balance, sort_order, created_at)
         VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM accounts), 0), ?)`,
      )
      .run(
        name,
        String(body.type || 'bank'),
        String(body.currency || 'CNY'),
        Number(body.initial_balance || 0),
        nowIso(),
      );
    return { id: Number(info.lastInsertRowid) };
  }],

  ['PATCH', /^\/api\/accounts\/(\d+)$/, async ({ req, body, params }) => {
    requireUser(req);
    const id = Number(params[0]);
    const acc = getAccount(id);
    if (!acc) throw new HttpError(404, '账户不存在');
    const fields = [];
    const values = [];
    for (const key of ['name', 'type', 'currency']) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(String(body[key]));
      }
    }
    if (body.archived !== undefined) {
      fields.push('archived = ?');
      values.push(body.archived ? 1 : 0);
    }
    if (body.initial_balance !== undefined) {
      fields.push('initial_balance = ?');
      values.push(Number(body.initial_balance));
    }
    if (body.balance !== undefined) {
      // Adjust the opening balance so the current balance matches the target.
      const target = Number(body.balance);
      const drift = round2(target - accountBalance(id));
      fields.push('initial_balance = ?');
      values.push(round2(acc.initial_balance + drift));
    }
    if (!fields.length) throw bad('没有需要更新的字段');
    db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
    return { ok: true, balance: accountBalance(id) };
  }],

  ['DELETE', /^\/api\/accounts\/(\d+)$/, async ({ req, params }) => {
    requireUser(req);
    const id = Number(params[0]);
    if (!getAccount(id)) throw new HttpError(404, '账户不存在');
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return { ok: true };
  }],

  ['GET', /^\/api\/transactions$/, async ({ req, url }) => {
    requireUser(req);
    const { rows, total } = searchTransactions({
      month: url.searchParams.get('month'),
      accountId: url.searchParams.get('account_id'),
      category: url.searchParams.get('category'),
      q: url.searchParams.get('q'),
      limit: Math.min(Number(url.searchParams.get('limit') || 200), 1000),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return { transactions: rows, total };
  }],

  ['POST', /^\/api\/transactions$/, async ({ req, body }) => {
    requireUser(req);
    const id = addTransaction(body);
    return { id, balance: accountBalance(Number(body.account_id ?? body.accountId)), net_worth: netWorth() };
  }],

  ['PATCH', /^\/api\/transactions\/(\d+)$/, async ({ req, body, params }) => {
    requireUser(req);
    const id = Number(params[0]);
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) throw new HttpError(404, '记录不存在');
    const fields = [];
    const values = [];
    if (body.amount !== undefined) {
      fields.push('amount = ?');
      values.push(parseAmount(body.amount));
    }
    if (body.category !== undefined) {
      fields.push('category = ?');
      values.push(String(body.category).trim());
    }
    if (body.note !== undefined) {
      fields.push('note = ?');
      values.push(String(body.note).trim());
    }
    if (body.date !== undefined) {
      fields.push('date = ?');
      values.push(parseDate(body.date));
    }
    if (body.account_id !== undefined) {
      const accountId = Number(body.account_id);
      if (!getAccount(accountId)) throw bad('账户不存在');
      fields.push('account_id = ?');
      values.push(accountId);
    }
    if (!fields.length) throw bad('没有需要更新的字段');
    db.prepare(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
    return { ok: true };
  }],

  ['DELETE', /^\/api\/transactions\/(\d+)$/, async ({ req, url, params }) => {
    requireUser(req);
    const id = Number(params[0]);
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) throw new HttpError(404, '记录不存在');
    if (url.searchParams.get('transfer') === '1' && tx.transfer_id) {
      db.prepare('DELETE FROM transactions WHERE transfer_id = ?').run(tx.transfer_id);
      return { ok: true, deleted: 2 };
    }
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    return { ok: true, deleted: 1 };
  }],

  ['POST', /^\/api\/transfers$/, async ({ req, body }) => {
    requireUser(req);
    const transferId = addTransfer(body);
    return { transfer_id: transferId, net_worth: netWorth() };
  }],

  ['GET', /^\/api\/categories$/, async ({ req }) => {
    requireUser(req);
    return { categories: db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all() };
  }],

  ['POST', /^\/api\/categories$/, async ({ req, body }) => {
    requireUser(req);
    return { name: upsertCategory(body.name, body.kind, body.icon) };
  }],

  ['DELETE', /^\/api\/categories\/(.+)$/, async ({ req, params }) => {
    requireUser(req);
    const name = decodeURIComponent(params[0]);
    db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    db.prepare('DELETE FROM budgets WHERE category = ?').run(name);
    return { ok: true };
  }],

  ['GET', /^\/api\/budgets$/, async ({ req }) => {
    requireUser(req);
    return { budgets: listBudgets() };
  }],

  ['POST', /^\/api\/budgets$/, async ({ req, body }) => {
    requireUser(req);
    const category = String(body.category || '').trim();
    if (!category) throw bad('请选择分类');
    const limit = Number(body.monthly_limit);
    if (!Number.isFinite(limit) || limit < 0) throw bad('预算金额无效');
    if (limit === 0) {
      db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
      return { ok: true, removed: true };
    }
    db.prepare(
      `INSERT INTO budgets (category, monthly_limit, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = excluded.updated_at`,
    ).run(category, round2(limit), nowIso());
    return { ok: true };
  }],

  ['POST', /^\/api\/import$/, async ({ req, body }) => {
    requireUser(req);
    const rows = Array.isArray(body) ? body : body.rows;
    if (!Array.isArray(rows) || !rows.length) throw bad('没有可导入的数据');
    return importRows(rows, {
      defaultAccountId: body.default_account_id ?? body.defaultAccountId,
      dryRun: !!body.dry_run,
    });
  }],

  ['POST', /^\/api\/import\/csv$/, async ({ req, body }) => {
    requireUser(req);
    const text = typeof body === 'string' ? body : body.csv;
    if (!text) throw bad('CSV 内容为空');
    const table = parseCsv(text);
    if (table.length < 2) throw bad('CSV 至少需要表头和一行数据');
    const map = mapHeader(table[0]);
    if (map.amount === undefined && map.income === undefined && map.expense === undefined) {
      throw bad('CSV 缺少金额列（金额 / 收入 / 支出）');
    }
    const rows = table.slice(1).map((cells) => {
      const pick = (field) => (map[field] === undefined ? undefined : cells[map[field]]);
      return {
        date: pick('date'),
        amount: pick('amount'),
        income: pick('income'),
        expense: pick('expense'),
        category: pick('category'),
        note: pick('note'),
        account: pick('account'),
      };
    });
    const opts = {
      defaultAccountId: typeof body === 'string' ? null : body.default_account_id,
      dryRun: typeof body === 'string' ? false : !!body.dry_run,
    };
    return importRows(rows, opts);
  }],

  ['GET', /^\/api\/export\.json$/, async ({ req }) => {
    requireUser(req);
    const dump = {
      exported_at: nowIso(),
      accounts: listAccounts({ includeArchived: true }),
      transactions: db.prepare('SELECT * FROM transactions ORDER BY date, id').all(),
      categories: db.prepare('SELECT * FROM categories ORDER BY sort_order').all(),
      budgets: listBudgets(),
    };
    return dump;
  }],

  ['GET', /^\/api\/export\.csv$/, async ({ req, res }) => {
    requireUser(req);
    const rows = db
      .prepare(
        `SELECT t.date, t.amount, t.category, t.note, a.name AS account
           FROM transactions t JOIN accounts a ON a.id = t.account_id
          ORDER BY t.date, t.id`,
      )
      .all();
    const csv = toCsv(rows, ['date', 'amount', 'category', 'note', 'account']);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="money-export.csv"',
    });
    res.end(`\uFEFF${csv}`);
    return null;
  }],

  ['POST', /^\/api\/token$/, async ({ req }) => {
    requireUser(req);
    return { token: rotateApiToken() };
  }],

  ['DELETE', /^\/api\/token$/, async ({ req }) => {
    requireUser(req);
    revokeApiToken();
    return { ok: true };
  }],

  // Apple Shortcuts / automation entry point: record one spend in one request.
  ['POST', /^\/api\/quick$/, async ({ req, url, body }) => {
    requireApiAuth(req, url, body);
    let accountId = Number(body.account_id ?? body.accountId ?? 0);
    if (!accountId) {
      const first = listAccounts()[0];
      if (!first) throw bad('还没有账户，请先在网页里添加账户');
      accountId = first.id;
    }
    const raw = body.amount ?? body.text;
    let amount = parseAmount(raw);
    const note = String(body.note || '').trim();
    if (amount > 0) amount = -amount; // default to an expense
    const id = insertTransaction({
      accountId,
      amount,
      category: String(body.category || '其他支出').trim(),
      note,
      date: parseDate(body.date || today()),
    });
    return {
      ok: true,
      id,
      amount,
      account: accountName(accountId),
      balance: accountBalance(accountId),
      net_worth: netWorth(),
    };
  }],

  ['GET', /^\/api\/quick$/, async ({ req, url }) => {
    requireApiAuth(req, url);
    const amount = parseAmount(url.searchParams.get('amount'));
    const accountId = Number(url.searchParams.get('account_id') || 0) || listAccounts()[0]?.id;
    if (!accountId) throw bad('还没有账户，请先在网页里添加账户');
    const id = insertTransaction({
      accountId,
      amount: amount > 0 ? -amount : amount,
      category: url.searchParams.get('category') || '其他支出',
      note: url.searchParams.get('note') || '',
      date: parseDate(url.searchParams.get('date') || today()),
    });
    return { ok: true, id, balance: accountBalance(accountId), net_worth: netWorth() };
  }],
];

function setCookie(req, res, token, expires) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  // Secure cookies are rejected over plain http, which is how you reach the app
  // from a phone on the LAN. Only mark Secure when the request really is https
  // (direct TLS or a proxy that terminates it), unless forced by env.
  const https = req.socket.encrypted === true || forwardedProto(req) === 'https';
  if (SECURE_COOKIE && https) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function forwardedProto(req) {
  const raw = req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'] || '';
  return String(raw).split(',')[0].trim().toLowerCase();
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) throw new HttpError(403, '禁止访问');
  try {
    const data = await readFile(filePath);
    // Never let a proxy or the service worker pin an old build of the app shell.
    const noStore = ['/index.html', '/app.js', '/styles.css', '/sw.js'].includes(rel);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-cache' : 'public, max-age=3600',
      'Service-Worker-Allowed': '/',
    });
    res.end(data);
  } catch {
    // SPA fallback for client-side routes.
    if (!pathname.startsWith('/api/') && !extname(pathname)) {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }
    throw new HttpError(404, '文件不存在');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Token',
    });
    res.end();
    return;
  }

  try {
    for (const [method, pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (!match || req.method !== method) continue;
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await handler({ req, res, url, body, params: match.slice(1) });
      if (result === null || res.writableEnded) return;
      sendJson(res, 200, result);
      return;
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在');
    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, pathname, err);
    sendJson(res, status, { error: err.message || '服务器错误' });
  }
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref?.();

server.listen(PORT, HOST, () => {
  console.log(`💰 理财账本已启动: http://localhost:${PORT}`);
  console.log(`   数据库: ${process.env.MONEY_DB || join(ROOT, 'data', 'money.db')}`);
  if (!hasUser()) console.log('   首次打开网页会引导你设置用户名和密码。');
});
