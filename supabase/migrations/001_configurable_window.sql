-- Run this against a database created before the QR rotation period was
-- configurable. Safe to run more than once.
alter table sessions add column if not exists window_seconds int not null default 15;

do $$ begin
  alter table sessions add constraint sessions_window_seconds_check
    check (window_seconds between 5 and 300);
exception when duplicate_object then null; end $$;
