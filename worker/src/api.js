import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class Api {
  constructor({ url, token, workerId }) {
    this.url = url.replace(/\/$/, '');
    this.headers = { authorization: `Worker ${token}`, 'x-worker-id': workerId };
  }

  async request(method, path, { json, body, headers = {}, raw = false, timeoutMs = 60000 } = {}) {
    const init = { method, headers: { ...this.headers, ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    } else if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    const res = await fetch(this.url + path, init);
    if (raw) {
      if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
      return res;
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(data.error || `${method} ${path} → HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  claim(platforms, info) {
    return this.request('POST', '/api/worker/claim', { json: { platforms, version: '1.0.0', info } });
  }
  heartbeat(type, id) {
    return this.request('POST', `/api/worker/jobs/${type}/${id}/heartbeat`, { json: {} });
  }
  logs(type, id, lines) {
    return this.request('POST', `/api/worker/jobs/${type}/${id}/logs`, { json: { lines } });
  }
  complete(type, id, payload) {
    return this.request('POST', `/api/worker/jobs/${type}/${id}/complete`, { json: payload });
  }
  storeCredential(type, id, ctype, data) {
    return this.request('PUT', `/api/worker/jobs/${type}/${id}/credentials/${ctype}`, { json: { data } });
  }

  async download(path, dest) {
    const res = await this.request('GET', path, { raw: true, timeoutMs: 30 * 60 * 1000 });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  }

  async uploadArtifact(id, file, name) {
    const size = fs.statSync(file).size;
    return this.request('PUT', `/api/worker/jobs/build/${id}/artifact?name=${encodeURIComponent(name)}`, {
      body: Readable.toWeb(fs.createReadStream(file)),
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      timeoutMs: 60 * 60 * 1000,
    });
  }
}
