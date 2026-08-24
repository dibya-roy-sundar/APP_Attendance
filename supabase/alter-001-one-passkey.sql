-- One passkey per student, and an approval queue instead of a reset button.
--
-- Run this once. It replaces the passkey_claimed approach entirely.
--
-- WHY ONE PER STUDENT
--
-- Credentials were one-to-many so a student could switch phones without asking
-- anyone. That also meant anybody in the room with a live QR code could attach
-- a second passkey to any roll number — including one already registered — and
-- then mark that student present, silently, for the rest of the term. The
-- device-binding scheme this replaced refused exactly that, through a unique
-- column. This puts the guarantee back where it belongs: in the database.
--
-- The unique index is also what makes the race safe. Checking for an existing
-- credential and then inserting one is two statements, and three phones
-- claiming the same roll number in the same instant all passed the check before
-- any of them wrote. A unique constraint has no such window: one insert wins,
-- the others raise 23505 and are turned into requests.
--
-- WHY A QUEUE RATHER THAN A RESET
--
-- Refusing a claim outright is correct but blind: the admin never learns it
-- happened. A rejected claim is now recorded, so a genuine lost phone and an
-- attempted proxy arrive through the same door and the admin decides which is
-- which — with the useful side effect that every attempt is evidence, stamped
-- with a time and a device.

alter table students drop column if exists passkey_claimed;

-- One credential per student, enforced by Postgres.
delete from student_credentials c
 where exists (
   select 1 from student_credentials keep
    where keep.student_id = c.student_id
      and (keep.created_at, keep.id) < (c.created_at, c.id)
 );

create unique index if not exists student_credentials_one_per_student
  on student_credentials (student_id);

-- A claim on a roll number that already has a passkey, awaiting a decision.
--
-- The credential is fully verified before it lands here — the signature, the
-- origin and the challenge are all checked — so approving is only a question of
-- trust, never of validity. Nothing here can mark attendance.
create table if not exists passkey_requests (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete cascade,
  -- The credential that wants to take over, held aside until approved.
  credential_id text not null unique,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[],
  device_label  text,
  -- Context the admin needs to judge it, captured at request time.
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  session_id    uuid references sessions(id) on delete set null,
  caller        text,               -- coarse origin of the request
  decided_at    timestamptz,
  decision      text check (decision in ('approved', 'rejected'))
);

-- At most one pending request per student, so the queue cannot be flooded for
-- one roll number. A new claim replaces the pending one.
create unique index if not exists passkey_requests_one_pending_per_student
  on passkey_requests (student_id) where decided_at is null;

create index if not exists passkey_requests_pending_idx
  on passkey_requests (expires_at) where decided_at is null;

-- Decided and expired rows are kept for a while on purpose: a rejected claim is
-- the record of an attempted proxy, and that is worth more than a tidy table.
-- Cleanup runs behind the panel's response and only removes rows older than 7 days.

alter table passkey_requests enable row level security;
