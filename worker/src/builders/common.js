import fs from 'node:fs';
import path from 'node:path';
import { run, capture, exists, readJson } from '../util.js';

// Fetch source into `srcDir` from an upload or a Git repo. Returns the git commit if known.
export async function fetchSource(ctx, srcDir) {
  const { api, job, logger, signal, workDir } = ctx;
  logger.section('Fetching source');
  fs.mkdirSync(srcDir, { recursive: true });
  if (job.sourceType === 'git') {
    logger.mask(job.gitUrl.match(/x-access-token:([^@]+)@/)?.[1]);
    await run('git', ['clone', '--depth', '50', '--no-single-branch', job.gitUrl, srcDir], { logger, signal });
    await run('git', ['checkout', job.gitRef || 'main'], { cwd: srcDir, logger, signal });
    await run('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], { cwd: srcDir, logger, signal, allowFailure: true });
  } else {
    const tarball = path.join(workDir, 'source.tar.gz');
    await api.download(`/api/worker/jobs/build/${job.id}/source`, tarball);
    logger.log(`Downloaded source (${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`);
    await run('tar', ['-xzf', tarball, '-C', srcDir], { logger, signal });
  }
  if (exists(path.join(srcDir, '.git'))) {
    return capture('git', ['rev-parse', 'HEAD'], { cwd: srcDir }).catch(() => null);
  }
  return null;
}

export function detectProjectType(dir) {
  if (exists(path.join(dir, 'pubspec.yaml'))) return 'flutter';
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    const pkg = readJson(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.expo) return 'expo';
    if (deps['react-native']) return 'react-native';
  }
  return 'native';
}

export async function installJsDependencies(ctx, dir) {
  const { logger, signal, env } = ctx;
  if (!exists(path.join(dir, 'package.json'))) return;
  logger.section('Installing JavaScript dependencies');
  const has = (f) => exists(path.join(dir, f));
  if (has('bun.lockb') || has('bun.lock')) return run('bun', ['install', '--frozen-lockfile'], { cwd: dir, env, logger, signal });
  if (has('pnpm-lock.yaml')) {
    await run('corepack', ['enable'], { cwd: dir, env, logger, signal, allowFailure: true });
    return run('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, env, logger, signal });
  }
  if (has('yarn.lock')) {
    await run('corepack', ['enable'], { cwd: dir, env, logger, signal, allowFailure: true });
    const berry = has('.yarnrc.yml');
    return run('yarn', berry ? ['install', '--immutable'] : ['install', '--frozen-lockfile'], { cwd: dir, env, logger, signal });
  }
  if (has('package-lock.json')) return run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env, logger, signal });
  return run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, env, logger, signal });
}

export async function expoPrebuild(ctx, dir, platform) {
  const { logger, signal, env, job } = ctx;
  const nativeDir = path.join(dir, platform);
  const pcfg = job.config?.[platform] || {};
  if (exists(nativeDir) && pcfg.prebuild !== true) {
    logger.log(`Found existing ${platform}/ directory — skipping prebuild (set "prebuild": true to force).`);
    return;
  }
  logger.section(`Expo prebuild (${platform})`);
  const args = ['expo', 'prebuild', '--platform', platform, '--no-install'];
  if (exists(nativeDir)) args.push('--clean');
  await run('npx', args, { cwd: dir, env, logger, signal });
}

export async function expoPublicConfig(ctx, dir) {
  try {
    const out = await capture('npx', ['expo', 'config', '--json', '--type', 'public'], { cwd: dir, env: ctx.env });
    return JSON.parse(out);
  } catch (err) {
    ctx.logger.log(`Could not read Expo config: ${err.message.split('\n')[0]}`);
    return null;
  }
}

// Point the native app at this build's update channel (like EAS does for build profiles).
export function applyUpdatesChannel(ctx, dir, platform) {
  const { job, logger } = ctx;
  if (!job.channel) return;
  const headers = JSON.stringify({ 'expo-channel-name': job.channel });
  if (platform === 'android') {
    const manifest = path.join(dir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    if (!exists(manifest)) return;
    let xml = fs.readFileSync(manifest, 'utf8');
    const key = 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY';
    const entity = headers.replace(/"/g, '&quot;');
    const tag = `<meta-data android:name="${key}" android:value="${entity}"/>`;
    const re = new RegExp(`<meta-data[^>]*android:name="${key.replace(/\./g, '\\.')}"[^>]*/>`);
    xml = re.test(xml) ? xml.replace(re, tag) : xml.replace(/<application([^>]*)>/, `<application$1>\n    ${tag}`);
    fs.writeFileSync(manifest, xml);
  } else {
    const plists = fs
      .readdirSync(path.join(dir, 'ios'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, 'ios', d.name, 'Supporting', 'Expo.plist'))
      .filter(exists);
    for (const plist of plists) {
      let xml = fs.readFileSync(plist, 'utf8');
      const dict = `<key>EXUpdatesRequestHeaders</key>\n\t<dict>\n\t\t<key>expo-channel-name</key>\n\t\t<string>${job.channel}</string>\n\t</dict>`;
      xml = /<key>EXUpdatesRequestHeaders<\/key>\s*<dict>[\s\S]*?<\/dict>/.test(xml)
        ? xml.replace(/<key>EXUpdatesRequestHeaders<\/key>\s*<dict>[\s\S]*?<\/dict>/, dict)
        : xml.replace(/<dict>/, `<dict>\n\t${dict}`);
      fs.writeFileSync(plist, xml);
    }
  }
  logger.log(`Set OTA update channel "${job.channel}" in the native ${platform} project`);
}

export function readRuntimeVersion(dir, platform) {
  try {
    if (platform === 'android') {
      const xml = fs.readFileSync(path.join(dir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
      return xml.match(/expo\.modules\.updates\.EXPO_RUNTIME_VERSION"\s+android:value="([^"]+)"/)?.[1] || null;
    }
    for (const d of fs.readdirSync(path.join(dir, 'ios'))) {
      const p = path.join(dir, 'ios', d, 'Supporting', 'Expo.plist');
      if (exists(p)) {
        const v = fs.readFileSync(p, 'utf8').match(/<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (v) return v;
      }
    }
  } catch {}
  return null;
}
