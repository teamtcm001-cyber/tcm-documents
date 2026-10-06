-- ============================================================================
-- ROLLBACK for scripts/project-tracking.sql
-- วิธีรัน: Supabase Dashboard -> SQL Editor -> วางทั้งไฟล์ -> Run
--
-- !! DESTRUCTIVE !!  This permanently deletes ALL progress history, installments,
-- audit events, document checklists and templates created by the app, plus the
-- projects.start_date / end_date / project_co columns and their data.
-- Export first if you might need any of it (Table Editor -> Export CSV).
--
-- If projects.start_date / end_date / project_co already existed BEFORE the
-- migration was run, delete the last section ("projects columns") so you do
-- not drop pre-existing columns.
--
-- Only objects added by project-tracking.sql are touched. Safe to run twice.
-- ============================================================================

begin;

-- views first (they depend on the tables)
drop view if exists public.project_tracking_overview;
drop view if exists public.installment_summary;
drop view if exists public.project_progress_latest;

-- triggers go away with their tables; drop the functions afterwards
drop table if exists public.installment_events;
drop table if exists public.installment_documents;
drop table if exists public.project_checklist_templates;
drop table if exists public.project_installments;
drop table if exists public.progress_updates;

drop function if exists public.tg_installment_before_write();
drop function if exists public.tg_installment_log_event();
drop function if exists public.tg_installment_prefill_checklist();
drop function if exists public.tg_installment_document_before_write();
drop function if exists public.tcm_today();

-- projects columns
alter table public.projects drop constraint if exists projects_period_chk;
alter table public.projects drop column if exists start_date;
alter table public.projects drop column if exists end_date;
alter table public.projects drop column if exists project_co;

commit;
