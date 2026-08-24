-- QR Attendance — the whole schema. Run once in the Supabase SQL editor.
--
-- This file is the single source of truth. It is not a migration chain: the app
-- never carried real attendance, so the four incremental migrations that built
-- it up were folded in here and moved to docs/superseded/migrations/ as a
-- record. If the schema changes again before the app carries data worth
-- keeping, edit this file and re-run reset.sql — do not add a migration.
--
-- Identity is a passkey. See README, "Why identity moved from localStorage, to
-- a cookie, to passkeys", for the two designs that came before and the specific
-- reason each failed. There are deliberately no device_id columns anywhere.

create extension if not exists pgcrypto;

create table if not exists students (
  id       uuid primary key default gen_random_uuid(),
  s_no     int  unique not null,          -- preserves the instructor's sheet order (col A)
  roll_no  text unique not null,
  name     text not null,
  email    text
);

create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  class_date     date not null unique,    -- one session per class day
  secret         text not null,           -- random 32 bytes, hex
  is_open        boolean not null default true,
  opened_at      timestamptz not null default now(),
  expires_at     timestamptz not null,    -- admin picks the duration
  -- The QR rotation period. This is the only real control over relaying a
  -- photographed code to somebody who never turned up: at 10s a code is usable
  -- for 10–20s, at 120s for 120–240s.
  window_seconds int not null default 15
    check (window_seconds between 5 and 300)
);

create table if not exists attendance (
  session_id uuid not null references sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  marked_at  timestamptz not null default now(),
  source     text not null default 'scan'  -- 'scan' | 'manual'
    check (source in ('scan', 'manual')),
  primary key (session_id, student_id)     -- makes double-marking impossible
);

-- ── passkeys ──────────────────────────────────────────────────────────────
--
-- One row per credential, and deliberately NOT unique on student_id: a student
-- may register one passkey per device. If it were one-per-student, somebody
-- moving from iPhone to Android would need an admin to clear the old one —
-- which is the exact problem passkeys were adopted to remove.
create table if not exists student_credentials (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete cascade,
  -- Base64URL of the raw credential id. Unique across the table, so one
  -- physical credential can only ever belong to one student.
  credential_id text not null unique,
  public_key    text not null,             -- base64url COSE key
  -- Monotonic per credential. A counter that fails to advance means a replayed
  -- or cloned assertion, so it is checked on every sign-in.
  counter       bigint not null default 0,
  transports    text[],
  device_label  text,                      -- "iPhone", so a student can tell theirs apart
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- One credential per student, enforced by Postgres rather than by remembering
-- to check. It is also what makes the race safe: check-then-insert has a window
-- in which three simultaneous claims all pass, a unique index has none.
--
-- Being in the room with a live QR code is enough to claim an *unclaimed* roll
-- number. It is never enough to claim one twice — otherwise anybody present
-- could attach a passkey to an absent classmate and mark them present for the
-- rest of the term. A second claim becomes a row in passkey_requests for the
-- admin to judge.
create unique index if not exists student_credentials_one_per_student
  on student_credentials (student_id);

-- Challenges are single-use and short-lived. Held server-side so a challenge
-- the caller chose, or one already spent, can never verify.
create table if not exists webauthn_challenges (
  challenge  text primary key,
  purpose    text not null check (purpose in ('register', 'authenticate')),
  -- Set for registration, where we already know who is claiming the roll
  -- number. Null for authentication, which is discoverable: the passkey itself
  -- says who it belongs to, which is why nothing is ever typed after the first
  -- time and why this table leaks nothing about who is enrolled.
  student_id uuid references students(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists webauthn_challenges_expiry_idx
  on webauthn_challenges (expires_at);

-- A claim on a roll number that already has a passkey, awaiting a decision.
--
-- Refusing outright is correct but blind — the admin never learns it happened.
-- A lost phone and an attempted proxy arrive through the same door, and the
-- admin decides which is which. Every rejected claim is then evidence, stamped
-- with a time and a device.
--
-- The credential is fully verified before it lands here: signature, origin and
-- challenge are all checked, so approving is a question of trust, never of
-- validity. Nothing in this table can mark attendance.
create table if not exists passkey_requests (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete cascade,
  credential_id text not null unique,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[],
  device_label  text,
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  session_id    uuid references sessions(id) on delete set null,
  caller        text,
  decided_at    timestamptz,
  decision      text check (decision in ('approved', 'rejected'))
);

-- At most one pending request per student, so one roll number cannot flood the
-- queue. A fresh claim replaces the pending one.
create unique index if not exists passkey_requests_one_pending_per_student
  on passkey_requests (student_id) where decided_at is null;

create index if not exists passkey_requests_pending_idx
  on passkey_requests (expires_at) where decided_at is null;

-- ── admin ─────────────────────────────────────────────────────────────────

create table if not exists audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  -- OVERRIDE_MARK | OVERRIDE_UNMARK | START_SESSION | START_BACKDATED_SESSION
  -- | OPEN_SESSION | CLOSE_SESSION | GRANT_ISSUED | GRANT_REVOKED | EXPORT
  -- | ADD_STUDENT | PASSKEY_REGISTERED | PASSKEY_REMOVED
  action     text not null,
  student_id uuid references students(id) on delete set null,
  session_id uuid references sessions(id) on delete set null,
  reason     text,
  actor      text            -- 'primary', 'deputy:<label>', or 'student'
);

-- Failed admin sign-ins, one row per attempt. Counting rows avoids the
-- read-modify-write race a single counter would have.
create table if not exists login_attempts (
  id     bigserial primary key,
  caller text        not null,
  at     timestamptz not null default now()
);

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

create index if not exists login_attempts_caller_at_idx on login_attempts (caller, at desc);
create index if not exists admin_grants_code_hash_idx   on admin_grants (code_hash);
create index if not exists admin_grants_expires_idx     on admin_grants (expires_at desc);
create index if not exists attendance_session_idx       on attendance (session_id);
create index if not exists sessions_class_date_idx      on sessions (class_date);
create index if not exists audit_log_at_idx             on audit_log (at desc);

-- Every query in this app runs through the service role key on the server.
-- Enable RLS with no policies, so a leaked anon key grants nothing.
alter table students            enable row level security;
alter table sessions            enable row level security;
alter table attendance          enable row level security;
alter table student_credentials enable row level security;
alter table webauthn_challenges enable row level security;
alter table passkey_requests    enable row level security;
alter table audit_log           enable row level security;
alter table admin_grants        enable row level security;
alter table login_attempts      enable row level security;
