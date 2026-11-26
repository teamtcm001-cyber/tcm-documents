-- ============================================================================
-- ROLLBACK of scripts/project-billing-flag.sql  (HARD rollback - usually NOT needed)
-- ============================================================================
-- ทางเลือกที่แนะนำก่อน (soft rollback, ไม่มี DDL, ทันที):
--     update public.projects set has_installments = true;
--   ทุกโครงการจะกลับไปทำงานเหมือนก่อนรัน project-billing-flag.sql ทุกประการ
--
-- ใช้ไฟล์นี้เฉพาะเมื่อต้องการเอาคอลัมน์ออกจริงๆ:
--   Supabase Dashboard -> SQL Editor -> วางทั้งไฟล์ -> Run  (บล็อก DO เดียว = สำเร็จทั้งหมดหรือไม่เปลี่ยนอะไรเลย, รันซ้ำได้)
--   * ค่าสวิตช์ has_installments ของทุกโครงการจะหายไป (โครงการทั้งหมดกลับเป็น "มีงวดงาน")
--   * ต้อง deploy หน้าเว็บรุ่นที่ไม่อ่าน/ไม่ส่ง has_installments ก่อนหรือพร้อมกัน
--   * ห้ามรัน scripts/project-tracking.sql ฉบับปัจจุบันซ้ำหลังจากนี้ (มันจะเพิ่มคอลัมน์กลับมา)
--
-- WHAT IT DOES
--   0. drops the guard trigger trg_projects_billing_flag_guard and its function
--   1. saves the grants (ACL) and comments of the three tracking views
--   2. drops project_tracking_overview, installment_summary, project_progress_latest
--      (NO cascade: if anything else depends on them the file stops and nothing changes)
--   3. re-creates them exactly as before project-billing-flag.sql (security_invoker = on)
--   4. restores the saved grants and comments
--   5. drops public.projects.has_installments; notify pgrst
--   Installment rows are never touched.
-- ============================================================================

-- ONE DO block = ONE statement: atomic even when the SQL editor commits between statements.
do $bfrb$
declare
  x_saved jsonb;
  x_rec   record;
  g       record;
  v_owner oid;
begin
  perform set_config('lock_timeout', '5s', true);

  select coalesce(jsonb_agg(jsonb_build_object(
           'view_name', c.relname::text,
           'acl', coalesce(to_jsonb(c.relacl::text[]), '[]'::jsonb),   -- NULL = owner-only defaults
           'descr', obj_description(c.oid, 'pg_class'))), '[]'::jsonb)
    into x_saved
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relname in ('project_progress_latest','installment_summary','project_tracking_overview')
    and c.relkind = 'v';

  -- the guard trigger first (it references the column)
  drop trigger if exists trg_projects_billing_flag_guard on public.projects;
  drop function if exists public.tg_projects_billing_flag_guard();

  drop view if exists public.project_tracking_overview;
  drop view if exists public.installment_summary;
  drop view if exists public.project_progress_latest;

  create view public.project_progress_latest
  with (security_invoker = on) as
  select
    p.id                       as project_id,
    p.code                     as project_code,
    p.name                     as project_name,
    p.status                   as project_status,
    p.project_co,
    p.start_date,
    p.end_date,
    lp.percent_complete,
    lp.as_of                   as progress_as_of,
    lp.note                    as progress_note,
    lp.updated_by              as progress_updated_by,
    lp.created_at              as progress_recorded_at,
    (public.tcm_today() - lp.as_of)            as days_since_update,
    case when p.start_date is not null and p.end_date is not null and p.end_date > p.start_date
         then least(100, greatest(0, round(
                100.0 * (public.tcm_today() - p.start_date) / (p.end_date - p.start_date)
              )))::int
    end                                        as time_elapsed_pct,
    (p.end_date - public.tcm_today())          as days_to_end
  from public.projects p
  left join lateral (
    select u.percent_complete, u.as_of, u.note, u.updated_by, u.created_at
    from public.progress_updates u
    where u.project_id = p.id
    order by u.as_of desc, u.created_at desc
    limit 1
  ) lp on true;

  create view public.installment_summary
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
                                as days_in_status,
    i.updated_by,
    i.updated_at,
    (i.status in ('planned','deliverable_done','ready_to_bill','returned'))
                                as is_open_to_bill,
    (i.status in ('billed','under_review','approved','paid'))
                                as is_billed,
    (i.planned_bill_date - public.tcm_today())
                                as days_until_planned,
    (i.status in ('planned','deliverable_done','ready_to_bill','returned')
     and i.planned_bill_date < public.tcm_today())
                                as is_overdue,
    coalesce(d.req_total, 0)    as required_docs_total,
    coalesce(d.req_attached, 0) as required_docs_attached,
    coalesce(d.req_outdated, 0) as required_docs_outdated,
    case
      when coalesce(d.req_total, 0) = 0           then 'no_required_docs'
      when d.req_attached = d.req_total           then 'ready'
      else                                             'missing'
    end                         as docs_state
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

  create view public.project_tracking_overview
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
    coalesce(c.installments_total, 0)      as installments_total,
    coalesce(c.installments_billed, 0)     as installments_billed,
    coalesce(c.installments_overdue, 0)    as installments_overdue,
    coalesce(c.installments_returned, 0)   as installments_returned,
    n.installment_id                       as next_installment_id,
    n.installment_no                       as next_installment_no,
    n.status                               as next_status,
    n.planned_bill_date                    as next_planned_bill_date,
    n.days_until_planned                   as next_days_until_planned,
    n.docs_state                           as next_docs_state,
    n.required_docs_total                  as next_required_docs_total,
    n.required_docs_attached               as next_required_docs_attached
  from public.project_progress_latest pl
  left join lateral (
    select
      count(*) filter (where s.status <> 'cancelled')::int  as installments_total,
      count(*) filter (where s.is_billed)::int              as installments_billed,
      count(*) filter (where s.is_overdue)::int             as installments_overdue,
      count(*) filter (where s.status = 'returned')::int    as installments_returned
    from public.installment_summary s
    where s.project_id = pl.project_id
  ) c on true
  left join lateral (
    select s.installment_id, s.installment_no, s.status, s.planned_bill_date,
           s.days_until_planned, s.docs_state, s.required_docs_total, s.required_docs_attached
    from public.installment_summary s
    where s.project_id = pl.project_id and s.is_open_to_bill
    order by s.planned_bill_date asc nulls last, s.installment_no asc
    limit 1
  ) n on true;

  -- restore grants exactly as saved (first strip whatever default privileges the new views got)
  for x_rec in select c.oid, c.relname::text as relname, c.relowner, c.relacl
           from pg_class c
           where c.relnamespace = 'public'::regnamespace
             and c.relname in ('project_progress_latest','installment_summary','project_tracking_overview')
  loop
    for g in select distinct a.grantee from aclexplode(coalesce(x_rec.relacl, '{}'::aclitem[])) a
             where a.grantee <> x_rec.relowner
    loop
      execute format('revoke all on public.%I from %s', x_rec.relname,
                     case when g.grantee = 0 then 'public' else g.grantee::regrole::text end);
    end loop;
  end loop;

  for x_rec in select e->>'view_name' as view_name,
                      (select array_agg(t)::aclitem[] from jsonb_array_elements_text(e->'acl') t) as relacl,
                      e->>'descr' as descr
               from jsonb_array_elements(x_saved) e
  loop
    v_owner := (select relowner from pg_class where oid = ('public.' || x_rec.view_name)::regclass);
    for g in select a.grantee, a.privilege_type, a.is_grantable
             from aclexplode(coalesce(x_rec.relacl, '{}'::aclitem[])) a
             where a.grantee <> v_owner
    loop
      execute format('grant %s on public.%I to %s%s', g.privilege_type, x_rec.view_name,
                     case when g.grantee = 0 then 'public' else g.grantee::regrole::text end,
                     case when g.is_grantable then ' with grant option' else '' end);
    end loop;
    if x_rec.descr is not null then
      execute format('comment on view public.%I is %L', x_rec.view_name, x_rec.descr);
    end if;
  end loop;

  -- never leave the views readable by anon / unreadable by the app, whatever was saved
  revoke all on public.project_progress_latest, public.installment_summary,
                public.project_tracking_overview
    from public, anon;
  grant select on public.project_progress_latest, public.installment_summary,
                  public.project_tracking_overview
    to authenticated;

  alter table public.projects drop column if exists has_installments;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'projects' and column_name = 'has_installments') then
    raise exception 'ROLLBACK CHECK FAILED: column still present';
  end if;
  if to_regprocedure('public.tg_projects_billing_flag_guard()') is not null then
    raise exception 'ROLLBACK CHECK FAILED: guard function still present';
  end if;
  if exists (select 1 from pg_class c
             where c.oid in ('public.project_progress_latest'::regclass, 'public.installment_summary'::regclass,
                             'public.project_tracking_overview'::regclass)
               and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                               where o in ('security_invoker=on','security_invoker=true'))) then
    raise exception 'ROLLBACK CHECK FAILED: a tracking view is not security_invoker';
  end if;
  raise notice 'project-billing-flag rollback OK.';

  perform pg_notify('pgrst', 'reload schema');
end
$bfrb$;
