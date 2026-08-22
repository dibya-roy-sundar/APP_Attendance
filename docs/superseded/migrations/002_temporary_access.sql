-- Temporary admin access, and an actor column so the log can say who acted.
-- Safe to run more than once.

create table if not exists admin_grants (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,              -- who it was issued to, in words
  code_hash    text not null,              -- sha256 of the code; the code itself is shown once
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists admin_grants_code_hash_idx on admin_grants (code_hash);
create index if not exists admin_grants_expires_idx on admin_grants (expires_at desc);

alter table admin_grants enable row level security;

-- Who performed an audited action: 'primary', or 'deputy:<label>'.
alter table audit_log add column if not exists actor text;
