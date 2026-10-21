import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db, getMeta, setMeta, delMeta, nowIso } from './db.js';

const SESSION_DAYS = 180;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hasUser() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

export function createUser(username, password) {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), nowIso());
  return Number(info.lastInsertRowid);
}

export function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256(token), userId, nowIso(), expires);
  return { token, expires };
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowIso());
  return row || null;
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

/** Long-lived token for Apple Shortcuts / curl automation. */
export function getApiToken() {
  return getMeta('api_token');
}

export function rotateApiToken() {
  const token = randomBytes(24).toString('base64url');
  setMeta('api_token', token);
  return token;
}

export function checkApiToken(token) {
  const current = getApiToken();
  if (!current || !token) return false;
  return timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(current)));
}

export function revokeApiToken() {
  delMeta('api_token');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
