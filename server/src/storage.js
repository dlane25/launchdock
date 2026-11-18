import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from './config.js';

export class LimitExceededError extends Error {
  constructor(limit) {
    super(`Upload exceeds limit of ${Math.round(limit / 1024 / 1024)} MB`);
    this.status = 413;
  }
}

function limiter(maxBytes, onSize) {
  let size = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) return cb(new LimitExceededError(maxBytes));
      onSize?.(size);
      cb(null, chunk);
    },
  });
}

class LocalStorage {
  constructor(dir) {
    this.dir = dir;
  }
  file(key) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(this.dir + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async putStream(key, stream, { maxBytes } = {}) {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    let size = 0;
    try {
      await pipeline(stream, limiter(maxBytes, (s) => (size = s)), fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return { size };
  }
  async putBuffer(key, buf) {
    const dest = this.file(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    return { size: buf.length };
  }
  async getStream(key) {
    const p = this.file(key);
    const stat = await fsp.stat(p).catch(() => null);
    if (!stat) return null;
    return { stream: fs.createReadStream(p), size: stat.size };
  }
  async exists(key) {
    return !!(await fsp.stat(this.file(key)).catch(() => null));
  }
  async delete(key) {
    await fsp.rm(this.file(key), { force: true });
  }
}

class S3Storage {
  constructor(opts) {
    this.opts = opts;
    this.ready = (async () => {
      const s3 = await import('@aws-sdk/client-s3');
      const lib = await import('@aws-sdk/lib-storage');
      this.s3 = s3;
      this.Upload = lib.Upload;
      this.client = new s3.S3Client({
        region: opts.region,
        endpoint: opts.endpoint,
        forcePathStyle: !!opts.endpoint,
        credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      });
    })();
  }
  async putStream(key, stream, { maxBytes, contentType } = {}) {
    await this.ready;
    let size = 0;
    const body = stream.pipe(limiter(maxBytes, (s) => (size = s)));
    let failure;
    body.on('error', (e) => (failure = e));
    const upload = new this.Upload({
      client: this.client,
      params: { Bucket: this.opts.bucket, Key: key, Body: body, ContentType: contentType || 'application/octet-stream' },
    });
    await upload.done();
    if (failure) {
      await this.delete(key);
      throw failure;
    }
    return { size };
  }
  async putBuffer(key, buf, { contentType } = {}) {
    await this.ready;
    await this.client.send(new this.s3.PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: buf, ContentType: contentType }));
    return { size: buf.length };
  }
  async getStream(key) {
    await this.ready;
    try {
      const res = await this.client.send(new this.s3.GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { stream: res.Body, size: res.ContentLength };
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
  async exists(key) {
    await this.ready;
    try {
      await this.client.send(new this.s3.HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key) {
    await this.ready;
    await this.client.send(new this.s3.DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key })).catch(() => {});
  }
}

export const storage =
  config.storage.driver === 's3' ? new S3Storage(config.storage.s3) : new LocalStorage(config.storage.dir);
