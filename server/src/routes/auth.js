import express from 'express';
import { one, many, query } from '../db.js';
import { hashPassword, verifyPassword, signJwt, randomToken, sha256Hex } from '../crypto.js';
import { ah, bad, HttpError, requireUser, isUuid } from '../http.js';
import { config } from '../config.js';

const r = express.Router();

const userOut = (u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.is_admin });

r.get('/auth/status', ah(async (_req, res) => {
  const { count } = await one('select count(*)::int as count from users');
  res.json({ registrationOpen: count === 0 || config.allowRegistration, firstUser: count === 0 });
}));

r.post('/auth/register', ah(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('A valid email is required');
  if (!password || password.length < 8) throw bad('Password must be at least 8 characters');
  const { count } = await one('select count(*)::int as count from users');
  if (count > 0 && !config.allowRegistration) throw new HttpError(403, 'Registration is closed. Ask an admin to invite you.');
  const existing = await one('select id from users where lower(email) = lower($1)', [email]);
  if (existing) throw new HttpError(409, 'An account with this email already exists');
  const user = await one(
    'insert into users (email, name, password_hash, is_admin) values ($1, $2, $3, $4) returning *',
    [email.toLowerCase(), name || null, hashPassword(password), count === 0],
  );
  res.status(201).json({ token: signJwt({ sub: user.id }), user: userOut(user) });
}));

r.post('/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && (await one('select * from users where lower(email) = lower($1)', [email]));
  if (!user || !verifyPassword(password || '', user.password_hash)) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: signJwt({ sub: user.id }), user: userOut(user) });
}));

r.get('/me', requireUser, (req, res) => res.json({ user: userOut(req.user) }));

r.post('/me/password', requireUser, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = await one('select * from users where id = $1', [req.user.id]);
  if (!verifyPassword(currentPassword || '', user.password_hash)) throw new HttpError(401, 'Current password is incorrect');
  if (!newPassword || newPassword.length < 8) throw bad('New password must be at least 8 characters');
  await query('update users set password_hash = $1 where id = $2', [hashPassword(newPassword), user.id]);
  res.json({ ok: true });
}));

// ---- API tokens for the CLI / CI ----
r.get('/tokens', requireUser, ah(async (req, res) => {
  const rows = await many('select id, name, last_used_at, created_at from api_tokens where user_id = $1 order by created_at desc', [req.user.id]);
  res.json({ tokens: rows.map((t) => ({ id: t.id, name: t.name, lastUsedAt: t.last_used_at, createdAt: t.created_at })) });
}));

r.post('/tokens', requireUser, ah(async (req, res) => {
  const name = String(req.body?.name || 'CLI').slice(0, 100);
  const token = randomToken('ldk_');
  const row = await one('insert into api_tokens (user_id, name, token_hash) values ($1, $2, $3) returning id, created_at', [
    req.user.id,
    name,
    sha256Hex(token),
  ]);
  res.status(201).json({ id: row.id, name, token, createdAt: row.created_at });
}));

r.delete('/tokens/:id', requireUser, ah(async (req, res) => {
  if (!isUuid(req.params.id)) throw bad('Invalid id');
  await query('delete from api_tokens where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---- Admin: users ----
r.get('/admin/users', requireUser, ah(async (req, res) => {
  if (!req.user.is_admin) throw new HttpError(403, 'Admin only');
  const users = await many('select id, email, name, is_admin, created_at from users order by created_at');
  res.json({ users: users.map((u) => ({ ...userOut(u), createdAt: u.created_at })) });
}));

r.post('/admin/users', requireUser, ah(async (req, res) => {
  if (!req.user.is_admin) throw new HttpError(403, 'Admin only');
  const { email, password, name, isAdmin } = req.body || {};
  if (!email || !password || password.length < 8) throw bad('email and a password of 8+ characters are required');
  const exists = await one('select id from users where lower(email) = lower($1)', [email]);
  if (exists) throw new HttpError(409, 'User already exists');
  const user = await one('insert into users (email, name, password_hash, is_admin) values ($1,$2,$3,$4) returning *', [
    email.toLowerCase(),
    name || null,
    hashPassword(password),
    !!isAdmin,
  ]);
  res.status(201).json({ user: userOut(user) });
}));

export default r;
