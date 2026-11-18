import crypto from 'node:crypto';
import path from 'node:path';

function required(name, fallbackForDev) {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV !== 'production' && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable ${name}`);
}

function parseKey(raw) {
  // Accept 64 hex chars or base64 for a 32-byte key.
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (64 hex chars or base64)');
  return buf;
}

const devKey = crypto.createHash('sha256').update('launchdock-dev-only-key').digest('hex');

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: required('DATABASE_URL', 'postgres://launchdock:launchdock@localhost:5432/launchdock'),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, ''),
  masterKey: parseKey(required('MASTER_KEY', devKey)),
  jwtSecret: required('JWT_SECRET', 'dev-jwt-secret'),
  workerToken: required('WORKER_TOKEN', 'dev-worker-token'),
  allowRegistration: process.env.ALLOW_REGISTRATION === 'true',
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    dir: path.resolve(process.env.STORAGE_DIR || './data/storage'),
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT, // e.g. https://<account>.r2.cloudflarestorage.com
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  },
  limits: {
    sourceBytes: Number(process.env.MAX_SOURCE_MB || 500) * 1024 * 1024,
    artifactBytes: Number(process.env.MAX_ARTIFACT_MB || 2048) * 1024 * 1024,
    assetBytes: Number(process.env.MAX_ASSET_MB || 50) * 1024 * 1024,
  },
  jobTimeoutMinutes: Number(process.env.JOB_HEARTBEAT_TIMEOUT_MIN || 10),
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS || 30),
};
