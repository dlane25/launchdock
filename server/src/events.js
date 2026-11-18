import crypto from 'node:crypto';
import { many, query } from './db.js';

export const WEBHOOK_EVENTS = [
  'build.started',
  'build.finished',
  'build.errored',
  'build.canceled',
  'submission.finished',
  'submission.errored',
  'update.published',
];

export async function appendLogs(jobId, lines) {
  const clean = lines
    .flatMap((l) => String(l).split('\n'))
    .map((l) => l.replace(/\r/g, '').slice(0, 4000))
    .filter((l) => l.length);
  if (!clean.length) return;
  // Single multi-row insert keeps ordering by id.
  const values = clean.map((_, i) => `($1, $${i + 2})`).join(',');
  await query(`insert into job_logs (job_id, line) values ${values}`, [jobId, ...clean]);
}

export async function emit(projectId, event, payload) {
  const hooks = await many(`select * from webhooks where project_id = $1 and ($2 = any(events) or cardinality(events) = 0)`, [
    projectId,
    event,
  ]);
  for (const hook of hooks) deliver(hook, event, payload);
}

async function deliver(hook, event, payload, attempt = 1) {
  const body = JSON.stringify({ event, projectId: hook.project_id, timestamp: new Date().toISOString(), data: payload });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-launchdock-event': event, 'x-launchdock-signature': `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (attempt < 4) setTimeout(() => deliver(hook, event, payload, attempt + 1), 2000 * 4 ** attempt);
    else console.warn(`[webhook] ${hook.url} failed for ${event}: ${err.message}`);
  }
}
