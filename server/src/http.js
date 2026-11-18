import { one, query } from './db.js';
import { verifyJwt, sha256Hex, safeEqual } from './crypto.js';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function bad(message, details) {
  return new HttpError(400, message, details);
}

export function notFound(what = 'Resource') {
  return new HttpError(404, `${what} not found`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v));

// Resolve the user from a dashboard JWT or a CLI API token ("ldk_...").
export async function authenticate(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!/^bearer$/i.test(scheme) || !token) return null;
  if (token.startsWith('ldk_')) {
    const row = await one(
      `select u.id, u.email, u.name, u.is_admin, t.id as token_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = $1`,
      [sha256Hex(token)],
    );
    if (!row) return null;
    query('update api_tokens set last_used_at = now() where id = $1', [row.token_id]).catch(() => {});
    return { id: row.id, email: row.email, name: row.name, is_admin: row.is_admin };
  }
  const payload = verifyJwt(token);
  if (!payload?.sub) return null;
  return one('select id, email, name, is_admin from users where id = $1', [payload.sub]);
}

export const requireUser = ah(async (req, _res, next) => {
  const user = await authenticate(req);
  if (!user) throw new HttpError(401, 'Authentication required');
  req.user = user;
  next();
});

export const requireAdmin = (req, _res, next) => {
  if (!req.user?.is_admin) return next(new HttpError(403, 'Admin access required'));
  next();
};

const ROLE_LEVEL = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export async function loadProjectForUser(projectId, user, minRole = 'viewer') {
  if (!isUuid(projectId)) throw notFound('Project');
  const project = await one(
    `select p.*, case when p.owner_id = $2 then 'owner' else m.role end as role
       from projects p
       left join project_members m on m.project_id = p.id and m.user_id = $2
      where p.id = $1`,
    [projectId, user.id],
  );
  if (!project || (!project.role && !user.is_admin)) throw notFound('Project');
  const role = project.role || 'admin'; // platform admins act as project admins
  if (ROLE_LEVEL[role] < ROLE_LEVEL[minRole]) throw new HttpError(403, `Requires ${minRole} role on this project`);
  project.role = role;
  return project;
}

// Middleware: req.project for routes with :pid
export const requireProject = (minRole = 'viewer') =>
  ah(async (req, _res, next) => {
    req.project = await loadProjectForUser(req.params.pid, req.user, minRole);
    next();
  });

export const requireWorker = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!/^worker$/i.test(scheme) || !token || !safeEqual(token, config.workerToken)) {
    return next(new HttpError(401, 'Invalid worker token'));
  }
  req.workerId = String(req.headers['x-worker-id'] || 'unknown').slice(0, 100);
  next();
};

export function publicProject(p) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    iosBundleId: p.ios_bundle_id,
    androidPackage: p.android_package,
    appleTeamId: p.apple_team_id,
    ascAppId: p.asc_app_id,
    gitUrl: p.git_url,
    hasGitToken: !!p.git_token_enc,
    hasUpdatesSigningKey: !!p.updates_signing_key_enc,
    role: p.role,
    createdAt: p.created_at,
  };
}
