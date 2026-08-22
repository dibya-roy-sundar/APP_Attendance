-- QR Attendance — full schema. Run once in the Supabase SQL editor.
-- Postgres is the single source of truth; Excel is generated on demand from it.

create extension if not exists pgcrypto;

create table if not exists students (
  id            uuid primary key default gen_random_uuid(),
  s_no          int  unique not null,       -- preserves the instructor's sheet order (col A)
  roll_no       text unique not null,
  name          text not null,
  email         text,
  device_id     text unique,                -- null until enrolled
  enrolled_at   timestamptz
);

create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  class_date     date not null unique,      -- one session per class day
  secret         text not null,             -- random 32 bytes, hex
  is_open        boolean not null default true,
  opened_at      timestamptz not null default now(),
  expires_at     timestamptz not null,      -- admin picks the duration
  window_seconds int not null default 15    -- admin picks the QR rotation period
    check (window_seconds between 5 and 300)
);

-- Upgrade for databases created before the rotation period was configurable.
alter table sessions add column if not exists window_seconds int not null default 15;
do $$ begin
  alter table sessions add constraint sessions_window_seconds_check
    check (window_seconds between 5 and 300);
exception when duplicate_object then null; end $$;

create table if not exists attendance (
  session_id  uuid not null references sessions(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  marked_at   timestamptz not null default now(),
  device_id   text,
  source      text not null default 'scan',  -- 'scan' | 'manual'
  primary key (session_id, student_id)       -- makes double-marking impossible
);

create table if not exists audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  action     text not null,   -- OVERRIDE_MARK | OVERRIDE_UNMARK | RESET_DEVICE
                              -- | OPEN_ENROLLMENT | CLOSE_ENROLLMENT
                              -- | START_SESSION | START_BACKDATED_SESSION
                              -- | OPEN_SESSION | CLOSE_SESSION
  student_id uuid references students(id) on delete set null,
  session_id uuid references sessions(id) on delete set null,
  reason     text
);

-- Failed admin sign-ins, one row per attempt. Counting rows avoids the
-- read-modify-write race a single counter would have.
create table if not exists login_attempts (
  id     bigserial primary key,
  caller text        not null,
  at     timestamptz not null default now()
);

create index if not exists login_attempts_caller_at_idx on login_attempts (caller, at desc);

-- Temporary admin access. A grant is a hashed one-time code with an expiry;
-- revoking it takes effect on the deputy's next request.
create table if not exists admin_grants (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  code_hash    text not null,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Who performed an audited action: 'primary', or 'deputy:<label>'.
alter table audit_log add column if not exists actor text;

create index if not exists admin_grants_code_hash_idx on admin_grants (code_hash);
create index if not exists admin_grants_expires_idx on admin_grants (expires_at desc);
create index if not exists attendance_session_idx on attendance (session_id);
create index if not exists sessions_class_date_idx on sessions (class_date);
create index if not exists audit_log_at_idx on audit_log (at desc);

-- Every query in this app runs through the service role key on the server.
-- Enable RLS with no policies so that a leaked anon key grants nothing.
alter table students   enable row level security;
alter table sessions   enable row level security;
alter table attendance enable row level security;
alter table audit_log  enable row level security;
alter table admin_grants enable row level security;
alter table login_attempts enable row level security;
