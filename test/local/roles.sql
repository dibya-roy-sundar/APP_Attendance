-- PostgREST needs these; Supabase provides them out of the box.
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;

do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;

grant anon, service_role to postgres;
grant usage on schema public to anon, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
