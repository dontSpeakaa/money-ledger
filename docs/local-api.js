/*
 * 本地模式：没有服务器，全部逻辑跑在浏览器里，数据存 IndexedDB。
 *
 * 这里的业务逻辑是从 server/db.js + server/index.js 原样搬过来的，
 * 目的是让前端 app.js 不用改调用方式就能两种模式通用。
 *
 * driver 是一层可替换的键值存储：
 *   - 浏览器里用 IndexedDB（idbDriver）
 *   - node 测试里用内存对象（memoryDriver）
 * 这样同一份业务逻辑可以在 node 里跑真实测试。
 */

export const DEFAULT_CATEGORIES = [
  ['餐饮', 'expense', '🍜'],
  ['买菜', 'expense', '🛒'],
  ['交通', 'expense', '🚇'],
  ['购物', 'expense', '🛍️'],
  ['居住', 'expense', '🏠'],
  ['水电燃气', 'expense', '💡'],
  ['通讯', 'expense', '📱'],
  ['医疗', 'expense', '💊'],
  ['娱乐', 'expense', '🎬'],
  ['学习', 'expense', '📚'],
  ['人情往来', 'expense', '🎁'],
  ['旅行', 'expense', '✈️'],
  ['订阅服务', 'expense', '🔁'],
  ['还款', 'expense', '💳'],
  ['手续费', 'expense', '🧾'],
  ['其他支出', 'expense', '📦'],
  ['工资', 'income', '💰'],
  ['奖金', 'income', '🏆'],
  ['投资收益', 'income', '📈'],
  ['红包', 'income', '🧧'],
  ['报销', 'income', '🧾'],
  ['其他收入', 'income', '➕'],
];

const STORE = 'kv';
const SESSION_DAYS = 180;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

// ------------------------------------------------------------------ 错误类型

export class LocalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new LocalError(400, msg);
const unauthorized = (msg = '未授权') => new LocalError(401, msg);

// -------------------------------------------------------------------- driver

/** IndexedDB：一个库一个对象仓库，键值对。 */
export function idbDriver(name = 'money-local') {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      try {
        out = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      // IDBRequest 本身不可被结构化克隆，必须取它的 result（键不存在时是 undefined）。
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    async get(key) {
      return tx('readonly', (s) => s.get(key));
    },
    async set(key, value) {
      return tx('readwrite', (s) => s.put(value, key));
    },
    async del(key) {
      return tx('readwrite', (s) => s.delete(key));
    },
    async keys() {
      return tx('readonly', (s) => s.getAllKeys());
    },
  };
}

/** 内存 driver，仅用于 node 测试。 */
export function memoryDriver() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    async get(key) {
      return clone(m.get(key));
    },
    async set(key, value) {
      m.set(key, clone(value));
    },
    async del(key) {
      m.delete(key);
    },
    async keys() {
      return [...m.keys()];
    },
  };
}

// ------------------------------------------------------------------ 数据访问

/*
 * 每次操作都从 driver 读一份完整快照、改完写回。
 * 单用户、数据量小（几千条），这样最简单也最不容易出错；
 * 写入前用内存里的写队列串行化，避免并发写互相覆盖。
 */
export function createStore(driver) {
  const K = {
    accounts: 'accounts',
    tx: 'transactions',
    categories: 'categories',
    budgets: 'budgets',
    meta: 'meta',
  };
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const read = async (key, fallback) => {
    const v = await driver.get(key);
    return v === undefined || v === null ? fallback : v;
  };
  const write = (key, value) => driver.set(key, value);

  return {
    driver,

    async state() {
      const [accounts, tx, categories, budgets, meta] = await Promise.all([
        read(K.accounts, []),
        read(K.tx, []),
        read(K.categories, []),
        read(K.budgets, []),
        read(K.meta, {}),
      ]);
      return { accounts, tx, categories, budgets, meta };
    },

    /** 读改写一体，串行执行。mutator 收到快照，可以改并返回结果。 */
    async mutate(mutator) {
      return serialize(async () => {
        const s = await this.state();
        const result = await mutator(s);
        await Promise.all([
          write(K.accounts, s.accounts),
          write(K.tx, s.tx),
          write(K.categories, s.categories),
          write(K.budgets, s.budgets),
          write(K.meta, s.meta),
        ]);
        return result;
      });
    },

    async init() {
      return this.mutate((s) => {
        if (!s.categories.length) {
          s.categories = DEFAULT_CATEGORIES.map(([name, kind, icon], i) => ({
            id: i + 1,
            name,
            kind,
            icon,
            sort_order: i,
          }));
        }
      });
    },
  };
}

// -------------------------------------------------------------- 派生计算

const accountBalanceIn = (s, id) =>
  round2(
    (s.accounts.find((a) => a.id === Number(id))?.initial_balance || 0) +
      s.tx.filter((t) => t.account_id === Number(id)).reduce((sum, t) => sum + t.amount, 0),
  );

const netWorthIn = (s) =>
  round2(
    s.accounts.filter((a) => !a.archived).reduce((sum, a) => sum + a.initial_balance, 0) +
      s.tx
        .filter((t) => s.accounts.some((a) => a.id === t.account_id && !a.archived))
        .reduce((sum, t) => sum + t.amount, 0),
  );

function listAccountsIn(s, { includeArchived = false } = {}) {
  return s.accounts
    .filter((a) => includeArchived || !a.archived)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((a) => ({
      // 只暴露服务端 listAccounts() 里 SELECT 的那几列，保持两边返回一致。
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      initial_balance: a.initial_balance,
      archived: !!a.archived,
      sort_order: a.sort_order,
      balance: accountBalanceIn(s, a.id),
      tx_count: s.tx.filter((t) => t.account_id === a.id).length,
    }));
}

/** 只保留 category / monthly_limit，与服务端 listBudgets() 的 SELECT 一致。 */
const plainBudgets = (s) =>
  [...s.budgets]
    .sort((a, b) => (a.category < b.category ? -1 : 1))
    .map((b) => ({ category: b.category, monthly_limit: b.monthly_limit }));

function monthSummaryIn(s, month) {
  const rows = s.tx.filter((t) => t.date.slice(0, 7) === month);
  return {
    income: round2(rows.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0)),
    expense: round2(rows.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0)),
    count: rows.length,
  };
}

function categoryTotalsIn(s, month) {
  const map = new Map();
  for (const t of s.tx) {
    if (t.date.slice(0, 7) !== month) continue;
    const cur = map.get(t.category) || { category: t.category, total: 0, n: 0 };
    cur.total += t.amount;
    cur.n += 1;
    map.set(t.category, cur);
  }
  return [...map.values()]
    .map((r) => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => a.total - b.total);
}

function monthlyTrendIn(s, months = 6) {
  const map = new Map();
  for (const t of s.tx) {
    const m = t.date.slice(0, 7);
    const cur = map.get(m) || { month: m, income: 0, expense: 0 };
    if (t.amount > 0) cur.income += t.amount;
    else cur.expense -= t.amount;
    map.set(m, cur);
  }
  return [...map.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, months)
    .map((r) => ({ ...r, income: round2(r.income), expense: round2(r.expense) }))
    .reverse();
}

function searchIn(s, { month, accountId, category, q, limit = 200, offset = 0 }) {
  const nameOf = (id) => s.accounts.find((a) => a.id === id)?.name || '已删除账户';
  let rows = s.tx.filter((t) => s.accounts.some((a) => a.id === t.account_id));
  if (month) rows = rows.filter((t) => t.date.slice(0, 7) === month);
  if (accountId) rows = rows.filter((t) => t.account_id === Number(accountId));
  if (category) rows = rows.filter((t) => t.category === category);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (t) =>
        String(t.note).toLowerCase().includes(needle) ||
        String(t.category).toLowerCase().includes(needle),
    );
  }
  const total = rows.length;
  rows = rows
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
    .slice(Number(offset), Number(offset) + Number(limit))
    .map((t) => ({ ...t, account_name: nameOf(t.account_id) }));
  return { rows, total };
}

function summaryIn(s, month) {
  const spent = Object.fromEntries(categoryTotalsIn(s, month).map((r) => [r.category, -r.total]));
  return {
    month,
    net_worth: netWorthIn(s),
    month_summary: monthSummaryIn(s, month),
    accounts: listAccountsIn(s),
    by_category: categoryTotalsIn(s, month).filter((r) => r.total < 0),
    trend: monthlyTrendIn(s, 6),
    budgets: plainBudgets(s).map((b) => ({
      ...b,
      spent: round2(spent[b.category] || 0),
      ratio: b.monthly_limit > 0 ? round2((spent[b.category] || 0) / b.monthly_limit) : 0,
    })),
  };
}

// ------------------------------------------------------------------ 工具函数

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

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

export function parseCsv(text) {
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

// ------------------------------------------------------------------- 哈希

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
      key,
      hashHex.length * 4,
    );
    const got = toHex(bits);
    // 定长比较，避免按字节提前返回。
    if (got.length !== hashHex.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

const randomId = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// ------------------------------------------------------------------- 主入口

/** 构造一个和服务器 API 行为一致的本地实现。 */
export function createLocalApi(driver) {
  const store = createStore(driver);
  const nextId = (rows) => (rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1);

  async function insertTransaction(s, { accountId, amount, category = '', note = '', date, transferId = null }) {
    const id = nextId(s.tx);
    s.tx.push({
      id,
      account_id: Number(accountId),
      amount: round2(amount),
      category,
      note,
      date,
      transfer_id: transferId,
      created_at: nowIso(),
    });
    return id;
  }

  async function upsertCategory(s, name, kind, icon) {
    const clean = String(name || '').trim();
    if (!clean) throw bad('分类名称不能为空');
    const existing = s.categories.find((c) => c.name === clean);
    if (existing) {
      existing.kind = kind === 'income' ? 'income' : 'expense';
      if (icon && icon !== '🏷️') existing.icon = String(icon);
    } else {
      s.categories.push({
        id: nextId(s.categories),
        name: clean,
        kind: kind === 'income' ? 'income' : 'expense',
        icon: String(icon || '🏷️'),
        sort_order: s.categories.length,
      });
    }
    return clean;
  }

  function importRows(s, rows, { defaultAccountId, dryRun = false, source = 'import' }) {
    const report = { imported: 0, skipped: 0, errors: [], preview: [] };
    const fallback = defaultAccountId ? Number(defaultAccountId) : null;
    const seen = new Set(s.tx.map((r) => `${r.account_id}|${r.date}|${round2(r.amount)}|${r.note}`));

    rows.forEach((raw, i) => {
      const lineNo = i + 1;
      try {
        let accountId = Number(raw.account_id ?? raw.accountId ?? fallback);
        if (raw.account && !accountId) {
          const found = s.accounts.find((a) => a.name === String(raw.account).trim());
          if (found) accountId = found.id;
        }
        if (!s.accounts.some((a) => a.id === accountId)) throw new Error('找不到账户');

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
          if (report.preview.length < 50) report.preview.push({ line: lineNo, status: '重复跳过', date, amount, note });
          return;
        }
        seen.add(key);
        const category = String(raw.category || '').trim() || (amount > 0 ? '其他收入' : '其他支出');
        if (!dryRun) {
          const id = nextId(s.tx);
          s.tx.push({
            id,
            account_id: accountId,
            amount,
            category,
            note: note || source,
            date,
            transfer_id: null,
            created_at: nowIso(),
          });
        }
        report.imported += 1;
        if (report.preview.length < 50) report.preview.push({ line: lineNo, status: '导入', date, amount, category, note });
      } catch (err) {
        report.skipped += 1;
        if (report.errors.length < 50) report.errors.push({ line: lineNo, message: err.message });
      }
    });
    return report;
  }

  /** 处理一个请求。返回结构和服务器 JSON 响应一致。 */
  async function handle(path, { method = 'GET', body } = {}) {
    const url = new URL(path, 'http://local');
    const p = url.pathname;
    const q = url.searchParams;
    const b = body || {};

    await store.init();

    // ---- 会话 / 账号 ----
    if (p === '/api/health') return { ok: true, time: nowIso() };

    if (p === '/api/me') {
      const s = await store.state();
      const user = s.meta.user;
      return {
        setup_required: !user,
        authenticated: !!s.meta.session,
        username: s.meta.session ? user?.username ?? null : null,
        has_api_token: false,
      };
    }

    if (p === '/api/setup') {
      const username = String(b.username || 'me').trim();
      const password = String(b.password || '');
      if (password.length < 6) throw bad('密码至少 6 位');
      const hash = await hashPassword(password);
      await store.mutate((s) => {
        if (s.meta.user) throw new LocalError(409, '已完成初始化');
        s.meta.user = { username, password_hash: hash, created_at: nowIso() };
        s.meta.session = { created_at: nowIso(), expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() };
      });
      return { ok: true, username };
    }

    if (p === '/api/login') {
      const s = await store.state();
      const user = s.meta.user;
      if (!user || !(await verifyPassword(b.password, user.password_hash))) {
        throw new LocalError(401, '用户名或密码错误');
      }
      await store.mutate((st) => {
        st.meta.session = { created_at: nowIso(), expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() };
      });
      return { ok: true, username: user.username };
    }

    if (p === '/api/logout') {
      await store.mutate((s) => {
        delete s.meta.session;
      });
      return { ok: true };
    }

    // 以下接口都要求已登录。
    const guard = async () => {
      const s = await store.state();
      if (!s.meta.session) throw unauthorized('未登录');
      return s;
    };

    if (p === '/api/password') {
      await guard();
      const user = (await store.state()).meta.user;
      if (!(await verifyPassword(b.current_password, user.password_hash))) {
        throw new LocalError(401, '当前密码不正确');
      }
      const next = String(b.new_password || '');
      if (next.length < 6) throw bad('新密码至少 6 位');
      const hash = await hashPassword(next);
      await store.mutate((s) => {
        s.meta.user.password_hash = hash;
        delete s.meta.session; // 改密后需要重新登录
      });
      return { ok: true, relogin: true };
    }

    if (p === '/api/summary') {
      const s = await guard();
      return summaryIn(s, q.get('month') || currentMonth());
    }

    // ---- 账户 ----
    if (p === '/api/accounts' && method === 'GET') {
      const s = await guard();
      return { accounts: listAccountsIn(s, { includeArchived: q.get('all') === '1' }) };
    }

    if (p === '/api/accounts' && method === 'POST') {
      await guard();
      const name = String(b.name || '').trim();
      if (!name) throw bad('账户名称不能为空');
      const id = await store.mutate((s) => {
        const newId = nextId(s.accounts);
        s.accounts.push({
          id: newId,
          name,
          type: String(b.type || 'bank'),
          currency: String(b.currency || 'CNY'),
          initial_balance: Number(b.initial_balance || 0),
          archived: 0,
          sort_order: s.accounts.length ? Math.max(...s.accounts.map((a) => a.sort_order)) + 1 : 0,
          created_at: nowIso(),
        });
        return newId;
      });
      return { id };
    }

    const accMatch = p.match(/^\/api\/accounts\/(\d+)$/);
    if (accMatch && method === 'PATCH') {
      const id = Number(accMatch[1]);
      const balance = await store.mutate((s) => {
        const acc = s.accounts.find((a) => a.id === id);
        if (!acc) throw new LocalError(404, '账户不存在');
        if (b.name !== undefined) acc.name = String(b.name);
        if (b.type !== undefined) acc.type = String(b.type);
        if (b.currency !== undefined) acc.currency = String(b.currency);
        if (b.archived !== undefined) acc.archived = b.archived ? 1 : 0;
        if (b.initial_balance !== undefined) acc.initial_balance = Number(b.initial_balance);
        if (b.balance !== undefined) {
          // 调整期初余额，使当前余额等于目标值。
          const drift = round2(Number(b.balance) - accountBalanceIn(s, id));
          acc.initial_balance = round2(acc.initial_balance + drift);
        }
        return accountBalanceIn(s, id);
      });
      return { ok: true, balance };
    }

    if (accMatch && method === 'DELETE') {
      const id = Number(accMatch[1]);
      await store.mutate((s) => {
        if (!s.accounts.some((a) => a.id === id)) throw new LocalError(404, '账户不存在');
        s.accounts = s.accounts.filter((a) => a.id !== id);
        s.tx = s.tx.filter((t) => t.account_id !== id);
      });
      return { ok: true };
    }

    // ---- 流水 ----
    if (p === '/api/transactions' && method === 'GET') {
      const s = await guard();
      const { rows, total } = searchIn(s, {
        month: q.get('month'),
        accountId: q.get('account_id'),
        category: q.get('category'),
        q: q.get('q'),
        limit: Math.min(Number(q.get('limit') || 200), 1000),
        offset: Number(q.get('offset') || 0),
      });
      return { transactions: rows, total };
    }

    if (p === '/api/transactions' && method === 'POST') {
      await guard();
      const accountId = Number(b.account_id ?? b.accountId);
      const amount = parseAmount(b.amount);
      const res = await store.mutate(async (s) => {
        if (!s.accounts.some((a) => a.id === accountId)) throw bad('账户不存在');
        const id = await insertTransaction(s, {
          accountId,
          amount,
          category: String(b.category || '').trim(),
          note: String(b.note || '').trim(),
          date: parseDate(b.date || today()),
        });
        return { id, balance: accountBalanceIn(s, accountId), net_worth: netWorthIn(s) };
      });
      return res;
    }

    const txMatch = p.match(/^\/api\/transactions\/(\d+)$/);
    if (txMatch && method === 'PATCH') {
      const id = Number(txMatch[1]);
      await store.mutate((s) => {
        const tx = s.tx.find((t) => t.id === id);
        if (!tx) throw new LocalError(404, '记录不存在');
        if (b.amount !== undefined) tx.amount = parseAmount(b.amount);
        if (b.category !== undefined) tx.category = String(b.category).trim();
        if (b.note !== undefined) tx.note = String(b.note).trim();
        if (b.date !== undefined) tx.date = parseDate(b.date);
        if (b.account_id !== undefined) {
          const accountId = Number(b.account_id);
          if (!s.accounts.some((a) => a.id === accountId)) throw bad('账户不存在');
          tx.account_id = accountId;
        }
      });
      return { ok: true };
    }

    if (txMatch && method === 'DELETE') {
      const id = Number(txMatch[1]);
      const deleted = await store.mutate((s) => {
        const tx = s.tx.find((t) => t.id === id);
        if (!tx) throw new LocalError(404, '记录不存在');
        if (q.get('transfer') === '1' && tx.transfer_id) {
          const n = s.tx.filter((t) => t.transfer_id === tx.transfer_id).length;
          s.tx = s.tx.filter((t) => t.transfer_id !== tx.transfer_id);
          return n;
        }
        s.tx = s.tx.filter((t) => t.id !== id);
        return 1;
      });
      return { ok: true, deleted };
    }

    if (p === '/api/transfers' && method === 'POST') {
      await guard();
      const fromId = Number(b.from_account_id ?? b.fromAccountId);
      const toId = Number(b.to_account_id ?? b.toAccountId);
      const amount = Math.abs(parseAmount(b.amount));
      const res = await store.mutate(async (s) => {
        if (!s.accounts.some((a) => a.id === fromId) || !s.accounts.some((a) => a.id === toId)) {
          throw bad('账户不存在');
        }
        if (fromId === toId) throw bad('转出与转入账户不能相同');
        const date = parseDate(b.date || today());
        const note = String(b.note || '').trim();
        const transferId = `tr_${Date.now()}_${randomId().slice(0, 6)}`;
        await insertTransaction(s, { accountId: fromId, amount: -amount, category: '转账', note, date, transferId });
        await insertTransaction(s, { accountId: toId, amount, category: '转账', note, date, transferId });
        return { transfer_id: transferId, net_worth: netWorthIn(s) };
      });
      return res;
    }

    // ---- 分类 ----
    if (p === '/api/categories' && method === 'GET') {
      const s = await guard();
      return {
        categories: [...s.categories].sort((a, b2) => a.sort_order - b2.sort_order || a.id - b2.id),
      };
    }

    if (p === '/api/categories' && method === 'POST') {
      await guard();
      const name = await store.mutate((s) => upsertCategory(s, b.name, b.kind, b.icon));
      return { name };
    }

    const catMatch = p.match(/^\/api\/categories\/(.+)$/);
    if (catMatch && method === 'DELETE') {
      await guard();
      const name = decodeURIComponent(catMatch[1]);
      await store.mutate((s) => {
        s.categories = s.categories.filter((c) => c.name !== name);
        s.budgets = s.budgets.filter((x) => x.category !== name);
      });
      return { ok: true };
    }

    // ---- 预算 ----
    if (p === '/api/budgets' && method === 'GET') {
      const s = await guard();
      return { budgets: plainBudgets(s) };
    }

    if (p === '/api/budgets' && method === 'POST') {
      await guard();
      const category = String(b.category || '').trim();
      if (!category) throw bad('请选择分类');
      const limit = Number(b.monthly_limit);
      if (!Number.isFinite(limit) || limit < 0) throw bad('预算金额无效');
      return store.mutate((s) => {
        s.budgets = s.budgets.filter((x) => x.category !== category);
        if (limit === 0) return { ok: true, removed: true };
        s.budgets.push({ category, monthly_limit: round2(limit), updated_at: nowIso() });
        return { ok: true };
      });
    }

    // ---- 导入 ----
    if (p === '/api/import' && method === 'POST') {
      await guard();
      const rows = Array.isArray(body) ? body : b.rows;
      if (!Array.isArray(rows) || !rows.length) throw bad('没有可导入的数据');
      return store.mutate((s) =>
        importRows(s, rows, {
          defaultAccountId: b.default_account_id ?? b.defaultAccountId,
          dryRun: !!b.dry_run,
        }),
      );
    }

    if (p === '/api/import/csv' && method === 'POST') {
      await guard();
      const text = typeof body === 'string' ? body : b.csv;
      if (!text) throw bad('CSV 内容为空');
      const table = parseCsv(text);
      if (table.length < 2) throw bad('CSV 至少需要表头和一行数据');
      const map = mapHeader(table[0]);
      if (map.amount === undefined && map.income === undefined && map.expense === undefined) {
        throw bad('CSV 缺少金额列（金额 / 收入 / 支出）');
      }
      const rows = table.slice(1).map((cells) => {
        const pick = (f) => (map[f] === undefined ? undefined : cells[map[f]]);
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
      return store.mutate((s) =>
        importRows(s, rows, {
          defaultAccountId: typeof body === 'string' ? null : b.default_account_id,
          dryRun: typeof body === 'string' ? false : !!b.dry_run,
        }),
      );
    }

    // ---- 导出 ----
    if (p === '/api/export.json') {
      const s = await guard();
      return {
        exported_at: nowIso(),
        accounts: listAccountsIn(s, { includeArchived: true }),
        transactions: [...s.tx].sort((a, b2) => (a.date === b2.date ? a.id - b2.id : a.date < b2.date ? -1 : 1)),
        categories: [...s.categories].sort((a, b2) => a.sort_order - b2.sort_order),
        budgets: plainBudgets(s),
      };
    }

    if (p === '/api/export.csv') {
      const s = await guard();
      const nameOf = (id) => s.accounts.find((a) => a.id === id)?.name || '已删除账户';
      const rows = [...s.tx]
        .sort((a, b2) => (a.date === b2.date ? a.id - b2.id : a.date < b2.date ? -1 : 1))
        .map((t) => ({ date: t.date, amount: t.amount, category: t.category, note: t.note, account: nameOf(t.account_id) }));
      return { __csv: toCsv(rows, ['date', 'amount', 'category', 'note', 'account']) };
    }

    // ---- 整库备份 / 恢复 ----
    if (p === '/api/backup') {
      const s = await guard();
      return {
        format: 'money-local-backup',
        version: 1,
        exported_at: nowIso(),
        accounts: s.accounts,
        transactions: s.tx,
        categories: s.categories,
        budgets: s.budgets,
      };
    }

    if (p === '/api/restore' && method === 'POST') {
      await guard();
      const data = b.data || b;
      if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)) {
        throw bad('备份文件格式不正确');
      }
      await store.mutate((s) => {
        s.accounts = data.accounts;
        s.tx = data.transactions;
        if (Array.isArray(data.categories) && data.categories.length) s.categories = data.categories;
        if (Array.isArray(data.budgets)) s.budgets = data.budgets;
      });
      return { ok: true, accounts: data.accounts.length, transactions: data.transactions.length };
    }

    if (p === '/api/wipe' && method === 'POST') {
      await guard();
      await store.mutate((s) => {
        s.accounts = [];
        s.tx = [];
        s.budgets = [];
        s.categories = DEFAULT_CATEGORIES.map(([name, kind, icon], i) => ({
          id: i + 1,
          name,
          kind,
          icon,
          sort_order: i,
        }));
      });
      return { ok: true };
    }

    // 快捷指令 / 自动化在纯手机模式下不可用（没有公网地址可调用）。
    if (p === '/api/token' || p === '/api/quick') {
      throw bad('纯手机模式没有公网地址，快捷指令不可用。');
    }

    throw new LocalError(404, `未知接口：${p}`);
  }

  return { handle, store, ready: () => store.init() };
}
