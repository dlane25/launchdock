// Minimal streaming tar.gz writer (ustar + PAX long names) so packing works the same on Windows, macOS and Linux.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const DEFAULT_IGNORES = [
  'node_modules', '.git', '.expo', '.expo-shared', 'dist', 'web-build', '.turbo', '.next', 'coverage',
  'ios/Pods', 'ios/build', 'android/build', 'android/app/build', 'android/.gradle', 'android/.cxx', 'android/app/.cxx',
  'build', '.dart_tool', '.idea', '.vscode', '.DS_Store', '.launchdock',
];

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name, size, mode, mtime, type = '0') {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 'utf8');
  buf.write(octal(mode, 8), 100);
  buf.write(octal(0, 8), 108);
  buf.write(octal(0, 8), 116);
  buf.write(octal(size, 12), 124);
  buf.write(octal(Math.floor(mtime), 12), 136);
  buf.write('        ', 148); // checksum placeholder
  buf.write(type, 156);
  buf.write('ustar\0', 257);
  buf.write('00', 263);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octal(sum, 7) + ' ', 148);
  return buf;
}

function paxHeader(name, mtime) {
  const record = (k, v) => {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
    return `${len}${body}`;
  };
  const data = Buffer.from(record('path', name), 'utf8');
  return [header('PaxHeader', data.length, 0o644, mtime, 'x'), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

// Files to include: git-tracked + untracked-not-ignored when in a git repo, otherwise a filtered walk.
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
    const files = out.toString('utf8').split('\0').filter(Boolean);
    if (files.length) return files.filter((f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
  } catch {}
  const files = [];
  const ignored = (rel) => DEFAULT_IGNORES.some((i) => rel === i || rel.startsWith(`${i}/`) || rel.split('/').includes(i) && !i.includes('/'));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ignored(rel)) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(root);
  return files;
}

export async function packDirectory(root, dest) {
  const files = listFiles(root);
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(dest);
  gz.pipe(out);
  const write = (chunk) => (gz.write(chunk) ? Promise.resolve() : new Promise((r) => gz.once('drain', r)));
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    const name = rel.split(path.sep).join('/');
    const executable = (st.mode & 0o111) !== 0 || /(^|\/)gradlew$|\.sh$/.test(name);
    const mode = executable ? 0o755 : 0o644;
    if (Buffer.byteLength(name) > 100) for (const part of paxHeader(name, st.mtimeMs / 1000)) await write(part);
    await write(header(name, st.size, mode, st.mtimeMs / 1000));
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(abs);
      rs.on('data', (c) => {
        if (!gz.write(c)) {
          rs.pause();
          gz.once('drain', () => rs.resume());
        }
      });
      rs.on('end', resolve);
      rs.on('error', reject);
    });
    const pad = (512 - (st.size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024));
  gz.end();
  await new Promise((r, j) => out.on('finish', r).on('error', j));
  return { files: files.length, size: fs.statSync(dest).size };
}
