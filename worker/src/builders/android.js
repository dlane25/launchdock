import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, findFiles, exists } from '../util.js';
import { installJsDependencies, expoPrebuild, applyUpdatesChannel, readRuntimeVersion } from './common.js';

async function ensureKeystore(ctx) {
  const { credentials, project, api, job, logger, signal, workDir } = ctx;
  let ks = credentials.android_keystore;
  if (!ks) {
    logger.section('Generating Android upload keystore');
    const password = crypto.randomBytes(18).toString('base64url');
    const file = path.join(workDir, 'generated.jks');
    await run(
      'keytool',
      ['-genkeypair', '-v', '-storetype', 'JKS', '-keystore', file, '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '10000', '-storepass', password, '-keypass', password,
        '-dname', `CN=${project.name.replace(/[,=]/g, ' ')}, O=${project.slug}, C=US`],
      { logger, signal, quiet: true },
    );
    ks = { keystoreBase64: fs.readFileSync(file).toString('base64'), keystorePassword: password, keyAlias: 'upload', keyPassword: password };
    await api.storeCredential('build', job.id, 'android_keystore', ks);
    logger.log('Generated a new upload keystore and saved it to the project vault. Download a backup from the dashboard.');
  }
  logger.mask(ks.keystorePassword, ks.keyPassword);
  const file = path.join(workDir, 'upload.jks');
  fs.writeFileSync(file, Buffer.from(ks.keystoreBase64, 'base64'), { mode: 0o600 });
  return { ...ks, file };
}

function injectSigning(androidDir, ks) {
  // AGP honours these "injected" properties (the same ones Android Studio uses for signed builds).
  const props = [
    '',
    '# --- LaunchDock signing (injected at build time) ---',
    `android.injected.signing.store.file=${ks.file.replace(/\\/g, '/')}`,
    `android.injected.signing.store.password=${ks.keystorePassword}`,
    `android.injected.signing.key.alias=${ks.keyAlias}`,
    `android.injected.signing.key.password=${ks.keyPassword}`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(androidDir, 'gradle.properties'), props);
}

function patchVersionCode(appDir, buildNumber, logger) {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const f = path.join(appDir, name);
    if (!exists(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/versionCode\s*=?\s*\d+/.test(src)) {
      fs.writeFileSync(f, src.replace(/versionCode(\s*=?\s*)\d+/, `versionCode$1${buildNumber}`));
      logger.log(`Set versionCode = ${buildNumber}`);
      return true;
    }
  }
  logger.log('versionCode is not a literal in app/build.gradle — leaving it as is');
  return false;
}

function readVersionName(appDir) {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const f = path.join(appDir, name);
    if (exists(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/versionName\s*=?\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  }
  return null;
}

export async function buildAndroid(ctx, srcDir, projectType) {
  const { job, logger, signal, env } = ctx;
  const cfg = job.config?.android || {};
  const dir = cfg.projectDir ? path.join(srcDir, cfg.projectDir) : srcDir;
  const buildType = cfg.buildType || 'app-bundle'; // app-bundle | apk
  const ext = buildType === 'apk' ? 'apk' : 'aab';

  const ks = await ensureKeystore(ctx);

  if (projectType === 'flutter') {
    logger.section('Flutter build');
    await run('flutter', ['pub', 'get'], { cwd: dir, env, logger, signal });
    injectSigning(path.join(dir, 'android'), ks);
    const args = ['build', buildType === 'apk' ? 'apk' : 'appbundle', '--release'];
    if (job.buildNumber) args.push('--build-number', job.buildNumber);
    if (cfg.flavor) args.push('--flavor', cfg.flavor);
    await run('flutter', args, { cwd: dir, env, logger, signal });
    const out = findFiles(path.join(dir, 'build', 'app', 'outputs'), (p) => p.endsWith(`.${ext}`) && /release/i.test(p));
    if (!out.length) throw new Error(`No .${ext} produced by flutter build`);
    const pubspec = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
    return { artifact: out[0], ext, appVersion: pubspec.match(/^version:\s*([^+\s]+)/m)?.[1] || null };
  }

  if (projectType === 'expo' || projectType === 'react-native') await installJsDependencies(ctx, dir);
  if (projectType === 'expo') {
    await expoPrebuild(ctx, dir, 'android');
    applyUpdatesChannel(ctx, dir, 'android');
  }

  const androidDir = exists(path.join(dir, 'android')) ? path.join(dir, 'android') : dir;
  const appDir = path.join(androidDir, cfg.appModule || 'app');
  if (!exists(path.join(androidDir, 'gradlew'))) throw new Error(`No gradlew found in ${path.relative(srcDir, androidDir) || '.'}`);
  fs.chmodSync(path.join(androidDir, 'gradlew'), 0o755);

  if (job.buildNumber) patchVersionCode(appDir, job.buildNumber, logger);
  injectSigning(androidDir, ks);

  logger.section('Gradle build');
  const variant = cfg.variant || 'Release';
  const task = cfg.gradleCommand || `:${cfg.appModule || 'app'}:${buildType === 'apk' ? 'assemble' : 'bundle'}${variant}`;
  const gradleArgs = [...task.split(/\s+/), '--no-daemon', '--stacktrace'];
  if (job.buildNumber) gradleArgs.push(`-PversionCode=${job.buildNumber}`);
  await run('./gradlew', gradleArgs, {
    cwd: androidDir,
    env: { ...env, GRADLE_OPTS: env.GRADLE_OPTS || '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g' },
    logger,
    signal,
  });

  const outputs = findFiles(path.join(appDir, 'build', 'outputs'), (p) => p.endsWith(`.${ext}`));
  const artifact = outputs.find((p) => new RegExp(variant, 'i').test(p)) || outputs[0];
  if (!artifact) throw new Error(`Gradle finished but no .${ext} was found under ${appDir}/build/outputs`);
  return {
    artifact,
    ext,
    appVersion: readVersionName(appDir),
    runtimeVersion: projectType === 'expo' ? readRuntimeVersion(dir, 'android') : null,
  };
}
