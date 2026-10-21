/* 我的账本 - 前端逻辑（原生 JS，无依赖） */

// MONEY_MODE 由构建脚本注入：'local' 表示纯手机模式（数据存本机 IndexedDB），
// 'server' 或未定义表示连后端。也支持 ?local=1 临时切换，方便在服务器上试本地模式。
const LOCAL_MODE =
  window.MONEY_MODE === 'local' ||
  new URLSearchParams(location.search).get('local') === '1';
let localApi = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 本地模式的后端要等用到才 import，但那次 import 是一次网络往返。
// 这里在脚本一加载就把它启动起来，和后面的启动流程并行，省掉一段串行等待。
const localApiReady = LOCAL_MODE
  ? import('./local-api.js').then((m) => m.createLocalApi(m.idbDriver()))
  : null;

const state = {
  month: new Date().toISOString().slice(0, 7),
  view: 'overview',
  accounts: [],
  categories: [],
  summary: null,
  transactions: [],
  total: 0,
  offset: 0,
  filters: { q: '', accountId: null, category: null },
  kind: 'expense',
  pickedCategory: null,
  token: null,
  local: LOCAL_MODE,
};

// ------------------------------------------------------------------- helpers

const ACCOUNT_TYPES = {
  bank: { label: '储蓄卡', icon: '🏦' },
  cash: { label: '现金', icon: '💵' },
  credit: { label: '信用卡', icon: '💳' },
  alipay: { label: '支付宝', icon: '🅰️' },
  wechat: { label: '微信', icon: '💬' },
  investment: { label: '投资', icon: '📈' },
  loan: { label: '贷款/欠款', icon: '📉' },
  other: { label: '其他', icon: '🧩' },
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n, { sign = false } = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = sign && v > 0 ? '+' : v < 0 ? '-' : '';
  return `${prefix}¥${abs}`;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

function monthLabel(month) {
  const [y, m] = month.split('-');
  return `${y}年${Number(m)}月`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function relDate(dateStr) {
  const t = todayStr();
  if (dateStr === t) return '今天';
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === y) return '昨天';
  return `${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日 周${weekday(dateStr)}`;
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  // 纯手机模式：不经过网络，直接调本地实现。
  if (LOCAL_MODE) {
    if (!localApi) localApi = await localApiReady;
    try {
      const data = await localApi.handle(path, { method, body });
      if (data && data.__csv) {
        const blob = new Blob([`\uFEFF${data.__csv}`], { type: 'text/csv;charset=utf-8' });
        return raw ? new Response(blob) : data;
      }
      return data;
    } catch (err) {
      if (err.status === 401 && state.view) showAuth();
      throw new Error(err.message || '本地操作失败');
    }
  }

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 && state.view) showAuth();
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

/** 下载一份数据（本地模式造 blob，服务端模式走接口）。 */
async function downloadFile(path, filename, { body, method = 'GET' } = {}) {
  let blob;
  if (LOCAL_MODE) {
    const data = await api(path, { method, body });
    const text = data.__csv ?? JSON.stringify(data, null, 2);
    blob = new Blob([data.__csv ? `\uFEFF${text}` : text], {
      type: data.__csv ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    });
  } else {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`导出失败 (${res.status})`);
    blob = await res.blob();
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const categoryIcon = (name) => state.categories.find((c) => c.name === name)?.icon || '🏷️';
const accountById = (id) => state.accounts.find((a) => a.id === Number(id));

// -------------------------------------------------------------- auth screen

function showAuth(setupRequired = false) {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-title').textContent = setupRequired ? '欢迎使用' : '我的账本';
  $('#auth-hint').textContent = setupRequired ? '先设置一个只有你知道的密码' : '输入密码登录';
  $('#username-label').classList.toggle('hidden', !setupRequired);
  $('#confirm-label').classList.toggle('hidden', !setupRequired);
  $('#auth-submit').textContent = setupRequired ? '创建账本' : '登录';
  $('#auth-error').classList.add('hidden');
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  state.setupRequired = setupRequired;
}

async function boot() {
  // 本地模式的界面文案/入口与服务器模式不同，登录前就先调整好，
  // 否则设置页会先闪一下「存在服务器上」的字样。
  if (LOCAL_MODE) {
    applyLocalUi();
    requestPersistentStorage();
  }
  // 先决定去登录页还是主界面，这一步只依赖 /api/me；令牌等主界面的事
  // 放到后台做，不阻塞首屏。
  const me = await api('/api/me');
  hideSplash();
  if (me.setup_required) return showAuth(true);
  if (!me.authenticated) return showAuth(false);
  await enterApp();
}

function hideSplash() {
  $('#splash')?.classList.add('hidden');
}

async function enterApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // 账户/分类/汇总与交易明细互不依赖，并发拉取，省掉一段串行等待。
  await Promise.all([refreshAll(), loadTransactions(true)]);
  navigate('overview');
  render();
  hideSplash();
  loadToken(); // 不 await：只有设置页用到，不该拖慢首屏
}

/**
 * 纯手机模式下数据只有手机这一份，尽量争取「持久存储」，
 * 降低系统在空间紧张时清理掉账本的可能。
 */
async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch {
    /* 拿不到持久化也不影响使用 */
  }
}

/** 纯手机模式下调整界面：隐藏用不上的自动化，换成备份/恢复。 */
function applyLocalUi() {
  $('#automation-section')?.classList.add('hidden');
  $('#automation-card')?.classList.add('hidden');
  $('#backup-section')?.classList.remove('hidden');
  $('#backup-card')?.classList.remove('hidden');
  $('#btn-wipe')?.classList.remove('hidden');
  $('#storage-note').textContent = '我的账本 · 数据存在这台手机的浏览器里';
  $('#auth-note').textContent = '数据只保存在这台手机上，只有你能看到。';
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#auth-error');
  err.classList.add('hidden');
  const password = $('#auth-password').value;
  const username = $('#auth-username').value.trim() || 'me';
  try {
    if (state.setupRequired) {
      if (password.length < 6) throw new Error('密码至少 6 位');
      if (password !== $('#auth-confirm').value) throw new Error('两次输入的密码不一致');
      await api('/api/setup', { method: 'POST', body: { username, password } });
    } else {
      await api('/api/login', { method: 'POST', body: { username, password } });
    }
    await enterApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
  }
});

// ------------------------------------------------------------------- refresh

async function refreshAll() {
  const [accounts, categories, summary] = await Promise.all([
    api('/api/accounts?all=1'),
    api('/api/categories'),
    api(`/api/summary?month=${state.month}`),
  ]);
  state.accounts = accounts.accounts;
  state.categories = categories.categories;
  state.summary = summary;
  renderAccountPickers();
}

async function reloadMonth() {
  const [summary] = await Promise.all([api(`/api/summary?month=${state.month}`)]);
  state.summary = summary;
  state.offset = 0;
  await loadTransactions(true);
  render();
}

async function loadTransactions(reset = false) {
  if (reset) state.offset = 0;
  const p = new URLSearchParams({ month: state.month, limit: '100', offset: String(state.offset) });
  if (state.filters.accountId) p.set('account_id', state.filters.accountId);
  if (state.filters.category) p.set('category', state.filters.category);
  if (state.filters.q) p.set('q', state.filters.q);
  const data = await api(`/api/transactions?${p}`);
  state.transactions = reset ? data.transactions : [...state.transactions, ...data.transactions];
  state.total = data.total;
  state.offset = state.transactions.length;
}

// -------------------------------------------------------------------- render

function render() {
  $('#month-label').textContent = monthLabel(state.month);
  renderOverview();
  renderList();
  renderStats();
  renderSettings();
}

function renderOverview() {
  const s = state.summary;
  if (!s) return;
  $('#net-worth').textContent = money(s.net_worth);
  $('#month-income').textContent = money(s.month_summary.income);
  $('#month-expense').textContent = money(s.month_summary.expense);
  const net = s.month_summary.income - s.month_summary.expense;
  const netEl = $('#month-net');
  netEl.textContent = money(net, { sign: true });
  netEl.className = net >= 0 ? 'pos' : 'neg';

  $('#account-list').innerHTML = s.accounts.length
    ? s.accounts
        .map((a) => {
          const t = ACCOUNT_TYPES[a.type] || ACCOUNT_TYPES.other;
          return `<div class="account-row" data-edit-account="${a.id}">
            <div class="name"><span class="acct-icon">${t.icon}</span>
              <span>${esc(a.name)}<br><span class="badge">${t.label} · ${a.tx_count} 笔</span></span></div>
            <div class="balance ${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}</div>
          </div>`;
        })
        .join('')
    : `<div class="empty">还没有账户，去「设置 → 账户」添加你的银行卡、支付宝、微信余额吧。</div>`;

  const cats = s.by_category.filter((c) => c.total < 0);
  const max = Math.max(...cats.map((c) => -c.total), 1);
  $('#category-chart').innerHTML = cats.length
    ? cats
        .slice(0, 8)
        .map((c) => {
          const pct = Math.round((-c.total / max) * 100);
          return `<div class="bar-row">
            <span>${categoryIcon(c.category)} ${esc(c.category)}</span>
            <span class="muted small">${money(-c.total)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          </div>`;
        })
        .join('')
    : `<p class="muted small" style="margin:0">本月还没有支出记录。</p>`;

  const recent = state.transactions.slice(0, 6);
  $('#recent-list').innerHTML = recent.length ? recent.map(txRow).join('') : emptyMonth();
}

function txRow(t) {
  const isTransfer = t.category === '转账';
  const icon = isTransfer ? '🔁' : categoryIcon(t.category);
  const title = t.category || (t.amount > 0 ? '收入' : '支出');
  const sub = [t.note, t.account_name].filter(Boolean).join(' · ');
  return `<div class="tx-row" data-tx="${t.id}">
    <div class="tx-icon">${icon}</div>
    <div class="tx-main">
      <div class="tx-title">${esc(title)}</div>
      <div class="tx-sub">${esc(sub) || relDate(t.date)}</div>
    </div>
    <div class="tx-amount ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount, { sign: true })}</div>
  </div>`;
}

const emptyMonth = () => `<div class="empty">本月还没有记录。<br>点下面的「＋」开始记一笔。</div>`;

function renderList() {
  const meta = $('#list-meta');
  meta.textContent = state.transactions.length
    ? `共 ${state.total} 笔 · 已显示 ${state.transactions.length} 笔`
    : '';
  $('#btn-more').classList.toggle('hidden', state.transactions.length >= state.total);

  if (!state.transactions.length) {
    $('#tx-list').innerHTML = state.filters.q || state.filters.accountId || state.filters.category
      ? '<div class="empty">没有符合条件的记录。</div>'
      : emptyMonth();
    return;
  }

  let html = '';
  let lastDate = null;
  for (const t of state.transactions) {
    if (t.date !== lastDate) {
      html += `<div class="date-sep">${relDate(t.date)}</div>`;
      lastDate = t.date;
    }
    html += txRow(t);
  }
  $('#tx-list').innerHTML = html;

  $('#filter-accounts').innerHTML = [
    `<button class="chip ${state.filters.accountId ? '' : 'active'}" data-filter-account="">全部账户</button>`,
    ...state.accounts
      .filter((a) => !a.archived)
      .map(
        (a) =>
          `<button class="chip ${Number(state.filters.accountId) === a.id ? 'active' : ''}" data-filter-account="${a.id}">${esc(a.name)}</button>`,
      ),
  ].join('');

  const used = new Set(state.transactions.map((t) => t.category));
  $('#filter-categories').innerHTML = [
    `<button class="chip ${state.filters.category ? '' : 'active'}" data-filter-category="">全部分类</button>`,
    ...[...used].sort().map(
      (c) =>
        `<button class="chip ${state.filters.category === c ? 'active' : ''}" data-filter-category="${esc(c)}">${categoryIcon(c)} ${esc(c)}</button>`,
    ),
  ].join('');
}

function renderStats() {
  const s = state.summary;
  if (!s) return;

  const trend = s.trend;
  const max = Math.max(...trend.flatMap((t) => [t.income, t.expense]), 1);
  $('#trend-chart').innerHTML = trend.length
    ? `<div class="bar-chart">${trend
        .map(
          (t) => `<div class="bar-col">
            <div class="bar-pair">
              <i class="bar-in" style="height:${Math.round((t.income / max) * 100)}%"></i>
              <i class="bar-out" style="height:${Math.round((t.expense / max) * 100)}%"></i>
            </div>
            <small>${Number(t.month.slice(5))}月</small>
          </div>`,
        )
        .join('')}</div>
      <p class="muted small" style="margin:10px 0 0">
        <span style="color:var(--pos)">■</span> 收入
        <span style="color:var(--neg);margin-left:10px">■</span> 支出
      </p>`
    : '<p class="muted small" style="margin:0">还没有足够的数据。</p>';

  const budgets = s.budgets;
  $('#budget-list').innerHTML = budgets.length
    ? budgets
        .map((b) => {
          const pct = Math.min(Math.round(b.ratio * 100), 100);
          const cls = b.ratio > 1 ? 'over' : b.ratio > 0.8 ? 'warn' : '';
          const left = b.monthly_limit - b.spent;
          return `<div class="account-row" style="flex-direction:column;align-items:stretch;gap:8px">
            <div style="display:flex;justify-content:space-between">
              <span>${categoryIcon(b.category)} ${esc(b.category)}</span>
              <span class="small ${left < 0 ? 'neg' : 'muted'}">${money(b.spent)} / ${money(b.monthly_limit)}</span>
            </div>
            <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
            <div class="small muted">${left < 0 ? `已超支 ${money(-left)}` : `还可花 ${money(left)}`}</div>
          </div>`;
        })
        .join('')
    : '<div class="empty">还没有设置预算。<br>点右上角「设置」为餐饮、购物等分类加上月度上限。</div>';

  const cats = s.by_category.filter((c) => c.total < 0);
  const totalExpense = s.month_summary.expense || 1;
  $('#rank-list').innerHTML = cats.length
    ? cats
        .map((c) => {
          const pct = (( -c.total / totalExpense) * 100).toFixed(1);
          return `<div class="account-row">
            <div class="name"><span class="acct-icon">${categoryIcon(c.category)}</span>
              <span>${esc(c.category)}<br><span class="badge">${c.n} 笔 · 占比 ${pct}%</span></span></div>
            <div class="balance neg">${money(-c.total)}</div>
          </div>`;
        })
        .join('')
    : '<div class="empty">本月还没有支出。</div>';
}

function renderSettings() {
  const active = state.accounts.filter((a) => !a.archived);
  const archived = state.accounts.filter((a) => a.archived);
  $('#settings-accounts').innerHTML =
    [...active, ...archived]
      .map((a) => {
        const t = ACCOUNT_TYPES[a.type] || ACCOUNT_TYPES.other;
        return `<div class="account-row" data-edit-account="${a.id}">
          <div class="name"><span class="acct-icon">${t.icon}</span>
            <span>${esc(a.name)}<br><span class="badge">${t.label}${a.archived ? ' · 已隐藏' : ''}</span></span></div>
          <div class="balance ${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}</div>
        </div>`;
      })
      .join('') || '<div class="empty">还没有账户。</div>';

  $('#settings-categories').innerHTML = state.categories
    .map(
      (c) =>
        `<button class="chip" data-del-category="${esc(c.name)}">${c.icon} ${esc(c.name)} ✕</button>`,
    )
    .join('');

  $('#import-account').innerHTML = active
    .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`)
    .join('');
}

function renderAccountPickers() {
  const active = state.accounts.filter((a) => !a.archived);
  const opts = active.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  for (const id of ['#tx-account', '#tx-from', '#tx-to']) {
    const el = $(id);
    const prev = el.value;
    el.innerHTML = opts;
    if (prev && active.some((a) => String(a.id) === prev)) el.value = prev;
  }
  if (active.length > 1 && !$('#tx-to').value) $('#tx-to').value = active[1].id;

  const kind = state.kind;
  const cats = state.categories.filter((c) => (kind === 'income' ? c.kind === 'income' : c.kind === 'expense'));
  $('#tx-categories').innerHTML = cats
    .map(
      (c) =>
        `<button class="chip ${state.pickedCategory === c.name ? 'active' : ''}" data-pick-category="${esc(c.name)}">${c.icon} ${esc(c.name)}</button>`,
    )
    .join('');

  const quick = [10, 20, 50, 100, 200, 500];
  $('#tx-quick').innerHTML = quick.map((v) => `<button class="chip" data-quick="${v}">+${v}</button>`).join('');
}

// -------------------------------------------------------------------- 视图切换

function navigate(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo({ top: 0 });
}

$$('.tab[data-view]').forEach((t) => t.addEventListener('click', () => navigate(t.dataset.view)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) navigate(goto.dataset.goto);
});

$('#btn-prev-month').onclick = () => {
  state.month = shiftMonth(state.month, -1);
  reloadMonth();
};
$('#btn-next-month').onclick = () => {
  state.month = shiftMonth(state.month, 1);
  reloadMonth();
};
$('#month-label').onclick = () => {
  const d = new Date();
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  reloadMonth();
};
$('#btn-refresh').onclick = async () => {
  await refreshAll();
  await reloadMonth();
  toast('已刷新');
};

// ------------------------------------------------------------------ 记账面板

function openSheet() {
  if (!state.accounts.filter((a) => !a.archived).length) {
    toast('请先添加一个账户');
    return navigate('settings');
  }
  state.kind = 'expense';
  state.pickedCategory = null;
  $('#tx-amount').value = '';
  $('#tx-note').value = '';
  $('#tx-date').value = todayStr();
  $$('#tx-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.kind));
  $('#tx-single').classList.remove('hidden');
  $('#tx-transfer').classList.add('hidden');
  renderAccountPickers();
  $('#sheet').classList.remove('hidden');
  setTimeout(() => $('#tx-amount').focus(), 120);
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
}

$('#tab-add').onclick = () => openSheet();
$('#btn-sheet-cancel').onclick = closeSheet;
$('#sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet') closeSheet();
});

$$('#tx-kind button').forEach((b) =>
  b.addEventListener('click', () => {
    state.kind = b.dataset.kind;
    state.pickedCategory = null;
    $$('#tx-kind button').forEach((x) => x.classList.toggle('active', x === b));
    $('#tx-single').classList.toggle('hidden', state.kind === 'transfer');
    $('#tx-transfer').classList.toggle('hidden', state.kind !== 'transfer');
    renderAccountPickers();
  }),
);

$('#tx-categories').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick-category]');
  if (!btn) return;
  state.pickedCategory = btn.dataset.pickCategory;
  renderAccountPickers();
});

$('#tx-quick').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-quick]');
  if (!btn) return;
  const cur = Number($('#tx-amount').value.replace(/[^\d.]/g, '')) || 0;
  $('#tx-amount').value = String(cur + Number(btn.dataset.quick));
});

$('#btn-sheet-save').onclick = async () => {
  const amount = Number($('#tx-amount').value.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(amount) || amount === 0) return toast('请输入金额');
  const date = $('#tx-date').value || todayStr();
  const note = $('#tx-note').value.trim();
  try {
    if (state.kind === 'transfer') {
      await api('/api/transfers', {
        method: 'POST',
        body: {
          from_account_id: $('#tx-from').value,
          to_account_id: $('#tx-to').value,
          amount,
          date,
          note,
        },
      });
      toast('转账已记录');
    } else {
      const payload = {
        account_id: $('#tx-account').value,
        amount: state.kind === 'income' ? Math.abs(amount) : -Math.abs(amount),
        category: state.pickedCategory || (state.kind === 'income' ? '其他收入' : '其他支出'),
        note,
        date,
      };
      await api('/api/transactions', { method: 'POST', body: payload });
      toast(`已记账 ${money(payload.amount, { sign: true })}`);
    }
    closeSheet();
    await refreshAll();
    await reloadMonth();
  } catch (e) {
    toast(e.message);
  }
};

// 交易点击 -> 编辑 / 删除
document.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-tx]');
  if (!row) return;
  const tx = state.transactions.find((t) => t.id === Number(row.dataset.tx));
  if (!tx) return;
  openModal(
    '编辑记录',
    `<label class="field"><span>金额</span><input id="m-amount" type="text" inputmode="decimal" value="${Math.abs(tx.amount)}"></label>
     <label class="field"><span>分类</span><select id="m-category">${state.categories
       .map((c) => `<option ${c.name === tx.category ? 'selected' : ''}>${esc(c.name)}</option>`)
       .join('')}</select></label>
     <label class="field"><span>备注</span><input id="m-note" type="text" value="${esc(tx.note)}"></label>
     <label class="field"><span>日期</span><input id="m-date" type="date" value="${tx.date}"></label>
     <button class="btn danger-ghost block" id="m-delete">删除这笔记录</button>`,
    async () => {
      const v = Number($('#m-amount').value.replace(/[^\d.-]/g, ''));
      if (!v) throw new Error('请输入金额');
      await api(`/api/transactions/${tx.id}`, {
        method: 'PATCH',
        body: {
          amount: tx.amount < 0 ? -Math.abs(v) : Math.abs(v),
          category: $('#m-category').value,
          note: $('#m-note').value.trim(),
          date: $('#m-date').value,
        },
      });
      toast('已更新');
    },
  );
  $('#m-delete').onclick = async () => {
    const isTransfer = tx.category === '转账' && tx.transfer_id;
    if (!confirm(isTransfer ? '这是转账记录，将同时删除另一条。确认删除？' : '确认删除这笔记录？')) return;
    await api(`/api/transactions/${tx.id}?transfer=1`, { method: 'DELETE' });
    closeModal();
    await refreshAll();
    await reloadMonth();
    toast('已删除');
  };
});

// -------------------------------------------------------------------- 弹窗

function openModal(title, bodyHtml, onOk, okLabel = '保存') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#btn-modal-ok').textContent = okLabel;
  $('#modal').classList.remove('hidden');
  $('#btn-modal-ok').onclick = async () => {
    try {
      await onOk();
      closeModal();
    } catch (e) {
      toast(e.message);
    }
  };
}
function closeModal() {
  $('#modal').classList.add('hidden');
}
$('#btn-modal-cancel').onclick = closeModal;
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

const typeOptions = (sel) =>
  Object.entries(ACCOUNT_TYPES)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.icon} ${v.label}</option>`)
    .join('');

// ------------------------------------------------------------------- 账户管理

$('#btn-add-account').onclick = () =>
  openModal(
    '新增账户',
    `<label class="field"><span>名称</span><input id="a-name" placeholder="例如：招商银行储蓄卡"></label>
     <label class="field"><span>类型</span><select id="a-type">${typeOptions('bank')}</select></label>
     <label class="field"><span>当前余额</span><input id="a-balance" type="text" inputmode="decimal" placeholder="0.00"></label>
     <p class="muted small">信用卡 / 欠款请填负数，例如 -1200。</p>`,
    async () => {
      const name = $('#a-name').value.trim();
      if (!name) throw new Error('请输入账户名称');
      await api('/api/accounts', {
        method: 'POST',
        body: {
          name,
          type: $('#a-type').value,
          initial_balance: Number($('#a-balance').value.replace(/[^\d.-]/g, '')) || 0,
        },
      });
      await refreshAll();
      render();
      toast('账户已添加');
    },
  );

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-edit-account]');
  if (!row) return;
  const a = accountById(row.dataset.editAccount);
  if (!a) return;
  openModal(
    '编辑账户',
    `<label class="field"><span>名称</span><input id="a-name" value="${esc(a.name)}"></label>
     <label class="field"><span>类型</span><select id="a-type">${typeOptions(a.type)}</select></label>
     <label class="field"><span>当前余额（直接改这里可校准）</span><input id="a-balance" type="text" inputmode="decimal" value="${a.balance}"></label>
     <button class="btn ghost block" id="a-archive">${a.archived ? '恢复显示' : '隐藏该账户'}</button>
     <button class="btn danger-ghost block" id="a-delete">删除账户及其记录</button>`,
    async () => {
      await api(`/api/accounts/${a.id}`, {
        method: 'PATCH',
        body: {
          name: $('#a-name').value.trim() || a.name,
          type: $('#a-type').value,
          balance: Number($('#a-balance').value.replace(/[^\d.-]/g, '')) || 0,
        },
      });
      await refreshAll();
      await reloadMonth();
      toast('已保存');
    },
  );
  $('#a-archive').onclick = async () => {
    await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { archived: !a.archived } });
    closeModal();
    await refreshAll();
    render();
  };
  $('#a-delete').onclick = async () => {
    if (!confirm(`删除「${a.name}」以及它的全部交易记录？此操作不可恢复。`)) return;
    await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
    closeModal();
    await refreshAll();
    await reloadMonth();
    toast('账户已删除');
  };
});

// ------------------------------------------------------------------- 分类管理

$('#btn-add-category').onclick = () =>
  openModal(
    '新增分类',
    `<label class="field"><span>名称</span><input id="c-name" placeholder="例如：宠物"></label>
     <label class="field"><span>类型</span><select id="c-kind">
        <option value="expense">支出</option><option value="income">收入</option></select></label>
     <label class="field"><span>图标（一个 emoji）</span><input id="c-icon" placeholder="🐶" value="🏷️"></label>`,
    async () => {
      const name = $('#c-name').value.trim();
      if (!name) throw new Error('请输入分类名称');
      await api('/api/categories', {
        method: 'POST',
        body: { name, kind: $('#c-kind').value, icon: $('#c-icon').value.trim() || '🏷️' },
      });
      await refreshAll();
      render();
      toast('分类已添加');
    },
  );

$('#settings-categories').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-category]');
  if (!btn) return;
  const name = btn.dataset.delCategory;
  if (!confirm(`删除分类「${name}」？（已有记录会保留分类名）`)) return;
  await api(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await refreshAll();
  render();
});

// --------------------------------------------------------------------- 预算

$('#btn-edit-budget').onclick = () => {
  const expenseCats = state.categories.filter((c) => c.kind === 'expense');
  const cur = Object.fromEntries((state.summary?.budgets || []).map((b) => [b.category, b.monthly_limit]));
  openModal(
    '设置月度预算',
    `<p class="muted small">填 0 表示不限制。</p>` +
      expenseCats
        .map(
          (c) =>
            `<label class="field"><span>${c.icon} ${esc(c.name)}</span><input data-budget="${esc(c.name)}" type="text" inputmode="decimal" value="${cur[c.name] ?? ''}" placeholder="0"></label>`,
        )
        .join(''),
    async () => {
      const inputs = $$('[data-budget]');
      for (const el of inputs) {
        const val = Number(el.value.replace(/[^\d.-]/g, '')) || 0;
        await api('/api/budgets', {
          method: 'POST',
          body: { category: el.dataset.budget, monthly_limit: val },
        });
      }
      await refreshAll();
      render();
      toast('预算已更新');
    },
  );
};

// ------------------------------------------------------------ 明细筛选 / 分页

let searchTimer;
$('#filter-q').addEventListener('input', (e) => {
  state.filters.q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await loadTransactions(true);
    renderList();
  }, 280);
});

$('#filter-accounts').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-filter-account]');
  if (!btn) return;
  state.filters.accountId = btn.dataset.filterAccount || null;
  await loadTransactions(true);
  renderList();
});

$('#filter-categories').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-filter-category]');
  if (!btn) return;
  state.filters.category = btn.dataset.filterCategory || null;
  await loadTransactions(true);
  renderList();
});

$('#btn-more').onclick = async () => {
  await loadTransactions(false);
  renderList();
};

// ---------------------------------------------------------------- 导入 / 导出

let pendingImport = null;

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsText(file, 'utf-8');
  });
}

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingImport = { name: file.name, text: await readFileAsText(file) };
  $('#import-file-name').textContent = `已选择：${file.name}`;
  $('#import-file-name').className = 'file-name';
  $('#btn-import-preview').textContent = `预览「${file.name}」`;
});

async function doImport(dryRun) {
  if (!pendingImport) return toast('请先选择 CSV 或 JSON 文件');
  const accountId = $('#import-account').value;
  const isJson = /\.json$/i.test(pendingImport.name) || pendingImport.text.trim().startsWith('[');
  let result;
  if (isJson) {
    let rows;
    try {
      const parsed = JSON.parse(pendingImport.text);
      rows = Array.isArray(parsed) ? parsed : parsed.transactions;
    } catch {
      throw new Error('JSON 解析失败');
    }
    if (!Array.isArray(rows)) throw new Error('JSON 里没有找到交易数组');
    result = await api('/api/import', {
      method: 'POST',
      body: { rows, default_account_id: accountId, dry_run: dryRun },
    });
  } else {
    result = await api('/api/import/csv', {
      method: 'POST',
      body: { csv: pendingImport.text, default_account_id: accountId, dry_run: dryRun },
    });
  }

  const box = $('#import-report');
  box.classList.remove('hidden');
  box.innerHTML = `
    <p class="${result.imported ? 'ok' : 'muted'}"><strong>${dryRun ? '预览结果' : '导入完成'}：</strong>
      成功 ${result.imported} 条，跳过 ${result.skipped} 条</p>
    ${
      result.errors.length
        ? `<p class="bad">问题明细（最多 50 条）：</p><ul>${result.errors
            .map((x) => `<li>第 ${x.line} 行：${esc(x.message)}</li>`)
            .join('')}</ul>`
        : ''
    }
    ${
      result.preview.length
        ? `<details><summary>查看明细</summary><ul>${result.preview
            .map((p) => `<li>第 ${p.line} 行 · ${p.status} · ${p.date} · ${money(p.amount)} · ${esc(p.category || '')} ${esc(p.note || '')}</li>`)
            .join('')}</ul></details>`
        : ''
    }`;
  if (!dryRun && result.imported) {
    await refreshAll();
    await reloadMonth();
    toast(`已导入 ${result.imported} 条记录`);
  }
}

$('#btn-import-preview').onclick = async () => {
  try {
    await doImport(true);
    const box = $('#import-report');
    box.insertAdjacentHTML(
      'beforeend',
      `<button class="btn primary block" id="btn-import-run" style="margin-top:10px">确认导入</button>`,
    );
    $('#btn-import-run').onclick = async () => {
      try {
        await doImport(false);
      } catch (e) {
        toast(e.message);
      }
    };
  } catch (e) {
    toast(e.message);
  }
};

// ------------------------------------------------------------------ 自动化令牌

async function loadToken() {
  if (LOCAL_MODE) return; // 纯手机模式没有公网地址，快捷指令不适用
  const me = await api('/api/me');
  const box = $('#token-box');
  if (!me.has_api_token) {
    state.token = null;
    box.textContent = '尚未生成令牌';
    $('#btn-token-revoke').classList.add('hidden');
    return;
  }
  box.textContent = '令牌已生成（出于安全考虑不在这里显示，重置后会展示新的令牌）';
  $('#btn-token-revoke').classList.remove('hidden');
}

$('#btn-token').onclick = async () => {
  const { token } = await api('/api/token', { method: 'POST' });
  state.token = token;
  $('#token-box').textContent = token;
  $('#btn-token-revoke').classList.remove('hidden');
  await navigator.clipboard?.writeText(token).catch(() => {});
  toast('令牌已生成并复制');
};

$('#btn-token-revoke').onclick = async () => {
  if (!confirm('撤销后，快捷指令将无法再记账。确认撤销？')) return;
  await api('/api/token', { method: 'DELETE' });
  state.token = null;
  await loadToken();
  toast('令牌已撤销');
};

$('#btn-copy-cmd').onclick = async () => {
  const origin = location.origin;
  const t = state.token || 'YOUR_TOKEN';
  const text = `curl -X POST "${origin}/api/quick?token=${t}" -H "Content-Type: application/json" -d '{"amount":38.5,"category":"餐饮","note":"午饭"}'`;
  await navigator.clipboard?.writeText(text).catch(() => {});
  toast('示例已复制，可粘到快捷指令的「获取 URL 内容」');
};

// --------------------------------------------------------------------- 退出

$('#btn-change-password').onclick = () =>
  openModal(
    '修改密码',
    `<label class="field"><span>当前密码</span><input id="p-old" type="password" autocomplete="current-password"></label>
     <label class="field"><span>新密码（至少 6 位）</span><input id="p-new" type="password" autocomplete="new-password"></label>
     <p class="muted small">修改后所有设备都需要重新登录。</p>`,
    async () => {
      await api('/api/password', {
        method: 'POST',
        body: { current_password: $('#p-old').value, new_password: $('#p-new').value },
      });
      toast('密码已修改，请重新登录');
      showAuth(false);
    },
  );

$('#btn-logout').onclick = async () => {
  if (!confirm('退出登录？')) return;
  await api('/api/logout', { method: 'POST' });
  showAuth(false);
};

// ---------------------------------------------------------- 备份 / 恢复（纯手机模式）

$('#btn-export-csv')?.addEventListener('click', async () => {
  try {
    await downloadFile('/api/export.csv', `账本-${todayStr()}.csv`);
    toast('已导出 CSV');
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-export-json')?.addEventListener('click', async () => {
  try {
    await downloadFile('/api/export.json', `账本-${todayStr()}.json`);
    toast('已导出 JSON');
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-backup')?.addEventListener('click', async () => {
  try {
    await downloadFile('/api/backup', `账本备份-${todayStr()}.json`);
    localStorage.setItem('money_last_backup', new Date().toISOString());
    toast('备份已导出，请存到「文件」App 或 iCloud');
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-restore')?.addEventListener('click', () => $('#restore-file')?.click());

$('#restore-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('不是有效的 JSON 文件');
    }
    if (!Array.isArray(data.accounts) || !Array.isArray(data.transactions)) {
      throw new Error('这不是本应用导出的备份文件');
    }
    if (!confirm(`将用备份覆盖当前数据（${data.accounts.length} 个账户、${data.transactions.length} 笔记录）。\n当前数据会被替换，确定继续？`)) {
      return;
    }
    const r = await api('/api/restore', { method: 'POST', body: { data } });
    await refreshAll();
    await loadTransactions(true);
    render();
    toast(`已恢复 ${r.accounts} 个账户、${r.transactions} 笔记录`);
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-wipe')?.addEventListener('click', async () => {
  if (!confirm('清空所有账户和流水？此操作无法撤销，建议先导出备份。')) return;
  if (!confirm('再确认一次：真的要清空全部账目吗？')) return;
  try {
    await api('/api/wipe', { method: 'POST' });
    await refreshAll();
    await loadTransactions(true);
    render();
    toast('已清空');
  } catch (e) {
    toast(e.message);
  }
});

// ---------------------------------------------------------------- 启动 & PWA

// 出问题时把错误显示出来，避免只看到界面没反应。
window.addEventListener('error', (e) => {
  const msg = e.error?.message || e.message || '未知错误';
  console.error(e.error || e);
  if (typeof toast === 'function') toast(`出错了：${msg}`, 5000);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  console.error(e.reason);
  if (typeof toast === 'function') toast(`出错了：${msg}`, 5000);
});

if ('serviceWorker' in navigator) {
  // 首次访问时 Service Worker 会立刻接管（clients.claim），这会触发
  // controllerchange；此时页面本来就是新的，再 reload 一次纯属白等一整个加载。
  // 只有「本来就有旧版本在控制」时才需要重载去换新代码。
  const hadController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' 保证 sw.js 本身永远从网络取，避免旧版本被长期钉住。
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      reg.update();
    } catch {
      /* 离线缓存不可用不影响正常使用 */
    }
  });

  // 新版本接管后自动重载一次，确保页面跑的是最新代码。
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    location.reload();
  });
}

boot().catch((e) => {
  console.error(e);
  // 启动失败也必须收起启动占位，否则会一直停在 logo 上。
  hideSplash();
  showAuth(false);
  $('#auth-error').textContent = `无法连接服务器：${e.message}`;
  $('#auth-error').classList.remove('hidden');
});
