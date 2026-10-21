/**
 * 生成演示数据：npm run seed-demo
 * 会清空现有账户与交易，并写入最近 3 个月的示例记录。
 * 演示账号：me / demo123456
 */
import { db, nowIso, insertTransaction, round2 } from '../server/db.js';
import { hasUser, createUser } from '../server/auth.js';

const ACCOUNTS = [
  ['招商银行储蓄卡', 'bank', 48200],
  ['支付宝', 'alipay', 1350.5],
  ['微信零钱', 'wechat', 620],
  ['现金', 'cash', 300],
  ['招行信用卡', 'credit', -2380.4],
  ['基金账户', 'investment', 56000],
];

db.exec('BEGIN');
try {
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM accounts');
  const insertAccount = db.prepare(
    `INSERT INTO accounts (name, type, currency, initial_balance, sort_order, created_at)
     VALUES (?, ?, 'CNY', ?, ?, ?)`,
  );
  const ids = ACCOUNTS.map(([name, type, balance], i) => {
    const info = insertAccount.run(name, type, balance, i, nowIso());
    return Number(info.lastInsertRowid);
  });

  const EXPENSE = [
    ['餐饮', '午饭', 18, 45],
    ['餐饮', '晚饭', 25, 80],
    ['买菜', '超市', 60, 180],
    ['交通', '地铁', 3, 12],
    ['购物', '日用品', 30, 220],
    ['娱乐', '电影', 35, 70],
    ['订阅服务', '会员续费', 15, 30],
  ];
  const INCOME = [
    ['工资', '月薪'],
    ['其他收入', '报销'],
  ];

  const start = new Date();
  start.setDate(1);
  start.setMonth(start.getMonth() - 2);

  let count = 0;
  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const day = d.getDate();

    if (day === 10) {
      insertTransaction({
        accountId: ids[0],
        amount: 18500,
        category: '工资',
        note: '月薪',
        date,
      });
      count += 1;
    }

    const spendCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < spendCount; i += 1) {
      const [category, note, min, max] = EXPENSE[Math.floor(Math.random() * EXPENSE.length)];
      const amount = round2(-(min + Math.random() * (max - min)));
      const accountId = Math.random() < 0.6 ? ids[1] : ids[2];
      insertTransaction({ accountId, amount, category, note, date });
      count += 1;
    }

    if (day === 20) {
      insertTransaction({ accountId: ids[0], amount: 3200, category: '还款', note: '信用卡还款', date });
      count += 1;
    }
  }

  db.prepare(
    `INSERT INTO budgets (category, monthly_limit, updated_at) VALUES ('餐饮', 2000, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
  ).run(nowIso());
  db.prepare(
    `INSERT INTO budgets (category, monthly_limit, updated_at) VALUES ('购物', 1200, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
  ).run(nowIso());

  db.exec('COMMIT');

  if (!hasUser()) {
    createUser('me', 'demo123456');
    console.log('已创建演示账号：me / demo123456');
  }

  console.log(`已写入 ${ACCOUNTS.length} 个账户、${count} 笔交易。`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
