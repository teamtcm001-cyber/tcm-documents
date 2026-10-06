-- ============================================================================
-- PROJECT TRACKING - FIX 1   (follow-up to scripts/project-tracking.sql)
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   รันซ้ำได้อย่างปลอดภัย (idempotent) และทั้งไฟล์อยู่ใน transaction เดียว
--   ถ้าผิดพลาดตรงไหน จะไม่มีอะไรถูกเปลี่ยนค้างครึ่งๆ กลางๆ
--   ต้องรัน scripts/project-tracking.sql มาก่อนแล้ว (รันไปแล้ว)
--   ไม่ได้แก้ไฟล์ project-tracking.sql เดิม - ไฟล์นี้เป็น migration ใหม่ต่อท้าย
--
-- WHAT THIS FIXES
--   1. Audit note dropped: tg_installment_before_write() used to NULL
--      status_note when it equalled the previous row's note, so repeating the
--      same comment on two transitions logged the 2nd event with note = NULL.
--      Now a real status change keeps exactly what the UPDATE supplied.
--   2. Date sanity: CHECK constraints (2000-01-01 .. 2100-12-31) on
--      project_installments.planned_bill_date / billed_date and
--      projects.start_date / end_date. A Buddhist-year typo (2569) now fails.
--   3. Future as_of: BEFORE INSERT trigger on progress_updates rejects
--      as_of > public.tcm_today() (Thailand date).
--
-- CONTRACT for status_note (read this)
--   Whoever changes `status` MUST send `status_note` in the SAME UPDATE.
--   Send NULL or '' to mean "no comment" (the DB stores NULL for '').
--   The trigger cannot tell "column omitted" from "column sent with the same
--   value", so an UPDATE that changes status WITHOUT status_note would re-log
--   the previous comment. The app (setInstallmentStatus) always sends it.
--   Manual edits in the SQL editor: write `set status = '...', status_note = null`.
--   When status does NOT change, the trigger does not touch status_note.
--
-- UNDO (forward-only is preferred; these are notes if you must revert)
--   -- Section 1: re-create the old function body (below) with CREATE OR REPLACE:
--   --     ...inside `if new.status is distinct from old.status then` after
--   --     `new.status_changed_at := now();` add:
--   --       if new.status_note is not distinct from old.status_note then
--   --         new.status_note := null;
--   --       end if;
--   --     and remove the two `new.status_note := nullif(btrim(...), '')` lines.
--   --   (Restores the old, buggy behaviour; not recommended.)
--   -- Section 2:
--   --   alter table public.project_installments
--   --     drop constraint if exists project_installments_planned_bill_date_range_chk,
--   --     drop constraint if exists project_installments_billed_date_range_chk;
--   --   alter table public.projects
--   --     drop constraint if exists projects_start_date_range_chk,
--   --     drop constraint if exists projects_end_date_range_chk;
--   -- Section 3:
--   --   drop trigger  if exists trg_progress_no_future_asof on public.progress_updates;
--   --   drop function if exists public.tg_progress_no_future_asof();
--   -- Existing audit events are never modified by this file.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Audit note: keep the note the caller supplied on a status change
--    Trigger chain on project_installments (verified from project-tracking.sql;
--    the live DB itself was not inspected):
--      BEFORE INSERT/UPDATE  trg_installment_before_write   <- redefined here
--      AFTER  INSERT         trg_installment_prefill_checklist (no status_note)
--      AFTER  INSERT/UPDATE OF status  trg_installment_log_event
--                            reads NEW.status_note, i.e. the value left by the
--                            BEFORE trigger. Unchanged: it already does the
--                            right thing once the clearing is gone.
--    No other trigger touches status_note. CREATE OR REPLACE keeps the existing
--    trigger binding, grants and ownership.
-- ----------------------------------------------------------------------------
create or replace function public.tg_installment_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_by_uid := auth.uid();
  if tg_op = 'INSERT' then
    new.status_changed_at := now();
    new.status_note := nullif(btrim(new.status_note), '');
  else
    new.updated_at := now();
    if new.status is distinct from old.status then
      new.status_changed_at := now();
      -- Contract: the caller sends status_note on every status change.
      -- Keep it as given (even if identical to the previous one); '' -> NULL.
      new.status_note := nullif(btrim(new.status_note), '');
    end if;
    -- status unchanged: status_note (and everything else) is left alone
  end if;
  return new;
end $$;

-- CREATE OR REPLACE preserves privileges; repeated only so a fresh DB is safe.
revoke all on function public.tg_installment_before_write() from public, anon;

comment on column public.project_installments.status_note is
  'Comment for the LATEST status change; the AFTER trigger copies it into installment_events. '
  'Contract: send it in the same UPDATE as every status change (NULL/empty = no comment). '
  'It is kept as given, even if identical to the previous note. Not touched when status is unchanged.';

-- ----------------------------------------------------------------------------
-- 2. Date sanity CHECKs (2000-01-01 .. 2100-12-31, NULL allowed)
--    For each column: add the constraint NOT VALID (instant; enforced for all
--    new writes), then try to VALIDATE it. If an existing row violates it, the
--    migration does NOT abort: a WARNING is raised and the constraint stays
--    NOT VALID (still enforced on new/updated rows). Re-run after fixing the
--    rows to finish validation.
--    - project_installments: brand-new table, expected to pass immediately.
--    - projects: pre-existing table, but start_date/end_date were added by
--      project-tracking.sql (ADD COLUMN IF NOT EXISTS) so they are expected to
--      be all NULL -> validation passes trivially. If those columns happened to
--      exist before with bad data, you get the WARNING instead of a failure.
--      Caveat: a NOT VALID constraint is still checked when a bad row is
--      UPDATEd for any reason, so such a row must be corrected first.
--    Constraint names end in _range_chk (client can match on that).
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('project_installments', 'project_installments_planned_bill_date_range_chk', 'planned_bill_date'),
      ('project_installments', 'project_installments_billed_date_range_chk',       'billed_date'),
      ('projects',             'projects_start_date_range_chk',                    'start_date'),
      ('projects',             'projects_end_date_range_chk',                      'end_date')
    ) as v(tbl, cname, col)
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = r.cname
        and conrelid = format('public.%I', r.tbl)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I '
        'check (%I is null or %I between date ''2000-01-01'' and date ''2100-12-31'') not valid',
        r.tbl, r.cname, r.col, r.col);
    end if;

    if exists (
      select 1 from pg_constraint
      where conname = r.cname
        and conrelid = format('public.%I', r.tbl)::regclass
        and not convalidated
    ) then
      begin
        execute format('alter table public.%I validate constraint %I', r.tbl, r.cname);
      exception when check_violation then
        raise warning 'Constraint % on public.% left NOT VALID: existing rows have % outside 2000-01-01..2100-12-31. Fix them (e.g. Buddhist year typo) and re-run this file.',
          r.cname, r.tbl, r.col;
      end;
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. progress_updates.as_of must not be in the future (Thailand date)
--    CHECK cannot do this (now() is not immutable), hence a trigger. INSERT
--    only: the table is append-only, so there is no UPDATE path to guard.
--    public.tcm_today() exists (project-tracking.sql section 0), is STABLE,
--    and authenticated has EXECUTE on it. Trigger is SECURITY INVOKER.
--    errcode = check_violation (23514) so the client's existing 23514 branch
--    handles it; message is short Thai + English.
-- ----------------------------------------------------------------------------
create or replace function public.tg_progress_no_future_asof()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.as_of > public.tcm_today() then
    raise exception 'as_of % is in the future (today in Thailand: %) / วันที่ข้อมูลต้องไม่เกินวันนี้',
      new.as_of, public.tcm_today()
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_progress_no_future_asof on public.progress_updates;
create trigger trg_progress_no_future_asof
  before insert on public.progress_updates
  for each row execute function public.tg_progress_no_future_asof();

revoke all on function public.tg_progress_no_future_asof() from public, anon;

commit;

-- ============================================================================
-- OPTIONAL CHECKS - run SEPARATELY, after the migration. Each block ends with
-- ROLLBACK so nothing is left behind. They use an existing project row and the
-- SQL editor's postgres role (RLS bypassed; auth.uid() is NULL there - fine).
-- Uncomment one block at a time. A "PASS" notice = OK; an error = problem.
-- ============================================================================
--
-- (a) Which triggers exist on project_installments? Expect exactly 3:
--     trg_installment_before_write, trg_installment_log_event,
--     trg_installment_prefill_checklist
--   select tgname from pg_trigger
--   where tgrelid = 'public.project_installments'::regclass and not tgisinternal
--   order by tgname;
--
-- (b) Duplicate note is kept on two transitions; unchanged status leaves note alone
--   begin;
--   do $$
--   declare pid uuid; iid uuid; n int; sn text;
--   begin
--     select id into pid from public.projects limit 1;
--     if pid is null then raise exception 'no project row to test with'; end if;
--     insert into public.project_installments (project_id, installment_no, updated_by)
--       values (pid, 999999, 'fix1-test') returning id into iid;
--     update public.project_installments
--       set status = 'ready_to_bill', status_note = 'same', updated_by = 'fix1-test' where id = iid;
--     update public.project_installments
--       set status = 'billed', status_note = 'same', updated_by = 'fix1-test' where id = iid;
--     select count(*) into n from public.installment_events
--       where installment_id = iid and note = 'same';
--     if n <> 2 then raise exception 'FAIL: expected 2 events with note "same", got %', n; end if;
--     update public.project_installments
--       set note = 'unrelated edit', updated_by = 'fix1-test' where id = iid;
--     select status_note into sn from public.project_installments where id = iid;
--     if sn is distinct from 'same' then raise exception 'FAIL: status_note changed without status change'; end if;
--     update public.project_installments
--       set status = 'approved', status_note = '', updated_by = 'fix1-test' where id = iid;
--     select count(*) into n from public.installment_events
--       where installment_id = iid and to_status = 'approved' and note is null;
--     if n <> 1 then raise exception 'FAIL: empty note should be logged as NULL'; end if;
--     raise notice 'PASS (b)';
--   end $$;
--   rollback;
--
-- (c) Date guard: 2569 must be rejected (expect: PASS notice, not an error)
--   begin;
--   do $$
--   declare pid uuid;
--   begin
--     select id into pid from public.projects limit 1;
--     begin
--       insert into public.project_installments (project_id, installment_no, updated_by, planned_bill_date)
--         values (pid, 999998, 'fix1-test', date '2569-01-31');
--       raise exception 'FAIL: 2569 was accepted';
--     exception when check_violation then
--       raise notice 'PASS (c) %', sqlerrm;
--     end;
--   end $$;
--   rollback;
--
-- (d) Future as_of is rejected, today is accepted
--   begin;
--   do $$
--   declare pid uuid;
--   begin
--     select id into pid from public.projects limit 1;
--     insert into public.progress_updates (project_id, percent_complete, as_of, updated_by)
--       values (pid, 1, public.tcm_today(), 'fix1-test');          -- must work
--     begin
--       insert into public.progress_updates (project_id, percent_complete, as_of, updated_by)
--         values (pid, 1, public.tcm_today() + 1, 'fix1-test');    -- must fail
--       raise exception 'FAIL: future as_of was accepted';
--     exception when check_violation then
--       raise notice 'PASS (d) %', sqlerrm;
--     end;
--   end $$;
--   rollback;
--
-- (e) Any constraint left NOT VALID by section 2? Expect zero rows.
--   select conrelid::regclass, conname from pg_constraint
--   where conname like '%\_range\_chk' and not convalidated;
-- ============================================================================
