import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const CONFIG_DIR = path.join(os.homedir(), '.launchdock');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadUserConfig() {
  const env = { url: process.env.LAUNCHDOCK_URL, token: process.env.LAUNCHDOCK_TOKEN };
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return { url: env.url || file.url, token: env.token || file.token, email: file.email };
}

export function saveUserConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function clearUserConfig() {
  fs.rmSync(CONFIG_FILE, { force: true });
}

export class Client {
  constructor({ url, token }) {
    if (!url) throw new Error('No server configured. Run: launchdock login --url https://your-launchdock-server');
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }
  async request(method, p, { json, body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (this.token) init.headers.authorization = `Bearer ${this.token}`;
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['content-type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = body;
      init.duplex = 'half';
    }
    let res;
    try {
      res = await fetch(this.url + p, init);
    } catch (err) {
      throw new Error(`Cannot reach ${this.url}: ${err.cause?.code || err.message}`);
    }
    if (raw) {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res;
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error('Not logged in (or token revoked). Run: launchdock login');
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
  get(p) {
    return this.request('GET', p);
  }
  post(p, json) {
    return this.request('POST', p, { json: json ?? {} });
  }
  put(p, json) {
    return this.request('PUT', p, { json });
  }
  del(p) {
    return this.request('DELETE', p);
  }
  uploadFile(p, file, contentType = 'application/octet-stream') {
    const size = fs.statSync(file).size;
    return this.request('POST', p, {
      body: Readable.toWeb(fs.createReadStream(file)),
      headers: { 'content-type': contentType, 'content-length': String(size) },
    });
  }
}
