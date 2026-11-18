import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { migrate, query, many } from './db.js';
import { appendLogs } from './events.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import buildRoutes from './routes/builds.js';
import updateRoutes from './routes/updates.js';
import workerRoutes from './routes/worker.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // JSON for API calls; uploads (sources/artifacts/assets) are streamed by their own handlers.
  app.use('/api', express.json({ limit: '25mb' }));
  app.use('/api', updateRoutes);
  app.use('/api', workerRoutes);
  app.use('/api', authRoutes);
  app.use('/api', buildRoutes);
  app.use('/api', projectRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Dashboard (static SPA)
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(pub, { index: 'index.html', maxAge: '5m' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details });
  });
  return app;
}

// Fail jobs whose worker stopped sending heartbeats; prune old logs.
export async function reap() {
  for (const table of ['builds', 'submissions']) {
    const stale = await many(
      `update ${table} set status = 'errored', finished_at = now(),
              error = 'Worker stopped responding (no heartbeat for ${config.jobTimeoutMinutes} minutes)'
        where status = 'in_progress' and heartbeat_at < now() - make_interval(mins => $1)
        returning id`,
      [config.jobTimeoutMinutes],
    );
    for (const s of stale) await appendLogs(s.id, ['[launchdock] Job timed out: worker stopped responding']);
  }
  await query(
    `delete from job_logs where ts < now() - make_interval(days => $1)`,
    [config.logRetentionDays],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => console.log(`[launchdock] API + dashboard on ${config.publicUrl} (port ${config.port})`));
  setInterval(() => reap().catch((e) => console.error('[reaper]', e.message)), 60 * 1000);
}
