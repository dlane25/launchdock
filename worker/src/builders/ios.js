import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, capture, findFiles, exists } from '../util.js';
import { installJsDependencies, expoPrebuild, applyUpdatesChannel, readRuntimeVersion } from './common.js';

const EXPORT_METHOD = {
  // [Xcode >= 15.4 name, legacy name]
  store: ['app-store-connect', 'app-store'],
  'ad-hoc': ['release-testing', 'ad-hoc'],
  development: ['debugging', 'development'],
  enterprise: ['enterprise', 'enterprise'],
};

export function parseProfile(buf) {
  const text = buf.toString('latin1');
  const xml = text.slice(text.indexOf('<?xml'), text.indexOf('</plist>') + 8);
  const str = (k) => xml.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`))?.[1];
  const appId = xml.match(/<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  return {
    name: str('Name'),
    uuid: str('UUID'),
    teamId: xml.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1],
    bundleId: appId?.replace(/^[A-Z0-9]+\./, ''),
  };
}

const plistEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function exportOptionsPlist({ method, teamId, signingStyle, bundleId, profileName }) {
  const profiles =
    signingStyle === 'manual'
      ? `<key>provisioningProfiles</key><dict><key>${plistEscape(bundleId)}</key><string>${plistEscape(profileName)}</string></dict>`
      : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>${method}</string>
<key>teamID</key><string>${plistEscape(teamId)}</string>
<key>signingStyle</key><string>${signingStyle}</string>
<key>destination</key><string>export</string>
<key>uploadSymbols</key><true/>
<key>stripSwiftSymbols</key><true/>
${profiles}
</dict></plist>`;
}

// Force manual signing on the target(s) whose bundle id matches, leaving Pods untouched.
export function patchPbxprojForManualSigning(pbxPath, { bundleId, teamId, profileName, identity }) {
  let src = fs.readFileSync(pbxPath, 'utf8');
  let patched = 0;
  const keys = ['CODE_SIGN_STYLE', 'DEVELOPMENT_TEAM', 'PROVISIONING_PROFILE_SPECIFIER', 'PROVISIONING_PROFILE', 'CODE_SIGN_IDENTITY', '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'];
  src = src.replace(/buildSettings = \{([\s\S]*?)\n(\t+)\};/g, (block, body, indent) => {
    const m = body.match(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/);
    if (!m || m[1] !== bundleId) return block;
    patched++;
    let lines = body.split('\n').filter((l) => !keys.some((k) => l.trim().startsWith(`${k} =`)));
    const pad = `${indent}\t`;
    lines.splice(1, 0,
      `${pad}CODE_SIGN_STYLE = Manual;`,
      `${pad}DEVELOPMENT_TEAM = ${teamId};`,
      `${pad}PROVISIONING_PROFILE_SPECIFIER = "${profileName}";`,
      `${pad}CODE_SIGN_IDENTITY = "${identity}";`,
      `${pad}"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "${identity}";`,
    );
    return `buildSettings = {${lines.join('\n')}\n${indent}};`;
  });
  src = src.replace(/ProvisioningStyle = Automatic;/g, 'ProvisioningStyle = Manual;');
  fs.writeFileSync(pbxPath, src);
  return patched;
}

function setBundleVersionInPlists(iosDir, buildNumber, logger) {
  const plists = findFiles(iosDir, (p) => p.endsWith('Info.plist') && !/\/(Pods|build|DerivedData)\//.test(p), 4);
  for (const p of plists) {
    const src = fs.readFileSync(p, 'utf8');
    const re = /(<key>CFBundleVersion<\/key>\s*<string>)([^<]*)(<\/string>)/;
    const m = src.match(re);
    if (m && !m[2].includes('$(')) {
      fs.writeFileSync(p, src.replace(re, `$1${buildNumber}$3`));
      logger.log(`Set CFBundleVersion = ${buildNumber} in ${path.relative(iosDir, p)}`);
    }
  }
}

class Keychain {
  constructor(ctx) {
    this.ctx = ctx;
    this.path = path.join(ctx.workDir, 'launchdock.keychain-db');
    this.password = crypto.randomBytes(16).toString('hex');
    this.original = [];
  }
  async setup(p12Path, p12Password) {
    const { logger, signal } = this.ctx;
    const opt = { logger, signal, quiet: true };
    logger.log('Creating temporary keychain and importing distribution certificate');
    this.original = (await capture('security', ['list-keychains', '-d', 'user']))
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    await run('security', ['create-keychain', '-p', this.password, this.path], opt);
    await run('security', ['set-keychain-settings', '-lut', '21600', this.path], opt);
    await run('security', ['unlock-keychain', '-p', this.password, this.path], opt);
    await run('security', ['import', p12Path, '-k', this.path, '-P', p12Password || '', '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'], opt);
    await run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', this.password, this.path], opt);
    await run('security', ['list-keychains', '-d', 'user', '-s', this.path, ...this.original], opt);
    const ids = await capture('security', ['find-identity', '-v', '-p', 'codesigning', this.path]);
    const m = ids.match(/\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/);
    if (!m) throw new Error('The .p12 does not contain a valid code signing identity (wrong password or expired certificate?)');
    logger.log(`Signing identity: ${m[2]}`);
    return { sha1: m[1], name: m[2] };
  }
  async cleanup() {
    try {
      if (this.original.length) await run('security', ['list-keychains', '-d', 'user', '-s', ...this.original], { quiet: true });
      await run('security', ['delete-keychain', this.path], { quiet: true, allowFailure: true });
    } catch {}
  }
}

function installProfile(buf, uuid) {
  const dirs = [
    path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
    path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${uuid}.mobileprovision`), buf);
  }
}

async function podInstall(ctx, iosDir) {
  if (!exists(path.join(iosDir, 'Podfile'))) return;
  const { logger, signal, env } = ctx;
  logger.section('CocoaPods');
  const root = path.dirname(iosDir);
  const gemfile = [root, iosDir].find((d) => exists(path.join(d, 'Gemfile')) && exists(path.join(d, 'Gemfile.lock')));
  if (gemfile) {
    await run('bundle', ['install'], { cwd: gemfile, env, logger, signal });
    await run('bundle', ['exec', 'pod', 'install'], { cwd: iosDir, env, logger, signal });
  } else {
    await run('pod', ['install'], { cwd: iosDir, env, logger, signal });
  }
}

export function writeAscKey(workDir, key) {
  const dir = path.join(workDir, 'private_keys');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `AuthKey_${key.keyId}.p8`);
  fs.writeFileSync(file, key.p8, { mode: 0o600 });
  return { dir, file };
}

export async function buildIos(ctx, srcDir, projectType) {
  if (process.platform !== 'darwin') throw new Error('iOS builds require a macOS worker with Xcode');
  const { job, project, credentials, logger, signal, env, workDir } = ctx;
  const cfg = job.config?.ios || {};
  const dir = cfg.projectDir ? path.join(srcDir, cfg.projectDir) : srcDir;
  const distribution = cfg.distribution || 'store';
  if (!EXPORT_METHOD[distribution]) throw new Error(`Unknown ios.distribution "${distribution}"`);

  const cert = credentials.ios_distribution_certificate;
  const profileCred = credentials.ios_provisioning_profile;
  const ascKey = credentials.asc_api_key;
  const signingStyle = cfg.signing || (cert && profileCred ? 'manual' : 'automatic');
  if (signingStyle === 'manual' && (!cert || !profileCred)) throw new Error('Manual signing needs a distribution certificate (.p12) and a provisioning profile in the vault');
  if (signingStyle === 'automatic' && !ascKey) throw new Error('Automatic signing needs an App Store Connect API key in the vault (or upload a .p12 + provisioning profile)');
  if (cert?.password) logger.mask(cert.password);

  const xcodeVersion = await capture('xcodebuild', ['-version']);
  logger.log(xcodeVersion.split('\n')[0]);
  const [maj, min] = (xcodeVersion.match(/Xcode (\d+)\.(\d+)/) || []).slice(1).map(Number);
  const modernNames = maj > 15 || (maj === 15 && min >= 4);

  // ---- Prepare native project ----
  if (projectType === 'flutter') {
    logger.section('Flutter prepare');
    await run('flutter', ['pub', 'get'], { cwd: dir, env, logger, signal });
    const args = ['build', 'ios', '--config-only', '--release'];
    if (job.buildNumber) args.push('--build-number', job.buildNumber);
    await run('flutter', args, { cwd: dir, env, logger, signal });
  } else {
    if (projectType === 'expo' || projectType === 'react-native') await installJsDependencies(ctx, dir);
    if (projectType === 'expo') {
      await expoPrebuild(ctx, dir, 'ios');
      applyUpdatesChannel(ctx, dir, 'ios');
    }
    const iosDirTmp = exists(path.join(dir, 'ios')) ? path.join(dir, 'ios') : dir;
    if (!exists(path.join(iosDirTmp, 'Pods')) || projectType === 'expo') await podInstall(ctx, iosDirTmp);
  }
  const iosDir = exists(path.join(dir, 'ios')) ? path.join(dir, 'ios') : dir;

  const workspace = fs.readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  const xcodeproj = fs.readdirSync(iosDir).find((f) => f.endsWith('.xcodeproj'));
  if (!workspace && !xcodeproj) throw new Error('No .xcworkspace or .xcodeproj found');
  const container = workspace ? ['-workspace', workspace] : ['-project', xcodeproj];

  let scheme = cfg.scheme;
  if (!scheme) {
    const list = JSON.parse(await capture('xcodebuild', ['-list', '-json', ...container], { cwd: iosDir }));
    const schemes = (list.workspace || list.project)?.schemes || [];
    const base = (workspace || xcodeproj).replace(/\.(xcworkspace|xcodeproj)$/, '');
    scheme = schemes.find((s) => s === base) || schemes.find((s) => !/^Pods|-tvOS$/.test(s));
    if (!scheme) throw new Error('Could not determine the Xcode scheme; set ios.scheme in launchdock.json');
  }
  logger.log(`Scheme: ${scheme} · Distribution: ${distribution} · Signing: ${signingStyle}`);

  if (job.buildNumber) setBundleVersionInPlists(iosDir, job.buildNumber, logger);

  const teamId = project.appleTeamId || (profileCred && parseProfile(Buffer.from(profileCred.profileBase64, 'base64')).teamId);
  if (!teamId) throw new Error('Set the Apple Team ID on the project (Project settings → Apple Team ID)');

  const keychain = new Keychain(ctx);
  const signingArgs = [];
  const authArgs = [];
  let profileMeta = null;
  try {
    if (ascKey) {
      const { file } = writeAscKey(workDir, ascKey);
      authArgs.push('-authenticationKeyPath', file, '-authenticationKeyID', ascKey.keyId, '-authenticationKeyIssuerID', ascKey.issuerId);
    }
    if (signingStyle === 'manual') {
      const p12 = path.join(workDir, 'dist.p12');
      fs.writeFileSync(p12, Buffer.from(cert.p12Base64, 'base64'), { mode: 0o600 });
      const identity = await keychain.setup(p12, cert.password);
      const profBuf = Buffer.from(profileCred.profileBase64, 'base64');
      profileMeta = parseProfile(profBuf);
      installProfile(profBuf, profileMeta.uuid);
      logger.log(`Provisioning profile: ${profileMeta.name} (${profileMeta.uuid})`);
      const bundleId = project.iosBundleId;
      if (profileMeta.bundleId !== bundleId && profileMeta.bundleId !== '*') {
        logger.log(`⚠ Profile is for ${profileMeta.bundleId} but the project bundle id is ${bundleId}`);
      }
      const pbx = path.join(iosDir, xcodeproj, 'project.pbxproj');
      const n = patchPbxprojForManualSigning(pbx, { bundleId, teamId, profileName: profileMeta.name, identity: identity.sha1 });
      if (!n) throw new Error(`No build configuration in ${xcodeproj} has PRODUCT_BUNDLE_IDENTIFIER = ${bundleId}`);
      logger.log(`Configured manual signing on ${n} build configuration(s)`);
      signingArgs.push(`OTHER_CODE_SIGN_FLAGS=--keychain ${keychain.path}`);
    } else {
      signingArgs.push('-allowProvisioningUpdates', ...authArgs, `DEVELOPMENT_TEAM=${teamId}`, 'CODE_SIGN_STYLE=Automatic');
    }

    // ---- Archive ----
    logger.section('xcodebuild archive');
    const buildDir = path.join(workDir, 'ios-build');
    const archivePath = path.join(buildDir, `${scheme}.xcarchive`);
    const archiveArgs = [
      ...container, '-scheme', scheme, '-configuration', cfg.buildConfiguration || 'Release',
      '-destination', 'generic/platform=iOS', '-archivePath', archivePath,
      ...signingArgs,
      ...(job.buildNumber ? [`CURRENT_PROJECT_VERSION=${job.buildNumber}`] : []),
      'archive',
    ];
    await run('xcodebuild', archiveArgs, { cwd: iosDir, env: { ...env, NSUnbufferedIO: 'YES' }, logger, signal });

    // ---- Export IPA ----
    logger.section('xcodebuild -exportArchive');
    const method = EXPORT_METHOD[distribution][modernNames ? 0 : 1];
    const exportPlist = path.join(buildDir, 'ExportOptions.plist');
    fs.writeFileSync(
      exportPlist,
      exportOptionsPlist({ method, teamId, signingStyle, bundleId: project.iosBundleId, profileName: profileMeta?.name }),
    );
    const exportPath = path.join(buildDir, 'export');
    const exportArgs = ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', exportPlist];
    if (signingStyle === 'automatic') exportArgs.push('-allowProvisioningUpdates', ...authArgs);
    await run('xcodebuild', exportArgs, { cwd: iosDir, env, logger, signal });

    const ipa = findFiles(exportPath, (p) => p.endsWith('.ipa'), 1)[0];
    if (!ipa) throw new Error('Export finished but no .ipa was produced');
    const plist = path.join(archivePath, 'Info.plist');
    const appVersion = await capture('plutil', ['-extract', 'ApplicationProperties.CFBundleShortVersionString', 'raw', plist]).catch(() => null);
    const buildNumber = await capture('plutil', ['-extract', 'ApplicationProperties.CFBundleVersion', 'raw', plist]).catch(() => job.buildNumber);
    return {
      artifact: ipa,
      ext: 'ipa',
      appVersion,
      buildNumber,
      runtimeVersion: projectType === 'expo' ? readRuntimeVersion(dir, 'ios') : null,
    };
  } finally {
    await keychain.cleanup();
  }
}
