-- ============================================================================
-- project-tracking-fix-2.sql
--   1) stop recording WHO changed tracking data
--   2) stop keeping installment status history
--   3) allow deleting installments and editing / deleting progress entries
--
-- วิธีรัน: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → Run (รันซ้ำได้ปลอดภัย)
-- ทำงานเป็นธุรกรรมเดียว ถ้าพลาดจะไม่เหลือค้างครึ่งๆ กลางๆ
--
-- ต้องรันไฟล์นี้ก่อนปุ่ม "ลบงวด" และ "แก้ไข/ลบรายการ %" จะใช้งานได้
-- (ถ้ายังไม่รัน ปุ่มเหล่านั้นจะแจ้งข้อความว่าให้รันไฟล์นี้ ส่วนฟีเจอร์อื่นใช้ได้ปกติ)
--
-- Product decisions behind this file:
--   * no person's name is recorded for tracking changes (app sends NULL / '-')
--   * no status history: the log trigger is dropped, the history UI is gone
--   * installments can be removed outright (their checklist rows cascade);
--     progress entries can be corrected or deleted
-- The shared account has no per-person identity, so none of this weakens
-- anything that was enforceable before.
-- ============================================================================

begin;

-- ---------- A. progress_updates.updated_by may be NULL ----------
alter table public.progress_updates alter column updated_by drop not null;
alter table public.progress_updates drop constraint if exists progress_updates_updated_by_chk;

-- ---------- B. no more status history ----------
-- Without the trigger no installment_events rows are written any more.
drop trigger if exists trg_installment_log_event on public.project_installments;
-- (the table and function are left in place; the app no longer reads them.
--  To also erase history already recorded, run section D below.)

-- ---------- C. wipe recorder names already stored ----------
update public.progress_updates      set updated_by  = null where updated_by  is not null;
update public.project_installments  set updated_by  = null where updated_by  is not null;
update public.installment_events    set actor_name  = null where actor_name  is not null;
update public.installment_documents set attached_by = null where attached_by is not null;

-- ---------- E. delete / edit permissions ----------
-- Deleting an installment cascades to installment_documents and installment_events
-- (foreign keys are ON DELETE CASCADE; referential actions bypass RLS).
grant delete on public.project_installments to authenticated;
drop policy if exists "Authenticated can delete installments" on public.project_installments;
create policy "Authenticated can delete installments"
  on public.project_installments for delete to authenticated using (true);

grant update, delete on public.progress_updates to authenticated;
drop policy if exists "Authenticated can update progress" on public.progress_updates;
create policy "Authenticated can update progress"
  on public.progress_updates for update to authenticated using (true) with check (true);
drop policy if exists "Authenticated can delete progress" on public.progress_updates;
create policy "Authenticated can delete progress"
  on public.progress_updates for delete to authenticated using (true);

-- The "as_of may not be in the future" guard (fix-1) only ran on INSERT; run it on
-- UPDATE of as_of too so an edit cannot sneak a future date in.
drop trigger if exists trg_progress_no_future_asof_upd on public.progress_updates;
create trigger trg_progress_no_future_asof_upd
  before update of as_of on public.progress_updates
  for each row execute function public.tg_progress_no_future_asof();

commit;

-- ---------- D. OPTIONAL: erase status history that already exists ----------
-- delete from public.installment_events;

-- ---------- F. OPTIONAL: also anonymise uploader / activity names ----------
-- (files.uploader_name feeds the "โดย ..." label and the AI chat uploader search;
--  activity.user_name feeds the project timeline.)
-- update public.files    set uploader_name = null where uploader_name is not null;
-- update public.activity set user_name     = null where user_name     is not null;

-- ---------- Verify (optional, read-only) ----------
-- select polname, polcmd from pg_policy where polrelid in
--   ('public.project_installments'::regclass, 'public.progress_updates'::regclass);
-- select tgname from pg_trigger where tgrelid='public.project_installments'::regclass and not tgisinternal;
--   -- expect no trg_installment_log_event
