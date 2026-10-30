-- ============================================================================
-- project-tracking-fix-3.sql — Project Co contact phone number per project
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → Run (รันซ้ำได้ปลอดภัย)
-- ต้องรันก่อนช่อง "เบอร์ติดต่อ" ในหน้าแก้ไข Project Co จะบันทึกได้
-- (ถ้ายังไม่รัน หน้าเว็บยังใช้งานได้ปกติ แต่เบอร์จะไม่แสดงและบันทึกไม่ได้)
--
-- Adds one nullable text column to public.projects. Free text on purpose:
-- project_co may already list several coordinators ("แพรว, สมชาย"), so the phone
-- column may list several numbers in the same order ("081-111-1111, 089-222-2222").
-- No view is changed: the app reads this column straight from public.projects.
-- Existing RLS / grants on public.projects already cover a new column.
-- ============================================================================

begin;

alter table public.projects add column if not exists project_co_phone text;

comment on column public.projects.project_co_phone is
  'Contact phone number(s) of the Project Coordinator(s) in project_co (free text, same order, comma separated).';

commit;

-- ---------- Verify (optional, read-only) ----------
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'projects' and column_name = 'project_co_phone';
-- Undo: alter table public.projects drop column if exists project_co_phone;
