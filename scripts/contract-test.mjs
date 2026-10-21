/*
 * 契约一致性测试：本地实现（IndexedDB 版逻辑）与服务端实现的返回结构必须一致。
 *
 * 之前踩过的坑：本地 /api/transactions 返回的是 {rows,total}，而服务端返回
 * {transactions,total}，前端读 data.transactions 直接报 undefined。只测本地逻辑
 * 是发现不了的，必须两边对比。
 *
 * 做法：起一个真实服务端（临时库），同时建一个内存版本地实现，
 * 对同一批接口分别调用，然后比较「返回值的键结构」。
 *
 * 用法：node scripts/contract-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalApi, memoryDriver } from '../public/local-api.js';

const PORT = 13188;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'money-contract-'));
const dbFile = join(dir, 'test.db');

let pass = 0;
let fail = 0;
const check = (desc, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${desc}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${desc}\n      本地 ${a}\n      服务端 ${e}`);
    fail += 1;
  }
};

/** 递归取出对象的键结构，数组只看第一个元素的形状。 */
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, depth < 2 ? shape(v[k], depth + 1) : typeof v[k]]),
    );
  }
  return typeof v;
}

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MONEY_DB: dbFile },
  stdio: 'ignore',
});

const stop = () => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', stop);

for (let i = 0; i < 60; i += 1) {
  try {
    await fetch(`${BASE}/api/me`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}

const local = createLocalApi(memoryDriver());

let cookie = '';
async function serverCall(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
const localCall = (path, opts) => local.handle(path, opts);

console.log('== 准备两边同样的数据 ==');

for (const call of [serverCall, localCall]) {
  await call('/api/setup', { method: 'POST', body: { username: 'me', password: 'secret123' } });
}
const bankS = (await serverCall('/api/accounts', { method: 'POST', body: { name: '招商银行', type: 'bank', initial_balance: 48200 } })).id;
const bankL = (await localCall('/api/accounts', { method: 'POST', body: { name: '招商银行', type: 'bank', initial_balance: 48200 } })).id;
await serverCall('/api/accounts', { method: 'POST', body: { name: '信用卡', type: 'credit', initial_balance: -2380.4 } });
await localCall('/api/accounts', { method: 'POST', body: { name: '信用卡', type: 'credit', initial_balance: -2380.4 } });

const txBody = (accountId) => [
  { method: 'POST', body: { account_id: accountId, amount: -88.8, category: '餐饮', note: '午饭', date: '2026-10-21' } },
  { method: 'POST', body: { account_id: accountId, amount: 18500, category: '工资', note: '月薪', date: '2026-10-10' } },
];
for (const o of txBody(bankS)) await serverCall('/api/transactions', o);
for (const o of txBody(bankL)) await localCall('/api/transactions', o);

await serverCall('/api/transfers', { method: 'POST', body: { from_account_id: bankS, to_account_id: 2, amount: 3200, date: '2026-10-20' } });
await localCall('/api/transfers', { method: 'POST', body: { from_account_id: bankL, to_account_id: 2, amount: 3200, date: '2026-10-20' } });

await serverCall('/api/budgets', { method: 'POST', body: { category: '餐饮', monthly_limit: 1200 } });
await localCall('/api/budgets', { method: 'POST', body: { category: '餐饮', monthly_limit: 1200 } });

console.log('== 逐个接口比较返回结构 ==');

const GETS = [
  '/api/me',
  '/api/accounts',
  '/api/accounts?all=1',
  '/api/categories',
  '/api/summary',
  '/api/summary?month=2026-10',
  '/api/transactions',
  '/api/transactions?month=2026-10',
  '/api/budgets',
  '/api/export.json',
];

for (const path of GETS) {
  const [s, l] = [await serverCall(path), await localCall(path)];
  check(`GET ${path} 结构一致`, shape(l), shape(s));
}

console.log('== 关键字段的取值也要一致 ==');

const sSum = await serverCall('/api/summary?month=2026-10');
const lSum = await localCall('/api/summary?month=2026-10');
check('净资产一致', lSum.net_worth, sSum.net_worth);
check('本月收支一致', lSum.month_summary, sSum.month_summary);
check('账户余额一致', lSum.accounts.map((a) => [a.name, a.balance]), sSum.accounts.map((a) => [a.name, a.balance]));
check('支出构成一致', lSum.by_category.map((c) => [c.category, c.total, c.n]), sSum.by_category.map((c) => [c.category, c.total, c.n]));
check('预算一致', lSum.budgets.map((b) => [b.category, b.spent, b.ratio]), sSum.budgets.map((b) => [b.category, b.spent, b.ratio]));

const sTx = await serverCall('/api/transactions?month=2026-10');
const lTx = await localCall('/api/transactions?month=2026-10');
check('流水总数一致', lTx.total, sTx.total);
check(
  '流水内容一致',
  lTx.transactions.map((t) => [t.date, t.amount, t.category, t.note, t.account_name]),
  sTx.transactions.map((t) => [t.date, t.amount, t.category, t.note, t.account_name]),
);

const sCsv = await fetch(`${BASE}/api/export.csv`, { headers: { Cookie: cookie } }).then((r) => r.text());
const lCsv = (await localCall('/api/export.csv')).__csv;
check('CSV 导出内容一致', lCsv, sCsv.replace(/^\uFEFF/, ''));

console.log('== 写操作的返回结构 ==');

const sAdd = await serverCall('/api/transactions', { method: 'POST', body: { account_id: bankS, amount: -12.5, category: '交通', date: '2026-10-22' } });
const lAdd = await localCall('/api/transactions', { method: 'POST', body: { account_id: bankL, amount: -12.5, category: '交通', date: '2026-10-22' } });
check('记账返回结构一致', shape(lAdd), shape(sAdd));
check('记账返回余额一致', lAdd.balance, sAdd.balance);
check('记账返回净资产一致', lAdd.net_worth, sAdd.net_worth);

const sAcc = await serverCall('/api/accounts', { method: 'POST', body: { name: '现金', initial_balance: 300 } });
const lAcc = await localCall('/api/accounts', { method: 'POST', body: { name: '现金', initial_balance: 300 } });
check('新增账户返回结构一致', shape(lAcc), shape(sAcc));

const sPatch = await serverCall(`/api/accounts/${bankS}`, { method: 'PATCH', body: { name: '招商银行储蓄卡' } });
const lPatch = await localCall(`/api/accounts/${bankL}`, { method: 'PATCH', body: { name: '招商银行储蓄卡' } });
check('改账户返回结构一致', shape(lPatch), shape(sPatch));
check('改账户后余额一致', lPatch.balance, sPatch.balance);

const csvIn = '日期,金额,分类,备注\n2026-09-01,-25.5,餐饮,早餐\n2026-09-02,8000,工资,兼职';
const sImp = await serverCall('/api/import/csv', { method: 'POST', body: { csv: csvIn, default_account_id: bankS } });
const lImp = await localCall('/api/import/csv', { method: 'POST', body: { csv: csvIn, default_account_id: bankL } });
check('CSV 导入返回结构一致', shape(lImp), shape(sImp));
check('CSV 导入数量一致', [lImp.imported, lImp.skipped], [sImp.imported, sImp.skipped]);

const sDel = await serverCall('/api/transactions/1', { method: 'DELETE' });
const lDel = await localCall('/api/transactions/1', { method: 'DELETE' });
check('删除返回结构一致', shape(lDel), shape(sDel));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
stop();
process.exit(fail ? 1 : 0);
