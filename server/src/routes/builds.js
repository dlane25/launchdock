import crypto from 'node:crypto';
import express from 'express';
import { one, many, query } from '../db.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import { signLink, verifyLink, verifyJwt } from '../crypto.js';
import { ah, bad, notFound, HttpError, requireUser, requireProject, loadProjectForUser, isUuid, authenticate } from '../http.js';
import { appendLogs, emit } from '../events.js';
import { dispatchRunner } from '../dispatch.js';

const r = express.Router();

export function buildOut(b) {
  return {
    id: b.id,
    projectId: b.project_id,
    platform: b.platform,
    profile: b.profile,
    status: b.status,
    sourceType: b.source_type,
    gitRef: b.git_ref,
    gitCommit: b.git_commit,
    message: b.message,
    config: b.config,
    artifactName: b.artifact_name,
    artifactSize: b.artifact_size,
    hasArtifact: !!b.artifact_key,
    appVersion: b.app_version,
    buildNumber: b.build_number,
    runtimeVersion: b.runtime_version,
    channel: b.channel,
    autoSubmit: b.auto_submit,
    workerId: b.worker_id,
    error: b.error,
    createdAt: b.created_at,
    startedAt: b.started_at,
    finishedAt: b.finished_at,
  };
}

export function submissionOut(s) {
  return {
    id: s.id,
    projectId: s.project_id,
    buildId: s.build_id,
    platform: s.platform,
    status: s.status,
    config: s.config,
    result: s.result,
    workerId: s.worker_id,
    error: s.error,
    createdAt: s.created_at,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
  };
}

async function loadJob(table, id, user, minRole = 'viewer') {
  if (!isUuid(id)) throw notFound(table === 'builds' ? 'Build' : 'Submission');
  const job = await one(`select * from ${table} where id = $1`, [id]);
  if (!job) throw notFound(table === 'builds' ? 'Build' : 'Submission');
  const project = await loadProjectForUser(job.project_id, user, minRole);
  return { job, project };
}

const PLATFORMS = ['ios', 'android'];

function normalizeSubmitConfig(platform, cfg = {}) {
  if (platform === 'android') {
    const track = cfg.track || 'internal';
    const releaseStatus = cfg.releaseStatus || 'completed';
    if (!['completed', 'draft', 'halted', 'inProgress'].includes(releaseStatus)) throw bad('android releaseStatus invalid');
    const out = { track, releaseStatus };
    if (cfg.rollout !== undefined) out.rollout = Number(cfg.rollout);
    if (cfg.changesNotSentForReview !== undefined) out.changesNotSentForReview = !!cfg.changesNotSentForReview;
    if (cfg.releaseNotes) out.releaseNotes = String(cfg.releaseNotes).slice(0, 500);
    return out;
  }
  return { ascAppId: cfg.ascAppId || null, groups: Array.isArray(cfg.groups) ? cfg.groups : [], whatToTest: cfg.whatToTest || null };
}

// ---- Upload a source tarball (CLI) ----
r.post('/projects/:pid/sources', requireUser, requireProject('developer'), ah(async (req, res) => {
  const key = `sources/${req.project.id}/${crypto.randomUUID()}.tar.gz`;
  const { size } = await storage.putStream(key, req, { maxBytes: config.limits.sourceBytes, contentType: 'application/gzip' });
  if (!size) throw bad('Empty upload');
  res.status(201).json({ sourceKey: key, size });
}));

// ---- Create builds ----
r.post('/projects/:pid/builds', requireUser, requireProject('developer'), ah(async (req, res) => {
  const body = req.body || {};
  const platforms = body.platform === 'all' || !body.platform ? body.platforms || PLATFORMS : [body.platform];
  if (!platforms.length || platforms.some((p) => !PLATFORMS.includes(p))) throw bad('platform must be ios, android or all');
  const p = req.project;

  let sourceType;
  if (body.sourceKey) {
    if (!String(body.sourceKey).startsWith(`sources/${p.id}/`)) throw bad('sourceKey does not belong to this project');
    if (!(await storage.exists(body.sourceKey))) throw bad('Source upload not found; upload again');
    sourceType = 'upload';
  } else {
    if (!p.git_url) throw bad('Provide sourceKey (upload) or configure a Git URL on the project');
    sourceType = 'git';
  }

  const profile = String(body.profile || 'production').slice(0, 50);
  const profileConfig = body.config && typeof body.config === 'object' ? body.config : {};
  const created = [];
  for (const platform of platforms) {
    if (platform === 'ios' && !p.ios_bundle_id) throw bad('Set the iOS bundle identifier on the project first');
    if (platform === 'android' && !p.android_package) throw bad('Set the Android package name on the project first');
    const platformCfg = { ...(profileConfig[platform] || {}) };
    const cfg = {
      env: { ...(profileConfig.env || {}), ...(platformCfg.env || {}) },
      node: profileConfig.node,
      [platform]: platformCfg,
    };
    const autoSubmit = !!body.autoSubmit;
    const submitConfig = autoSubmit ? normalizeSubmitConfig(platform, body.submitConfig?.[platform]) : null;
    const b = await one(
      `insert into builds (project_id, platform, profile, source_type, source_key, git_ref, config, message, channel,
                           runtime_version, app_version, auto_submit, submit_config, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [
        p.id,
        platform,
        profile,
        sourceType,
        body.sourceKey || null,
        sourceType === 'git' ? body.gitRef || 'main' : null,
        cfg,
        body.message ? String(body.message).slice(0, 500) : null,
        profileConfig.channel || null,
        body.runtimeVersion?.[platform] || null,
        body.appVersion || null,
        autoSubmit,
        submitConfig,
        req.user.id,
      ],
    );
    if (body.gitCommit) await query('update builds set git_commit = $1 where id = $2', [String(body.gitCommit).slice(0, 64), b.id]);
    await appendLogs(b.id, [`[launchdock] Build queued by ${req.user.email} (${platform}, profile "${profile}")`]);
    created.push(buildOut(b));
    dispatchRunner(platform);
  }
  res.status(201).json({ builds: created });
}));

r.get('/projects/:pid/builds', requireUser, requireProject(), ah(async (req, res) => {
  const params = [req.project.id];
  let where = 'project_id = $1';
  if (req.query.platform) {
    params.push(req.query.platform);
    where += ` and platform = $${params.length}`;
  }
  if (req.query.status) {
    params.push(req.query.status);
    where += ` and status = $${params.length}`;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await many(`select * from builds where ${where} order by created_at desc limit ${limit}`, params);
  res.json({ builds: rows.map(buildOut) });
}));

r.get('/builds/:id', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('builds', req.params.id, req.user);
  const submissions = await many('select * from submissions where build_id = $1 order by created_at desc', [job.id]);
  res.json({ build: buildOut(job), submissions: submissions.map(submissionOut) });
}));

r.post('/builds/:id/cancel', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('builds', req.params.id, req.user, 'developer');
  if (!['queued', 'in_progress'].includes(job.status)) throw bad(`Build is already ${job.status}`);
  const b = await one(`update builds set status = 'canceled', finished_at = now(), error = 'Canceled by user' where id = $1 returning *`, [job.id]);
  await appendLogs(job.id, [`[launchdock] Canceled by ${req.user.email}`]);
  emit(job.project_id, 'build.canceled', buildOut(b));
  res.json({ build: buildOut(b) });
}));

r.post('/builds/:id/retry', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('builds', req.params.id, req.user, 'developer');
  if (job.source_type === 'upload' && !(await storage.exists(job.source_key))) throw bad('Original source upload is gone; run a new build');
  const b = await one(
    `insert into builds (project_id, platform, profile, source_type, source_key, git_ref, git_commit, config, message, channel,
                         runtime_version, app_version, auto_submit, submit_config, created_by)
     select project_id, platform, profile, source_type, source_key, git_ref, git_commit, config, coalesce(message, '') || ' (retry)', channel,
            runtime_version, app_version, auto_submit, submit_config, $2 from builds where id = $1 returning *`,
    [job.id, req.user.id],
  );
  await appendLogs(b.id, [`[launchdock] Retry of build ${job.id}`]);
  dispatchRunner(b.platform);
  res.status(201).json({ build: buildOut(b) });
}));

// ---- Logs (builds and submissions share job_logs) ----
async function logsHandler(table, req, res) {
  await loadJob(table, req.params.id, req.user);
  const after = Number(req.query.after) || 0;
  const rows = await many('select id, line, ts from job_logs where job_id = $1 and id > $2 order by id limit 5000', [req.params.id, after]);
  const job = await one(`select status from ${table} where id = $1`, [req.params.id]);
  res.json({ logs: rows, status: job.status });
}

// SSE stream; EventSource can't send headers, so a token query param is accepted here.
async function streamHandler(table, req, res) {
  const token = req.query.token;
  if (!req.user && token) {
    const payload = verifyJwt(token);
    if (payload?.sub) req.user = await one('select id, email, name, is_admin from users where id = $1', [payload.sub]);
  }
  if (!req.user) throw new HttpError(401, 'Authentication required');
  await loadJob(table, req.params.id, req.user);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let lastId = Number(req.query.after) || 0;
  let closed = false;
  req.on('close', () => (closed = true));
  while (!closed) {
    const rows = await many('select id, line, ts from job_logs where job_id = $1 and id > $2 order by id limit 1000', [req.params.id, lastId]);
    for (const row of rows) {
      res.write(`id: ${row.id}\nevent: log\ndata: ${JSON.stringify(row)}\n\n`);
      lastId = row.id;
    }
    const { status } = await one(`select status from ${table} where id = $1`, [req.params.id]);
    res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
    if (!['queued', 'in_progress'].includes(status) && rows.length < 1000) {
      res.write('event: end\ndata: {}\n\n');
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.end();
}

const optionalUser = ah(async (req, _res, next) => {
  req.user = await authenticate(req);
  next();
});

r.get('/builds/:id/logs', requireUser, ah((req, res) => logsHandler('builds', req, res)));
r.get('/builds/:id/logs/stream', optionalUser, ah((req, res) => streamHandler('builds', req, res)));
r.get('/submissions/:id/logs', requireUser, ah((req, res) => logsHandler('submissions', req, res)));
r.get('/submissions/:id/logs/stream', optionalUser, ah((req, res) => streamHandler('submissions', req, res)));

// ---- Artifacts ----
async function sendArtifact(build, res) {
  if (!build.artifact_key) throw notFound('Artifact');
  const obj = await storage.getStream(build.artifact_key);
  if (!obj) throw notFound('Artifact');
  const type = build.artifact_name?.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream';
  res.setHeader('content-type', type);
  if (obj.size) res.setHeader('content-length', obj.size);
  res.setHeader('content-disposition', `attachment; filename="${build.artifact_name || 'artifact'}"`);
  obj.stream.pipe(res);
}

r.get('/builds/:id/artifact', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('builds', req.params.id, req.user);
  await sendArtifact(job, res);
}));

// Signed, shareable links (for testers / QR codes). Valid 7 days by default.
r.post('/builds/:id/share', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('builds', req.params.id, req.user, 'developer');
  if (!job.artifact_key) throw bad('Build has no artifact yet');
  const ttl = Math.min(Number(req.body?.ttlHours) || 168, 720) * 3600;
  res.json({
    downloadUrl: config.publicUrl + signLink(`/api/public/builds/${job.id}/artifact`, ttl),
    installUrl: config.publicUrl + signLink(`/api/public/builds/${job.id}/install`, ttl),
  });
}));

const checkSig = (req) => {
  if (!isUuid(req.params.id) || !verifyLink('/api' + req.path, req.query.exp, req.query.sig)) {
    throw new HttpError(403, 'Link expired or invalid');
  }
};

r.get('/public/builds/:id/artifact', ah(async (req, res) => {
  checkSig(req);
  const build = await one('select * from builds where id = $1', [req.params.id]);
  if (!build) throw notFound('Build');
  await sendArtifact(build, res);
}));

r.get('/public/builds/:id/manifest.plist', ah(async (req, res) => {
  checkSig(req);
  const b = await one('select b.*, p.name, p.ios_bundle_id from builds b join projects p on p.id = b.project_id where b.id = $1', [req.params.id]);
  if (!b) throw notFound('Build');
  const ipaUrl = config.publicUrl + signLink(`/api/public/builds/${b.id}/artifact`, 3600 * 24);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${esc(ipaUrl)}</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>${esc(b.ios_bundle_id)}</string>
<key>bundle-version</key><string>${esc(b.app_version || '1.0')}</string><key>kind</key><string>software</string>
<key>title</key><string>${esc(b.name)}</string></dict></dict></array></dict></plist>`);
}));

r.get('/public/builds/:id/install', ah(async (req, res) => {
  checkSig(req);
  const b = await one('select b.*, p.name from builds b join projects p on p.id = b.project_id where b.id = $1', [req.params.id]);
  if (!b) throw notFound('Build');
  const download = signLink(`/api/public/builds/${b.id}/artifact`, 3600 * 24);
  const manifest = encodeURIComponent(config.publicUrl + signLink(`/api/public/builds/${b.id}/manifest.plist`, 3600 * 24));
  const isIpa = b.artifact_name?.endsWith('.ipa');
  const isAab = b.artifact_name?.endsWith('.aab');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const href = isIpa ? `itms-services://?action=download-manifest&url=${manifest}` : download;
  const note = isAab
    ? 'This is an Android App Bundle for Google Play. It cannot be installed directly — use an APK build (preview profile) for testers.'
    : isIpa && b.config?.ios?.distribution !== 'ad-hoc'
      ? 'Only ad-hoc or enterprise iOS builds can be installed from a link. Store builds go through TestFlight.'
      : '';
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install ${esc(b.name)}</title><style>body{font-family:system-ui;background:#0b1020;color:#e8ecf8;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#141a2e;padding:32px;border-radius:16px;max-width:380px;text-align:center}a.b{display:inline-block;margin-top:16px;padding:14px 22px;background:#4f7cff;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
small{color:#9aa4c4;display:block;margin-top:14px}</style></head><body><div class="c"><h2>${esc(b.name)}</h2>
<div>${esc(b.platform.toUpperCase())} · v${esc(b.app_version || '?')} (${esc(b.build_number || '?')}) · ${esc(b.profile)}</div>
<a class="b" href="${esc(href)}">${isIpa ? 'Install on iPhone' : 'Download'}</a><small>${esc(note)}</small></div></body></html>`);
}));

// ---- Submissions ----
r.post('/projects/:pid/submissions', requireUser, requireProject('developer'), ah(async (req, res) => {
  const body = req.body || {};
  let build;
  if (body.buildId) {
    if (!isUuid(body.buildId)) throw bad('Invalid buildId');
    build = await one('select * from builds where id = $1 and project_id = $2', [body.buildId, req.project.id]);
  } else {
    if (!PLATFORMS.includes(body.platform)) throw bad('Provide buildId, or platform to submit the latest finished build');
    build = await one(
      `select * from builds where project_id = $1 and platform = $2 and status = 'finished' and artifact_key is not null
        order by finished_at desc limit 1`,
      [req.project.id, body.platform],
    );
  }
  if (!build) throw notFound('Finished build');
  if (build.status !== 'finished' || !build.artifact_key) throw bad('Build has not finished successfully');
  if (build.platform === 'android' && !build.artifact_name?.endsWith('.aab') && !build.artifact_name?.endsWith('.apk')) throw bad('No Android artifact');
  if (build.platform === 'ios' && !build.artifact_name?.endsWith('.ipa')) throw bad('No IPA artifact');
  const sub = await createSubmission(build, normalizeSubmitConfig(build.platform, body.config), req.user.id);
  res.status(201).json({ submission: submissionOut(sub) });
}));

export async function createSubmission(build, cfg, userId) {
  const sub = await one(
    `insert into submissions (project_id, build_id, platform, config, created_by) values ($1,$2,$3,$4,$5) returning *`,
    [build.project_id, build.id, build.platform, cfg, userId],
  );
  await appendLogs(sub.id, [`[launchdock] Submission queued for build ${build.id} (${build.platform})`]);
  dispatchRunner(build.platform);
  return sub;
}

r.get('/projects/:pid/submissions', requireUser, requireProject(), ah(async (req, res) => {
  const rows = await many('select * from submissions where project_id = $1 order by created_at desc limit 100', [req.project.id]);
  res.json({ submissions: rows.map(submissionOut) });
}));

r.get('/submissions/:id', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('submissions', req.params.id, req.user);
  res.json({ submission: submissionOut(job) });
}));

r.post('/submissions/:id/cancel', requireUser, ah(async (req, res) => {
  const { job } = await loadJob('submissions', req.params.id, req.user, 'developer');
  if (!['queued', 'in_progress'].includes(job.status)) throw bad(`Submission is already ${job.status}`);
  const s = await one(`update submissions set status = 'canceled', finished_at = now() where id = $1 returning *`, [job.id]);
  res.json({ submission: submissionOut(s) });
}));

export default r;
