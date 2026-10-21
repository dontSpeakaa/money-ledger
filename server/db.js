import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DB_PATH = process.env.MONEY_DB || join(ROOT, 'data', 'money.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'bank',
  currency        TEXT NOT NULL DEFAULT 'CNY',
  initial_balance REAL NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  category    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  transfer_id TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'expense',
  icon       TEXT NOT NULL DEFAULT '🏷️',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
  category      TEXT PRIMARY KEY,
  monthly_limit REAL NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

db.exec(SCHEMA);

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

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) return;
  const insert = db.prepare(
    'INSERT INTO categories (name, kind, icon, sort_order) VALUES (?, ?, ?, ?)',
  );
  DEFAULT_CATEGORIES.forEach(([name, kind, icon], i) => insert.run(name, kind, icon, i));
}

seedCategories();

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function delMeta(key) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Account rows with balance = initial_balance + sum(transactions). */
export function listAccounts({ includeArchived = false } = {}) {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.type, a.currency, a.initial_balance, a.archived, a.sort_order,
              a.initial_balance + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id), 0) AS balance,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
         FROM accounts a
        ${includeArchived ? '' : 'WHERE a.archived = 0'}
        ORDER BY a.sort_order, a.id`,
    )
    .all();
  return rows.map((r) => ({ ...r, balance: round2(r.balance), archived: !!r.archived }));
}

export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
}

export function accountBalance(id) {
  const row = db
    .prepare(
      `SELECT a.initial_balance + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.account_id = a.id), 0) AS balance
         FROM accounts a WHERE a.id = ?`,
    )
    .get(id);
  return row ? round2(row.balance) : 0;
}

export function netWorth() {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.initial_balance), 0) + COALESCE((SELECT SUM(t.amount) FROM transactions t), 0) AS total
         FROM accounts a WHERE a.archived = 0`,
    )
    .get();
  return round2(row.total);
}

export function insertTransaction({
  accountId,
  amount,
  category = '',
  note = '',
  date,
  transferId = null,
}) {
  const info = db
    .prepare(
      `INSERT INTO transactions (account_id, amount, category, note, date, transfer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, round2(amount), category, note, date, transferId, nowIso());
  return Number(info.lastInsertRowid);
}

export function categoryTotals(month) {
  return db
    .prepare(
      `SELECT category, ROUND(SUM(amount), 2) AS total, COUNT(*) AS n
         FROM transactions
        WHERE substr(date, 1, 7) = ?
        GROUP BY category
        ORDER BY total ASC`,
    )
    .all(month);
}

export function monthSummary(month) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
         COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense,
         COUNT(*) AS n
       FROM transactions WHERE substr(date, 1, 7) = ?`,
    )
    .get(month);
  return { income: round2(row.income), expense: round2(row.expense), count: row.n };
}

export function monthlyTrend(months = 6) {
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense
         FROM transactions
        GROUP BY month
        ORDER BY month DESC
        LIMIT ?`,
    )
    .all(months);
  return rows
    .map((r) => ({ ...r, income: round2(r.income), expense: round2(r.expense) }))
    .reverse();
}

export function listBudgets() {
  return db.prepare('SELECT category, monthly_limit FROM budgets ORDER BY category').all();
}
