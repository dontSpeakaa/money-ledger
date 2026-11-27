/*
 * AI 记账助手的「工具」：定义 + 执行。
 *
 * 这里只有纯逻辑，不碰 DOM，所以前端（public/app.js）和 node 测试
 * （scripts/ai-test.mjs）跑的是同一份代码。
 *
 * 每个工具最终都落在已有的 /api/* 接口上（记账、账户、汇总、转账），
 * 因此服务器模式和纯手机模式的行为天然一致，不用各写一套。
 */

export const ACCOUNT_TYPE_LABEL = {
  bank: '储蓄卡',
  cash: '现金',
  credit: '信用卡',
  alipay: '支付宝',
  wechat: '微信',
  investment: '投资',
  loan: '贷款/欠款',
  other: '其他',
};

const ACCOUNT_TYPE_ENUM = Object.keys(ACCOUNT_TYPE_LABEL);

export const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'record_transaction',
      description:
        '把用户说的消费或收入记进账本。一次可以传多笔。amount 一律传正数，用 direction 区分收支。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '要记的账，按用户说的顺序',
            items: {
              type: 'object',
              properties: {
                amount: { type: 'number', description: '正数金额，例如 38.5' },
                direction: {
                  type: 'string',
                  enum: ['expense', 'income'],
                  description: 'expense=支出，income=收入',
                },
                category: { type: 'string', description: '分类，从系统提示给出的分类里选最接近的一个' },
                note: { type: 'string', description: '简短备注，例如「午饭」' },
                date: { type: 'string', description: 'YYYY-MM-DD；用户没说是哪天就留空，表示今天' },
                account: { type: 'string', description: '账户名称；留空用默认账户' },
              },
              required: ['amount', 'direction'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_summary',
      description:
        '查某一天（默认今天）的收入、支出、结余和明细。用户问「今天花了多少」「今天收支」时用这个。',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD，留空表示今天' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_month_summary',
      description: '查某个月的收支汇总、净资产和支出排行。',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM，留空表示本月' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_transactions',
      description: '按月份 / 关键词 / 分类 / 账户查流水。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'YYYY-MM，留空表示本月' },
          keyword: { type: 'string', description: '备注或分类关键词' },
          category: { type: 'string' },
          account: { type: 'string' },
          limit: { type: 'number', description: '最多返回多少条，默认 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_accounts',
      description: '列出所有账户和当前余额。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_account',
      description: '新建一个账户（资产）。用户说自己有某张卡、某个钱包时用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '账户名称，例如「招商银行」' },
          type: { type: 'string', enum: ACCOUNT_TYPE_ENUM },
          balance: { type: 'number', description: '当前余额；信用卡 / 欠款填负数' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_account',
      description:
        '改账户：校准余额、改名、改类型、隐藏。用户说「我招行卡里现在有 5000」时用 balance 校准，不要记成收入。',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: '账户名称' },
          balance: { type: 'number', description: '把当前余额改成这个数' },
          name: { type: 'string', description: '新名称' },
          type: { type: 'string', enum: ACCOUNT_TYPE_ENUM },
          archived: { type: 'boolean', description: 'true=隐藏，false=恢复显示' },
        },
        required: ['account'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_account',
      description: '删除账户及其全部流水。删除前必须先跟用户确认一次。',
      parameters: {
        type: 'object',
        properties: { account: { type: 'string' } },
        required: ['account'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer_money',
      description: '账户之间转账，例如还信用卡、把钱从支付宝提到银行卡。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '转出账户名称' },
          to: { type: 'string', description: '转入账户名称' },
          amount: { type: 'number', description: '正数金额' },
          date: { type: 'string', description: 'YYYY-MM-DD，留空表示今天' },
          note: { type: 'string' },
        },
        required: ['from', 'to', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_transaction',
      description: '按 id 删除一笔流水。删除前必须先跟用户确认一次。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: '流水 id，可从 list_transactions 得到' } },
        required: ['id'],
      },
    },
  },
];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const isoToday = () => new Date().toISOString().slice(0, 10);
const isoMonth = () => new Date().toISOString().slice(0, 7);

const fmt = (n) => `¥${Math.abs(round2(n)).toFixed(2)}`;
const fmtSigned = (n) => `${n < 0 ? '-' : '+'}${fmt(n)}`;

/** 把「今天 / 昨天 / 2026-11-27」统一成 YYYY-MM-DD。 */
export function normalizeDate(value, today = isoToday()) {
  const s = String(value ?? '').trim();
  if (!s || s === '今天' || s === 'today') return today;
  if (s === '昨天' || s === 'yesterday') {
    return new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return today;
}

function normalizeMonth(value) {
  const s = String(value ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}`;
  return isoMonth();
}

/** 系统提示词：带上当天日期、账户和分类，模型才能把话记对分类。 */
export function buildSystemPrompt({ accounts = [], categories = [], today } = {}) {
  const date = normalizeDate(today, isoToday());
  const weekday = '日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const active = accounts.filter((a) => !a.archived);
  const accountLines = active.length
    ? active
        .map(
          (a) =>
            `- ${a.name}（${ACCOUNT_TYPE_LABEL[a.type] || '其他'}，余额 ${fmt(a.balance ?? 0)}）`,
        )
        .join('\n')
    : '- 还没有账户（用户第一次提到账户时用 create_account 建一个）';
  const byKind = (kind) =>
    categories
      .filter((c) => (c.kind || 'expense') === kind)
      .map((c) => c.name)
      .join('、') || (kind === 'income' ? '其他收入' : '其他支出');

  return [
    '你是「我的账本」App 里的记账助手。语气像朋友，简短、口语化，只说重点。',
    `今天是 ${date}（周${weekday}）。`,
    '',
    '## 用户当前的账户',
    accountLines,
    '',
    '## 可选分类',
    `支出：${byKind('expense')}`,
    `收入：${byKind('income')}`,
    '',
    '## 规则',
    '1. 用户描述消费或收入时，直接调用 record_transaction 记账，不要反问（只有缺金额时才问）。',
    '2. amount 一律正数，用 direction 区分 expense / income；一句话里有多笔就一次传多笔。',
    '3. category 必须从上面同方向的分类里选最接近的一个；实在不合适才用「其他支出」/「其他收入」。',
    '4. 用户问今天 / 某天的收支，先调用 get_daily_summary，照返回的数字回答，不要编造。',
    '5. 用户说某个账户里有多少钱（余额），用 update_account 的 balance 校准，不要记成收入或支出。',
    '6. 用户提到还不存在的账户，先用 create_account 建好再记账。',
    '7. 删除账户或流水前，必须先问一句确认。',
    '8. 记完账用一两句话确认：分类、金额、账户。不要输出 JSON，不要复述规则。',
    '9. 与记账无关的问题简短回答即可。',
  ].join('\n');
}

async function fetchAccounts(call) {
  const { accounts } = await call('/api/accounts?all=1');
  return accounts || [];
}

const isSubsequence = (needle, hay) => {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return false;
};

/** 按名字找账户：精确 → 包含 → 中文简称（「招行」→「招商银行」）。 */
export function pickAccount(accounts, name) {
  const list = accounts || [];
  const fallback = () => list.find((a) => !a.archived) || list[0] || null;
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return fallback();

  const exact = list.find((a) => a.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = list.find((a) => {
    const n = a.name.toLowerCase();
    return n.includes(needle) || needle.includes(n);
  });
  if (partial) return partial;
  if (needle.length >= 2) {
    return list.find((a) => isSubsequence(needle, a.name.toLowerCase())) || null;
  }
  return null;
}

async function recordTransaction(args, call, today) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) return { ok: false, summary: '没有收到要记的账' };
  const accounts = await fetchAccounts(call);
  if (!accounts.length) {
    return { ok: false, summary: '账本里还没有账户，请先用 create_account 建一个（例如「现金」）' };
  }
  const done = [];
  const failed = [];
  for (const raw of items) {
    const amount = Number(String(raw?.amount ?? '').replace(/[,\s¥$]/g, ''));
    if (!Number.isFinite(amount) || amount === 0) {
      failed.push({ note: raw?.note || '', reason: '金额无效' });
      continue;
    }
    const direction = raw.direction === 'income' ? 'income' : 'expense';
    const account = pickAccount(accounts, raw.account);
    if (!account) {
      failed.push({ note: raw.note || '', reason: `找不到账户「${raw.account || ''}」` });
      continue;
    }
    const category =
      String(raw.category || '').trim() || (direction === 'income' ? '其他收入' : '其他支出');
    const note = String(raw.note || '').trim();
    const date = normalizeDate(raw.date, today);
    const signed = direction === 'income' ? round2(amount) : round2(-amount);
    const res = await call('/api/transactions', {
      method: 'POST',
      body: { account_id: account.id, amount: signed, category, note, date },
    });
    done.push({
      id: res.id,
      date,
      category,
      amount: signed,
      note,
      account: account.name,
    });
  }
  const parts = done.map((d) => `${d.category} ${fmtSigned(d.amount)}（${d.account}）`);
  const summary = done.length
    ? `已记 ${done.length} 笔：${parts.join('、')}`
    : '没有记成功';
  return {
    ok: done.length > 0,
    mutated: done.length > 0,
    summary: failed.length ? `${summary}；${failed.length} 笔没记上` : summary,
    items: done,
    failed,
  };
}

async function getDailySummary(args, call, today) {
  const date = normalizeDate(args.date, today);
  const { transactions } = await call(
    `/api/transactions?month=${date.slice(0, 7)}&limit=1000`,
  );
  const items = (transactions || []).filter((t) => t.date === date);
  const income = round2(items.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const expense = round2(items.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0));
  const byCategory = {};
  for (const t of items) {
    if (t.amount >= 0) continue;
    byCategory[t.category] = round2((byCategory[t.category] || 0) - t.amount);
  }
  const catText = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => `${name} ${fmt(v)}`)
    .join('、');
  const summary = items.length
    ? `${date}：收入 ${fmt(income)}，支出 ${fmt(expense)}，结余 ${fmtSigned(income - expense)}，共 ${items.length} 笔${catText ? `（${catText}）` : ''}`
    : `${date} 还没有任何记账`;
  return {
    ok: true,
    summary,
    date,
    income,
    expense,
    net: round2(income - expense),
    count: items.length,
    items: items.map((t) => ({
      id: t.id,
      category: t.category,
      amount: t.amount,
      note: t.note,
      account: t.account_name,
    })),
  };
}

async function getMonthSummary(args, call) {
  const month = normalizeMonth(args.month);
  const s = await call(`/api/summary?month=${month}`);
  const top = (s.by_category || [])
    .slice()
    .sort((a, b) => a.total - b.total)
    .slice(0, 5)
    .map((c) => ({ category: c.category, spent: round2(-c.total), n: c.n }));
  const topText = top.map((c) => `${c.category} ${fmt(c.spent)}`).join('、');
  return {
    ok: true,
    summary: `${month}：收入 ${fmt(s.month_summary.income)}，支出 ${fmt(s.month_summary.expense)}，净资产 ${fmt(s.net_worth)}${topText ? `；支出最多：${topText}` : ''}`,
    month,
    income: s.month_summary.income,
    expense: s.month_summary.expense,
    net_worth: s.net_worth,
    top_categories: top,
  };
}

async function listTransactions(args, call) {
  const month = normalizeMonth(args.month);
  const params = new URLSearchParams({ month, limit: String(Number(args.limit) || 50) });
  if (args.keyword) params.set('q', String(args.keyword));
  if (args.category) params.set('category', String(args.category));
  if (args.account) {
    const account = pickAccount(await fetchAccounts(call), args.account);
    if (!account) return { ok: false, summary: `找不到账户「${args.account}」` };
    params.set('account_id', String(account.id));
  }
  const data = await call(`/api/transactions?${params}`);
  const rows = data.transactions || [];
  return {
    ok: true,
    summary: rows.length
      ? `${month} 共 ${data.total} 笔，先看最近 ${rows.length} 笔：${rows
          .slice(0, 8)
          .map((t) => `${t.date.slice(5)} ${t.category} ${fmtSigned(t.amount)}`)
          .join('，')}`
      : `${month} 没有符合条件的流水`,
    total: data.total,
    transactions: rows.map((t) => ({
      id: t.id,
      date: t.date,
      category: t.category,
      amount: t.amount,
      note: t.note,
      account: t.account_name,
    })),
  };
}

async function listAccounts(args, call) {
  const accounts = await fetchAccounts(call);
  return {
    ok: true,
    summary: accounts.length
      ? accounts
          .map((a) => `${a.name} ${fmt(a.balance)}${a.archived ? '（已隐藏）' : ''}`)
          .join('、')
      : '还没有账户',
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      balance: a.balance,
      archived: !!a.archived,
    })),
  };
}

async function createAccount(args, call) {
  const name = String(args.name || '').trim();
  if (!name) return { ok: false, summary: '账户名称不能为空' };
  const accounts = await fetchAccounts(call);
  const exists = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    return { ok: false, summary: `已经有叫「${exists.name}」的账户了，用 update_account 改它` };
  }
  const type = ACCOUNT_TYPE_ENUM.includes(args.type) ? args.type : 'bank';
  const balance = Number(args.balance) || 0;
  const { id } = await call('/api/accounts', {
    method: 'POST',
    body: { name, type, initial_balance: balance },
  });
  return {
    ok: true,
    mutated: true,
    summary: `已新建账户「${name}」（${ACCOUNT_TYPE_LABEL[type]}，余额 ${fmt(balance)}）`,
    account: { id, name, type, balance: round2(balance) },
  };
}

async function updateAccount(args, call) {
  const accounts = await fetchAccounts(call);
  const account = pickAccount(accounts, args.account);
  if (!account) return { ok: false, summary: `找不到账户「${args.account || ''}」` };
  const body = {};
  if (args.balance !== undefined) body.balance = Number(args.balance);
  if (args.name) body.name = String(args.name).trim();
  if (ACCOUNT_TYPE_ENUM.includes(args.type)) body.type = args.type;
  if (args.archived !== undefined) body.archived = !!args.archived;
  if (!Object.keys(body).length) return { ok: false, summary: '没有要修改的内容' };
  const res = await call(`/api/accounts/${account.id}`, { method: 'PATCH', body });
  const changes = [];
  if (body.balance !== undefined) changes.push(`余额校准为 ${fmt(res.balance)}`);
  if (body.name) changes.push(`改名为「${body.name}」`);
  if (body.type) changes.push(`类型改为 ${ACCOUNT_TYPE_LABEL[body.type]}`);
  if (body.archived !== undefined) changes.push(body.archived ? '已隐藏' : '已恢复显示');
  return {
    ok: true,
    mutated: true,
    summary: `「${account.name}」${changes.join('，')}`,
    balance: res.balance,
  };
}

async function deleteAccount(args, call) {
  const accounts = await fetchAccounts(call);
  const account = pickAccount(accounts, args.account);
  if (!account) return { ok: false, summary: `找不到账户「${args.account || ''}」` };
  await call(`/api/accounts/${account.id}`, { method: 'DELETE' });
  return { ok: true, mutated: true, summary: `已删除账户「${account.name}」及其全部流水` };
}

async function transferMoney(args, call, today) {
  const accounts = await fetchAccounts(call);
  const from = pickAccount(accounts, args.from);
  const to = pickAccount(accounts, args.to);
  if (!from) return { ok: false, summary: `找不到转出账户「${args.from || ''}」` };
  if (!to) return { ok: false, summary: `找不到转入账户「${args.to || ''}」` };
  const amount = Math.abs(Number(args.amount) || 0);
  if (!amount) return { ok: false, summary: '转账金额无效' };
  const res = await call('/api/transfers', {
    method: 'POST',
    body: {
      from_account_id: from.id,
      to_account_id: to.id,
      amount,
      date: normalizeDate(args.date, today),
      note: String(args.note || '').trim(),
    },
  });
  return {
    ok: true,
    mutated: true,
    summary: `已转账 ${fmt(amount)}：${from.name} → ${to.name}`,
    transfer_id: res.transfer_id,
  };
}

async function deleteTransaction(args, call) {
  const id = Number(args.id);
  if (!id) return { ok: false, summary: '流水 id 无效' };
  await call(`/api/transactions/${id}?transfer=1`, { method: 'DELETE' });
  return { ok: true, mutated: true, summary: `已删除流水 #${id}` };
}

/**
 * 执行一个工具调用。
 * call(path, opts) 与前端 api() 同签名，测试里可以直接接本地实现。
 */
export async function runTool(name, args = {}, call, ctx = {}) {
  const today = normalizeDate(ctx.today, isoToday());
  const a = args && typeof args === 'object' ? args : {};
  try {
    switch (name) {
      case 'record_transaction':
        return await recordTransaction(a, call, today);
      case 'get_daily_summary':
        return await getDailySummary(a, call, today);
      case 'get_month_summary':
        return await getMonthSummary(a, call);
      case 'list_transactions':
        return await listTransactions(a, call);
      case 'list_accounts':
        return await listAccounts(a, call);
      case 'create_account':
        return await createAccount(a, call);
      case 'update_account':
        return await updateAccount(a, call);
      case 'delete_account':
        return await deleteAccount(a, call);
      case 'transfer_money':
        return await transferMoney(a, call, today);
      case 'delete_transaction':
        return await deleteTransaction(a, call);
      default:
        return { ok: false, summary: `未知工具：${name}` };
    }
  } catch (err) {
    return { ok: false, summary: `操作失败：${err.message || err}` };
  }
}
