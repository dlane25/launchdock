import { bad } from './http.js';

// Credential types the vault accepts. `fields` are required keys in the payload.
export const CREDENTIAL_TYPES = {
  android_keystore: {
    platform: 'android',
    label: 'Android upload keystore',
    fields: ['keystoreBase64', 'keystorePassword', 'keyAlias', 'keyPassword'],
    meta: (d) => ({ keyAlias: d.keyAlias, sizeBytes: Buffer.from(d.keystoreBase64, 'base64').length }),
  },
  google_service_account: {
    platform: 'android',
    label: 'Google Play service account key',
    fields: ['json'],
    meta: (d) => {
      let parsed;
      try {
        parsed = JSON.parse(d.json);
      } catch {
        throw bad('Service account key must be valid JSON');
      }
      if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
        throw bad('This JSON is not a Google service account key');
      }
      return { clientEmail: parsed.client_email, gcpProject: parsed.project_id };
    },
  },
  asc_api_key: {
    platform: 'ios',
    label: 'App Store Connect API key',
    fields: ['keyId', 'issuerId', 'p8'],
    meta: (d) => {
      if (!/BEGIN PRIVATE KEY/.test(d.p8)) throw bad('p8 must be the contents of the AuthKey_XXXX.p8 file');
      return { keyId: d.keyId, issuerId: d.issuerId };
    },
  },
  ios_distribution_certificate: {
    platform: 'ios',
    label: 'iOS distribution certificate (.p12)',
    fields: ['p12Base64'],
    meta: (d) => ({ sizeBytes: Buffer.from(d.p12Base64, 'base64').length, hasPassword: !!d.password }),
  },
  ios_provisioning_profile: {
    platform: 'ios',
    label: 'iOS provisioning profile',
    fields: ['profileBase64'],
    meta: (d) => parseProvisioningProfile(Buffer.from(d.profileBase64, 'base64')),
  },
};

// The .mobileprovision file is a CMS-signed plist; the XML is embedded verbatim.
export function parseProvisioningProfile(buf) {
  const text = buf.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < 0) throw bad('Could not read provisioning profile');
  const xml = text.slice(start, end + 8);
  const str = (key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
  const date = (key) => xml.match(new RegExp(`<key>${key}</key>\\s*<date>([^<]*)</date>`))?.[1];
  const teamId = xml.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1];
  const appId = xml.match(/<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  const hasDevices = /<key>ProvisionedDevices<\/key>/.test(xml);
  const enterprise = /<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(xml);
  return {
    name: str('Name'),
    uuid: str('UUID'),
    teamId,
    bundleId: appId ? appId.replace(/^[A-Z0-9]+\./, '') : null,
    expiresAt: date('ExpirationDate'),
    distribution: enterprise ? 'enterprise' : hasDevices ? 'ad-hoc' : 'app-store',
  };
}

export function validateCredential(type, data) {
  const def = CREDENTIAL_TYPES[type];
  if (!def) throw bad(`Unknown credential type "${type}". Valid: ${Object.keys(CREDENTIAL_TYPES).join(', ')}`);
  if (!data || typeof data !== 'object') throw bad('Body must include a "data" object');
  for (const f of def.fields) {
    if (data[f] === undefined || data[f] === null || data[f] === '') throw bad(`Missing field "${f}" for ${type}`);
  }
  return { platform: def.platform, meta: def.meta(data) };
}
