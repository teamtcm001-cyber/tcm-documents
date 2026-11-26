-- ============================================================================
-- PROJECT BILLING FLAG  (projects.has_installments: "this project has billing installments")
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   * งานทั้งหมดอยู่ในบล็อก DO เดียว (คำสั่งเดียว): สำเร็จทั้งหมด หรือไม่เปลี่ยนอะไรเลย
--     แม้ SQL Editor จะ commit คั่นระหว่างคำสั่งก็ตาม
--   * รันซ้ำได้ปลอดภัย (idempotent) และรันได้ระหว่างที่แอปเปิดใช้งานอยู่
--     (lock_timeout 5s: ถ้ามีคิวรียาวค้างอยู่จะยกเลิกเองแทนการรอ - รอสักครู่แล้วรันใหม่)
--   * ต้องรัน scripts/project-tracking.sql มาก่อน (ต้องมี view ของระบบติดตามโครงการ)
--   คู่มือภาษาไทย: scripts/PROJECT_BILLING_FLAG.md
--
-- WHY
--   Some projects (e.g. a "Hybrid" project) have NO billing installments (งวดเบิก Pre-con
--   etc.). Without a switch the tracking module showed them as "ยังไม่มีงวดงาน" / missing
--   data and the health rules / AI chat counted them as "no installment data".
--
-- WHAT THIS DOES (additive; existing data is not modified - the only row write is the
-- repair branch of step 1: if a has_installments column ALREADY existed as nullable, its
-- NULLs are set to true before NOT NULL is added)
--   0. Preflight: the live views must have the known column lists AND the known
--      definition (the original project-tracking.sql one, or this file's on a re-run);
--      their current definitions are printed as NOTICEs before anything is replaced.
--   1. public.projects.has_installments boolean NOT NULL DEFAULT true
--      (existing rows = true = behaviour unchanged). Added only when missing, so a re-run
--      takes no exclusive lock on projects.
--   1b. Guard trigger trg_projects_billing_flag_guard (BEFORE INSERT OR UPDATE OF
--      has_installments): a signed-in end user (auth.uid() not null) may CHANGE the flag
--      only if public.is_admin() or public.is_project_manager(project) (auth-04; without
--      auth-04: admins only). Otherwise:
--        ERROR 42501  message 'BILLING_FLAG_FORBIDDEN'
--        detail 'เฉพาะแอดมินหรือผู้ดูแลโครงการเท่านั้นที่เปิด/ปิดการตั้งค่าไม่มีงวดเบิกได้'
--      and the whole statement is rolled back (other columns in the same UPDATE too).
--      Sending the column with its CURRENT value is not a change and is allowed, so an
--      editor saving a full form still works. No JWT (SQL editor, service role): allowed.
--      Before auth-01 exists (no per-person roles) the trigger lets everything through.
--   2. Views (CREATE OR REPLACE: the new column is APPENDED as the LAST column, every
--      existing column keeps its name, type and position; owner, grants, comments and
--      security_invoker = on are preserved and re-stated):
--        project_progress_latest   + has_installments                 (last column)
--        installment_summary       + has_installments                 (last column;
--                                    informational only - its ROWS ARE NOT FILTERED)
--        project_tracking_overview + has_installments                 (last column)
--          when has_installments = false the installment-derived columns are
--            installments_total / _billed / _overdue / _returned       -> 0
--            next_installment_id / _no, next_status, next_planned_bill_date,
--            next_days_until_planned, next_docs_state,
--            next_required_docs_total / _attached                      -> NULL
--          so no installment rule (overdue / returned / next docs ...) can fire.
--          The installment rows stay in project_installments / installment_documents
--          and in installment_summary: the switch HIDES them, it never deletes.
--   3. Write permission: NO new policy. After auth-02 the projects UPDATE policy is
--        projects_update  USING / WITH CHECK  can_edit_project(id)
--      (admin, and project_members.role editor / manager); exec / viewer / non-members
--      update 0 rows (RLS hides the row; the trigger never fires). On top of that the
--      trigger of 1b refuses editors (decision: only admin / the project's manager).
--   4. Audit: public.tg_audit_generic() (auth-01) logs every projects column except a
--      fixed skip list (content_text, mom_*, timestamps, updated_by...). has_installments
--      is NOT in that list, so a flip writes one audit_log row
--      (action 'update', table 'projects', details {"has_installments":{"old":..,"new":..}}).
--   5. Self-checks (abort = nothing changed) and `notify pgrst, 'reload schema'` so the
--      API sees the new column at once.
--
-- The same definitions are folded into scripts/project-tracking.sql, so re-running that
-- file later keeps the column and the view columns.
--
-- ROLLBACK
--   Soft (recommended, instant, no DDL):  update public.projects set has_installments = true;
--     -> every project behaves exactly as before this file; the unused column is harmless.
--   Hard: scripts/project-billing-flag-rollback.sql (drops the guard trigger + function,
--     drops and re-creates the three views in their previous shape with the same grants,
--     then drops the column; the flag values are lost). The frontend must not send/read
--     has_installments any more after a hard rollback.
-- ============================================================================

-- Supabases SQL Editor may COMMIT between the statements of a pasted script (a
-- "begin; ... commit;" pair is then not one transaction). So everything that changes
-- the database runs inside ONE DO block = ONE statement: it succeeds completely or
-- changes nothing, however the editor sends it. Only the read-only result query follows.
do $bf$
declare
  x_rec    record;
  x_view   text;
  x_cols   text[];
  x_expect text[];
  x_live   text;
  x_old    text;
  x_pre    jsonb := '{}'::jsonb;   -- view name -> {def, state}
  x_type   text;
  x_null   text;
  x_def    text;
  x_cnt    bigint;
begin
  perform set_config('lock_timeout', '5s', true);   -- = set local lock_timeout


-- ----------------------------------------------------------------------------
-- 0. Preflight: the tracking views must exist and have the shape this file expects
--    (exactly the known columns, optionally already followed by has_installments).
--    A different live shape aborts here with a clear message instead of half-way.
-- ----------------------------------------------------------------------------
  if to_regclass('public.projects') is null then
    raise exception 'public.projects does not exist - wrong database?';
  end if;

  for x_rec in
    select * from (values
      ('project_progress_latest', array['project_id','project_code','project_name','project_status',
        'project_co','start_date','end_date','percent_complete','progress_as_of','progress_note',
        'progress_updated_by','progress_recorded_at','days_since_update','time_elapsed_pct','days_to_end']),
      ('installment_summary', array['installment_id','project_id','project_code','project_name',
        'installment_no','title','status','planned_bill_date','billed_date','note','status_note',
        'status_changed_at','days_in_status','updated_by','updated_at','is_open_to_bill','is_billed',
        'days_until_planned','is_overdue','required_docs_total','required_docs_attached',
        'required_docs_outdated','docs_state']),
      ('project_tracking_overview', array['project_id','project_code','project_name','project_status',
        'project_co','start_date','end_date','percent_complete','progress_as_of','progress_note',
        'progress_updated_by','days_since_update','time_elapsed_pct','days_to_end',
        'installments_total','installments_billed','installments_overdue','installments_returned',
        'next_installment_id','next_installment_no','next_status','next_planned_bill_date',
        'next_days_until_planned','next_docs_state','next_required_docs_total',
        'next_required_docs_attached'])
    ) as v(view_name, cols)
  loop
    if to_regclass('public.' || x_rec.view_name) is null then
      raise exception 'view public.% not found. Run scripts/project-tracking.sql first.', x_rec.view_name;
    end if;
    select array_agg(a.attname::text order by a.attnum) into x_cols
    from pg_attribute a
    where a.attrelid = ('public.' || x_rec.view_name)::regclass and a.attnum > 0 and not a.attisdropped;
    x_expect := x_rec.cols;
    if x_cols is distinct from x_expect and x_cols is distinct from x_expect || array['has_installments'] then
      raise exception E'view public.% has an unexpected column list - nothing was changed.\n  found:    %\n  expected: % [+ has_installments]',
        x_rec.view_name, x_cols, x_expect;
    end if;
  end loop;

-- 0b. Definitions. The current text of each view is saved and printed (NOTICE) before it is
--     replaced. It must equal EITHER the original project-tracking.sql definition (checked
--     here against temporary copies built from that text, bf_old_*) OR - on a re-run - this
--     file's own definition (checked in 2b, right after the replace; a mismatch aborts the
--     whole transaction). Anything else = a hand-edited live view: stop, change nothing.
  -- temporary copies of the ORIGINAL definitions (a session left over from an aborted run
  -- may still hold them, so drop first)
  drop view if exists pg_temp.bf_old_project_tracking_overview;
  drop view if exists pg_temp.bf_old_installment_summary;
  drop view if exists pg_temp.bf_old_project_progress_latest;

create temporary view bf_old_project_progress_latest as
select
  p.id as project_id, p.code as project_code, p.name as project_name, p.status as project_status,
  p.project_co, p.start_date, p.end_date,
  lp.percent_complete, lp.as_of as progress_as_of, lp.note as progress_note,
  lp.updated_by as progress_updated_by, lp.created_at as progress_recorded_at,
  (public.tcm_today() - lp.as_of) as days_since_update,
  case when p.start_date is not null and p.end_date is not null and p.end_date > p.start_date
       then least(100, greatest(0, round(
              100.0 * (public.tcm_today() - p.start_date) / (p.end_date - p.start_date)
            )))::int
  end as time_elapsed_pct,
  (p.end_date - public.tcm_today()) as days_to_end
from public.projects p
left join lateral (
  select u.percent_complete, u.as_of, u.note, u.updated_by, u.created_at
  from public.progress_updates u
  where u.project_id = p.id
  order by u.as_of desc, u.created_at desc
  limit 1
) lp on true;

create temporary view bf_old_installment_summary as
select
  i.id as installment_id, i.project_id, p.code as project_code, p.name as project_name,
  i.installment_no, i.title, i.status, i.planned_bill_date, i.billed_date, i.note, i.status_note,
  i.status_changed_at,
  (public.tcm_today() - (i.status_changed_at at time zone 'Asia/Bangkok')::date) as days_in_status,
  i.updated_by, i.updated_at,
  (i.status in ('planned','deliverable_done','ready_to_bill','returned')) as is_open_to_bill,
  (i.status in ('billed','under_review','approved','paid')) as is_billed,
  (i.planned_bill_date - public.tcm_today()) as days_until_planned,
  (i.status in ('planned','deliverable_done','ready_to_bill','returned')
   and i.planned_bill_date < public.tcm_today()) as is_overdue,
  coalesce(d.req_total, 0) as required_docs_total,
  coalesce(d.req_attached, 0) as required_docs_attached,
  coalesce(d.req_outdated, 0) as required_docs_outdated,
  case
    when coalesce(d.req_total, 0) = 0 then 'no_required_docs'
    when d.req_attached = d.req_total then 'ready'
    else 'missing'
  end as docs_state
from public.project_installments i
join public.projects p on p.id = i.project_id
left join lateral (
  select
    count(*) filter (where dd.required)::int as req_total,
    count(*) filter (where dd.required and dd.file_id is not null)::int as req_attached,
    count(*) filter (where dd.required and dd.file_id is not null
                       and f.is_latest = false)::int as req_outdated
  from public.installment_documents dd
  left join public.files f on f.id = dd.file_id
  where dd.installment_id = i.id
) d on true;

create temporary view bf_old_project_tracking_overview as
select
  pl.project_id, pl.project_code, pl.project_name, pl.project_status, pl.project_co,
  pl.start_date, pl.end_date, pl.percent_complete, pl.progress_as_of, pl.progress_note,
  pl.progress_updated_by, pl.days_since_update, pl.time_elapsed_pct, pl.days_to_end,
  coalesce(c.installments_total, 0) as installments_total,
  coalesce(c.installments_billed, 0) as installments_billed,
  coalesce(c.installments_overdue, 0) as installments_overdue,
  coalesce(c.installments_returned, 0) as installments_returned,
  n.installment_id as next_installment_id,
  n.installment_no as next_installment_no,
  n.status as next_status,
  n.planned_bill_date as next_planned_bill_date,
  n.days_until_planned as next_days_until_planned,
  n.docs_state as next_docs_state,
  n.required_docs_total as next_required_docs_total,
  n.required_docs_attached as next_required_docs_attached
from bf_old_project_progress_latest pl
left join lateral (
  select
    count(*) filter (where s.status <> 'cancelled')::int as installments_total,
    count(*) filter (where s.is_billed)::int as installments_billed,
    count(*) filter (where s.is_overdue)::int as installments_overdue,
    count(*) filter (where s.status = 'returned')::int as installments_returned
  from bf_old_installment_summary s
  where s.project_id = pl.project_id
) c on true
left join lateral (
  select s.installment_id, s.installment_no, s.status, s.planned_bill_date,
         s.days_until_planned, s.docs_state, s.required_docs_total, s.required_docs_attached
  from bf_old_installment_summary s
  where s.project_id = pl.project_id and s.is_open_to_bill
  order by s.planned_bill_date asc nulls last, s.installment_no asc
  limit 1
) n on true;

  foreach x_view in array array['project_progress_latest','installment_summary','project_tracking_overview']
  loop
    x_live := pg_get_viewdef(('public.' || x_view)::regclass, false);
    -- normalise: whitespace, and the bf_old_ prefix the temporary copies reference each other by
    x_old  := replace(pg_get_viewdef(('pg_temp.bf_old_' || x_view)::regclass, false), 'bf_old_', '');
    raise notice E'previous definition of public.% (kept here for the record):\n%', x_view, x_live;
    x_pre := x_pre || jsonb_build_object(x_view, jsonb_build_object(
               'def',   x_live,
               'state', case when regexp_replace(x_live, '\s+', ' ', 'g') = regexp_replace(x_old, '\s+', ' ', 'g')
                             then 'original' else 'must_equal_new' end));
  end loop;

  drop view pg_temp.bf_old_project_tracking_overview;
  drop view pg_temp.bf_old_installment_summary;
  drop view pg_temp.bf_old_project_progress_latest;

-- ----------------------------------------------------------------------------
-- 1. The switch  (same block as project-tracking.sql section 1)
-- ----------------------------------------------------------------------------
  select data_type, is_nullable, column_default into x_type, x_null, x_def
  from information_schema.columns
  where table_schema = 'public' and table_name = 'projects' and column_name = 'has_installments';
  if not found then
    -- PG11+: a constant default is metadata-only (no table rewrite); brief exclusive lock.
    alter table public.projects add column has_installments boolean not null default true;
    raise notice 'added public.projects.has_installments (all existing projects = true)';
  else
    if x_type <> 'boolean' then
      raise exception 'public.projects.has_installments exists with type % (expected boolean) - fix it by hand first', x_type;
    end if;
    if x_def is distinct from 'true' then
      alter table public.projects alter column has_installments set default true;
    end if;
    if x_null = 'YES' then
      update public.projects set has_installments = true where has_installments is null;
      alter table public.projects alter column has_installments set not null;
    end if;
  end if;

comment on column public.projects.has_installments is
  'true = the project bills in installments (งวดเบิก). false = no installments (e.g. Hybrid): '
  'project_tracking_overview shows no installment-derived values; installment rows are kept, only hidden.';

-- ----------------------------------------------------------------------------
-- 1b. Who may CHANGE the switch: admin, or the manager (Project Co) of that project.
--     (IDENTICAL to project-tracking.sql section 1b - keep the two in sync)
--     RLS (projects_update = can_edit_project) still decides which rows an UPDATE sees;
--     this BEFORE trigger additionally refuses editors. SECURITY DEFINER so the role
--     helpers are reachable whatever the caller's privileges; search_path pinned.
-- ----------------------------------------------------------------------------
create or replace function public.tg_projects_billing_flag_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean := false;
begin
  -- no end user (SQL editor, service role, migrations): unrestricted
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.has_installments is not distinct from old.has_installments then
      return new;                 -- sent with its current value (full-form save): not a change
    end if;
  elsif new.has_installments is not false then
    return new;                   -- INSERT with the default (true)
  end if;
  -- before the per-person login (auth-01) there are no roles to check
  if to_regprocedure('public.is_admin()') is null then
    return new;
  end if;
  v_ok := public.is_admin();
  -- auth-04 (project managers) not installed: admins only
  if not v_ok and to_regprocedure('public.is_project_manager(uuid)') is not null then
    v_ok := public.is_project_manager(new.id);
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'BILLING_FLAG_FORBIDDEN'
      using errcode = '42501',
            detail  = 'เฉพาะแอดมินหรือผู้ดูแลโครงการเท่านั้นที่เปิด/ปิดการตั้งค่าไม่มีงวดเบิกได้',
            hint    = 'Only an admin or the manager (Project Co) of this project may change projects.has_installments.';
  end if;
  return new;
end $$;

revoke all on function public.tg_projects_billing_flag_guard() from public, anon, authenticated;

-- (re)create the trigger only when missing or different, so a re-run takes no lock on projects
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.projects'::regclass
      and t.tgname = 'trg_projects_billing_flag_guard'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
      and t.tgfoid = 'public.tg_projects_billing_flag_guard()'::regprocedure
      and pg_get_triggerdef(t.oid) ~* 'BEFORE INSERT OR UPDATE OF has_installments ON public\.projects FOR EACH ROW'
  ) then
    drop trigger if exists trg_projects_billing_flag_guard on public.projects;
    create trigger trg_projects_billing_flag_guard
      before insert or update of has_installments on public.projects
      for each row execute function public.tg_projects_billing_flag_guard();
    raise notice 'created trigger trg_projects_billing_flag_guard on public.projects';
  end if;

-- ----------------------------------------------------------------------------
-- 2. Views  (IDENTICAL to project-tracking.sql section 8 - keep the two in sync)
-- ----------------------------------------------------------------------------
create or replace view public.project_progress_latest
with (security_invoker = on) as
select
  p.id                       as project_id,
  p.code                     as project_code,
  p.name                     as project_name,
  p.status                   as project_status,
  p.project_co,
  p.start_date,
  p.end_date,
  lp.percent_complete,                       -- null = never updated
  lp.as_of                   as progress_as_of,
  lp.note                    as progress_note,
  lp.updated_by              as progress_updated_by,
  lp.created_at              as progress_recorded_at,
  (public.tcm_today() - lp.as_of)            as days_since_update,   -- null = never; app flags > 14
  case when p.start_date is not null and p.end_date is not null and p.end_date > p.start_date
       then least(100, greatest(0, round(
              100.0 * (public.tcm_today() - p.start_date) / (p.end_date - p.start_date)
            )))::int
  end                                        as time_elapsed_pct,
  (p.end_date - public.tcm_today())          as days_to_end,         -- negative = past end date
  p.has_installments                         -- appended last (CREATE OR REPLACE may only add at the end)
from public.projects p
left join lateral (
  select u.percent_complete, u.as_of, u.note, u.updated_by, u.created_at
  from public.progress_updates u
  where u.project_id = p.id
  order by u.as_of desc, u.created_at desc
  limit 1
) lp on true;

create or replace view public.installment_summary
with (security_invoker = on) as
select
  i.id                        as installment_id,
  i.project_id,
  p.code                      as project_code,
  p.name                      as project_name,
  i.installment_no,
  i.title,
  i.status,
  i.planned_bill_date,
  i.billed_date,
  i.note,
  i.status_note,
  i.status_changed_at,
  (public.tcm_today() - (i.status_changed_at at time zone 'Asia/Bangkok')::date)
                              as days_in_status,          -- e.g. ready_to_bill > 7
  i.updated_by,
  i.updated_at,
  (i.status in ('planned','deliverable_done','ready_to_bill','returned'))
                              as is_open_to_bill,         -- still has to be (re)billed
  (i.status in ('billed','under_review','approved','paid'))
                              as is_billed,
  (i.planned_bill_date - public.tcm_today())
                              as days_until_planned,      -- negative = overdue
  (i.status in ('planned','deliverable_done','ready_to_bill','returned')
   and i.planned_bill_date < public.tcm_today())
                              as is_overdue,
  coalesce(d.req_total, 0)    as required_docs_total,
  coalesce(d.req_attached, 0) as required_docs_attached,
  coalesce(d.req_outdated, 0) as required_docs_outdated,  -- attached file has a newer version
  case
    when coalesce(d.req_total, 0) = 0           then 'no_required_docs'  -- checklist empty: NOT "ready"
    when d.req_attached = d.req_total           then 'ready'
    else                                             'missing'
  end                         as docs_state,
  p.has_installments                                      -- informational only: rows are NOT filtered
from public.project_installments i
join public.projects p on p.id = i.project_id
left join lateral (
  select
    count(*) filter (where dd.required)::int                                          as req_total,
    count(*) filter (where dd.required and dd.file_id is not null)::int               as req_attached,
    count(*) filter (where dd.required and dd.file_id is not null
                       and f.is_latest = false)::int                                  as req_outdated
  from public.installment_documents dd
  left join public.files f on f.id = dd.file_id
  where dd.installment_id = i.id
) d on true;

create or replace view public.project_tracking_overview
with (security_invoker = on) as
select
  pl.project_id,
  pl.project_code,
  pl.project_name,
  pl.project_status,
  pl.project_co,
  pl.start_date,
  pl.end_date,
  pl.percent_complete,
  pl.progress_as_of,
  pl.progress_note,
  pl.progress_updated_by,
  pl.days_since_update,
  pl.time_elapsed_pct,
  pl.days_to_end,
  coalesce(c.installments_total, 0)      as installments_total,      -- excludes cancelled
  coalesce(c.installments_billed, 0)     as installments_billed,     -- billed..paid
  coalesce(c.installments_overdue, 0)    as installments_overdue,
  coalesce(c.installments_returned, 0)   as installments_returned,
  n.installment_id                       as next_installment_id,     -- next one still to bill
  n.installment_no                       as next_installment_no,
  n.status                               as next_status,
  n.planned_bill_date                    as next_planned_bill_date,
  n.days_until_planned                   as next_days_until_planned,
  n.docs_state                           as next_docs_state,
  n.required_docs_total                  as next_required_docs_total,
  n.required_docs_attached               as next_required_docs_attached,
  pl.has_installments                                                -- appended last
from public.project_progress_latest pl
left join lateral (
  select
    count(*) filter (where s.status <> 'cancelled')::int  as installments_total,
    count(*) filter (where s.is_billed)::int              as installments_billed,
    count(*) filter (where s.is_overdue)::int             as installments_overdue,
    count(*) filter (where s.status = 'returned')::int    as installments_returned
  from public.installment_summary s
  where s.project_id = pl.project_id and pl.has_installments
) c on true
left join lateral (
  select s.installment_id, s.installment_no, s.status, s.planned_bill_date,
         s.days_until_planned, s.docs_state, s.required_docs_total, s.required_docs_attached
  from public.installment_summary s
  where s.project_id = pl.project_id and pl.has_installments and s.is_open_to_bill
  order by s.planned_bill_date asc nulls last, s.installment_no asc
  limit 1
) n on true;

-- grants: CREATE OR REPLACE keeps them; re-stated so a partially hand-edited DB converges.
-- (Same statements as project-tracking.sql section 9 and auth-02 section 5.)
alter view public.project_progress_latest   set (security_invoker = on);
alter view public.installment_summary       set (security_invoker = on);
alter view public.project_tracking_overview set (security_invoker = on);
revoke all on public.project_progress_latest, public.installment_summary,
              public.project_tracking_overview
  from public, anon;
grant select on public.project_progress_latest, public.installment_summary,
                public.project_tracking_overview
  to authenticated;

-- 2b. A view that did not match the ORIGINAL definition must have been this file's own
--     definition already (re-run): its text before and after the replace must be equal.
  for x_rec in select e.key as view_name, e.value->>'def' as def
               from jsonb_each(x_pre) e
               where e.value->>'state' = 'must_equal_new' order by e.key
  loop
    if regexp_replace(pg_get_viewdef(('public.' || x_rec.view_name)::regclass, false), '\s+', ' ', 'g')
       <> regexp_replace(x_rec.def, '\s+', ' ', 'g') then
      raise exception E'view public.% has an unexpected DEFINITION (neither the original project-tracking.sql one nor this file''s) - nothing was changed. Its current definition was printed as a NOTICE above; send it to the developer.',
        x_rec.view_name;
    end if;
  end loop;
  raise notice 'view definitions: %',
    (select string_agg(e.key || '=' || case e.value->>'state' when 'original' then 'original (replaced)' else 'already current' end, ', ' order by e.key)
     from jsonb_each(x_pre) e);

-- ----------------------------------------------------------------------------
-- 3. Self-checks  (any exception = the whole file is rolled back)
-- ----------------------------------------------------------------------------
  -- column shape
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'projects'
                   and column_name = 'has_installments' and data_type = 'boolean'
                   and is_nullable = 'NO' and column_default = 'true') then
    raise exception 'SELF-CHECK FAILED: projects.has_installments is not boolean NOT NULL DEFAULT true';
  end if;

  foreach x_view in array array['project_progress_latest','installment_summary','project_tracking_overview']
  loop
    -- has_installments is the LAST column
    if (select a.attname from pg_attribute a
         where a.attrelid = ('public.' || x_view)::regclass and a.attnum > 0 and not a.attisdropped
         order by a.attnum desc limit 1) is distinct from 'has_installments' then
      raise exception 'SELF-CHECK FAILED: public.% does not end with has_installments', x_view;
    end if;
    -- security_invoker still on (otherwise the view would bypass RLS)
    if not exists (select 1 from pg_class c, unnest(coalesce(c.reloptions, '{}')) o
                   where c.oid = ('public.' || x_view)::regclass
                     and o in ('security_invoker=on','security_invoker=true')) then
      raise exception 'SELF-CHECK FAILED: public.% is not security_invoker', x_view;
    end if;
    if has_table_privilege('anon', 'public.' || x_view, 'select') then
      raise exception 'SELF-CHECK FAILED: anon can read public.%', x_view;
    end if;
    if not has_table_privilege('authenticated', 'public.' || x_view, 'select') then
      raise exception 'SELF-CHECK FAILED: authenticated cannot read public.%', x_view;
    end if;
  end loop;

  -- a switched-off project never shows an installment-derived value (read-only check)
  select count(*) into x_cnt
  from public.project_tracking_overview o
  where not o.has_installments
    and (o.installments_total <> 0 or o.installments_billed <> 0 or o.installments_overdue <> 0
         or o.installments_returned <> 0 or o.next_installment_id is not null
         or o.next_installment_no is not null or o.next_status is not null
         or o.next_planned_bill_date is not null or o.next_days_until_planned is not null
         or o.next_docs_state is not null or o.next_required_docs_total is not null
         or o.next_required_docs_attached is not null);
  if x_cnt > 0 then
    raise exception 'SELF-CHECK FAILED: % switched-off project(s) still show installment values', x_cnt;
  end if;

  -- guard trigger present, enabled, SECURITY DEFINER with a pinned search_path, not callable
  if not exists (select 1 from pg_trigger t
                 where t.tgrelid = 'public.projects'::regclass and t.tgname = 'trg_projects_billing_flag_guard'
                   and t.tgenabled <> 'D' and t.tgfoid = 'public.tg_projects_billing_flag_guard()'::regprocedure) then
    raise exception 'SELF-CHECK FAILED: trigger trg_projects_billing_flag_guard missing or disabled';
  end if;
  if not exists (select 1 from pg_proc p
                 where p.oid = 'public.tg_projects_billing_flag_guard()'::regprocedure
                   and p.prosecdef and p.proconfig @> array['search_path=public']) then
    raise exception 'SELF-CHECK FAILED: tg_projects_billing_flag_guard() is not SECURITY DEFINER with search_path=public';
  end if;
  if has_function_privilege('anon', 'public.tg_projects_billing_flag_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_projects_billing_flag_guard()', 'execute') then
    raise exception 'SELF-CHECK FAILED: tg_projects_billing_flag_guard() is executable by API roles';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise notice 'billing flag guard: auth-01 not installed - no per-person roles yet, the switch is not restricted.';
  elsif to_regprocedure('public.is_project_manager(uuid)') is null then
    raise notice 'billing flag guard: auth-04 not installed - only ADMINS can change the switch until it is.';
  else
    raise notice 'billing flag guard: admins and project managers can change the switch; editors get 42501 BILLING_FLAG_FORBIDDEN.';
  end if;

  -- the column must be writable through the API by the roles that may edit projects
  if not has_column_privilege('authenticated', 'public.projects', 'has_installments', 'UPDATE') then
    raise warning 'authenticated has no UPDATE privilege on projects.has_installments - the app cannot save the switch. Re-run scripts/auth-02-enforce-rls.sql (it grants UPDATE on projects).';
  end if;

  -- informational: who may write it / is it audited
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'projects'
               and policyname = 'projects_update') then
    raise notice 'write access: policy projects_update (can_edit_project) decides the visible rows; the guard trigger then allows only admin / project manager to change has_installments.';
    -- older copies of project-tracking*.sql re-created "using (true)" policies when re-run
    -- after auth-02; report (never change) any such leftover so an admin can re-run auth-02
    for x_view in
      select format('%s.%s', tablename, policyname) from pg_policies
      where schemaname = 'public'
        and tablename in ('projects','files','activity','progress_updates','project_installments',
                          'installment_events','installment_documents','project_checklist_templates')
        and (   coalesce(qual, '')       ~* '^[\s(]*true[\s)]*$'
             or coalesce(with_check, '') ~* '^[\s(]*true[\s)]*$'
             or coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* 'auth\.role\(\)'
             or coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* 'auth\.uid\(\)[\s)]*(AS\s+\w+[\s)]*)?IS\s+NOT\s+NULL')
    loop
      raise warning 'policy % lets ANY signed-in account through (using true / auth.role() / auth.uid() is not null) although per-person RLS is installed. Re-run scripts/auth-02-enforce-rls.sql.', x_view;
    end loop;
  else
    raise notice 'auth-02 not detected: projects UPDATE follows the policies currently on public.projects.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.projects'::regclass
               and tgname = 'trg_audit_projects' and tgenabled <> 'D') then
    if (select prosrc from pg_proc where oid = 'public.tg_audit_generic()'::regprocedure) ~ 'has_installments' then
      raise warning 'tg_audit_generic() mentions has_installments (skip list?) - flips may not be audited.';
    else
      raise notice 'audit: trg_audit_projects is active; has_installments changes are logged in audit_log.';
    end if;
  else
    raise notice 'audit: trg_audit_projects not found (auth-01 not installed?) - flips are not audited.';
  end if;

  raise notice 'project-billing-flag self-check OK.';

  -- PostgREST: pick up the new column now (delivered at COMMIT)
  perform pg_notify('pgrst', 'reload schema');
end
$bf$;


-- ----------------------------------------------------------------------------
-- Result shown in the SQL editor (read-only): one row per project with the switch
-- ----------------------------------------------------------------------------
select project_code, has_installments, installments_total, next_installment_no
from public.project_tracking_overview
order by project_code;

-- ============================================================================
-- VERIFY (optional, read-only, run separately)
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'projects' and column_name = 'has_installments';
--   select relname, reloptions from pg_class
--   where oid in ('public.project_tracking_overview'::regclass, 'public.installment_summary'::regclass,
--                 'public.project_progress_latest'::regclass);
--   -- switch a project off / on (as admin in the app, or here in the SQL editor):
--   -- update public.projects set has_installments = false where code = 'XXX';
--   select * from public.audit_log where table_name = 'projects' order by at desc limit 5;
-- ============================================================================
