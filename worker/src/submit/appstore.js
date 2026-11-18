// App Store Connect: upload with altool (macOS), then optional TestFlight distribution via the ASC API.
import crypto from 'node:crypto';
import { run, sleep } from '../util.js';
import { writeAscKey } from '../builders/ios.js';

const ASC = 'https://api.appstoreconnect.apple.com';

export function ascToken({ keyId, issuerId, p8 }) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${enc({ iss: issuerId, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${unsigned}.${sig}`;
}

export async function asc(key, method, path, json) {
  let res;
  try {
    res = await fetch(ASC + path, {
      method,
      headers: { authorization: `Bearer ${ascToken(key)}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach api.appstoreconnect.apple.com: ${err.cause?.code || err.message}`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = data.errors?.[0];
    throw new Error(`App Store Connect ${method} ${path.split('?')[0]}: ${e ? `${e.title} — ${e.detail}` : `HTTP ${res.status}`}`);
  }
  return data;
}

export async function findAscAppId(key, bundleId) {
  const data = await asc(key, 'GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  return data.data?.[0]?.id || null;
}

export async function submitToAppStore(ctx, { file, project, build, config }) {
  if (process.platform !== 'darwin') throw new Error('App Store uploads run on a macOS worker (xcrun altool)');
  const { credentials, logger, signal, workDir } = ctx;
  const key = credentials.asc_api_key;
  if (!key) throw new Error('Add an App Store Connect API key to the project vault to submit to TestFlight / App Store');

  let appId = config.ascAppId || project.ascAppId;
  if (!appId) {
    logger.log(`Looking up App Store Connect app for ${project.iosBundleId}`);
    appId = await findAscAppId(key, project.iosBundleId);
    if (!appId) throw new Error(`No app with bundle id ${project.iosBundleId} in App Store Connect. Create it at appstoreconnect.apple.com first.`);
  }
  logger.log(`App Store Connect app id: ${appId}`);

  const { dir } = writeAscKey(workDir, key);
  const env = { API_PRIVATE_KEYS_DIR: dir };
  const args =
    build.appVersion && build.buildNumber
      ? ['altool', '--upload-package', file, '--type', 'ios', '--apple-id', appId, '--bundle-id', project.iosBundleId,
          '--bundle-version', String(build.buildNumber), '--bundle-short-version-string', build.appVersion]
      : ['altool', '--upload-app', '-f', file, '-t', 'ios'];
  args.push('--apiKey', key.keyId, '--apiIssuer', key.issuerId, '--show-progress');
  logger.section('Uploading to App Store Connect');
  await run('xcrun', args, { env, logger, signal });
  logger.log('Upload accepted by Apple. Processing usually takes 5–30 minutes.');

  const result = { store: 'app-store-connect', ascAppId: appId, buildNumber: build.buildNumber, appVersion: build.appVersion };
  const groups = config.groups || [];
  if (!groups.length && !config.whatToTest) return result;

  // ---- Wait for processing, then distribute to TestFlight groups ----
  logger.section('TestFlight distribution');
  const deadline = Date.now() + (config.processingTimeoutMin || 45) * 60 * 1000;
  let ascBuild = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Canceled');
    const q = `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(build.buildNumber)}` +
      (build.appVersion ? `&filter[preReleaseVersion.version]=${encodeURIComponent(build.appVersion)}` : '') + '&limit=1';
    ascBuild = (await asc(key, 'GET', q)).data?.[0];
    const state = ascBuild?.attributes?.processingState;
    logger.log(`Processing state: ${state || 'not visible yet'}`);
    if (state === 'VALID') break;
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`Apple rejected the build during processing (${state})`);
    await sleep(30000);
  }
  if (ascBuild?.attributes?.processingState !== 'VALID') throw new Error('Timed out waiting for Apple to process the build');

  if (config.whatToTest) {
    await asc(key, 'POST', '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew: config.whatToTest },
        relationships: { build: { data: { type: 'builds', id: ascBuild.id } } },
      },
    }).catch((e) => logger.log(`Could not set "What to Test": ${e.message}`));
  }
  if (groups.length) {
    const all = (await asc(key, 'GET', `/v1/apps/${appId}/betaGroups?limit=200`)).data || [];
    const ids = groups.map((g) => all.find((x) => x.attributes.name === g || x.id === g)?.id).filter(Boolean);
    const unknown = groups.filter((g) => !all.some((x) => x.attributes.name === g || x.id === g));
    if (unknown.length) logger.log(`⚠ Unknown TestFlight groups: ${unknown.join(', ')}`);
    if (ids.length) {
      await asc(key, 'POST', `/v1/builds/${ascBuild.id}/relationships/betaGroups`, { data: ids.map((id) => ({ type: 'betaGroups', id })) });
      logger.log(`Added build to TestFlight groups: ${groups.filter((g) => !unknown.includes(g)).join(', ')}`);
    }
  }
  return { ...result, ascBuildId: ascBuild.id, testflightGroups: groups };
}
