import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client, loadUserConfig, saveUserConfig, clearUserConfig } from './client.js';
import { packDirectory } from './tar.js';

// ---------- small helpers ----------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const STATUS = { queued: c.yellow('queued'), in_progress: c.cyan('in progress'), finished: c.green('finished'), errored: c.red('errored'), canceled: c.dim('canceled') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (!/[\r\n]/.test(s)) rl.output.write('*');
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

function client() {
  return new Client(loadUserConfig());
}

function findProjectRoot(start = process.cwd()) {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, 'launchdock.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadProjectConfig() {
  const root = findProjectRoot();
  if (!root) throw new Error('No launchdock.json found. Run "launchdock init" in your app folder.');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'launchdock.json'), 'utf8'));
  if (!cfg.projectId) throw new Error('launchdock.json is missing "projectId"');
  return { root, cfg };
}

// Resolve a build profile with "extends", then fold shared keys into each platform config.
export function resolveProfile(cfg, name, section = 'build') {
  const profiles = cfg[section] || {};
  const seen = new Set();
  const resolve = (n) => {
    if (seen.has(n)) throw new Error(`Circular "extends" in ${section} profile "${n}"`);
    seen.add(n);
    const p = profiles[n];
    if (!p) throw new Error(`No ${section} profile "${n}" in launchdock.json (have: ${Object.keys(profiles).join(', ') || 'none'})`);
    const base = p.extends ? resolve(p.extends) : {};
    const merged = { ...base, ...p, env: { ...base.env, ...p.env } };
    for (const plat of ['ios', 'android']) merged[plat] = { ...base[plat], ...p[plat], env: { ...base[plat]?.env, ...p[plat]?.env } };
    delete merged.extends;
    return merged;
  };
  const prof = resolve(name);
  if (section !== 'build') return prof;
  const shared = Object.fromEntries(Object.entries(prof).filter(([k]) => !['ios', 'android', 'env', 'channel', 'node'].includes(k)));
  for (const plat of ['ios', 'android']) prof[plat] = { ...shared, ...prof[plat] };
  return prof;
}

function gitCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function fmtSize(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

function readAppJson(root) {
  const p = path.join(root, 'app.json');
  if (!fs.existsSync(p)) return null;
  return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

// ---------- commands ----------
export async function login(opts) {
  const current = loadUserConfig();
  const url = (opts.url || current.url || (await ask('LaunchDock server URL: '))).replace(/\/$/, '');
  if (opts.token) {
    const cl = new Client({ url, token: opts.token });
    const { user } = await cl.get('/api/me');
    saveUserConfig({ url, token: opts.token, email: user.email });
    return console.log(c.green(`✔ Logged in as ${user.email}`));
  }
  const email = opts.email || (await ask('Email: '));
  const password = await ask('Password: ', { hidden: true });
  const anon = new Client({ url });
  const { token: jwt, user } = await anon.post('/api/auth/login', { email, password });
  const cl = new Client({ url, token: jwt });
  const { token } = await cl.post('/api/tokens', { name: `CLI on ${os.hostname()}` });
  saveUserConfig({ url, token, email: user.email });
  console.log(c.green(`✔ Logged in to ${url} as ${user.email}`));
}

export async function logout() {
  clearUserConfig();
  console.log('Logged out.');
}

export async function whoami() {
  const cfg = loadUserConfig();
  const { user } = await client().get('/api/me');
  console.log(`${user.email}${user.isAdmin ? c.dim(' (admin)') : ''} @ ${cfg.url}`);
}

export async function init(opts) {
  const root = process.cwd();
  const file = path.join(root, 'launchdock.json');
  if (fs.existsSync(file) && !opts.force) throw new Error('launchdock.json already exists (use --force to overwrite)');
  const cl = client();
  const app = readAppJson(root)?.json?.expo || {};
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}

  let projectId = opts.projectId;
  if (!projectId) {
    const name = opts.name || app.name || pkg.name || path.basename(root);
    const iosBundleId = opts.iosBundleId || app.ios?.bundleIdentifier || (await ask('iOS bundle identifier (blank to skip): '));
    const androidPackage = opts.androidPackage || app.android?.package || (await ask('Android package name (blank to skip): '));
    const { project } = await cl.post('/api/projects', { name, iosBundleId: iosBundleId || undefined, androidPackage: androidPackage || undefined, appleTeamId: opts.appleTeamId });
    projectId = project.id;
    console.log(c.green(`✔ Created project "${project.name}" (${project.id})`));
  } else {
    const { project } = await cl.get(`/api/projects/${projectId}`);
    console.log(c.green(`✔ Linked to project "${project.name}"`));
  }

  const config = {
    projectId,
    build: {
      development: { android: { buildType: 'apk' }, ios: { distribution: 'development' }, channel: 'development' },
      preview: { android: { buildType: 'apk' }, ios: { distribution: 'ad-hoc' }, channel: 'preview' },
      production: { android: { buildType: 'app-bundle' }, ios: { distribution: 'store' }, channel: 'production' },
    },
    submit: {
      production: {
        android: { track: 'internal', releaseStatus: 'draft' },
        ios: { groups: [] },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${c.bold('launchdock.json')}. Next:`);
  console.log(`  launchdock credentials:set asc_api_key --key-id XXXX --issuer-id YYYY --file AuthKey_XXXX.p8`);
  console.log(`  launchdock credentials:set google_service_account --file play-service-account.json`);
  console.log(`  launchdock build --platform all --profile production`);
}

export async function build(opts) {
  const { root, cfg } = loadProjectConfig();
  const cl = client();
  const profileName = opts.profile || 'production';
  const profile = resolveProfile(cfg, profileName);
  const platform = opts.platform || 'all';
  const body = {
    platform,
    profile: profileName,
    config: profile,
    message: opts.message,
    gitCommit: gitCommit(root),
    autoSubmit: !!opts.autoSubmit,
  };
  if (opts.autoSubmit) {
    const submitProfile = cfg.submit?.[opts.submitProfile || profileName] ? resolveProfile(cfg, opts.submitProfile || profileName, 'submit') : {};
    body.submitConfig = { ios: submitProfile.ios || {}, android: submitProfile.android || {} };
  }

  if (opts.git) {
    body.gitRef = typeof opts.git === 'string' ? opts.git : 'main';
    console.log(`Building from the project's Git repository at ${c.bold(body.gitRef)}`);
  } else {
    const tmp = path.join(os.tmpdir(), `launchdock-${crypto.randomUUID()}.tar.gz`);
    process.stdout.write('Packing project… ');
    const { files, size } = await packDirectory(root, tmp);
    console.log(`${files} files, ${fmtSize(size)}`);
    process.stdout.write('Uploading… ');
    try {
      const { sourceKey } = await cl.uploadFile(`/api/projects/${cfg.projectId}/sources`, tmp, 'application/gzip');
      body.sourceKey = sourceKey;
      console.log(c.green('done'));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  const { builds } = await cl.post(`/api/projects/${cfg.projectId}/builds`, body);
  const server = loadUserConfig().url;
  for (const b of builds) console.log(`${c.green('✔')} Queued ${b.platform} build ${c.bold(b.id)}  ${c.dim(`${server}/#/builds/${b.id}`)}`);
  if (opts.wait === false || opts.noWait) return;
  await waitForJobs(cl, builds.map((b) => ({ kind: 'builds', id: b.id, label: b.platform })), { follow: builds.length === 1 && !opts.quiet });
}

async function waitForJobs(cl, jobs, { follow }) {
  const after = Object.fromEntries(jobs.map((j) => [j.id, 0]));
  const done = new Map();
  if (!follow) console.log(c.dim('Waiting for builds (Ctrl+C to stop waiting; builds keep running)…'));
  while (done.size < jobs.length) {
    for (const j of jobs) {
      if (done.has(j.id)) continue;
      const { logs, status } = await cl.get(`/api/${j.kind}/${j.id}/logs?after=${after[j.id]}`);
      for (const l of logs) {
        after[j.id] = l.id;
        if (follow) console.log(l.line);
      }
      if (!['queued', 'in_progress'].includes(status)) {
        done.set(j.id, status);
        console.log(`${j.label} ${j.id.slice(0, 8)}: ${STATUS[status] || status}`);
      }
    }
    if (done.size < jobs.length) await sleep(2000);
  }
  for (const j of jobs.filter((x) => x.kind === 'builds' && done.get(x.id) === 'finished')) {
    const { downloadUrl, installUrl } = await cl.post(`/api/builds/${j.id}/share`, {});
    console.log(`\n${c.bold(j.label)} artifact: ${downloadUrl}\n${c.dim('install page:')} ${installUrl}`);
  }
  if ([...done.values()].some((s) => s !== 'finished')) process.exitCode = 1;
}

export async function submit(opts) {
  const { cfg } = loadProjectConfig();
  const cl = client();
  const profileName = opts.profile || 'production';
  const prof = cfg.submit?.[profileName] ? resolveProfile(cfg, profileName, 'submit') : {};
  const platforms = !opts.platform || opts.platform === 'all' ? ['ios', 'android'] : [opts.platform];
  const jobs = [];
  for (const platform of platforms) {
    const conf = { ...(prof[platform] || {}) };
    if (opts.track) conf.track = opts.track;
    if (opts.releaseStatus) conf.releaseStatus = opts.releaseStatus;
    if (opts.groups) conf.groups = String(opts.groups).split(',').map((s) => s.trim());
    if (opts.whatToTest) conf.whatToTest = opts.whatToTest;
    const { submission } = await cl.post(`/api/projects/${cfg.projectId}/submissions`, { buildId: opts.id, platform, config: conf });
    console.log(`${c.green('✔')} Queued ${platform} submission ${c.bold(submission.id)} for build ${submission.buildId.slice(0, 8)}`);
    jobs.push({ kind: 'submissions', id: submission.id, label: platform });
    if (opts.id) break;
  }
  if (!opts.noWait) await waitForJobs(cl, jobs, { follow: jobs.length === 1 });
}

export async function buildsList(opts) {
  const { cfg } = loadProjectConfig();
  const q = new URLSearchParams();
  if (opts.platform) q.set('platform', opts.platform);
  if (opts.status) q.set('status', opts.status);
  q.set('limit', opts.limit || 20);
  const { builds } = await client().get(`/api/projects/${cfg.projectId}/builds?${q}`);
  if (!builds.length) return console.log('No builds yet.');
  for (const b of builds) {
    console.log(
      `${b.id.slice(0, 8)}  ${b.platform.padEnd(7)} ${(STATUS[b.status] || b.status).padEnd(20)} ${b.profile.padEnd(12)} ` +
        `${(b.appVersion || '-') + ' (' + (b.buildNumber || '-') + ')'}  ${c.dim(new Date(b.createdAt).toLocaleString())}`,
    );
  }
}

export async function buildsView(opts) {
  const id = opts._[0];
  if (!id) throw new Error('Usage: launchdock builds:view <buildId>');
  const { build: b, submissions } = await client().get(`/api/builds/${id}`);
  console.log(JSON.stringify({ ...b, submissions }, null, 2));
}

export async function buildsLogs(opts) {
  const id = opts._[0];
  if (!id) throw new Error('Usage: launchdock builds:logs <buildId>');
  await waitForJobs(client(), [{ kind: opts.submission ? 'submissions' : 'builds', id, label: 'job' }], { follow: true });
}

export async function buildsCancel(opts) {
  const id = opts._[0];
  if (!id) throw new Error('Usage: launchdock builds:cancel <buildId>');
  await client().post(`/api/builds/${id}/cancel`);
  console.log('Canceled.');
}

// ---------- credentials ----------
export async function credentialsList() {
  const { cfg } = loadProjectConfig();
  const { credentials, types } = await client().get(`/api/projects/${cfg.projectId}/credentials`);
  for (const t of types) {
    const have = credentials.find((x) => x.type === t.type);
    console.log(`${have ? c.green('✔') : c.dim('·')} ${t.type.padEnd(30)} ${t.label}${have ? c.dim('  ' + JSON.stringify(have.meta)) : ''}`);
  }
}

export async function credentialsSet(opts) {
  const { cfg } = loadProjectConfig();
  const type = opts._[0];
  const need = (k, label) => {
    if (!opts[k]) throw new Error(`--${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())} is required (${label})`);
    return opts[k];
  };
  const readFile = () => fs.readFileSync(need('file', 'path to the file'));
  let data;
  switch (type) {
    case 'android_keystore':
      data = {
        keystoreBase64: readFile().toString('base64'),
        keystorePassword: opts.password || (await ask('Keystore password: ', { hidden: true })),
        keyAlias: need('alias', 'key alias'),
        keyPassword: opts.keyPassword || opts.password || (await ask('Key password: ', { hidden: true })),
      };
      break;
    case 'google_service_account':
      data = { json: readFile().toString('utf8') };
      break;
    case 'asc_api_key':
      data = { keyId: need('keyId', 'App Store Connect key ID'), issuerId: need('issuerId', 'issuer ID'), p8: readFile().toString('utf8') };
      break;
    case 'ios_distribution_certificate':
      data = { p12Base64: readFile().toString('base64'), password: opts.password ?? (await ask('.p12 password (blank if none): ', { hidden: true })) };
      break;
    case 'ios_provisioning_profile':
      data = { profileBase64: readFile().toString('base64') };
      break;
    default:
      throw new Error('Type must be one of: android_keystore, google_service_account, asc_api_key, ios_distribution_certificate, ios_provisioning_profile');
  }
  const { credential } = await client().put(`/api/projects/${cfg.projectId}/credentials/${type}`, { data });
  console.log(c.green(`✔ Saved ${type}`), c.dim(JSON.stringify(credential.meta)));
}

export async function credentialsBackup(opts) {
  const { cfg } = loadProjectConfig();
  const k = await client().get(`/api/projects/${cfg.projectId}/credentials/android_keystore/backup`);
  const out = opts.out || 'upload-keystore.jks';
  fs.writeFileSync(out, Buffer.from(k.keystoreBase64, 'base64'));
  console.log(c.green(`✔ Wrote ${out}`));
  console.log(`  keystore password: ${k.keystorePassword}\n  key alias:         ${k.keyAlias}\n  key password:      ${k.keyPassword}`);
  console.log(c.yellow('Keep this file and these passwords safe — Google Play requires the same upload key for every update.'));
}

export async function credentialsDelete(opts) {
  const { cfg } = loadProjectConfig();
  await client().del(`/api/projects/${cfg.projectId}/credentials/${opts._[0]}`);
  console.log('Deleted.');
}

// ---------- secrets & versions ----------
export async function secretsSet(opts) {
  const { cfg } = loadProjectConfig();
  const [name, value] = opts._;
  if (!name) throw new Error('Usage: launchdock secrets:set NAME [value]');
  await client().put(`/api/projects/${cfg.projectId}/secrets/${name}`, { value: value ?? (await ask(`${name}: `, { hidden: true })) });
  console.log(c.green(`✔ ${name} saved`));
}
export async function secretsList() {
  const { cfg } = loadProjectConfig();
  const { secrets } = await client().get(`/api/projects/${cfg.projectId}/secrets`);
  secrets.forEach((s) => console.log(s.name));
  if (!secrets.length) console.log('No secrets.');
}
export async function secretsDelete(opts) {
  const { cfg } = loadProjectConfig();
  await client().del(`/api/projects/${cfg.projectId}/secrets/${opts._[0]}`);
  console.log('Deleted.');
}
export async function versionSet(opts) {
  const { cfg } = loadProjectConfig();
  if (!opts.platform || opts.buildNumber === undefined) throw new Error('Usage: launchdock version:set --platform ios|android --build-number N');
  await client().put(`/api/projects/${cfg.projectId}/versions/${opts.platform}`, { buildNumber: Number(opts.buildNumber) });
  console.log(c.green(`✔ Next ${opts.platform} build will be ${Number(opts.buildNumber) + 1}`));
}

// ---------- OTA updates ----------
export async function updateConfigure() {
  const { root, cfg } = loadProjectConfig();
  const app = readAppJson(root);
  const url = `${loadUserConfig().url}/api/updates/${cfg.projectId}/manifest`;
  if (!app) {
    console.log('No app.json (dynamic app.config.js?). Add this to your Expo config:');
    console.log(JSON.stringify({ updates: { url, enabled: true, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }, runtimeVersion: { policy: 'appVersion' } }, null, 2));
    return;
  }
  const expo = app.json.expo || (app.json.expo = {});
  expo.updates = { ...(expo.updates || {}), url, enabled: true };
  expo.updates.checkAutomatically ??= 'ON_LOAD';
  expo.updates.fallbackToCacheTimeout ??= 0;
  expo.runtimeVersion ??= { policy: 'appVersion' };
  fs.writeFileSync(app.path, JSON.stringify(app.json, null, 2) + '\n');
  console.log(c.green('✔ app.json now points expo-updates at LaunchDock'));
  console.log(c.dim('Make sure expo-updates is installed: npx expo install expo-updates — then make a new native build.'));
}

function runtimeVersionFor(root, platform, expoConfig) {
  const r = spawnSync(npx, ['expo-updates', 'runtimeversion:resolve', '--platform', platform], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status === 0) {
    try {
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
      if (parsed.runtimeVersion) return parsed.runtimeVersion;
    } catch {}
  }
  const rv = expoConfig[platform]?.runtimeVersion ?? expoConfig.runtimeVersion;
  if (typeof rv === 'string') return rv;
  const policy = rv?.policy || 'sdkVersion';
  if (policy === 'appVersion') return expoConfig.version;
  if (policy === 'nativeVersion') return `${expoConfig.version}(${platform === 'ios' ? expoConfig.ios?.buildNumber || '1' : expoConfig.android?.versionCode || 1})`;
  if (policy === 'sdkVersion') return `exposdk:${expoConfig.sdkVersion}`;
  throw new Error(`Could not resolve runtime version (policy ${policy}). Pass --runtime-version explicitly.`);
}

const hashFile = (buf) => crypto.createHash('sha256').update(buf).digest('base64url');

export async function update(opts) {
  const { root, cfg } = loadProjectConfig();
  const cl = client();
  const channel = opts.channel || opts.branch || 'production';
  const platforms = !opts.platform || opts.platform === 'all' ? ['ios', 'android'] : [opts.platform];
  const outDir = path.join(root, opts.inputDir || 'dist');

  if (!opts.skipExport) {
    console.log(c.bold('Exporting JavaScript bundle…'));
    fs.rmSync(outDir, { recursive: true, force: true });
    const args = ['expo', 'export', '--output-dir', path.relative(root, outDir), ...platforms.flatMap((p) => ['--platform', p])];
    const r = spawnSync(npx, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, EXPO_NO_TELEMETRY: '1' } });
    if (r.status !== 0) throw new Error('expo export failed');
  }
  const metaPath = path.join(outDir, 'metadata.json');
  if (!fs.existsSync(metaPath)) throw new Error(`${metaPath} not found — is this an Expo project?`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const cfgOut = spawnSync(npx, ['expo', 'config', '--json', '--type', 'public'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (cfgOut.status !== 0) throw new Error('Could not read Expo config (npx expo config)');
  const expoConfig = JSON.parse(cfgOut.stdout);

  const files = new Map(); // hash -> {abs, ext}
  const payload = {};
  const runtimeVersion = {};
  for (const platform of platforms) {
    const fm = meta.fileMetadata?.[platform];
    if (!fm) {
      console.log(c.yellow(`No ${platform} bundle in export — skipping ${platform}`));
      continue;
    }
    runtimeVersion[platform] = opts.runtimeVersion || runtimeVersionFor(root, platform, expoConfig);
    const add = (rel, ext) => {
      const abs = path.join(outDir, rel);
      const hash = hashFile(fs.readFileSync(abs));
      files.set(hash, { abs, ext });
      return { hash, ext };
    };
    const launch = add(fm.bundle, 'bundle');
    payload[platform] = { launchAsset: launch, assets: fm.assets.map((a) => add(a.path, a.ext)) };
  }
  if (!Object.keys(payload).length) throw new Error('Nothing to publish');

  const { missing } = await cl.post(`/api/projects/${cfg.projectId}/updates/assets/check`, { hashes: [...files.keys()] });
  console.log(`Uploading ${missing.length} new asset(s) (${files.size - missing.length} already on server)…`);
  let i = 0;
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const hash = queue.shift();
        const f = files.get(hash);
        await cl.request('PUT', `/api/projects/${cfg.projectId}/updates/assets/${hash}`, {
          body: fs.readFileSync(f.abs),
          headers: { 'content-type': 'application/octet-stream', 'x-asset-ext': f.ext },
        });
        i++;
        if (i % 10 === 0) process.stdout.write(`  ${i}/${missing.length}\r`);
      }
    }),
  );
  const res = await cl.post(`/api/projects/${cfg.projectId}/updates`, {
    channel,
    message: opts.message || gitCommitMessage(root),
    runtimeVersion,
    platforms: payload,
    expoClient: expoConfig,
    gitCommit: gitCommit(root),
  });
  console.log(c.green(`✔ Published update group ${res.groupId} to channel "${channel}"`));
  for (const u of res.updates) console.log(`  ${u.platform.padEnd(8)} runtime ${u.runtimeVersion}  id ${u.id}`);
}

function gitCommitMessage(root) {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

export async function updateList(opts) {
  const { cfg } = loadProjectConfig();
  const q = opts.channel ? `?channel=${encodeURIComponent(opts.channel)}` : '';
  const { updates } = await client().get(`/api/projects/${cfg.projectId}/updates${q}`);
  for (const u of updates) {
    console.log(`${u.groupId.slice(0, 8)}  ${u.channel.padEnd(12)} ${u.platform.padEnd(8)} rt ${u.runtimeVersion.padEnd(10)} ${u.kind === 'rollback' ? c.yellow('rollback') : ''} ${u.message || ''} ${c.dim(new Date(u.createdAt).toLocaleString())}`);
  }
  if (!updates.length) console.log('No updates published.');
}

export async function updateRollback(opts) {
  const { cfg } = loadProjectConfig();
  const body = { channel: opts.channel || 'production' };
  if (opts.to) body.toGroupId = opts.to;
  else if (opts.runtimeVersion) body.runtimeVersion = opts.runtimeVersion;
  else throw new Error('Use --to <groupId> to republish an older update, or --runtime-version X to roll back to the embedded bundle');
  if (opts.platform && opts.platform !== 'all') body.platforms = [opts.platform];
  const res = await client().post(`/api/projects/${cfg.projectId}/updates/rollback`, body);
  console.log(c.green(`✔ Rolled back channel "${body.channel}" (group ${res.groupId})`));
}

export async function updateSigningKey(opts) {
  const { cfg } = loadProjectConfig();
  if (opts.remove) {
    await client().put(`/api/projects/${cfg.projectId}/updates-signing-key`, { privateKeyPem: null });
    return console.log('Removed update signing key.');
  }
  if (!opts.file) throw new Error('Usage: launchdock update:signing-key --file keys/private-key.pem');
  await client().put(`/api/projects/${cfg.projectId}/updates-signing-key`, { privateKeyPem: fs.readFileSync(opts.file, 'utf8') });
  console.log(c.green('✔ Update manifests will now be signed (RSA-SHA256, keyid "main")'));
}

export async function projectInfo() {
  const { cfg } = loadProjectConfig();
  const data = await client().get(`/api/projects/${cfg.projectId}`);
  console.log(JSON.stringify(data, null, 2));
}

export async function projectsList() {
  const { projects } = await client().get('/api/projects');
  for (const p of projects) console.log(`${p.id}  ${p.name}  ${c.dim([p.iosBundleId, p.androidPackage].filter(Boolean).join(' · '))}`);
}
