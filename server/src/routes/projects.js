import crypto from 'node:crypto';
import express from 'express';
import { one, many, query } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { ah, bad, notFound, HttpError, requireUser, requireProject, publicProject, isUuid } from '../http.js';
import { CREDENTIAL_TYPES, validateCredential } from '../credentials.js';
import { WEBHOOK_EVENTS } from '../events.js';

const r = express.Router();
r.use(requireUser);

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'app';

const BUNDLE_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function projectFields(body) {
  const out = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw bad('Name is required');
    out.name = String(body.name).trim().slice(0, 100);
  }
  if (body.iosBundleId !== undefined) {
    if (body.iosBundleId && !BUNDLE_RE.test(body.iosBundleId)) throw bad('Invalid iOS bundle identifier');
    out.ios_bundle_id = body.iosBundleId || null;
  }
  if (body.androidPackage !== undefined) {
    if (body.androidPackage && !PACKAGE_RE.test(body.androidPackage)) throw bad('Invalid Android package name');
    out.android_package = body.androidPackage || null;
  }
  if (body.appleTeamId !== undefined) {
    if (body.appleTeamId && !/^[A-Z0-9]{10}$/.test(body.appleTeamId)) throw bad('Apple Team ID is 10 uppercase letters/digits');
    out.apple_team_id = body.appleTeamId || null;
  }
  if (body.ascAppId !== undefined) {
    if (body.ascAppId && !/^\d+$/.test(body.ascAppId)) throw bad('App Store Connect App ID is numeric (Apple ID of the app)');
    out.asc_app_id = body.ascAppId || null;
  }
  if (body.gitUrl !== undefined) {
    if (body.gitUrl && !/^(https:\/\/|git@)/.test(body.gitUrl)) throw bad('Git URL must be https:// or git@');
    out.git_url = body.gitUrl || null;
  }
  if (body.gitToken !== undefined) out.git_token_enc = body.gitToken ? encrypt(String(body.gitToken)) : null;
  return out;
}

r.get('/projects', ah(async (req, res) => {
  const rows = await many(
    `select p.*, case when p.owner_id = $1 then 'owner' else m.role end as role,
            (select max(created_at) from builds b where b.project_id = p.id) as last_build_at
       from projects p
       left join project_members m on m.project_id = p.id and m.user_id = $1
      where p.owner_id = $1 or m.user_id is not null
      order by coalesce((select max(created_at) from builds b where b.project_id = p.id), p.created_at) desc`,
    [req.user.id],
  );
  res.json({ projects: rows.map((p) => ({ ...publicProject(p), lastBuildAt: p.last_build_at })) });
}));

r.post('/projects', ah(async (req, res) => {
  const fields = projectFields({ ...req.body, name: req.body?.name ?? '' });
  let slug = slugify(req.body.slug || fields.name);
  const taken = await one('select 1 from projects where owner_id = $1 and slug = $2', [req.user.id, slug]);
  if (taken) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  const cols = ['owner_id', 'slug', ...Object.keys(fields)];
  const vals = [req.user.id, slug, ...Object.values(fields)];
  const p = await one(
    `insert into projects (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
    vals,
  );
  p.role = 'owner';
  res.status(201).json({ project: publicProject(p) });
}));

r.get('/projects/:pid', requireProject(), ah(async (req, res) => {
  const p = req.project;
  const [stats] = await many(
    `select
       (select count(*) from builds where project_id = $1)::int as builds,
       (select count(*) from submissions where project_id = $1)::int as submissions,
       (select count(distinct group_id) from updates where project_id = $1)::int as updates`,
    [p.id],
  );
  const versions = await many('select platform, build_number from app_versions where project_id = $1', [p.id]);
  res.json({ project: publicProject(p), stats, versions });
}));

r.patch('/projects/:pid', requireProject('admin'), ah(async (req, res) => {
  const fields = projectFields(req.body || {});
  if (!Object.keys(fields).length) return res.json({ project: publicProject(req.project) });
  const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
  const p = await one(`update projects set ${sets.join(', ')} where id = $1 returning *`, [req.project.id, ...Object.values(fields)]);
  p.role = req.project.role;
  res.json({ project: publicProject(p) });
}));

r.delete('/projects/:pid', requireProject('owner'), ah(async (req, res) => {
  await query('delete from projects where id = $1', [req.project.id]);
  res.json({ ok: true });
}));

// ---- Members ----
r.get('/projects/:pid/members', requireProject(), ah(async (req, res) => {
  const owner = await one('select id, email, name from users where id = $1', [req.project.owner_id]);
  const rows = await many(
    'select u.id, u.email, u.name, m.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.email',
    [req.project.id],
  );
  res.json({ members: [{ ...owner, role: 'owner' }, ...rows] });
}));

r.post('/projects/:pid/members', requireProject('admin'), ah(async (req, res) => {
  const { email, role = 'developer' } = req.body || {};
  if (!['admin', 'developer', 'viewer'].includes(role)) throw bad('role must be admin, developer or viewer');
  const user = await one('select id from users where lower(email) = lower($1)', [email || '']);
  if (!user) throw notFound('User with that email');
  if (user.id === req.project.owner_id) throw bad('That user owns the project');
  await query(
    `insert into project_members (project_id, user_id, role) values ($1,$2,$3)
     on conflict (project_id, user_id) do update set role = excluded.role`,
    [req.project.id, user.id, role],
  );
  res.status(201).json({ ok: true });
}));

r.delete('/projects/:pid/members/:uid', requireProject('admin'), ah(async (req, res) => {
  if (!isUuid(req.params.uid)) throw bad('Invalid user id');
  await query('delete from project_members where project_id = $1 and user_id = $2', [req.project.id, req.params.uid]);
  res.json({ ok: true });
}));

// ---- Secrets (injected into builds as environment variables) ----
r.get('/projects/:pid/secrets', requireProject(), ah(async (req, res) => {
  const rows = await many('select name, created_at from project_secrets where project_id = $1 order by name', [req.project.id]);
  res.json({ secrets: rows.map((s) => ({ name: s.name, createdAt: s.created_at })) });
}));

r.put('/projects/:pid/secrets/:name', requireProject('developer'), ah(async (req, res) => {
  const name = req.params.name;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw bad('Secret names must be UPPER_SNAKE_CASE');
  if (typeof req.body?.value !== 'string') throw bad('"value" (string) is required');
  await query(
    `insert into project_secrets (project_id, name, value_enc) values ($1,$2,$3)
     on conflict (project_id, name) do update set value_enc = excluded.value_enc, created_at = now()`,
    [req.project.id, name, encrypt(req.body.value)],
  );
  res.json({ ok: true });
}));

r.delete('/projects/:pid/secrets/:name', requireProject('developer'), ah(async (req, res) => {
  await query('delete from project_secrets where project_id = $1 and name = $2', [req.project.id, req.params.name]);
  res.json({ ok: true });
}));

// ---- Credentials vault ----
r.get('/projects/:pid/credentials', requireProject(), ah(async (req, res) => {
  const rows = await many(
    'select id, platform, type, name, meta, created_at, updated_at from credentials where project_id = $1 order by platform, type',
    [req.project.id],
  );
  res.json({
    types: Object.entries(CREDENTIAL_TYPES).map(([type, d]) => ({ type, platform: d.platform, label: d.label, fields: d.fields })),
    credentials: rows.map((c) => ({ id: c.id, platform: c.platform, type: c.type, name: c.name, meta: c.meta, createdAt: c.created_at, updatedAt: c.updated_at })),
  });
}));

r.put('/projects/:pid/credentials/:type', requireProject('admin'), ah(async (req, res) => {
  const { data, name } = req.body || {};
  const { platform, meta } = validateCredential(req.params.type, data);
  const row = await one(
    `insert into credentials (project_id, platform, type, name, data_enc, meta) values ($1,$2,$3,$4,$5,$6)
     on conflict (project_id, type) do update set name = excluded.name, data_enc = excluded.data_enc, meta = excluded.meta, updated_at = now()
     returning id, platform, type, name, meta, updated_at`,
    [req.project.id, platform, req.params.type, name || CREDENTIAL_TYPES[req.params.type].label, encrypt(data), meta],
  );
  res.json({ credential: row });
}));

// Backup download of the Android keystore (admins). Returns the file plus its passwords.
r.get('/projects/:pid/credentials/android_keystore/backup', requireProject('admin'), ah(async (req, res) => {
  const row = await one(`select data_enc from credentials where project_id = $1 and type = 'android_keystore'`, [req.project.id]);
  if (!row) throw notFound('Keystore');
  const d = decrypt(row.data_enc);
  res.json({ keystoreBase64: d.keystoreBase64, keystorePassword: d.keystorePassword, keyAlias: d.keyAlias, keyPassword: d.keyPassword });
}));

r.delete('/projects/:pid/credentials/:type', requireProject('admin'), ah(async (req, res) => {
  await query('delete from credentials where project_id = $1 and type = $2', [req.project.id, req.params.type]);
  res.json({ ok: true });
}));

// ---- Remote app versioning (auto-increment build numbers) ----
r.put('/projects/:pid/versions/:platform', requireProject('developer'), ah(async (req, res) => {
  const { platform } = req.params;
  if (!['ios', 'android'].includes(platform)) throw bad('platform must be ios or android');
  const n = Number(req.body?.buildNumber);
  if (!Number.isInteger(n) || n < 0) throw bad('buildNumber must be a non-negative integer');
  await query(
    `insert into app_versions (project_id, platform, build_number) values ($1,$2,$3)
     on conflict (project_id, platform) do update set build_number = excluded.build_number, updated_at = now()`,
    [req.project.id, platform, n],
  );
  res.json({ platform, buildNumber: n });
}));

// ---- OTA code signing key ----
r.put('/projects/:pid/updates-signing-key', requireProject('admin'), ah(async (req, res) => {
  const pem = req.body?.privateKeyPem;
  if (pem === null) {
    await query('update projects set updates_signing_key_enc = null where id = $1', [req.project.id]);
    return res.json({ ok: true });
  }
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw bad('privateKeyPem must be an RSA private key in PEM format (from `npx expo-updates codesigning:generate`)');
  }
  await query('update projects set updates_signing_key_enc = $1 where id = $2', [encrypt(pem), req.project.id]);
  res.json({ ok: true });
}));

// ---- Webhooks ----
r.get('/projects/:pid/webhooks', requireProject('admin'), ah(async (req, res) => {
  const rows = await many('select id, url, events, created_at from webhooks where project_id = $1 order by created_at', [req.project.id]);
  res.json({ webhooks: rows, events: WEBHOOK_EVENTS });
}));

r.post('/projects/:pid/webhooks', requireProject('admin'), ah(async (req, res) => {
  const { url, events = [] } = req.body || {};
  if (!/^https?:\/\//.test(url || '')) throw bad('url must be http(s)');
  const invalid = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (invalid.length) throw bad(`Unknown events: ${invalid.join(', ')}`);
  const secret = crypto.randomBytes(24).toString('hex');
  const row = await one('insert into webhooks (project_id, url, secret, events) values ($1,$2,$3,$4) returning id, url, events, created_at', [
    req.project.id,
    url,
    secret,
    events,
  ]);
  res.status(201).json({ webhook: { ...row, secret } });
}));

r.delete('/projects/:pid/webhooks/:id', requireProject('admin'), ah(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'Invalid id');
  await query('delete from webhooks where id = $1 and project_id = $2', [req.params.id, req.project.id]);
  res.json({ ok: true });
}));

export default r;
