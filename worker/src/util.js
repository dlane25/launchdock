import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Buffers log lines, masks secrets, and ships them to the API in batches.
export class JobLogger {
  constructor(api, type, id) {
    this.api = api;
    this.type = type;
    this.id = id;
    this.buffer = [];
    this.secrets = [];
    this.timer = setInterval(() => this.flush().catch(() => {}), 1500);
  }
  mask(...values) {
    for (const v of values) if (v && String(v).length >= 4) this.secrets.push(String(v));
    this.secrets.sort((a, b) => b.length - a.length);
  }
  scrub(line) {
    let out = line;
    for (const s of this.secrets) out = out.split(s).join('********');
    return out;
  }
  log(...parts) {
    const line = this.scrub(parts.join(' '));
    process.stdout.write(`[${this.type}:${this.id.slice(0, 8)}] ${line}\n`);
    this.buffer.push(line);
    if (this.buffer.length >= 500) this.flush().catch(() => {});
  }
  section(title) {
    this.log('');
    this.log(`━━━ ${title} ━━━`);
  }
  async flush() {
    if (!this.buffer.length) return;
    const lines = this.buffer.splice(0, this.buffer.length);
    try {
      await this.api.logs(this.type, this.id, lines);
    } catch (err) {
      // Put them back so they are retried on the next flush.
      this.buffer.unshift(...lines);
      if (this.buffer.length > 20000) this.buffer.splice(0, this.buffer.length - 20000);
      throw err;
    }
  }
  async close() {
    clearInterval(this.timer);
    await this.flush().catch(() => {});
  }
}

// Run a command, streaming output into the logger. Kills the whole process group on abort.
export function run(cmd, args, { cwd, env, logger, signal, quiet = false, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Canceled'));
    if (!quiet) logger?.log(`$ ${[cmd, ...args].map(shellQuote).join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const onLine = (chunk, which) => {
      const text = chunk.toString();
      if (which === 'out') stdout += text;
      else stderr += text;
      if (stdout.length > 5e6) stdout = stdout.slice(-2e6);
      if (stderr.length > 5e6) stderr = stderr.slice(-2e6);
      if (!quiet) for (const line of text.split(/\r?\n/)) if (line.trim()) logger?.log(line);
    };
    child.stdout.on('data', (c) => onLine(c, 'out'));
    child.stderr.on('data', (c) => onLine(c, 'err'));
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 10000);
      } catch {}
    };
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', kill);
      reject(err.code === 'ENOENT' ? new Error(`Command not found: ${cmd}. Is it installed on this worker?`) : err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new Error('Canceled'));
      if (code === 0 || allowFailure) return resolve({ code, stdout, stderr });
      const tail = (stderr || stdout).trim().split('\n').slice(-5).join('\n');
      reject(new Error(`${cmd} exited with code ${code}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

export const capture = (cmd, args, opts = {}) => run(cmd, args, { ...opts, quiet: true }).then((r) => r.stdout.trim());

export function shellQuote(s) {
  s = String(s);
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function findFiles(dir, predicate, maxDepth = 8, out = []) {
  if (maxDepth < 0 || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (predicate(p, entry)) out.push(p);
      findFiles(p, predicate, maxDepth - 1, out);
    } else if (predicate(p, entry)) out.push(p);
  }
  return out;
}

export const exists = (p) => fs.existsSync(p);
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
