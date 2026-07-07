-- ZenoX Exercise SaaS baseline schema.
-- The current app still runs on data/db.json for local use. This schema is the
-- target shape for moving production data to PostgreSQL.

create table if not exists zenox_app_state (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organizations (
  id text primary key,
  name text not null,
  plan text not null default 'starter',
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  username text not null unique,
  display_name text not null default '',
  role text not null check (role in ('owner', 'admin', 'teacher', 'reviewer')),
  password_hash text not null,
  status text not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists uploads (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  filename text not null,
  stored_name text not null,
  hash text,
  type text,
  size bigint not null default 0,
  extracted_text text not null default '',
  extraction_note text not null default '',
  pages jsonb not null default '[]'::jsonb,
  page_images jsonb not null default '[]'::jsonb,
  analysis_status text not null default 'ready',
  analysis_error text not null default '',
  analysis_progress jsonb not null default '{}'::jsonb,
  analysis_diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists questions (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  stem text not null,
  options jsonb not null default '[]'::jsonb,
  answer text not null default '',
  explanation text not null default '',
  subject text not null,
  stage text not null,
  grade text not null default '',
  chapter text not null default '',
  knowledge jsonb not null default '[]'::jsonb,
  level text not null default '基础',
  type text not null default '未分类',
  source_upload_id text,
  source_filename text not null default '',
  source_page text not null default '',
  question_image_stored_name text not null default '',
  explanation_image_stored_name text not null default '',
  question_bbox jsonb,
  variant_of text,
  quality_status text not null default 'ok',
  quality_errors jsonb not null default '[]'::jsonb,
  quality_warnings jsonb not null default '[]'::jsonb,
  revisions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table questions add column if not exists explanation_image_stored_name text not null default '';

create table if not exists pending_questions (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  payload jsonb not null,
  status text not null default 'pending',
  quality_status text not null default 'ok',
  quality_errors jsonb not null default '[]'::jsonb,
  quality_warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists students (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  name text not null,
  stage text not null default '',
  grade text not null default '',
  level text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mistakes (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  student_id text not null,
  question_id text not null,
  reason text not null default '',
  note text not null default '',
  date date not null default current_date,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists assignments (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  updated_by text references users(id),
  title text not null,
  student_id text not null default '',
  subject text not null default '',
  grade text not null default '',
  question_ids jsonb not null default '[]'::jsonb,
  generated_questions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists jobs (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  type text not null,
  status text not null,
  target_id text not null default '',
  message text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_usage (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  month text not null,
  provider text not null,
  model text not null,
  purpose text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  pages integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id text primary key,
  tenant_id text not null references organizations(id) on delete cascade,
  created_by text references users(id),
  action text not null,
  target_type text not null,
  target_id text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_questions_tenant on questions(tenant_id);
create index if not exists idx_uploads_tenant on uploads(tenant_id);
create index if not exists idx_pending_tenant on pending_questions(tenant_id);
create index if not exists idx_ai_usage_tenant_month on ai_usage(tenant_id, month);
create index if not exists idx_audit_tenant_created on audit_logs(tenant_id, created_at desc);

alter table uploads add column if not exists analysis_diagnostics jsonb not null default '{}'::jsonb;
alter table questions add column if not exists revisions jsonb not null default '[]'::jsonb;
alter table questions add column if not exists question_bbox jsonb;
