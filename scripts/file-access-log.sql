-- ============================================================================
-- FILE ACCESS LOG  (who opened / downloaded which document, admin-only)
-- ============================================================================
-- วิธีรัน: Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์ -> Run
--   * งานทั้งหมดอยู่ในบล็อก DO เดียว (คำสั่งเดียว): สำเร็จทั้งหมด หรือไม่เปลี่ยนอะไรเลย
--   * รันซ้ำได้ปลอดภัย (idempotent) ต้องมี auth-01 / auth-02 มาก่อน (is_admin, can_view_project)
--
-- WHAT
--   public.file_access_log: one row per (person, file, action) every time a person is given a link
--   to a file by POST /api/drive-url. Every way to read file BYTES goes through that endpoint, which
--   signs links only for the files the RPC reports as logged and refuses the link when the log write
--   fails (fail closed; before this file is run it serves files without logging).
--     action  'view'     preview / open in a new tab
--             'download' download of one file
--             'zip'      file put into a ZIP download
--             'reindex'  file read by the "Re-index เนื้อหา" action (text extraction / OCR)
--   The same person + file + action within 10 minutes is ONE row (a preview that re-asks for an
--   expired link, a ZIP that re-mints its links). Rows older than 365 days are purged now and then.
--   No foreign keys on purpose: the log outlives a deleted account / file / project; names and
--   e-mail are copied in at the time of access.
--   LIMITS (by design - keep in mind when reading the log): the action is what the person ASKED for
--   (a 'view' link can still be saved; a signed link works for ~5 minutes for whoever holds it); the
--   extracted TEXT of documents (files.content_text, used by search / AI chat) is read without a row.
--
--   Read:  admins only (RLS: is_admin()). No API role (anon / authenticated / service_role) can
--          insert / change / delete rows; the only writer is public.log_file_access(file_ids uuid[],
--          action text) -> uuid[] (the ids logged now or already logged in the last 10 minutes),
--          SECURITY DEFINER, which records auth.uid() itself (nobody can write rows for someone
--          else) and only for files the caller may see (can_view_project). The number of new rows per
--          person per 10 minutes is 20000 (LOG_RATE_LIMIT, SQLSTATE 54000): a script cannot flood the log, while
--          a "Zip ทั้งโครงการ" of a very large project still fits.
--
-- ROLLBACK: scripts/file-access-log-rollback.sql (drops the function and the table = the log is lost)
-- ============================================================================

do $fal$
declare
  x_cnt bigint;
begin
  perform set_config('lock_timeout', '5s', true);

  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.can_view_project(uuid)') is null then
    raise exception 'auth-01 (is_admin / can_view_project) is not installed - run scripts/auth-01-foundation.sql first. Nothing was changed.';
  end if;

  create table if not exists public.file_access_log (
    id           bigint generated always as identity primary key,
    at           timestamptz not null default now(),
    user_id      uuid        not null,
    user_email   text,
    user_name    text,
    file_id      uuid,
    file_name    text,
    project_id   uuid,
    project_code text,
    action       text        not null,
    constraint file_access_log_action_chk check (action in ('view','download','zip','reindex'))
  );
  comment on table public.file_access_log is
    'Who opened / downloaded which file (written only by log_file_access via /api/drive-url). Admin-only read. No FKs: outlives deleted accounts/files.';

  create index if not exists file_access_log_at_idx     on public.file_access_log (at);
  create index if not exists file_access_log_dedupe_idx on public.file_access_log (user_id, file_id, action, at desc);
  -- the admin screen pages by id (newest first), optionally filtered by person / project
  create index if not exists file_access_log_project_id_idx on public.file_access_log (project_id, id desc);
  create index if not exists file_access_log_user_id_idx    on public.file_access_log (user_id, id desc);

  -- (not FORCE: log_file_access runs as the table owner and must be able to insert / purge)
  alter table public.file_access_log enable row level security;
  drop policy if exists file_access_log_admin_read on public.file_access_log;
  create policy file_access_log_admin_read on public.file_access_log
    for select to authenticated using ((select public.is_admin()));

  revoke all on public.file_access_log from public, anon, authenticated;
  grant select on public.file_access_log to authenticated;   -- RLS above: admins only
  -- the service key (server code) must not be able to rewrite the trail either
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke insert, update, delete, truncate on public.file_access_log from service_role;
  end if;

  -- an earlier draft returned integer: CREATE OR REPLACE cannot change the return type
  if exists (select 1 from pg_proc where oid = to_regprocedure('public.log_file_access(uuid[], text)')
             and prorettype <> 'uuid[]'::regtype) then
    drop function public.log_file_access(uuid[], text);
  end if;

  create or replace function public.log_file_access(p_file_ids uuid[], p_action text)
  returns uuid[]
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    v_uid    uuid := auth.uid();
    v_ok     uuid[];
    v_recent bigint;
  begin
    if v_uid is null then
      raise exception 'NOT_SIGNED_IN' using errcode = '28000';
    end if;
    if p_action is null or p_action not in ('view','download','zip','reindex') then
      raise exception 'BAD_ACTION' using errcode = '22023';
    end if;
    if p_file_ids is null or cardinality(p_file_ids) = 0 then
      return '{}'::uuid[];
    end if;
    if cardinality(p_file_ids) > 50 then
      raise exception 'TOO_MANY_FILES' using errcode = '22023';
    end if;

    -- one call per person at a time: the 10-minute de-duplication below cannot race with itself
    perform pg_advisory_xact_lock(hashtext('file_access_log'), hashtext(v_uid::text));

    select count(*) into v_recent from public.file_access_log
    where user_id = v_uid and at > now() - interval '10 minutes';
    if v_recent >= 20000 then
      raise exception 'LOG_RATE_LIMIT' using errcode = '54000';
    end if;

    -- the files this person may see (checked NOW, with their own uid)
    select coalesce(array_agg(f.id), '{}'::uuid[]) into v_ok
    from (select distinct unnest(p_file_ids) as id) ids
    join public.files f on f.id = ids.id
    where public.can_view_project(f.project_id);

    insert into public.file_access_log (user_id, user_email, user_name, file_id, file_name, project_id, project_code, action)
    select v_uid, pr.email, pr.full_name, f.id, f.name, f.project_id, p.code, p_action
    from public.files f
    join public.projects p on p.id = f.project_id
    left join public.profiles pr on pr.id = v_uid
    where f.id = any (v_ok)
      and not exists (
        select 1 from public.file_access_log l
        where l.user_id = v_uid and l.file_id = f.id and l.action = p_action
          and l.at > now() - interval '10 minutes');

    -- retention: about once in 200 calls, drop up to 1000 rows older than a year. It never blocks or
    -- fails the request: locked rows are skipped and any error is swallowed (the insert above stays).
    if random() < 0.005 then
      begin
        delete from public.file_access_log
        where id in (select id from public.file_access_log where at < now() - interval '365 days'
                     order by at limit 1000 for update skip locked);
      exception when others then
        null;
      end;
    end if;
    -- logged now or already logged within 10 minutes: /api/drive-url signs links ONLY for these ids
    return v_ok;
  end
  $fn$;

  revoke all on function public.log_file_access(uuid[], text) from public, anon;
  grant execute on function public.log_file_access(uuid[], text) to authenticated;

  -- ---- self-checks (any exception = nothing changed) ----
  if has_table_privilege('anon', 'public.file_access_log', 'select')
     or has_table_privilege('authenticated', 'public.file_access_log', 'insert')
     or has_table_privilege('authenticated', 'public.file_access_log', 'update')
     or has_table_privilege('authenticated', 'public.file_access_log', 'delete') then
    raise exception 'SELF-CHECK FAILED: file_access_log privileges are too wide';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and (has_table_privilege('service_role', 'public.file_access_log', 'insert')
          or has_table_privilege('service_role', 'public.file_access_log', 'update')
          or has_table_privilege('service_role', 'public.file_access_log', 'delete')
          or has_table_privilege('service_role', 'public.file_access_log', 'truncate')) then
    raise exception 'SELF-CHECK FAILED: service_role can still change file_access_log';
  end if;
  if has_function_privilege('anon', 'public.log_file_access(uuid[], text)', 'execute') then
    raise exception 'SELF-CHECK FAILED: anon can execute log_file_access';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.log_file_access(uuid[], text)'::regprocedure
                 and prosecdef and proconfig @> array['search_path=public'] and prorettype = 'uuid[]'::regtype) then
    raise exception 'SELF-CHECK FAILED: log_file_access is not SECURITY DEFINER / search_path=public / returns uuid[]';
  end if;
  select count(*) into x_cnt from pg_policies where schemaname = 'public' and tablename = 'file_access_log';
  if x_cnt <> 1 then
    raise exception 'SELF-CHECK FAILED: file_access_log should have exactly 1 policy (admin read), found %', x_cnt;
  end if;

  perform pg_notify('pgrst', 'reload schema');
  raise notice 'file-access-log installed: admins can read public.file_access_log; /api/drive-url now logs every view / download / zip / reindex.';
end
$fal$;

select 'file_access_log' as installed, count(*) as rows_now from public.file_access_log;
