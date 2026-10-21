/*
 * 纯手机模式（无服务器）的业务逻辑测试。
 *
 * public/local-api.js 里的逻辑原本跑在浏览器 IndexedDB 上，这里换成内存 driver，
 * 于是可以在 node 里跑真实代码路径，而不是模拟。
 *
 * 用法：node scripts/local-test.mjs
 */
import { createLocalApi, memoryDriver, LocalError } from '../public/local-api.js';

let pass = 0;
let fail = 0;
const check = (desc, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${desc}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${desc}\n      得到 ${a}\n      期望 ${e}`);
    fail += 1;
  }
};

const ok = (desc, cond) => check(desc, !!cond, true);

async function expectError(desc, fn, status) {
  try {
    await fn();
    check(desc, '没有报错', `错误 ${status}`);
  } catch (err) {
    check(desc, err.status, status);
  }
}

const api = createLocalApi(memoryDriver());
const call = (path, opts) => api.handle(path, opts);

console.log('== 1. 初始化与登录 ==');

check('初始状态需要设置密码', (await call('/api/me')).setup_required, true);
await expectError('密码过短被拒', () => call('/api/setup', { method: 'POST', body: { username: 'me', password: '123' } }), 400);
check('设置成功', (await call('/api/setup', { method: 'POST', body: { username: 'me', password: 'secret123' } })).ok, true);
check('重复初始化被拒', await call('/api/setup', { method: 'POST', body: { username: 'me', password: 'secret123' } }).then(() => 'no error', (e) => e.status), 409);
check('登录后可访问', (await call('/api/me')).authenticated, true);
check('默认分类已就位', (await call('/api/categories')).categories.length, 22);

await call('/api/logout', { method: 'POST' });
check('登出后未认证', (await call('/api/me')).authenticated, false);
await expectError('未登录访问汇总被拒', () => call('/api/summary'), 401);
await expectError('错误密码被拒', () => call('/api/login', { method: 'POST', body: { username: 'me', password: 'nope' } }), 401);
check('正确密码可登录', (await call('/api/login', { method: 'POST', body: { username: 'me', password: 'secret123' } })).ok, true);

console.log('== 2. 账户与余额 ==');

const bank = (await call('/api/accounts', { method: 'POST', body: { name: '招商银行', type: 'bank', initial_balance: 48200 } })).id;
const card = (await call('/api/accounts', { method: 'POST', body: { name: '信用卡', type: 'credit', initial_balance: -2380.4 } })).id;
check('账户创建成功', typeof bank === 'number' && bank !== card, true);
check('账户数为 2', (await call('/api/accounts')).accounts.length, 2);
check('净资产为期初合计', (await call('/api/summary')).net_worth, 45819.6);

console.log('== 3. 记账后资产自动更新 ==');

const before = (await call('/api/summary')).net_worth;
const added = await call('/api/transactions', {
  method: 'POST',
  body: { account_id: bank, amount: -88.8, category: '餐饮', note: '午饭', date: '2026-10-21' },
});
check('记账返回余额', added.balance, 48111.2);
check('净资产减少 88.8', added.net_worth, Math.round((before - 88.8) * 100) / 100);
check('账户余额同步', (await call('/api/accounts')).accounts.find((a) => a.id === bank).balance, 48111.2);

await call('/api/transactions', {
  method: 'POST',
  body: { account_id: bank, amount: 18500, category: '工资', note: '月薪', date: '2026-10-10' },
});
const sum = await call('/api/summary?month=2026-10');
check('本月收入', sum.month_summary.income, 18500);
check('本月支出', sum.month_summary.expense, 88.8);
check('本月笔数', sum.month_summary.count, 2);
check('支出构成只含支出', sum.by_category.length, 1);
check('趋势含该月', sum.trend.at(-1).month, '2026-10');

await expectError('金额为 0 被拒', () => call('/api/transactions', { method: 'POST', body: { account_id: bank, amount: 0 } }), 400);
await expectError('不存在的账户被拒', () => call('/api/transactions', { method: 'POST', body: { account_id: 9999, amount: 5 } }), 400);

console.log('== 4. 修改与删除 ==');

const txList = await call('/api/transactions?month=2026-10');
const lunch = txList.transactions.find((t) => t.category === '餐饮');
check('列表带账户名', lunch.account_name, '招商银行');
await call(`/api/transactions/${lunch.id}`, { method: 'PATCH', body: { amount: 100, note: '晚饭' } });
const edited = (await call('/api/transactions?month=2026-10')).transactions.find((t) => t.id === lunch.id);
check('编辑金额生效', edited.amount, 100);
check('编辑备注生效', edited.note, '晚饭');

await call(`/api/transactions/${lunch.id}`, { method: 'DELETE' });
check('删除后笔数', (await call('/api/transactions?month=2026-10')).total, 1);
check('删除后净资产', (await call('/api/summary')).net_worth, 48200 + 18500 - 2380.4);

console.log('== 5. 转账 ==');

const tr = await call('/api/transfers', {
  method: 'POST',
  body: { from_account_id: bank, to_account_id: card, amount: 3200, note: '还款', date: '2026-10-20' },
});
check('转账返回 id', typeof tr.transfer_id === 'string', true);
check('转账不改变净资产', tr.net_worth, 48200 + 18500 - 2380.4);
const accounts = (await call('/api/accounts')).accounts;
check('转出账户减少', accounts.find((a) => a.id === bank).balance, 63500);
check('转入账户增加', accounts.find((a) => a.id === card).balance, 819.6);
await expectError('同账户转账被拒', () => call('/api/transfers', { method: 'POST', body: { from_account_id: bank, to_account_id: bank, amount: 1 } }), 400);

const trTx = (await call('/api/transactions')).transactions.find((t) => t.transfer_id === tr.transfer_id);
await call(`/api/transactions/${trTx.id}?transfer=1`, { method: 'DELETE' });
check('删除转账连删两条', (await call('/api/accounts')).accounts.find((a) => a.id === card).balance, -2380.4);

console.log('== 6. 预算 ==');

await call('/api/budgets', { method: 'POST', body: { category: '餐饮', monthly_limit: 1200 } });
await call('/api/transactions', { method: 'POST', body: { account_id: bank, amount: -300, category: '餐饮', date: '2026-10-05' } });
const withBudget = await call('/api/summary?month=2026-10');
check('预算已记录', withBudget.budgets.length, 1);
check('预算已花费', withBudget.budgets[0].spent, 300);
check('预算比例', withBudget.budgets[0].ratio, 0.25);
await call('/api/budgets', { method: 'POST', body: { category: '餐饮', monthly_limit: 0 } });
check('预算设为 0 即删除', (await call('/api/budgets')).budgets.length, 0);

console.log('== 7. 分类 ==');

check('新增分类', (await call('/api/categories', { method: 'POST', body: { name: '宠物', kind: 'expense', icon: '🐱' } })).name, '宠物');
check('分类总数', (await call('/api/categories')).categories.length, 23);
await call('/api/categories/宠物', { method: 'DELETE' });
check('删除分类', (await call('/api/categories')).categories.length, 22);

console.log('== 8. CSV 导入与去重 ==');

const csv = [
  '日期,金额,分类,备注',
  '2026-09-01,-25.50,餐饮,早餐',
  '2026-09-02,-100,购物,日用品',
  '2026-09-02,-100,购物,日用品',
  '2026-09-03,8000,工资,兼职',
].join('\n');
const preview = await call('/api/import/csv', { method: 'POST', body: { csv, default_account_id: bank, dry_run: true } });
check('预览不写入', preview.imported, 3);
check('预览标记重复', preview.skipped, 1);
check('预览后仍为原笔数', (await call('/api/transactions')).total, 2);

const imported = await call('/api/import/csv', { method: 'POST', body: { csv, default_account_id: bank } });
check('导入 3 条', imported.imported, 3);
check('重复行被跳过', imported.skipped, 1);
check('再次导入全部重复', (await call('/api/import/csv', { method: 'POST', body: { csv, default_account_id: bank } })).skipped, 4);
check('9 月收入识别', (await call('/api/summary?month=2026-09')).month_summary.income, 8000);

await expectError('缺少金额列被拒', () => call('/api/import/csv', { method: 'POST', body: { csv: '日期,备注\n2026-01-01,x', default_account_id: bank } }), 400);

console.log('== 9. 导出 ==');

const csvOut = await call('/api/export.csv');
ok('CSV 导出有表头', csvOut.__csv.startsWith('date,amount,category,note,account'));
check('CSV 行数', csvOut.__csv.split('\n').length, 6);
const jsonOut = await call('/api/export.json');
check('JSON 导出含账户', jsonOut.accounts.length, 2);
ok('JSON 导出含流水', jsonOut.transactions.length >= 5);

console.log('== 10. 备份与恢复 ==');

const backup = await call('/api/backup');
ok('备份含全部数据', backup.accounts.length === 2 && backup.transactions.length >= 5);
await call('/api/wipe', { method: 'POST' });
check('清空后无账户', (await call('/api/accounts')).accounts.length, 0);
check('清空后无流水', (await call('/api/transactions')).total, 0);
const restored = await call('/api/restore', { method: 'POST', body: { data: backup } });
check('恢复账户数', restored.accounts, 2);
check('恢复后净资产一致', (await call('/api/summary')).net_worth, backup.accounts.reduce((a, x) => a + x.initial_balance, 0) + backup.transactions.reduce((a, x) => a + x.amount, 0));
await expectError('坏备份被拒', () => call('/api/restore', { method: 'POST', body: { data: { nope: 1 } } }), 400);

console.log('== 11. 修改密码 ==');

await expectError('旧密码错误被拒', () => call('/api/password', { method: 'POST', body: { current_password: 'wrong', new_password: 'abcdef' } }), 401);
await expectError('新密码过短被拒', () => call('/api/password', { method: 'POST', body: { current_password: 'secret123', new_password: 'abc' } }), 400);
check('改密成功', (await call('/api/password', { method: 'POST', body: { current_password: 'secret123', new_password: 'newsecret456' } })).ok, true);
check('改密后需要重新登录', (await call('/api/me')).authenticated, false);
await expectError('旧密码失效', () => call('/api/login', { method: 'POST', body: { username: 'me', password: 'secret123' } }), 401);
check('新密码可登录', (await call('/api/login', { method: 'POST', body: { username: 'me', password: 'newsecret456' } })).ok, true);

console.log('== 12. 数据真的落盘（driver 层） ==');

const drv = memoryDriver();
const apiA = createLocalApi(drv);
await apiA.handle('/api/setup', { method: 'POST', body: { username: 'me', password: 'secret123' } });
const accId = (await apiA.handle('/api/accounts', { method: 'POST', body: { name: '现金', initial_balance: 500 } })).id;
await apiA.handle('/api/transactions', { method: 'POST', body: { account_id: accId, amount: -30, category: '餐饮', date: '2026-10-21' } });
// 用同一份 driver 新建一个 api 实例，模拟「关掉页面重新打开」。
const apiB = createLocalApi(drv);
check('重新打开后账户还在', (await apiB.handle('/api/accounts')).accounts.length, 1);
check('重新打开后余额还在', (await apiB.handle('/api/accounts')).accounts[0].balance, 470);
// 会话本身也是持久化数据，重开页面不该被登出。
check('重新打开后仍是登录态', (await apiB.handle('/api/me')).authenticated, true);
await apiB.handle('/api/login', { method: 'POST', body: { username: 'me', password: 'secret123' } });
check('登录后数据完整', (await apiB.handle('/api/summary')).net_worth, 470);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
