-- LaunchDock initial schema
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  password_hash text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  slug text not null,
  ios_bundle_id text,
  android_package text,
  apple_team_id text,
  asc_app_id text,
  git_url text,
  git_token_enc text,
  updates_signing_key_enc text,
  created_at timestamptz not null default now(),
  unique (owner_id, slug)
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'developer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  value_enc text not null,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  type text not null,
  name text,
  data_enc text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, type)
);

create table app_versions (
  project_id uuid not null references projects(id) on delete cascade,
  platform text not null,
  build_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, platform)
);

create table builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  profile text not null default 'production',
  status text not null default 'queued'
    check (status in ('queued', 'in_progress', 'finished', 'errored', 'canceled')),
  source_type text not null check (source_type in ('upload', 'git')),
  source_key text,
  git_ref text,
  git_commit text,
  config jsonb not null default '{}',
  message text,
  artifact_key text,
  artifact_name text,
  artifact_size bigint,
  app_version text,
  build_number text,
  runtime_version text,
  channel text,
  auto_submit boolean not null default false,
  submit_config jsonb,
  worker_id text,
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);
create index builds_queue_idx on builds (status, platform, created_at);
create index builds_project_idx on builds (project_id, created_at desc);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  build_id uuid not null references builds(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  status text not null default 'queued'
    check (status in ('queued', 'in_progress', 'finished', 'errored', 'canceled')),
  config jsonb not null default '{}',
  result jsonb,
  worker_id text,
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);
create index submissions_queue_idx on submissions (status, platform, created_at);
create index submissions_project_idx on submissions (project_id, created_at desc);

create table job_logs (
  id bigserial primary key,
  job_id uuid not null,
  line text not null,
  ts timestamptz not null default now()
);
create index job_logs_job_idx on job_logs (job_id, id);

create table workers (
  id text primary key,
  platforms text[] not null,
  version text,
  info jsonb not null default '{}',
  current_job text,
  last_seen_at timestamptz not null default now()
);

create table update_assets (
  project_id uuid not null references projects(id) on delete cascade,
  hash text not null,
  storage_key text not null,
  content_type text not null,
  size bigint not null,
  created_at timestamptz not null default now(),
  primary key (project_id, hash)
);

create table updates (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  project_id uuid not null references projects(id) on delete cascade,
  channel text not null,
  runtime_version text not null,
  platform text not null check (platform in ('ios', 'android')),
  message text,
  kind text not null default 'update' check (kind in ('update', 'rollback')),
  launch_asset jsonb,
  assets jsonb not null default '[]',
  expo_client jsonb,
  metadata jsonb not null default '{}',
  git_commit text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index updates_lookup_idx on updates (project_id, channel, runtime_version, platform, created_at desc);

create table webhooks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  created_at timestamptz not null default now()
);
