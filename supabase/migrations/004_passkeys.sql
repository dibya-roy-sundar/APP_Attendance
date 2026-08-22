-- Passkeys replace device binding.
--
-- Why: identity used to be a random UUID in localStorage. Safari's Intelligent
-- Tracking Prevention deletes script-writable storage after roughly seven days
-- of browser use without interaction, and a weekly class sits exactly on that
-- boundary — so the whole roster would silently lose its binding between
-- classes and each student would need an admin reset. A server-set httpOnly
-- cookie fixed that, but two problems survived it: an installed home-screen web
-- app on iOS has its own storage container, so the same phone could hold two
-- unrelated identities; and any student who cleared site data still needed an
-- admin to intervene.
--
-- A passkey lives in the OS credential store (iCloud Keychain, Google Password
-- Manager), not in the browser's storage box. It therefore survives all of the
-- above, is reachable from both containers, follows the student to a new phone
-- in the same ecosystem, and — unlike a UUID, an emailed OTP or a password —
-- cannot be forwarded to a friend, because the private key is non-extractable
-- and using it requires the device plus its biometric.
--
-- See README, "Why identity moved from localStorage to a cookie to passkeys".

create table if not exists student_credentials (
  id             uuid primary key default gen_random_uuid(),
  student_id     uuid not null references students(id) on delete cascade,
  -- Base64URL of the raw credential id. Unique across the table: one physical
  -- credential can only ever belong to one student.
  credential_id  text not null unique,
  public_key     text not null,              -- base64url COSE key
  -- Monotonic per credential. A value that fails to advance is a replayed or
  -- cloned assertion, so it is checked on every sign-in.
  counter        bigint not null default 0,
  transports     text[],
  device_label   text,                       -- "iPhone", so a student can tell theirs apart
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

-- Deliberately NOT unique on student_id: a student may hold one passkey per
-- device. Without this, somebody moving from iPhone to Android would be back to
-- asking an admin to clear their old binding, which is the whole problem
-- passkeys were adopted to remove.
create index if not exists student_credentials_student_idx
  on student_credentials (student_id);

-- Challenges are single-use and short-lived. Held server-side so a replayed or
-- attacker-chosen challenge cannot be accepted.
create table if not exists webauthn_challenges (
  challenge   text primary key,
  purpose     text not null check (purpose in ('register', 'authenticate')),
  -- Set for registration, where we already know who is claiming the roll
  -- number. Null for authentication, which is discoverable — the passkey tells
  -- us who it belongs to.
  student_id  uuid references students(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists webauthn_challenges_expiry_idx
  on webauthn_challenges (expires_at);

alter table student_credentials enable row level security;
alter table webauthn_challenges enable row level security;

-- students.device_id and students.enrolled_at are retained on purpose.
--
-- Nothing writes them any more. They are kept so an existing database is not
-- rewritten by this migration, and so the previous term's bindings remain
-- readable if a question is ever asked about them. The superseded code that
-- used them is preserved verbatim under docs/superseded/.
comment on column students.device_id is
  'Superseded by student_credentials. Written by the device-binding scheme removed in 004; retained for history, read by nothing.';
comment on column students.enrolled_at is
  'Superseded by student_credentials.created_at. Retained for history, read by nothing.';
