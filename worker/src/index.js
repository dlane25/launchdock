#!/usr/bin/env node
// LaunchDock build worker: polls the API for build/submission jobs and runs them.
//   LAUNCHDOCK_URL=https://ship.example.com WORKER_TOKEN=... node src/index.js [--once]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from './api.js';
import { JobLogger, sleep, capture, run } from './util.js';
import { fetchSource, detectProjectType } from './builders/common.js';
import { buildAndroid } from './builders/android.js';
import { buildIos } from './builders/ios.js';
import { submitToPlay } from './submit/play.js';
import { submitToAppStore } from './submit/appstore.js';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once'); // run at most one job, then exit
const DRAIN = args.has('--drain'); // CI mode: run jobs until the queue is empty, then exit
const url = process.env.LAUNCHDOCK_URL;
const token = process.env.WORKER_TOKEN;
if (!url || !token) {
  console.error('Set LAUNCHDOCK_URL and WORKER_TOKEN');
  process.exit(1);
}
const workerId = process.env.WORKER_ID || `${os.hostname()}-${process.platform}`;
const platforms = (process.env.PLATFORMS || (process.platform === 'darwin' ? 'ios,android' : 'android')).split(',').map((s) => s.trim());
const workRoot = path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'launchdock-worker'));
const pollMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const keepWorkdir = process.env.KEEP_WORKDIR === 'true';

const api = new Api({ url, token, workerId });
let stopping = false;
let current = null;

async function toolInfo() {
  const v = (cmd, a) => capture(cmd, a).then((s) => s.split('\n')[0]).catch(() => null);
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    java: await run('java', ['-version'], { quiet: true }).then((r) => (r.stderr || r.stdout).split('\n')[0]).catch(() => null),
    xcode: process.platform === 'darwin' ? await v('xcodebuild', ['-version']) : null,
    flutter: await v('flutter', ['--version']),
    cpus: os.cpus().length,
    memGb: Math.round(os.totalmem() / 1e9),
  };
}

async function runJob(payload) {
  const { job } = payload;
  const logger = new JobLogger(api, job.type, job.id);
  const controller = new AbortController();
  const workDir = path.join(workRoot, job.id);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  current = { job, controller };

  // Secrets never appear in logs.
  for (const v of Object.values(payload.env || {})) logger.mask(v);
  for (const c of Object.values(payload.credentials || {})) for (const v of Object.values(c)) if (typeof v === 'string' && v.length < 200) logger.mask(v);

  const hb = setInterval(async () => {
    try {
      const r = await api.heartbeat(job.type, job.id);
      if (r.cancel) {
        logger.log('[worker] Job was canceled — stopping');
        controller.abort();
      }
    } catch {}
  }, 20000);

  const ctx = {
    api,
    job,
    project: payload.project,
    credentials: payload.credentials || {},
    env: {
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      LAUNCHDOCK: '1',
      LAUNCHDOCK_BUILD_ID: job.id,
      LAUNCHDOCK_BUILD_PROFILE: job.profile || '',
      LAUNCHDOCK_PLATFORM: job.platform,
      ...(payload.env || {}),
    },
    logger,
    signal: controller.signal,
    workDir,
  };

  let status = 'errored';
  let error = null;
  let result = {};
  try {
    result = job.type === 'build' ? await runBuild(ctx) : await runSubmission(ctx);
    status = 'finished';
  } catch (err) {
    error = controller.signal.aborted ? 'Canceled' : err.message;
    logger.log(`✖ ${error}`);
  } finally {
    clearInterval(hb);
    await logger.close();
    await api.complete(job.type, job.id, { status, error, result }).catch((e) => console.error('complete failed:', e.message));
    if (!keepWorkdir) fs.rmSync(workDir, { recursive: true, force: true });
    current = null;
  }
}

async function runBuild(ctx) {
  const { job, logger } = ctx;
  logger.section(`LaunchDock ${job.platform} build · profile "${job.profile}" · worker ${workerId}`);
  const srcDir = path.join(ctx.workDir, 'src');
  const gitCommit = await fetchSource(ctx, srcDir);
  const pcfg = job.config?.[job.platform] || {};
  const root = pcfg.projectDir ? path.join(srcDir, pcfg.projectDir) : srcDir;
  const projectType = pcfg.projectType || detectProjectType(root);
  logger.log(`Project type: ${projectType}${job.buildNumber ? ` · build number ${job.buildNumber}` : ''}`);

  const out = job.platform === 'android' ? await buildAndroid(ctx, srcDir, projectType) : await buildIos(ctx, srcDir, projectType);

  logger.section('Uploading artifact');
  const slug = ctx.project.slug || 'app';
  const version = out.appVersion ? `-${out.appVersion}` : '';
  const name = `${slug}${version}-${out.buildNumber || job.buildNumber || 'build'}-${job.profile}.${out.ext}`;
  const size = fs.statSync(out.artifact).size;
  logger.log(`${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  await api.uploadArtifact(job.id, out.artifact, name);
  return {
    appVersion: out.appVersion,
    buildNumber: out.buildNumber || job.buildNumber,
    runtimeVersion: out.runtimeVersion,
    gitCommit,
  };
}

async function runSubmission(ctx) {
  const { job, logger, project, credentials } = ctx;
  logger.section(`Submitting ${job.platform} build ${job.build.id.slice(0, 8)} (${job.build.appVersion || '?'} / ${job.build.buildNumber || '?'})`);
  const file = path.join(ctx.workDir, job.build.artifactName || `artifact.${job.platform === 'ios' ? 'ipa' : 'aab'}`);
  await api.download(`/api/worker/jobs/submission/${job.id}/build-artifact`, file);
  if (job.platform === 'android') {
    if (!credentials.google_service_account) throw new Error('Add a Google Play service account key to the project vault');
    return submitToPlay({
      file,
      packageName: project.androidPackage,
      serviceAccountJson: credentials.google_service_account.json,
      config: job.config || {},
      logger,
    });
  }
  return submitToAppStore(ctx, { file, project, build: job.build, config: job.config || {} });
}

async function main() {
  fs.mkdirSync(workRoot, { recursive: true });
  const info = await toolInfo();
  console.log(`[worker] ${workerId} · platforms: ${platforms.join(', ')} · ${url}${ONCE ? ' · once' : DRAIN ? ' · drain' : ''}`);
  let backoff = pollMs;
  while (!stopping) {
    try {
      const payload = await api.claim(platforms, info);
      backoff = pollMs;
      if (payload.job) {
        await runJob(payload);
        if (ONCE) break;
        continue;
      }
      if (ONCE || DRAIN) {
        console.log('[worker] No queued jobs');
        break;
      }
    } catch (err) {
      console.error(`[worker] ${err.message}`);
      backoff = Math.min(backoff * 2, 60000);
    }
    await sleep(backoff);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[worker] ${sig}: finishing current job then exiting (send again to force)`);
    if (!current) process.exit(0);
  });
}

main().then(() => process.exit(0));
