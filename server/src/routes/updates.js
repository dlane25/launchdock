// Over-the-air updates implementing the Expo Updates protocol (v0 and v1):
// https://docs.expo.dev/technical-specs/expo-updates-1/
import crypto from 'node:crypto';
import express from 'express';
import { one, many, query } from '../db.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import { decrypt } from '../crypto.js';
import { ah, bad, notFound, requireUser, requireProject, isUuid } from '../http.js';
import { emit } from '../events.js';

const r = express.Router();
const PLATFORMS = ['ios', 'android'];
const HASH_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(sha256)

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', json: 'application/json',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', js: 'application/javascript',
  bundle: 'application/javascript', hbc: 'application/javascript', html: 'text/html', txt: 'text/plain',
};
export const mimeFor = (ext) => MIME[String(ext || '').replace(/^\./, '').toLowerCase()] || 'application/octet-stream';

// ---- Publishing (CLI) ----
r.post('/projects/:pid/updates/assets/check', requireUser, requireProject('developer'), ah(async (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes.filter((h) => HASH_RE.test(h)) : [];
  if (!hashes.length) return res.json({ missing: [] });
  const rows = await many('select hash from update_assets where project_id = $1 and hash = any($2)', [req.project.id, hashes]);
  const have = new Set(rows.map((r) => r.hash));
  res.json({ missing: [...new Set(hashes.filter((h) => !have.has(h)))] });
}));

r.put(
  '/projects/:pid/updates/assets/:hash',
  requireUser,
  requireProject('developer'),
  express.raw({ type: () => true, limit: config.limits.assetBytes }),
  ah(async (req, res) => {
    const { hash } = req.params;
    if (!HASH_RE.test(hash)) throw bad('Invalid asset hash');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const actual = crypto.createHash('sha256').update(buf).digest('base64url');
    if (actual !== hash) throw bad(`Hash mismatch: expected ${hash}, got ${actual}`);
    const contentType = String(req.headers['x-asset-content-type'] || mimeFor(req.headers['x-asset-ext']));
    const key = `updates/${req.project.id}/assets/${hash}`;
    await storage.putBuffer(key, buf, { contentType });
    await query(
      `insert into update_assets (project_id, hash, storage_key, content_type, size) values ($1,$2,$3,$4,$5)
       on conflict (project_id, hash) do nothing`,
      [req.project.id, hash, key, contentType, buf.length],
    );
    res.status(201).json({ hash, size: buf.length });
  }),
);

r.post('/projects/:pid/updates', requireUser, requireProject('developer'), ah(async (req, res) => {
  const { channel = 'production', runtimeVersion, message, platforms, expoClient, gitCommit } = req.body || {};
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(channel)) throw bad('Invalid channel name');
  if (!platforms || typeof platforms !== 'object') throw bad('"platforms" is required');
  const groupId = crypto.randomUUID();
  const created = [];
  for (const [platform, spec] of Object.entries(platforms)) {
    if (!PLATFORMS.includes(platform)) throw bad(`Unknown platform ${platform}`);
    const rv = (typeof runtimeVersion === 'object' ? runtimeVersion?.[platform] : runtimeVersion) || spec.runtimeVersion;
    if (!rv) throw bad(`runtimeVersion is required for ${platform}`);
    const all = [spec.launchAsset, ...(spec.assets || [])];
    if (!spec.launchAsset?.hash) throw bad(`launchAsset missing for ${platform}`);
    const hashes = all.map((a) => a.hash);
    const present = await many('select hash from update_assets where project_id = $1 and hash = any($2)', [req.project.id, hashes]);
    const missing = hashes.filter((h) => !present.some((p) => p.hash === h));
    if (missing.length) throw bad(`Assets not uploaded yet: ${missing.slice(0, 5).join(', ')}`, { missing });
    const clean = (a, launch) => ({
      hash: a.hash,
      ext: launch ? 'bundle' : String(a.ext || '').replace(/^\./, ''),
      contentType: launch ? 'application/javascript' : a.contentType || mimeFor(a.ext),
    });
    const u = await one(
      `insert into updates (group_id, project_id, channel, runtime_version, platform, message, launch_asset, assets, expo_client, git_commit, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [
        groupId,
        req.project.id,
        channel,
        String(rv),
        platform,
        message ? String(message).slice(0, 500) : null,
        clean(spec.launchAsset, true),
        JSON.stringify((spec.assets || []).map((a) => clean(a, false))),
        expoClient || null,
        gitCommit || null,
        req.user.id,
      ],
    );
    created.push(updateOut(u));
  }
  emit(req.project.id, 'update.published', { groupId, channel, updates: created });
  res.status(201).json({ groupId, updates: created });
}));

r.get('/projects/:pid/updates', requireUser, requireProject(), ah(async (req, res) => {
  const params = [req.project.id];
  let where = 'project_id = $1';
  if (req.query.channel) {
    params.push(req.query.channel);
    where += ` and channel = $${params.length}`;
  }
  const rows = await many(`select * from updates where ${where} order by created_at desc limit 200`, params);
  res.json({ updates: rows.map(updateOut) });
}));

// Roll back a channel: either to the embedded bundle, or by republishing an older update group.
r.post('/projects/:pid/updates/rollback', requireUser, requireProject('developer'), ah(async (req, res) => {
  const { channel = 'production', runtimeVersion, platforms = PLATFORMS, toGroupId } = req.body || {};
  if (!runtimeVersion && !toGroupId) throw bad('runtimeVersion (rollback to embedded) or toGroupId (republish) is required');
  const groupId = crypto.randomUUID();
  const created = [];
  if (toGroupId) {
    if (!isUuid(toGroupId)) throw bad('Invalid toGroupId');
    const src = await many(`select * from updates where project_id = $1 and group_id = $2 and kind = 'update'`, [req.project.id, toGroupId]);
    if (!src.length) throw notFound('Update group');
    for (const s of src) {
      const u = await one(
        `insert into updates (group_id, project_id, channel, runtime_version, platform, message, launch_asset, assets, expo_client, metadata, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [groupId, req.project.id, channel, s.runtime_version, s.platform, `Republish of ${toGroupId.slice(0, 8)}: ${s.message || ''}`,
          s.launch_asset, JSON.stringify(s.assets), s.expo_client, { republishedFrom: s.id }, req.user.id],
      );
      created.push(updateOut(u));
    }
  } else {
    for (const platform of platforms.filter((p) => PLATFORMS.includes(p))) {
      const u = await one(
        `insert into updates (group_id, project_id, channel, runtime_version, platform, message, kind, created_by)
         values ($1,$2,$3,$4,$5,'Roll back to embedded build','rollback',$6) returning *`,
        [groupId, req.project.id, channel, String(runtimeVersion), platform, req.user.id],
      );
      created.push(updateOut(u));
    }
  }
  emit(req.project.id, 'update.published', { groupId, channel, rollback: true, updates: created });
  res.status(201).json({ groupId, updates: created });
}));

function updateOut(u) {
  return {
    id: u.id,
    groupId: u.group_id,
    channel: u.channel,
    runtimeVersion: u.runtime_version,
    platform: u.platform,
    message: u.message,
    kind: u.kind,
    assetCount: Array.isArray(u.assets) ? u.assets.length : 0,
    gitCommit: u.git_commit,
    createdAt: u.created_at,
  };
}

// ---- Protocol endpoints (called by expo-updates inside the app; public) ----
const assetUrl = (pid, hash) => `${config.publicUrl}/api/updates/${pid}/assets/${hash}`;
const md5Key = (hash) => crypto.createHash('md5').update(hash).digest('hex');

function multipart(parts) {
  const boundary = `launchdock-${crypto.randomBytes(12).toString('hex')}`;
  let out = '';
  for (const p of parts) {
    out += `--${boundary}\r\ncontent-disposition: form-data; name="${p.name}"\r\ncontent-type: application/json; charset=utf-8\r\n`;
    for (const [k, v] of Object.entries(p.headers || {})) out += `${k}: ${v}\r\n`;
    out += `\r\n${p.body}\r\n`;
  }
  out += `--${boundary}--\r\n`;
  return { boundary, body: Buffer.from(out, 'utf8') };
}

function signBody(project, body) {
  if (!project.updates_signing_key_enc) return null;
  const pem = decrypt(project.updates_signing_key_enc, { json: false });
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(pem, 'base64');
  return `sig="${sig}", keyid="main"`;
}

r.get('/updates/:pid/manifest', ah(async (req, res) => {
  const pid = req.params.pid;
  const protocol = Number(req.headers['expo-protocol-version'] ?? 0);
  const platform = req.headers['expo-platform'] || req.query.platform;
  const runtimeVersion = req.headers['expo-runtime-version'] || req.query['runtime-version'];
  const channel = req.headers['expo-channel-name'] || req.query.channel || 'production';
  const currentUpdateId = req.headers['expo-current-update-id'];
  const embeddedUpdateId = req.headers['expo-embedded-update-id'];
  const expectSignature = !!req.headers['expo-expect-signature'];

  if (!isUuid(pid)) return res.status(404).json({ error: 'Unknown project' });
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'expo-platform header must be ios or android' });
  if (!runtimeVersion) return res.status(400).json({ error: 'expo-runtime-version header is required' });

  const project = await one('select id, updates_signing_key_enc from projects where id = $1', [pid]);
  if (!project) return res.status(404).json({ error: 'Unknown project' });
  if (expectSignature && !project.updates_signing_key_enc) {
    return res.status(400).json({ error: 'App expects signed manifests, but no code signing key is configured for this project' });
  }

  const latest = await one(
    `select * from updates where project_id = $1 and channel = $2 and runtime_version = $3 and platform = $4
      order by created_at desc limit 1`,
    [pid, channel, String(runtimeVersion), platform],
  );

  res.setHeader('expo-protocol-version', String(protocol >= 1 ? 1 : 0));
  res.setHeader('expo-sfv-version', '0');
  res.setHeader('cache-control', 'private, max-age=0');

  const sendDirective = (directive) => {
    if (protocol < 1) {
      // Protocol 0 has no directives: report "nothing new" with 204.
      return res.status(204).end();
    }
    const body = JSON.stringify(directive);
    const sig = expectSignature ? signBody(project, body) : null;
    const mp = multipart([{ name: 'directive', body, headers: sig ? { 'expo-signature': sig } : {} }]);
    res.setHeader('content-type', `multipart/mixed; boundary=${mp.boundary}`);
    return res.status(200).send(mp.body);
  };

  if (!latest) return sendDirective({ type: 'noUpdateAvailable' });

  if (latest.kind === 'rollback') {
    // Already on the embedded update → nothing to do.
    if (currentUpdateId && embeddedUpdateId && currentUpdateId === embeddedUpdateId) return sendDirective({ type: 'noUpdateAvailable' });
    return sendDirective({ type: 'rollBackToEmbedded', parameters: { commitTime: new Date(latest.created_at).toISOString() } });
  }

  if (currentUpdateId && currentUpdateId === latest.id && protocol >= 1) return sendDirective({ type: 'noUpdateAvailable' });

  const meta = (a, launch) => ({
    hash: a.hash,
    key: md5Key(a.hash),
    contentType: a.contentType,
    fileExtension: launch ? '.bundle' : a.ext ? `.${a.ext}` : undefined,
    url: assetUrl(pid, a.hash),
  });
  const manifest = {
    id: latest.id,
    createdAt: new Date(latest.created_at).toISOString(),
    runtimeVersion: latest.runtime_version,
    launchAsset: meta(latest.launch_asset, true),
    assets: (latest.assets || []).map((a) => meta(a, false)),
    metadata: { channel, message: latest.message || undefined },
    extra: { expoClient: latest.expo_client || undefined },
  };
  const body = JSON.stringify(manifest);
  const sig = expectSignature ? signBody(project, body) : null;
  const mp = multipart([
    { name: 'manifest', body, headers: sig ? { 'expo-signature': sig } : {} },
    { name: 'extensions', body: JSON.stringify({ assetRequestHeaders: {} }) },
  ]);
  res.setHeader('content-type', `multipart/mixed; boundary=${mp.boundary}`);
  res.status(200).send(mp.body);
}));

r.get('/updates/:pid/assets/:hash', ah(async (req, res) => {
  const { pid, hash } = req.params;
  if (!isUuid(pid) || !HASH_RE.test(hash)) throw notFound('Asset');
  const row = await one('select * from update_assets where project_id = $1 and hash = $2', [pid, hash]);
  if (!row) throw notFound('Asset');
  const obj = await storage.getStream(row.storage_key);
  if (!obj) throw notFound('Asset');
  res.setHeader('content-type', row.content_type);
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  if (obj.size) res.setHeader('content-length', obj.size);
  obj.stream.pipe(res);
}));

export default r;
