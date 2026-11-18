// Google Play Developer API v3 (edits flow) using a service account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

async function netFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`Could not reach ${new URL(url).host}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
}
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

export async function googleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await netFetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error}`);
  return data.access_token;
}

function explain(message) {
  if (/Package not found/i.test(message))
    return `${message}\n→ Create the app in Play Console and upload the very first build manually; Google's API cannot create apps.`;
  if (/draft app/i.test(message)) return `${message}\n→ This app has never been published. Use "releaseStatus": "draft" until the first release is reviewed.`;
  if (/does not have permission|caller does not have/i.test(message))
    return `${message}\n→ Invite the service account email in Play Console → Users and permissions, with release permissions for this app.`;
  if (/Version code \d+ has already been used/i.test(message))
    return `${message}\n→ Bump the build number: launchdock version:set --platform android --build-number <higher>`;
  return message;
}

export async function submitToPlay({ file, packageName, serviceAccountJson, config, logger }) {
  const token = await googleAccessToken(serviceAccountJson);
  const call = async (method, url, { json, body, headers = {} } = {}) => {
    const init = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
    if (json) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    } else if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    const res = await netFetch(url, init);
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(explain(data.error?.message || `HTTP ${res.status} from Google Play`));
    return data;
  };

  const pkg = encodeURIComponent(packageName);
  logger.log(`Opening Play Console edit for ${packageName}`);
  const edit = await call('POST', `${API}/${pkg}/edits`, { json: {} });
  const isApk = file.endsWith('.apk');
  const size = fs.statSync(file).size;
  logger.log(`Uploading ${isApk ? 'APK' : 'app bundle'} (${(size / 1024 / 1024).toFixed(1)} MB)…`);
  const uploaded = await call('POST', `${UPLOAD}/${pkg}/edits/${edit.id}/${isApk ? 'apks' : 'bundles'}?uploadType=media`, {
    body: Readable.toWeb(fs.createReadStream(file)),
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
  });
  const versionCode = uploaded.versionCode;
  logger.log(`Uploaded versionCode ${versionCode}`);

  const release = { versionCodes: [String(versionCode)], status: config.releaseStatus || 'completed' };
  if (config.rollout !== undefined && ['inProgress', 'halted'].includes(release.status)) release.userFraction = config.rollout;
  if (config.releaseNotes) release.releaseNotes = [{ language: config.releaseNotesLanguage || 'en-US', text: config.releaseNotes }];
  const track = config.track || 'internal';
  logger.log(`Assigning to track "${track}" with status "${release.status}"`);
  await call('PUT', `${API}/${pkg}/edits/${edit.id}/tracks/${encodeURIComponent(track)}`, { json: { track, releases: [release] } });

  const q = config.changesNotSentForReview ? '?changesNotSentForReview=true' : '';
  await call('POST', `${API}/${pkg}/edits/${edit.id}:commit${q}`, { json: {} });
  logger.log('Edit committed to Google Play ✔');
  return { store: 'google-play', versionCode, track, status: release.status };
}
