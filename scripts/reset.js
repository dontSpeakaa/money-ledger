/**
 * 清空本地数据：npm run reset
 * 必须同时删掉 WAL / SHM，否则新库会被旧日志干扰。
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.MONEY_DB || join(ROOT, 'data', 'money.db');

for (const file of [base, `${base}-wal`, `${base}-shm`, `${base}-journal`]) {
  rmSync(file, { force: true });
}

console.log('已清空本地数据。重新启动后请设置自己的密码。');
