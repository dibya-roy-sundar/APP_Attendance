-- Two things this removes, and one it replaces.
--
-- `students.reset_allowed` existed only to let a student register while the
-- registration window was shut. There is no window any more, so nothing reads
-- it: it had become write-only state.
--
-- `settings` was the enrollment flag and its deadline. Those are gone too, and
-- the only remaining key was failed-login throttling — which does not belong in
-- a key/value blob. Counting rows in a real table also removes a read-modify-
-- write race where two simultaneous failures could each overwrite the other's
-- count.
--
-- Safe to run more than once.

create table if not exists login_attempts (
  id     bigserial primary key,
  caller text        not null,   -- the requesting address, as the platform reports it
  at     timestamptz not null default now()
);

create index if not exists login_attempts_caller_at_idx on login_attempts (caller, at desc);
alter table login_attempts enable row level security;

alter table students drop column if exists reset_allowed;
drop table if exists settings;
