-- ============================================================================
-- AUTH 02 - ENFORCE ROW LEVEL SECURITY  (THE CUTOVER)
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   ทั้งไฟล์อยู่ใน transaction เดียว: สำเร็จทั้งหมดหรือไม่เปลี่ยนอะไรเลย
--   รันซ้ำได้ (idempotent) - policy ทั้งหมดถูกลบแล้วสร้างใหม่ทุกครั้ง
--
-- !!! READ BEFORE RUNNING !!!
--   THE MOMENT THIS COMMITS, THE OLD SHARED-ACCOUNT APP STOPS WORKING.
--   The shared account (public@teamcm.co.th) has no row in public.profiles, so
--   every helper returns false for it: it reads nothing and writes nothing. This
--   takes effect on the very next query of every open browser tab (RLS is evaluated
--   per query; there is no waiting for tokens to expire).
--
--   Run it ONLY when:
--     [x] scripts/auth-01-foundation.sql has been run
--     [x] you have an ACTIVE admin profile (the preflight below aborts otherwise)
--     [x] the new app (login screen, admin UI, serverless admin function) is deployed
--     [x] every real person has an auth user + profiles row (admin UI), and
--         user-role people have project_members rows (admin UI)
--     [x] scripts/auth-test.sql was run after 01 and showed no FAIL
--   Then run auth-test.sql AGAIN: every check must now be PASS (none SKIP).
--   If people are locked out: scripts/auth-03-rollback.sql (it is safe to keep a tab
--   open with it ready).
--
-- WHAT IT DOES
--   0. preflight (aborts if prerequisites are missing; warns about auth users without profile)
--   1. backup: public._policy_backup_<yyyymmdd> (every policy in schema public) and
--      public._grant_backup_<yyyymmdd> (table privileges) - created once, never overwritten
--   2. drops EVERY policy (whatever its name) on the tables listed below
--   3. enables RLS (and makes sure it is NOT forced), sets table grants
--   4. creates the new policies on top of the helper functions from 01
--   5. views: forces security_invoker = on, grants
--   6. anon: no access to any table / view / function of the app
--   7. reports storage.objects policies (informational; nothing is dropped; can never abort the run)
--   7b. catch-all: anon loses all privileges on every public relation not starting with '_';
--       WARNINGs for public tables with RLS off and for functions anon can still EXECUTE
--
-- OPEN ITEM (not done by this file): if a legacy Supabase Storage bucket 'documents' exists
--   and is PUBLIC, its objects stay world-readable by URL whatever the policies above say.
--   Section 7 prints the buckets; if it is public and nothing needs it, make it private
--   (Dashboard -> Storage, or: update storage.buckets set public = false where id = 'documents';).
--
-- ACCESS MODEL (implemented by can_view_project / can_edit_project from 01)
--   admin  : everything, incl. create/delete projects, manage profiles + membership
--   exec   : read ALL projects and children; no writes anywhere
--   user   : read projects where they have a membership row (editor or viewer);
--            write only where role = 'editor'; cannot create/delete projects
--   no active profile (shared account, deactivated person): nothing at all
--
-- POLICIES CREATED (all TO authenticated; anon has none)
--   projects                 projects_select / _insert / _update / _delete
--   files, progress_updates, project_installments, installment_documents,
--   project_checklist_templates
--                            <table>_select / _insert / _update / _delete
--   activity                 activity_select / activity_insert        (append-only)
--   installment_events       installment_events_select / _insert      (append-only)
--   project_members          pm_admin_all, pm_select_own, pm_select_exec
--   profiles                 profiles_select_own, profiles_select_admin
--   audit_log                audit_log_select_admin
--   app_visits (if exists)   app_visits_select_admin                  (no client INSERT)
--   allowed_emails (if exists) allowed_emails_select_admin
-- ============================================================================

begin;
-- give up (and roll everything back) instead of queueing behind a long-running query
set local lock_timeout = '10s';

-- ----------------------------------------------------------------------------
-- 0. Preflight
-- ----------------------------------------------------------------------------
do $pre$
declare
  t       text;
  f       text;
  missing text[] := '{}';
  v_admins int;
  r       record;
begin
  foreach t in array array['projects','files','activity','progress_updates','project_installments',
                           'installment_events','installment_documents','project_checklist_templates',
                           'project_members','profiles','audit_log']
  loop
    if to_regclass('public.' || t) is null then
      missing := missing || t;
    end if;
  end loop;
  if cardinality(missing) > 0 then
    raise exception 'Missing tables: %. Run scripts/auth-01-foundation.sql (and project-tracking.sql) first.', missing;
  end if;

  foreach f in array array['public.my_profile()','public.is_admin()','public.is_exec()',
                           'public.can_view_project(uuid)','public.can_edit_project(uuid)',
                           'public.clear_must_change_password()','public.set_pw_marker(uuid)',
                           'public.revoke_user_sessions(uuid)']
  loop
    if to_regprocedure(f) is null then
      raise exception 'Missing function %. Run the CURRENT scripts/auth-01-foundation.sql first.', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass
                 and tgname = 'trg_profiles_last_admin' and tgenabled = 'A') then
    raise exception 'trigger trg_profiles_last_admin (last-admin backstop) is missing. Run the CURRENT scripts/auth-01-foundation.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'pw_marker') then
    raise exception 'column profiles.pw_marker is missing. Run the CURRENT scripts/auth-01-foundation.sql first.';
  end if;

  -- only admins who can really work count: active AND no temporary password pending
  select count(*) into v_admins from public.profiles
   where role = 'admin' and active and not must_change_password;
  if v_admins = 0 then
    raise exception 'ABORTED: there is no ACTIVE admin without a pending password change in public.profiles. Running this would lock everybody out (admins holding a temporary password see no data). Create/bootstrap the admin (bootstrap_first_admin in auth-01) or let the admin set a new password first.';
  end if;

  for r in
    select u.email
    from auth.users u
    left join public.profiles p on p.id = u.id
    where p.id is null
    order by u.email
  loop
    raise warning 'auth user % has NO profile: after this script that account can access nothing (expected for the old shared account public@teamcm.co.th).', r.email;
  end loop;

  if v_admins < 2 then
    raise warning 'only % usable admin: create a SECOND admin AND let him change the temporary password (the last-admin trigger does not count admins who still hold a temporary password, so you could not rotate or remove the only usable admin).', v_admins;
  end if;
  for r in
    select email from public.profiles where active and must_change_password order by email
  loop
    raise notice 'user % still has a temporary password: until they set a new one the database gives them NO data access (expected).', r.email;
  end loop;

  raise notice 'preflight OK: % active admin(s).', v_admins;
end
$pre$;

-- ----------------------------------------------------------------------------
-- 1. Backups (created ONCE; if any _policy_backup_* table exists it is kept as is)
-- ----------------------------------------------------------------------------
do $bak$
declare
  v_suffix text := to_char(now() at time zone 'Asia/Bangkok', 'YYYYMMDD');
  v_name   text;
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename like '\_policy\_backup\_%') then
    raise notice 'policy backup already exists - kept untouched (it holds the ORIGINAL pre-cutover policies).';
  else
    v_name := '_policy_backup_' || v_suffix;
    execute format(
      'create table public.%I as
         select now() as backed_up_at, schemaname, tablename, policyname, permissive,
                roles::text[] as roles, cmd, qual, with_check
         from pg_policies where schemaname = %L',
      v_name, 'public');
    execute format('alter table public.%I enable row level security', v_name);
    execute format('revoke all on public.%I from public, anon, authenticated', v_name);
    raise notice 'policies backed up into public.%', v_name;

    v_name := '_grant_backup_' || v_suffix;
    execute format(
      'create table public.%I as
         select now() as backed_up_at, c.relname::text as table_name, c.relkind::text as relkind,
                a.grantee::regrole::text as grantee, a.privilege_type::text as privilege_type
         from pg_class c
         cross join lateral aclexplode(c.relacl) a
         where c.relnamespace = %L::regnamespace and c.relkind in (''r'',''v'') and a.grantee <> 0',
      v_name, 'public');
    execute format('alter table public.%I enable row level security', v_name);
    execute format('revoke all on public.%I from public, anon, authenticated', v_name);
    raise notice 'table privileges backed up into public.%', v_name;
  end if;
end
$bak$;

-- ----------------------------------------------------------------------------
-- 2. Drop ALL existing policies on the app tables (names are never assumed)
-- ----------------------------------------------------------------------------
do $drop$
declare
  r record;
  n int := 0;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array['projects','files','activity','progress_updates','project_installments',
                                 'installment_events','installment_documents','project_checklist_templates',
                                 'app_visits','allowed_emails','project_members','profiles','audit_log'])
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  end loop;
  raise notice 'dropped % existing policies', n;
end
$drop$;

-- ----------------------------------------------------------------------------
-- 3. RLS on (and explicitly NOT forced: the SECURITY DEFINER helpers rely on the
--    table owner being exempt - forcing RLS would make them recurse), then grants
--    RLS does the row gating; grants only remove what no client should ever do.
--    Same privileges the repo's older scripts gave `authenticated`, except:
--      activity, installment_events : no UPDATE/DELETE (append-only, also at privilege level;
--                                     FK cascades/SET NULL run as table owner and are unaffected)
--      app_visits                   : no INSERT (visit logging removed)
--      profiles, audit_log, allowed_emails : SELECT only
-- ----------------------------------------------------------------------------
do $grants$
declare
  r record;
begin
  for r in
    select * from (values
      ('projects',                    'select, insert, update, delete'),
      ('files',                       'select, insert, update, delete'),
      ('activity',                    'select, insert'),
      ('progress_updates',            'select, insert, update, delete'),
      ('project_installments',        'select, insert, update, delete'),
      ('installment_events',          'select, insert'),
      ('installment_documents',       'select, insert, update, delete'),
      ('project_checklist_templates', 'select, insert, update, delete'),
      ('project_members',            'select, insert, update, delete'),
      ('profiles',                    ''),            -- column-level SELECT below (pw_marker stays hidden)
      ('audit_log',                   'select'),
      ('app_visits',                  'select'),
      ('allowed_emails',              'select')
    ) as v(tbl, privs)
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', r.tbl);
    execute format('alter table public.%I no force row level security', r.tbl);
    execute format('revoke all on public.%I from public, anon, authenticated', r.tbl);
    if r.privs <> '' then
      execute format('grant %s on public.%I to authenticated', r.privs, r.tbl);
    end if;
  end loop;
  -- profiles: SELECT on every column EXCEPT pw_marker (same as auth-01). Client queries must
  -- name their columns: `select *` on profiles fails with 42501 for a signed-in user.
  grant select (id, email, full_name, role, active, must_change_password, created_at, created_by)
    on public.profiles to authenticated;
end
$grants$;

-- ----------------------------------------------------------------------------
-- 4. New policies
-- ----------------------------------------------------------------------------

-- 4a. projects
create policy projects_select on public.projects
  for select to authenticated
  using (public.can_view_project(id));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (public.is_admin());

create policy projects_update on public.projects
  for update to authenticated
  using (public.can_edit_project(id))
  with check (public.can_edit_project(id));

create policy projects_delete on public.projects
  for delete to authenticated
  using (public.is_admin());

-- 4b. project-scoped tables with full CRUD.
--     SELECT: can_view_project(project_id).
--     INSERT: WITH CHECK can_edit_project(project_id)  -> cannot write into a project you cannot edit.
--     UPDATE: USING (old row's project is editable) AND WITH CHECK (NEW project_id is editable too)
--             -> a row cannot be moved into someone else's project.
--     DELETE: can_edit_project(project_id).
--     files INSERT additionally: uploader_id must be NULL or the caller (src/api/supabase.js
--     uploadFile sends user.id = auth.uid()), so nobody can attribute an upload to someone else.
--     UPDATE of uploader_id is guarded by the trigger trg_files_uploader_guard (section 4d2):
--     a signed-in user may set it only to NULL or to his own id (RLS cannot see OLD values);
--     every change is also written to audit_log (tg_audit_files, from auth-01).
do $crud$
declare
  t       text;
  v_extra text;
begin
  foreach t in array array['files','progress_updates','project_installments',
                           'installment_documents','project_checklist_templates']
  loop
    v_extra := '';
    if t = 'files' and exists (select 1 from information_schema.columns
                               where table_schema = 'public' and table_name = 'files'
                                 and column_name = 'uploader_id') then
      v_extra := ' and (uploader_id is null or uploader_id = (select auth.uid()))';
    end if;
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.can_view_project(project_id))', t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (public.can_edit_project(project_id)%s)', t || '_insert', t, v_extra);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (public.can_edit_project(project_id))
         with check (public.can_edit_project(project_id))', t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated
         using (public.can_edit_project(project_id))', t || '_delete', t);
  end loop;
end
$crud$;

-- 4c. append-only tables (no UPDATE / DELETE policy, and no such privilege)
create policy activity_select on public.activity
  for select to authenticated
  using (public.can_view_project(project_id));

-- user_id, when given, must be the caller (the app always sends auth user id)
create policy activity_insert on public.activity
  for insert to authenticated
  with check (public.can_edit_project(project_id)
              and (user_id is null or user_id = (select auth.uid())));

create policy installment_events_select on public.installment_events
  for select to authenticated
  using (public.can_view_project(project_id));

-- (the status-history trigger was dropped in fix-2; if it is ever re-created it is
--  SECURITY INVOKER and needs this INSERT policy)
create policy installment_events_insert on public.installment_events
  for insert to authenticated
  with check (public.can_edit_project(project_id));

-- 4d. membership / profiles / audit
create policy pm_admin_all on public.project_members
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- own membership rows, only while the profile is ACTIVE and has no password change pending
create policy pm_select_own on public.project_members
  for select to authenticated
  using (user_id = (select auth.uid())
         and (public.my_profile()).id is not null
         and not (public.my_profile()).must_change_password);

create policy pm_select_exec on public.project_members
  for select to authenticated
  using (public.is_exec());

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (public.is_admin());

-- 4d2. files.uploader_id cannot be re-attributed to somebody else by UPDATE (see 4b).
--     Only fires when uploader_id actually changes, so the app's is_latest / content_text /
--     rename updates never reach it. No end user (SQL editor, service role): unrestricted.
create or replace function public.tg_files_uploader_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.uploader_id is distinct from old.uploader_id
     and (select auth.uid()) is not null
     and new.uploader_id is not null
     and new.uploader_id <> (select auth.uid()) then
    raise exception 'UPLOADER_FORGED: uploader_id may only be set to NULL or to your own user id'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_files_uploader_guard() from public, anon, authenticated;

do $up$
begin
  drop trigger if exists trg_files_uploader_guard on public.files;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'files' and column_name = 'uploader_id') then
    create trigger trg_files_uploader_guard
      before update of uploader_id on public.files
      for each row execute function public.tg_files_uploader_guard();
  end if;
end
$up$;

-- 4e. optional legacy tables: admin can read, nobody writes through the API
do $legacy$
begin
  if to_regclass('public.app_visits') is not null then
    execute 'create policy app_visits_select_admin on public.app_visits
               for select to authenticated using (public.is_admin())';
  end if;
  if to_regclass('public.allowed_emails') is not null then
    execute 'create policy allowed_emails_select_admin on public.allowed_emails
               for select to authenticated using (public.is_admin())';
  end if;
end
$legacy$;

-- ----------------------------------------------------------------------------
-- 5. Views.  project_progress_latest, installment_summary, project_tracking_overview
--    are security_invoker views (project-tracking.sql): every base-table read inside
--    them (projects, progress_updates, project_installments, installment_documents,
--    files) is filtered by the CALLER's RLS, so:
--      * they return only rows of projects the caller can view (the joins to
--        `projects` / `files` cannot leak another project: both are RLS-filtered, and
--        the lateral subqueries are keyed by project_id / installment_id);
--      * aggregates (installment counts, required_docs_*) count only visible rows.
--    A view WITHOUT security_invoker would run as its owner (postgres, exempt from
--    RLS) and leak everything - so it is forced on here, and any other view in
--    schema public that lacks it is reported as a WARNING.
-- ----------------------------------------------------------------------------
do $views$
declare
  v text;
  r record;
begin
  foreach v in array array['project_progress_latest','installment_summary','project_tracking_overview']
  loop
    if to_regclass('public.' || v) is not null then
      execute format('alter view public.%I set (security_invoker = on)', v);
      execute format('revoke all on public.%I from public, anon', v);
      execute format('grant select on public.%I to authenticated', v);
    else
      raise notice 'view public.% not found (tracking schema not installed?)', v;
    end if;
  end loop;

  for r in
    select c.relname, c.relkind
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('v','m')
      and not exists (
        select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) o
        where o in ('security_invoker=on','security_invoker=true'))
  loop
    raise warning 'public.% (relkind %) is NOT security_invoker: it bypasses RLS. Make it security_invoker or revoke access.', r.relname, r.relkind;
  end loop;
end
$views$;

-- ----------------------------------------------------------------------------
-- 6. anon: nothing.  (No policy targets anon and, above, anon lost every table
--    privilege.) Functions: EXECUTE only for signed-in users where the app needs it.
-- ----------------------------------------------------------------------------
do $fn$
declare
  f text;
begin
  foreach f in array array[
    'public.tcm_today()',
    'public.tg_installment_before_write()','public.tg_installment_log_event()',
    'public.tg_installment_prefill_checklist()','public.tg_installment_document_before_write()',
    'public.tg_progress_no_future_asof()','public.check_email_allowed()',
    'public.my_profile()','public.is_admin()','public.is_exec()',
    'public.can_view_project(uuid)','public.can_edit_project(uuid)',
    'public.clear_must_change_password()'
  ]
  loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon', f);
    end if;
  end loop;
end
$fn$;

grant execute on function public.tcm_today()                  to authenticated;
grant execute on function public.my_profile()                 to authenticated;
grant execute on function public.is_admin()                   to authenticated;
grant execute on function public.is_exec()                    to authenticated;
grant execute on function public.can_view_project(uuid)       to authenticated;
grant execute on function public.can_edit_project(uuid)       to authenticated;
grant execute on function public.clear_must_change_password() to authenticated;

-- Future objects created by postgres in public must not be anon-readable by default
-- (Supabase's default grants anon everything; RLS would still stop rows, this stops
-- the privilege too). Only affects objects created AFTER this point.
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- ----------------------------------------------------------------------------
-- 7. Storage (informational; nothing is changed).
--    This app stores files in Google Drive. The repo's SQL contains NO policy on
--    storage.objects (SQL_SCHEMA.sql only has a comment telling you to create a
--    public bucket "documents" by hand). Whatever exists in the live project is
--    listed below - review it: a broad policy / a public bucket would expose any
--    legacy objects regardless of the policies above.
-- ----------------------------------------------------------------------------
do $sto$
declare
  r record;
begin
  -- purely informational: whatever goes wrong here must never abort the cutover
  begin
    if to_regclass('storage.objects') is null then
      raise notice 'storage.objects not present';
    else
      for r in
        select policyname, cmd, roles::text as roles, qual, with_check
        from pg_policies where schemaname = 'storage' and tablename = 'objects'
      loop
        raise notice 'storage.objects policy "%" cmd=% roles=% using=% check=%',
          r.policyname, r.cmd, r.roles, r.qual, r.with_check;
      end loop;
      for r in select id, public from storage.buckets loop
        raise notice 'storage bucket "%" public=%', r.id, r.public;
      end loop;
    end if;
  exception when others then
    raise notice 'storage report skipped: %', sqlerrm;
  end;
end
$sto$;
-- If a broad policy for bucket 'documents' / a public bucket shows up and no legacy
-- objects are needed, tighten it by hand (examples, NOT executed):
--   drop policy "<name from the NOTICE above>" on storage.objects;
--   update storage.buckets set public = false where id = 'documents';

-- ----------------------------------------------------------------------------
-- 7b. Catch-all for anon (belt and braces; covers objects this file does not know about)
--     * every table / view / materialized view / sequence in schema public whose name
--       does not start with '_' loses ALL anon privileges
--     * WARNING for every ordinary public table that still has RLS off
--     * WARNING for every (non-extension) public function anon can EXECUTE - review these
--       by hand: revoke execute on function public.<name>(<args>) from public, anon;
-- ----------------------------------------------------------------------------
do $anon$
declare
  r record;
  n int := 0;
begin
  for r in
    select c.oid::regclass::text as obj, c.relkind
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r','p','v','m','f','S')
      and c.relname not like '\_%'
  loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence %s from public, anon', r.obj);
    else
      execute format('revoke all on table %s from public, anon', r.obj);
    end if;
    n := n + 1;
  end loop;
  raise notice 'anon: privileges revoked on % public relations', n;

  for r in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r','p')
      and not c.relrowsecurity
      and c.relname not like '\_%'
  loop
    raise warning 'public.% has ROW LEVEL SECURITY OFF: any authenticated user can read/write it (anon no longer can).', r.relname;
  end loop;

  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind in ('f','p')
      and has_function_privilege('anon', p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    raise warning 'anon can EXECUTE function %', r.fn;
  end loop;
end
$anon$;

-- ----------------------------------------------------------------------------
-- 8. Summary (NOTICE): policies per table after the cutover
-- ----------------------------------------------------------------------------
do $sum$
declare
  r record;
begin
  for r in
    select tablename, count(*) as n, string_agg(policyname, ', ' order by policyname) as names
    from pg_policies where schemaname = 'public'
      and tablename not like '\_%'
    group by tablename order by tablename
  loop
    raise notice '% -> % policies: %', r.tablename, r.n, r.names;
  end loop;
end
$sum$;

-- make PostgREST pick up changes at once (delivered at COMMIT)
notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- After commit (read-only checks):
--   -- every app table has RLS on and not forced:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--   where relnamespace='public'::regnamespace and relkind='r' order by 1;
--   -- anon holds no privilege on any app table:
--   select table_name, privilege_type from information_schema.role_table_grants
--   where table_schema='public' and grantee='anon';
--   -- then run scripts/auth-test.sql again.
-- ============================================================================
