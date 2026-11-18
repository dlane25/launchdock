// Endpoints used by build workers (authenticated with WORKER_TOKEN).
import express from 'express';
import { one, many, query, tx } from '../db.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { ah, bad, notFound, HttpError, requireWorker, isUuid, requireUser, requireAdmin } from '../http.js';
import { validateCredential } from '../credentials.js';
import { appendLogs, emit } from '../events.js';
import { buildOut, submissionOut, createSubmission } from './builds.js';

const r = express.Router();

const TABLE = { build: 'builds', submission: 'submissions' };

async function projectPayload(projectId, platform) {
  const p = await one('select * from projects where id = $1', [projectId]);
  const creds = await many('select type, data_enc from credentials where project_id = $1 and platform = $2', [projectId, platform]);
  const credentials = Object.fromEntries(creds.map((c) => [c.type, decrypt(c.data_enc)]));
  return {
    project: {
      id: p.id,
      name: p.name,
      slug: p.slug,
      iosBundleId: p.ios_bundle_id,
      androidPackage: p.android_package,
      appleTeamId: p.apple_team_id,
      ascAppId: p.asc_app_id,
    },
    credentials,
    gitUrl: p.git_url,
    gitToken: p.git_token_enc ? decrypt(p.git_token_enc, { json: false }) : null,
  };
}

r.post('/worker/claim', requireWorker, ah(async (req, res) => {
  const platforms = (req.body?.platforms || []).filter((p) => ['ios', 'android'].includes(p));
  if (!platforms.length) throw bad('platforms is required');
  await query(
    `insert into workers (id, platforms, version, info, last_seen_at) values ($1,$2,$3,$4,now())
     on conflict (id) do update set platforms = excluded.platforms, version = excluded.version, info = excluded.info, last_seen_at = now()`,
    [req.workerId, platforms, req.body?.version || null, req.body?.info || {}],
  );

  const claimed = await tx(async (c) => {
    // Builds first, then submissions.
    const b = (
      await c.query(
        `select * from builds where status = 'queued' and platform = any($1) order by created_at for update skip locked limit 1`,
        [platforms],
      )
    ).rows[0];
    if (b) {
      const pcfg = b.config?.[b.platform] || {};
      let buildNumber = pcfg.buildNumber != null ? String(pcfg.buildNumber) : null;
      if (buildNumber === null && pcfg.autoIncrement !== false) {
        const v = (
          await c.query(
            `insert into app_versions (project_id, platform, build_number) values ($1,$2,1)
             on conflict (project_id, platform) do update set build_number = app_versions.build_number + 1, updated_at = now()
             returning build_number`,
            [b.project_id, b.platform],
          )
        ).rows[0];
        buildNumber = String(v.build_number);
      }
      const updated = (
        await c.query(
          `update builds set status = 'in_progress', worker_id = $2, started_at = now(), heartbeat_at = now(), build_number = coalesce($3, build_number)
            where id = $1 returning *`,
          [b.id, req.workerId, buildNumber],
        )
      ).rows[0];
      return { type: 'build', row: updated };
    }
    const s = (
      await c.query(
        `select * from submissions where status = 'queued' and platform = any($1) order by created_at for update skip locked limit 1`,
        [platforms],
      )
    ).rows[0];
    if (s) {
      const updated = (
        await c.query(
          `update submissions set status = 'in_progress', worker_id = $2, started_at = now(), heartbeat_at = now() where id = $1 returning *`,
          [s.id, req.workerId],
        )
      ).rows[0];
      return { type: 'submission', row: updated };
    }
    return null;
  });

  if (!claimed) return res.json({ job: null });
  const { type, row } = claimed;
  await query('update workers set current_job = $2 where id = $1', [req.workerId, `${type}:${row.id}`]);
  await appendLogs(row.id, [`[launchdock] Picked up by worker ${req.workerId}`]);
  const payload = await projectPayload(row.project_id, row.platform);

  if (type === 'build') {
    emit(row.project_id, 'build.started', buildOut(row));
    const secrets = await many('select name, value_enc from project_secrets where project_id = $1', [row.project_id]);
    const env = { ...Object.fromEntries(secrets.map((s) => [s.name, decrypt(s.value_enc, { json: false })])), ...(row.config?.env || {}) };
    let gitUrl = null;
    if (row.source_type === 'git') {
      gitUrl = payload.gitUrl;
      if (payload.gitToken && gitUrl.startsWith('https://')) {
        gitUrl = gitUrl.replace('https://', `https://x-access-token:${encodeURIComponent(payload.gitToken)}@`);
      }
    }
    return res.json({
      job: {
        type,
        id: row.id,
        platform: row.platform,
        profile: row.profile,
        config: row.config,
        sourceType: row.source_type,
        gitUrl,
        gitRef: row.git_ref,
        buildNumber: row.build_number,
        channel: row.channel,
        updatesUrl: `${config.publicUrl}/api/updates/${row.project_id}/manifest`,
      },
      project: payload.project,
      credentials: payload.credentials,
      env,
    });
  }

  const build = await one('select * from builds where id = $1', [row.build_id]);
  res.json({
    job: {
      type,
      id: row.id,
      platform: row.platform,
      config: row.config,
      build: { id: build.id, artifactName: build.artifact_name, appVersion: build.app_version, buildNumber: build.build_number, profile: build.profile },
    },
    project: payload.project,
    credentials: payload.credentials,
  });
}));

// Load a job and ensure the calling worker owns it.
async function ownedJob(req, { allowFinished = false } = {}) {
  const table = TABLE[req.params.type];
  if (!table || !isUuid(req.params.id)) throw notFound('Job');
  const job = await one(`select * from ${table} where id = $1`, [req.params.id]);
  if (!job) throw notFound('Job');
  if (job.worker_id !== req.workerId) throw new HttpError(409, 'Job is assigned to another worker');
  if (!allowFinished && job.status !== 'in_progress') throw new HttpError(409, `Job is ${job.status}`, { status: job.status });
  return { table, job };
}

r.post('/worker/jobs/:type/:id/heartbeat', requireWorker, ah(async (req, res) => {
  const { table, job } = await ownedJob(req, { allowFinished: true });
  await query('update workers set last_seen_at = now() where id = $1', [req.workerId]);
  if (job.status !== 'in_progress') return res.json({ cancel: true, status: job.status });
  await query(`update ${table} set heartbeat_at = now() where id = $1`, [job.id]);
  res.json({ cancel: false });
}));

r.post('/worker/jobs/:type/:id/logs', requireWorker, ah(async (req, res) => {
  const { job } = await ownedJob(req, { allowFinished: true });
  const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 5000) : [];
  await appendLogs(job.id, lines);
  res.json({ ok: true });
}));

r.get('/worker/jobs/:type/:id/source', requireWorker, ah(async (req, res) => {
  const { job } = await ownedJob(req);
  if (req.params.type !== 'build' || !job.source_key) throw notFound('Source');
  const obj = await storage.getStream(job.source_key);
  if (!obj) throw notFound('Source');
  res.setHeader('content-type', 'application/gzip');
  if (obj.size) res.setHeader('content-length', obj.size);
  obj.stream.pipe(res);
}));

r.put('/worker/jobs/:type/:id/artifact', requireWorker, ah(async (req, res) => {
  const { job } = await ownedJob(req);
  if (req.params.type !== 'build') throw bad('Only builds have artifacts');
  const name = String(req.query.name || '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!/\.(aab|apk|ipa|zip|tar\.gz)$/.test(name)) throw bad('Artifact name must end in .aab, .apk, .ipa, .zip or .tar.gz');
  const key = `artifacts/${job.project_id}/${job.id}/${name}`;
  const { size } = await storage.putStream(key, req, { maxBytes: config.limits.artifactBytes });
  await query('update builds set artifact_key = $2, artifact_name = $3, artifact_size = $4 where id = $1', [job.id, key, name, size]);
  res.json({ ok: true, size });
}));

r.get('/worker/jobs/:type/:id/build-artifact', requireWorker, ah(async (req, res) => {
  const { job } = await ownedJob(req);
  if (req.params.type !== 'submission') throw bad('Only submissions download build artifacts');
  const build = await one('select * from builds where id = $1', [job.build_id]);
  const obj = build?.artifact_key && (await storage.getStream(build.artifact_key));
  if (!obj) throw notFound('Build artifact');
  res.setHeader('content-type', 'application/octet-stream');
  if (obj.size) res.setHeader('content-length', obj.size);
  obj.stream.pipe(res);
}));

// Workers may store a keystore they generated on first Android build.
r.put('/worker/jobs/:type/:id/credentials/:ctype', requireWorker, ah(async (req, res) => {
  const { job } = await ownedJob(req);
  if (req.params.ctype !== 'android_keystore') throw bad('Workers may only store generated Android keystores');
  const existing = await one(`select 1 from credentials where project_id = $1 and type = 'android_keystore'`, [job.project_id]);
  if (existing) throw new HttpError(409, 'Project already has a keystore');
  const { platform, meta } = validateCredential('android_keystore', req.body?.data);
  await query(
    `insert into credentials (project_id, platform, type, name, data_enc, meta) values ($1,$2,'android_keystore',$3,$4,$5)`,
    [job.project_id, platform, 'Generated upload keystore', encrypt(req.body.data), { ...meta, generated: true }],
  );
  await appendLogs(job.id, ['[launchdock] Stored newly generated Android keystore in the credentials vault']);
  res.status(201).json({ ok: true });
}));

r.post('/worker/jobs/:type/:id/complete', requireWorker, ah(async (req, res) => {
  const { table, job } = await ownedJob(req, { allowFinished: true });
  await query('update workers set current_job = null, last_seen_at = now() where id = $1', [req.workerId]);
  if (job.status !== 'in_progress') return res.json({ ok: true, ignored: true, status: job.status });
  const status = req.body?.status === 'finished' ? 'finished' : 'errored';
  const error = status === 'errored' ? String(req.body?.error || 'Unknown error').slice(0, 4000) : null;
  const result = req.body?.result || {};

  if (table === 'builds') {
    if (status === 'finished' && !job.artifact_key) throw bad('Upload the artifact before completing the build');
    const b = await one(
      `update builds set status = $2, error = $3, finished_at = now(),
              app_version = coalesce($4, app_version), build_number = coalesce($5, build_number),
              runtime_version = coalesce($6, runtime_version), git_commit = coalesce($7, git_commit)
        where id = $1 returning *`,
      [job.id, status, error, result.appVersion || null, result.buildNumber ? String(result.buildNumber) : null,
        result.runtimeVersion || null, result.gitCommit || null],
    );
    await appendLogs(job.id, [status === 'finished' ? '[launchdock] Build finished ✔' : `[launchdock] Build failed: ${error}`]);
    emit(b.project_id, status === 'finished' ? 'build.finished' : 'build.errored', buildOut(b));
    if (status === 'finished' && b.auto_submit) {
      const sub = await createSubmission(b, b.submit_config || {}, b.created_by);
      await appendLogs(job.id, [`[launchdock] Auto-submit queued: submission ${sub.id}`]);
    }
  } else {
    const s = await one(`update submissions set status = $2, error = $3, result = $4, finished_at = now() where id = $1 returning *`, [
      job.id,
      status,
      error,
      result,
    ]);
    await appendLogs(job.id, [status === 'finished' ? '[launchdock] Submission finished ✔' : `[launchdock] Submission failed: ${error}`]);
    emit(s.project_id, status === 'finished' ? 'submission.finished' : 'submission.errored', submissionOut(s));
  }
  res.json({ ok: true });
}));

// Dashboard: list workers (admins only).
r.get('/workers', requireUser, requireAdmin, ah(async (_req, res) => {
  const rows = await many('select * from workers order by last_seen_at desc');
  res.json({
    workers: rows.map((w) => ({
      id: w.id,
      platforms: w.platforms,
      version: w.version,
      info: w.info,
      currentJob: w.current_job,
      lastSeenAt: w.last_seen_at,
      online: Date.now() - new Date(w.last_seen_at).getTime() < 2 * 60 * 1000,
    })),
  });
}));

r.get('/queue', requireUser, ah(async (_req, res) => {
  const rows = await many(
    `select platform, status, count(*)::int as n from builds where status in ('queued','in_progress') group by 1,2`,
  );
  res.json({ queue: rows });
}));

export default r;
