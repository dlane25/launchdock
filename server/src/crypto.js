import crypto from 'node:crypto';
import { config } from './config.js';

// ---- Vault: AES-256-GCM envelope for credentials and secrets ----
export function encrypt(value) {
  const plaintext = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(blob, { json = true } = {}) {
  if (!blob) return null;
  if (!blob.startsWith('v1:')) throw new Error('Unknown vault format');
  const raw = Buffer.from(blob.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.masterKey, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return json ? JSON.parse(text) : text;
}

// ---- Passwords (scrypt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// ---- JWT (HS256) for dashboard sessions ----
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, ttlSeconds = 60 * 60 * 24 * 7) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Misc ----
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const randomToken = (prefix, bytes = 32) => `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;

// Signed, expiring links (artifact downloads, install pages).
export function signLink(path, ttlSeconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${path}:${exp}`).digest('base64url');
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function verifyLink(path, exp, sig) {
  if (!exp || !sig || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${path}:${exp}`).digest('base64url');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
