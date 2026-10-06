-- ============================================================================
-- PROJECT TRACKING  (% Complete + billing installments + document checklist)
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   รันซ้ำได้อย่างปลอดภัย (idempotent) และทั้งไฟล์อยู่ใน transaction เดียว
--   ถ้าผิดพลาดตรงไหน จะไม่มีอะไรถูกสร้างค้างครึ่งๆ กลางๆ
--   ย้อนกลับด้วย scripts/project-tracking-rollback.sql
--
-- WHAT THIS ADDS (nothing existing is dropped or rewritten)
--   projects            + start_date, end_date, project_co            (columns)
--   progress_updates      append-only % complete log
--   project_installments  billing installments (NO money amounts, by decision)
--   installment_events    append-only audit log, written by a trigger
--   installment_documents per-installment document checklist (file_id or missing)
--   project_checklist_templates  per-project default checklist, auto-copied
--   views: project_progress_latest, installment_summary, project_tracking_overview
--
-- !! SECURITY LIMITATION - READ THIS !!
--   The app has no per-person login. Every user shares ONE Supabase account
--   (role `authenticated`) and identifies only by a self-typed display name
--   (localStorage `tcm_local_display_name`). Therefore:
--     * "A Project Co edits only their own project" is a CONVENTION. The
--       database cannot enforce it: any authenticated session can read/write
--       every project's rows through the API.
--     * `updated_by` / `actor_name` / `project_co` are self-reported text.
--       They are good for attribution, not proof of identity.
--   RLS below matches the other tables (authenticated = full app access,
--   anon = nothing). It still blocks the anon key and gives append-only
--   behaviour on the two log tables.
--
-- FUTURE PER-USER AUTH (no schema rewrite needed)
--   Every child table carries project_id directly, so a policy is a single
--   non-joined check, e.g. for project_installments:
--     create policy "members edit installments" on public.project_installments
--       for update to authenticated
--       using (exists (select 1 from public.project_members m
--                      where m.project_id = project_installments.project_id
--                        and m.user_id = (select auth.uid())
--                        and m.role in ('owner','manager','editor')))
--       with check (<same expression>);
--   The *_uid columns (created_by_uid / updated_by_uid / actor_uid) are
--   filled from auth.uid() automatically. Today they hold the same shared
--   uid for everyone; once real accounts exist they identify the person.
--
-- CONVENTIONS
--   * uuid ids via gen_random_uuid() (built in; no extension needed).
--     Existing tables use uuid_generate_v4(); both produce v4 uuids.
--   * New timestamps are timestamptz (existing tables use plain TIMESTAMP).
--   * "Today" is Thailand's date: public.tcm_today(). Supabase runs in UTC,
--     so current_date would be wrong between 00:00 and 07:00 Thai time.
--   * Requires Postgres 15+ (security_invoker views). Supabase default.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Helper: today's date in Thailand
-- ----------------------------------------------------------------------------
create or replace function public.tcm_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

revoke all on function public.tcm_today() from public, anon;
grant execute on function public.tcm_today() to authenticated;

-- ----------------------------------------------------------------------------
-- 1. projects: contract period + responsible coordinator
--    (SQL_SCHEMA.sql has none of these and no code references them; the live
--    DB was not inspected. IF NOT EXISTS makes this a no-op if they exist.)
-- ----------------------------------------------------------------------------
alter table public.projects add column if not exists start_date date;
alter table public.projects add column if not exists end_date   date;
alter table public.projects add column if not exists project_co text;

comment on column public.projects.project_co is
  'Responsible Project Coordinator display name (self-reported text, not a user reference).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_period_chk'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_period_chk
      check (start_date is null or end_date is null or end_date >= start_date);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. progress_updates  (append-only % complete log; latest row = current)
--    Corrections are made by inserting a new row, never by editing/deleting.
--    "Latest" = highest as_of, ties broken by created_at, so a back-dated
--    entry never overrides a newer reading.
-- ----------------------------------------------------------------------------
create table if not exists public.progress_updates (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  percent_complete integer not null,
  as_of            date not null default public.tcm_today(),
  note             text,
  updated_by       text not null,                 -- display name (self-reported)
  created_by_uid   uuid default auth.uid(),       -- shared uid today; see header
  created_at       timestamptz not null default now(),
  constraint progress_updates_percent_chk check (percent_complete between 0 and 100),
  constraint progress_updates_updated_by_chk check (length(btrim(updated_by)) > 0)
);

-- serves "latest row per project" and the trend line (project_id, as_of)
create index if not exists idx_progress_updates_project_asof
  on public.progress_updates (project_id, as_of desc, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. project_installments  (งวดงาน / งวดเบิก - status and dates only)
--    status is TEXT + CHECK rather than a PG enum: adding/renaming a value is
--    a one-line constraint swap, whereas enum values cannot be removed or
--    reordered and ALTER TYPE ADD VALUE has transaction restrictions.
--    Transitions are deliberately NOT restricted (real billing jumps around;
--    the audit log records whatever happened).
-- ----------------------------------------------------------------------------
create table if not exists public.project_installments (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  installment_no    integer not null,
  title             text,
  planned_bill_date date,
  status            text not null default 'planned',
  billed_date       date,
  note              text,           -- general remarks
  status_note       text,           -- comment for the LATEST status change; the
                                    -- trigger copies it into installment_events
                                    -- and clears it if the status changes
                                    -- without a fresh comment
  status_changed_at timestamptz not null default now(),   -- trigger-maintained
  updated_by        text,           -- display name; app MUST set on every write
  updated_by_uid    uuid,           -- trigger-maintained from auth.uid()
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint project_installments_no_chk check (installment_no > 0),
  constraint project_installments_status_chk check (status in (
    'planned',           -- วางแผนไว้
    'deliverable_done',  -- ส่งมอบงานแล้ว
    'ready_to_bill',     -- พร้อมเบิก
    'billed',            -- เบิกแล้ว
    'under_review',      -- ผู้ว่าจ้างกำลังตรวจ
    'approved',          -- อนุมัติแล้ว
    'paid',              -- ได้รับชำระแล้ว
    'returned',          -- ตีกลับ
    'cancelled'          -- ยกเลิก
  )),
  constraint project_installments_unique_no unique (project_id, installment_no),
  -- target for composite FKs: lets child tables carry project_id AND have the
  -- database guarantee it matches the installment's project
  constraint project_installments_id_project_uq unique (id, project_id)
);

-- overdue/upcoming widgets; partial so it only covers rows still waiting to bill
create index if not exists idx_project_installments_open_planned
  on public.project_installments (planned_bill_date)
  where status in ('planned','deliverable_done','ready_to_bill','returned');

-- ----------------------------------------------------------------------------
-- 4. installment_events  (append-only audit log, written by trigger)
--    No CHECK on from/to_status on purpose: history must survive any future
--    change to the status vocabulary.
-- ----------------------------------------------------------------------------
create table if not exists public.installment_events (
  id             uuid primary key default gen_random_uuid(),
  installment_id uuid not null,
  project_id     uuid not null,
  from_status    text,                       -- null = creation event
  to_status      text not null,
  note           text,
  actor_name     text,                       -- copied from installments.updated_by
  actor_uid      uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  constraint installment_events_installment_fk
    foreign key (installment_id, project_id)
    references public.project_installments (id, project_id) on delete cascade
);

create index if not exists idx_installment_events_installment
  on public.installment_events (installment_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 5. installment_documents  (checklist: each item linked to a file or missing)
--    files.id is uuid per SQL_SCHEMA.sql (live type not verified).
--    NOTE: a new upload creates a NEW files row (old one gets is_latest=false),
--    so file_id keeps pointing at the version that was attached. The summary
--    view exposes required_docs_outdated to show when a newer version exists.
-- ----------------------------------------------------------------------------
create table if not exists public.installment_documents (
  id             uuid primary key default gen_random_uuid(),
  installment_id uuid not null,
  project_id     uuid not null,
  label          text not null,                -- e.g. 'ใบส่งมอบงาน'
  required       boolean not null default true,
  sort_order     integer not null default 0,
  file_id        uuid references public.files(id) on delete set null,
  attached_by    text,                         -- display name; app sets with file_id
  attached_at    timestamptz,                  -- trigger-maintained
  created_at     timestamptz not null default now(),
  constraint installment_documents_installment_fk
    foreign key (installment_id, project_id)
    references public.project_installments (id, project_id) on delete cascade,
  constraint installment_documents_label_chk check (length(btrim(label)) > 0),
  constraint installment_documents_unique_label unique (installment_id, label)
);

-- needed so deleting a file (ON DELETE SET NULL) does not seq-scan this table
create index if not exists idx_installment_documents_file
  on public.installment_documents (file_id) where file_id is not null;

-- ----------------------------------------------------------------------------
-- 6. project_checklist_templates  (per-project default checklist)
--    Rows are copied into installment_documents when an installment is
--    created. Per-project only; no company-wide fallback (skipped to keep the
--    model small - the app can copy rows between projects if wanted).
-- ----------------------------------------------------------------------------
create table if not exists public.project_checklist_templates (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label      text not null,
  required   boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint project_checklist_templates_label_chk check (length(btrim(label)) > 0),
  constraint project_checklist_templates_unique_label unique (project_id, label)
);

-- ----------------------------------------------------------------------------
-- 7. Triggers  (all SECURITY INVOKER; search_path pinned; names schema-qualified)
--    They run with the caller's rights, so they rely on the INSERT policies
--    below. Switching to SECURITY DEFINER later would make the audit log
--    unforgeable via the API - if you do, keep `set search_path = public`.
-- ----------------------------------------------------------------------------

-- 7a. BEFORE: timestamps, uid, stale status_note handling
create or replace function public.tg_installment_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_by_uid := auth.uid();
  if tg_op = 'INSERT' then
    new.status_changed_at := now();
  else
    new.updated_at := now();
    if new.status is distinct from old.status then
      new.status_changed_at := now();
      -- a note left over from the previous transition must not be re-logged
      if new.status_note is not distinct from old.status_note then
        new.status_note := null;
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_installment_before_write on public.project_installments;
create trigger trg_installment_before_write
  before insert or update on public.project_installments
  for each row execute function public.tg_installment_before_write();

-- 7b. AFTER: write the audit event (creation + every real status change)
create or replace function public.tg_installment_log_event()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.installment_events
      (installment_id, project_id, from_status, to_status, note, actor_name)
    values
      (new.id, new.project_id, null, new.status, new.status_note, new.updated_by);
  elsif new.status is distinct from old.status then
    insert into public.installment_events
      (installment_id, project_id, from_status, to_status, note, actor_name)
    values
      (new.id, new.project_id, old.status, new.status, new.status_note, new.updated_by);
  end if;
  return null;
end $$;

drop trigger if exists trg_installment_log_event on public.project_installments;
create trigger trg_installment_log_event
  after insert or update of status on public.project_installments
  for each row execute function public.tg_installment_log_event();

-- 7c. AFTER INSERT: pre-fill the checklist from the project's template
create or replace function public.tg_installment_prefill_checklist()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.installment_documents
    (installment_id, project_id, label, required, sort_order)
  select new.id, new.project_id, t.label, t.required, t.sort_order
  from public.project_checklist_templates t
  where t.project_id = new.project_id
  on conflict (installment_id, label) do nothing;
  return null;
end $$;

drop trigger if exists trg_installment_prefill_checklist on public.project_installments;
create trigger trg_installment_prefill_checklist
  after insert on public.project_installments
  for each row execute function public.tg_installment_prefill_checklist();

-- 7d. BEFORE: a linked file must belong to the same project; maintain attached_at
create or replace function public.tg_installment_document_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  file_changed boolean;
begin
  -- OLD does not exist on INSERT, so never reference it in the same
  -- expression as the tg_op test (OR is not guaranteed to short-circuit).
  if tg_op = 'INSERT' then
    file_changed := new.file_id is not null;
  else
    file_changed := new.file_id is distinct from old.file_id;
  end if;

  if file_changed then
    if new.file_id is not null and not exists (
      select 1 from public.files f
      where f.id = new.file_id and f.project_id = new.project_id
    ) then
      raise exception 'File % does not belong to project % (ไฟล์ไม่ได้อยู่ในโครงการเดียวกับงวดงานนี้)',
        new.file_id, new.project_id
        using errcode = 'check_violation';
    end if;

    if new.file_id is null then
      new.attached_at := null;
      new.attached_by := null;
    else
      new.attached_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_installment_document_before_write on public.installment_documents;
create trigger trg_installment_document_before_write
  before insert or update of file_id on public.installment_documents
  for each row execute function public.tg_installment_document_before_write();

-- Trigger functions are never called directly; keep them off the public API.
revoke all on function public.tg_installment_before_write()             from public, anon;
revoke all on function public.tg_installment_log_event()                from public, anon;
revoke all on function public.tg_installment_prefill_checklist()        from public, anon;
revoke all on function public.tg_installment_document_before_write()    from public, anon;

-- ----------------------------------------------------------------------------
-- 8. Views  (security_invoker = on: callers' RLS on the base tables applies)
--    Column lists are explicit (no p.* / s.*) so later ALTERs on base tables
--    cannot silently change a view's shape.
-- ----------------------------------------------------------------------------

-- 8a. one row per project: current % complete, staleness, time elapsed
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
  (p.end_date - public.tcm_today())          as days_to_end          -- negative = past end date
from public.projects p
left join lateral (
  select u.percent_complete, u.as_of, u.note, u.updated_by, u.created_at
  from public.progress_updates u
  where u.project_id = p.id
  order by u.as_of desc, u.created_at desc
  limit 1
) lp on true;

-- 8b. one row per installment: dates relative to today + document readiness
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

-- 8c. one row per project for the cross-project dashboard (ONE query)
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

-- ----------------------------------------------------------------------------
-- 9. Row Level Security + grants
--    Same model as the existing tables: `authenticated` only, anon gets
--    nothing (no policy AND no table privilege). See header for the
--    shared-account limitation and the future per-user policy shape.
--    progress_updates + installment_events: SELECT/INSERT only (append-only).
--    project_installments: no DELETE (cancel with status='cancelled' instead;
--    deleting a project still cascades). Rows made by mistake can be removed
--    from the SQL editor.
-- ----------------------------------------------------------------------------
alter table public.progress_updates            enable row level security;
alter table public.project_installments        enable row level security;
alter table public.installment_events          enable row level security;
alter table public.installment_documents       enable row level security;
alter table public.project_checklist_templates enable row level security;

revoke all on public.progress_updates, public.project_installments,
              public.installment_events, public.installment_documents,
              public.project_checklist_templates
  from public, anon, authenticated;

grant select, insert         on public.progress_updates            to authenticated;
grant select, insert, update on public.project_installments        to authenticated;
grant select, insert         on public.installment_events          to authenticated;
grant select, insert, update, delete on public.installment_documents       to authenticated;
grant select, insert, update, delete on public.project_checklist_templates to authenticated;

-- progress_updates
drop policy if exists "Authenticated can read progress" on public.progress_updates;
create policy "Authenticated can read progress"
  on public.progress_updates for select to authenticated using (true);
drop policy if exists "Authenticated can add progress" on public.progress_updates;
create policy "Authenticated can add progress"
  on public.progress_updates for insert to authenticated with check (true);

-- project_installments
drop policy if exists "Authenticated can read installments" on public.project_installments;
create policy "Authenticated can read installments"
  on public.project_installments for select to authenticated using (true);
drop policy if exists "Authenticated can add installments" on public.project_installments;
create policy "Authenticated can add installments"
  on public.project_installments for insert to authenticated with check (true);
drop policy if exists "Authenticated can update installments" on public.project_installments;
create policy "Authenticated can update installments"
  on public.project_installments for update to authenticated using (true) with check (true);

-- installment_events (insert policy is required because the trigger is INVOKER)
drop policy if exists "Authenticated can read installment events" on public.installment_events;
create policy "Authenticated can read installment events"
  on public.installment_events for select to authenticated using (true);
drop policy if exists "Authenticated can add installment events" on public.installment_events;
create policy "Authenticated can add installment events"
  on public.installment_events for insert to authenticated with check (true);

-- installment_documents
drop policy if exists "Authenticated can read installment documents" on public.installment_documents;
create policy "Authenticated can read installment documents"
  on public.installment_documents for select to authenticated using (true);
drop policy if exists "Authenticated can add installment documents" on public.installment_documents;
create policy "Authenticated can add installment documents"
  on public.installment_documents for insert to authenticated with check (true);
drop policy if exists "Authenticated can update installment documents" on public.installment_documents;
create policy "Authenticated can update installment documents"
  on public.installment_documents for update to authenticated using (true) with check (true);
drop policy if exists "Authenticated can delete installment documents" on public.installment_documents;
create policy "Authenticated can delete installment documents"
  on public.installment_documents for delete to authenticated using (true);

-- project_checklist_templates
drop policy if exists "Authenticated can read checklist templates" on public.project_checklist_templates;
create policy "Authenticated can read checklist templates"
  on public.project_checklist_templates for select to authenticated using (true);
drop policy if exists "Authenticated can add checklist templates" on public.project_checklist_templates;
create policy "Authenticated can add checklist templates"
  on public.project_checklist_templates for insert to authenticated with check (true);
drop policy if exists "Authenticated can update checklist templates" on public.project_checklist_templates;
create policy "Authenticated can update checklist templates"
  on public.project_checklist_templates for update to authenticated using (true) with check (true);
drop policy if exists "Authenticated can delete checklist templates" on public.project_checklist_templates;
create policy "Authenticated can delete checklist templates"
  on public.project_checklist_templates for delete to authenticated using (true);

-- views: signed-in app users only
revoke all on public.project_progress_latest, public.installment_summary,
              public.project_tracking_overview
  from public, anon;
grant select on public.project_progress_latest, public.installment_summary,
                public.project_tracking_overview
  to authenticated;

commit;

-- ============================================================================
-- OPTIONAL CHECKS (run separately after the migration; read-only)
-- ============================================================================
-- Postgres version (need >= 15 for security_invoker views):
--   select version();
-- Live type of files.id / projects.id (this file assumes uuid):
--   select table_name, data_type from information_schema.columns
--   where table_schema='public' and table_name in ('files','projects') and column_name='id';
-- Can the app UPDATE projects (needed to save start/end date and project_co)?
--   select policyname, cmd, roles from pg_policies
--   where schemaname='public' and tablename='projects';
-- ============================================================================
