-- Destructive. Drops every table, then rebuilds from schema.sql.
--
-- This exists because the app has never carried real attendance: the roster is
-- regenerated from "Soft Skills.xlsx" by `npm run seed`, and nothing else in
-- here is worth preserving. That is what makes a clean rebuild cheaper and
-- safer than a migration chain.
--
-- Run this ONLY while that remains true. Once a term's attendance is real, the
-- .xlsx export is the only copy of it — export first, and prefer an
-- `alter table` you have thought about to this file.
--
--   1. run this
--   2. run schema.sql
--   3. npm run seed
--
-- Order matters: children first, or the foreign keys refuse.

drop table if exists webauthn_challenges cascade;
drop table if exists student_credentials  cascade;
drop table if exists attendance          cascade;
drop table if exists audit_log           cascade;
drop table if exists login_attempts      cascade;
drop table if exists admin_grants        cascade;
drop table if exists sessions            cascade;
drop table if exists students            cascade;
