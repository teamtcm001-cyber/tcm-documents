-- ============================================================================
-- AUTH 03 - ROLLBACK OF THE CUTOVER  (undoes scripts/auth-02-enforce-rls.sql)
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์ -> Run
--   ทำงานเป็นธุรกรรมเดียว และรันซ้ำได้
--
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! SECURITY WARNING !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- Modes 'repo' and 'backup' RE-ADMIT THE OLD SHARED ACCOUNT public@teamcm.co.th TO ALL DATA.
-- Its password was COMPILED INTO THE OLD PUBLIC JAVASCRIPT BUNDLE: everybody who ever opened
-- the old site (or can download that bundle from Vercel/browser caches/archives) can sign in
-- as that account. While the rollback is in force the data is, in effect, PUBLIC.
--   * the script REFUSES to run in those modes until you edit the line  accept_shared_risk
--     below to the exact text  I-ACCEPT-THE-RISK  (you will see the reason when it stops)
--   * the safe alternative is mode 'admin_only': policies gated on public.is_admin() ONLY. The
--     OLD shared-account app will NOT work with it, but admins keep a working database and nobody
--     is let in through the leaked password. Use it unless the old app MUST come back.
--   * if you do accept the risk: do it for hours, not days; afterwards disable the shared
--     account (Dashboard -> Authentication -> Users -> public@teamcm.co.th -> Ban / Delete) or
--     change its password, and re-run auth-02.
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

-- !! PRECONDITIONS - READ FIRST !!
--   1. Dashboard -> Authentication -> Providers/Settings: DISABLE SIGN-UPS (and keep
--      "Confirm email" on) BEFORE running this file. This rollback re-opens the data to
--      the old shared account and to admins; with open sign-ups anyone could register an
--      account first. (The restored policies below are NOT "any authenticated user", see
--      GATE, but do not rely on a single line of defence.)
--   2. This is an EMERGENCY measure while the OLD shared-account app version is
--      redeployed. It is not a way to run the new app without role enforcement.
--
-- WHEN TO USE
--   Only if auth-02 locked people out and you cannot fix it quickly (for example the
--   admin UI is broken, or user/membership data is wrong). Prefer fixing the data:
--   a missing profile or membership row is a 1-row INSERT, not a rollback.
--
-- GATE
--   The restored (mode 'repo') policies do not use `using (true)`. Every one of them is
--   gated on
--       coalesce(lower(auth.jwt() ->> 'email'), '') = 'public@teamcm.co.th'  OR  public.is_admin()
--   i.e. the old shared account, or an active admin. Nobody else (an exec, a normal user,
--   a self-registered stranger) gets in. Change the e-mail in the line `v_gate` below if
--   the shared account has a different address.
--
-- WHAT IT DOES
--   Drops every policy on the app tables and restores PERMISSIVE `authenticated`
--   policies, then the table grants, as the repo's older scripts defined them
--   (SQL_SCHEMA.sql, project-tracking.sql, project-tracking-fix-2.sql,
--   app-visits-table.sql):
--     projects, files, activity, progress_updates, project_installments,
--     installment_events, installment_documents, project_checklist_templates,
--     app_visits (INSERT only, as before)
--   Two ways, chosen by the single line "mode" just below:
--     'repo'   (default) policies written out in this file, gated as described above.
--              Their NAMES AND EXPRESSIONS ARE INVENTED by this script (the repo never
--              defined files/activity/projects UPDATE/DELETE policies, and the live ones
--              were not inspected). It restores "the old app works", not the exact old state.
--     'admin_only' same policies as 'repo' but gated on public.is_admin() ONLY (the shared
--              account is NOT re-admitted; the old shared-account app does not work).
--     'none'   touches NO policy and NO grant: use it (with an undo_* switch below set to 'YES') when you
--              only want to remove an add-on - e.g. the project-manager feature - and keep the
--              auth-02 policies exactly as they are. The shared account is not re-admitted.
--     'backup' the EXACT restore: replays the ORIGINAL policies saved by auth-02 in
--              public._policy_backup_<date> (the OLDEST backup table is used), whatever they
--              were - including a plain `using (true)` if that is what they were. With this
--              mode the sign-up precondition above is critical.
--              (Grants are always restored from this file.)
--
-- WHAT IT DOES NOT TOUCH (they remain, by design)
--   public.profiles, public.project_members and public.audit_log with their policies;
--   the helper functions (the project-manager functions of auth-04 too, unless
--   undo_project_managers = 'YES'); the audit triggers (audit_log keeps recording); the
--   _policy_backup_* / _grant_backup_* tables; security_invoker on the views;
--   anon stays without access.
--
-- !! AFTER A ROLLBACK THE DATABASE NO LONGER ENFORCES ROLES !!
--   Any signed-in account can read and write every project again (this is the old
--   shared-account model). exec/viewer restrictions then exist only in the UI.
--   Redeploy the previous app version if you need the shared-account login again,
--   and re-run auth-02 as soon as the problem is fixed.
-- ============================================================================

begin;
-- give up (and roll everything back) instead of queueing behind a long-running query
set local lock_timeout = '10s';

-- >>> EDIT HERE <<<
--   mode                'repo' (default) | 'backup' | 'admin_only' | 'none' (no policy / grant change at all)
--   accept_shared_risk  must be exactly  I-ACCEPT-THE-RISK  for 'repo' / 'backup' (see the warning
--                       at the top: they re-admit public@teamcm.co.th whose password is public)
--   undo_hardening      'NO' (default) | 'YES' - also remove the objects auth-01 added later
--                       (last-admin trigger, pw_marker column + triggers + set_pw_marker /
--                       begin_password_reset / revoke_user_sessions, uploader guard, files_storage_path_uq). Only for going back to the
--                       OLD app; the new admin API calls those functions. The must-change-password
--                       gate inside the helper functions is NOT undone (see section 4).
--   undo_project_managers 'NO' (default) | 'YES' - remove the project-manager feature (auth-04):
--                       every project_members.role = 'manager' becomes 'editor' (the list is first
--                       saved in public._project_managers_backup), the functions is_project_manager /
--                       list_project_members / find_user_for_project / set_project_member /
--                       remove_project_member are dropped and the role CHECK goes back to
--                       ('editor','viewer'). Independent of the two options above. To remove ONLY the
--                       manager feature use  mode 'none'  +  undo_project_managers 'YES'  (the policies of
--                       auth-02 stay as they are). To bring the feature back: run auth-04 again
--                       (auth-01 / auth-02 may be re-run in any order as well); the backup table says
--                       who was a manager: see the comment at the end of section 5.
create temp table _tcm_rollback_mode on commit drop as
  select 'repo'::text as mode,
         'NO'::text   as accept_shared_risk,
         'NO'::text   as undo_hardening,
         'NO'::text   as undo_project_managers;

do $guard$
declare
  m record;
begin
  select * into m from _tcm_rollback_mode;
  if m.mode not in ('repo','backup','admin_only','none') then
    raise exception 'mode must be repo, backup, admin_only or none (got %)', m.mode;
  end if;
  if m.undo_hardening not in ('YES','NO') or m.undo_project_managers not in ('YES','NO') then
    raise exception 'undo_hardening / undo_project_managers must be YES or NO';
  end if;
  if m.mode in ('repo','backup') and m.accept_shared_risk <> 'I-ACCEPT-THE-RISK' then
    raise exception E'REFUSED: mode "%" would re-admit the old shared account public@teamcm.co.th, whose password is compiled into the old public JavaScript bundle (= anyone can sign in).\n  Safer: set mode to ''admin_only'' (admins only; the old shared-account app will not work).\n  If you really must bring the old app back: first make sure nobody else can sign up (Dashboard -> Authentication), edit accept_shared_risk to I-ACCEPT-THE-RISK, run again, and disable/rotate that account as soon as possible.', m.mode;
  end if;
  if m.mode in ('repo','backup') then
    raise warning 'SHARED ACCOUNT RE-ADMITTED (mode %): the data is reachable with the public@teamcm.co.th password found in the old bundle. Disable or rotate that account and re-run auth-02 as soon as possible.', m.mode;
  end if;
end
$guard$;

-- ----------------------------------------------------------------------------
-- 1. Drop all policies on the app tables (names are never assumed)
-- ----------------------------------------------------------------------------
do $drop$
declare
  r record;
  n int := 0;
begin
  if (select mode from _tcm_rollback_mode) = 'none' then
    raise notice 'mode none: policies and grants are left untouched.';
    return;
  end if;
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array['projects','files','activity','progress_updates','project_installments',
                                 'installment_events','installment_documents','project_checklist_templates',
                                 'app_visits'])
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  end loop;
  raise notice 'dropped % policies', n;
end
$drop$;

-- ----------------------------------------------------------------------------
-- 2a. mode = 'repo': gated policies modelled on the older scripts
--     (names follow project-tracking.sql / SQL_SCHEMA.sql / app-visits-table.sql where
--      those scripts define one; the others are named in the same style)
-- ----------------------------------------------------------------------------
do $repo$
declare
  r record;
  v_mode text := (select mode from _tcm_rollback_mode);
  -- the old shared account, or an active admin (see header)
  -- (mode 'admin_only': the shared account is NOT part of the gate)
  v_gate text := case when (select mode from _tcm_rollback_mode) = 'admin_only'
                      then $g$(public.is_admin())$g$
                      else $g$(coalesce(lower(auth.jwt() ->> 'email'), '') = 'public@teamcm.co.th' or public.is_admin())$g$
                 end;
begin
  if v_mode not in ('repo','admin_only') then
    raise notice 'mode is %, skipping repo policies', v_mode;
    return;
  end if;

  for r in
    select * from (values
      ('projects',                    'select', 'Users can view all projects',                  'GATE', null),
      ('projects',                    'insert', 'Project creator can insert',                   null,   'GATE and auth.uid() = created_by'),
      ('projects',                    'update', 'Authenticated can update projects',            'GATE', 'GATE'),
      ('projects',                    'delete', 'Authenticated can delete projects',            'GATE', null),

      ('files',                       'select', 'Authenticated can read files',                 'GATE', null),
      ('files',                       'insert', 'Authenticated can add files',                  null,   'GATE'),
      ('files',                       'update', 'Authenticated can update files',               'GATE', 'GATE'),
      ('files',                       'delete', 'Authenticated can delete files',               'GATE', null),

      ('activity',                    'select', 'Authenticated can read activity',              'GATE', null),
      ('activity',                    'insert', 'Authenticated can add activity',               null,   'GATE'),

      ('progress_updates',            'select', 'Authenticated can read progress',              'GATE', null),
      ('progress_updates',            'insert', 'Authenticated can add progress',               null,   'GATE'),
      ('progress_updates',            'update', 'Authenticated can update progress',            'GATE', 'GATE'),
      ('progress_updates',            'delete', 'Authenticated can delete progress',            'GATE', null),

      ('project_installments',        'select', 'Authenticated can read installments',          'GATE', null),
      ('project_installments',        'insert', 'Authenticated can add installments',           null,   'GATE'),
      ('project_installments',        'update', 'Authenticated can update installments',        'GATE', 'GATE'),
      ('project_installments',        'delete', 'Authenticated can delete installments',        'GATE', null),

      ('installment_events',          'select', 'Authenticated can read installment events',    'GATE', null),
      ('installment_events',          'insert', 'Authenticated can add installment events',     null,   'GATE'),

      ('installment_documents',       'select', 'Authenticated can read installment documents', 'GATE', null),
      ('installment_documents',       'insert', 'Authenticated can add installment documents',  null,   'GATE'),
      ('installment_documents',       'update', 'Authenticated can update installment documents','GATE','GATE'),
      ('installment_documents',       'delete', 'Authenticated can delete installment documents','GATE', null),

      ('project_checklist_templates', 'select', 'Authenticated can read checklist templates',   'GATE', null),
      ('project_checklist_templates', 'insert', 'Authenticated can add checklist templates',    null,   'GATE'),
      ('project_checklist_templates', 'update', 'Authenticated can update checklist templates', 'GATE', 'GATE'),
      ('project_checklist_templates', 'delete', 'Authenticated can delete checklist templates', 'GATE', null),

      ('app_visits',                  'insert', 'Authenticated can log a visit',                null,   'GATE')
    ) as v(tbl, cmd, pname, using_expr, check_expr)
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    execute format(
      'create policy %I on public.%I for %s to authenticated %s %s',
      r.pname, r.tbl, r.cmd,
      case when r.using_expr is not null then 'using (' || replace(r.using_expr, 'GATE', v_gate) || ')' else '' end,
      case when r.check_expr is not null then 'with check (' || replace(r.check_expr, 'GATE', v_gate) || ')' else '' end);
  end loop;
end
$repo$;

-- ----------------------------------------------------------------------------
-- 2b. mode = 'backup': replay the saved original policies
-- ----------------------------------------------------------------------------
do $bk$
declare
  v_mode text := (select mode from _tcm_rollback_mode);
  v_tbl  text;
  r      record;
  n      int := 0;
begin
  if v_mode <> 'backup' then
    return;
  end if;

  select tablename into v_tbl
  from pg_tables
  where schemaname = 'public' and tablename like '\_policy\_backup\_%'
  order by tablename
  limit 1;

  if v_tbl is null then
    raise exception 'mode is backup but no public._policy_backup_* table exists. Use mode repo.';
  end if;

  for r in execute format(
    'select tablename, policyname, permissive, roles, cmd, qual, with_check
       from public.%I
      where tablename = any (array[''projects'',''files'',''activity'',''progress_updates'',
                                   ''project_installments'',''installment_events'',
                                   ''installment_documents'',''project_checklist_templates'',
                                   ''app_visits''])', v_tbl)
  loop
    if to_regclass('public.' || r.tablename) is null then
      continue;
    end if;
    execute format(
      'create policy %I on public.%I as %s for %s to %s %s %s',
      r.policyname, r.tablename, lower(r.permissive), r.cmd,
      (select string_agg(quote_ident(x), ', ') from unnest(r.roles) as x),
      case when r.qual       is not null then 'using ('      || r.qual       || ')' else '' end,
      case when r.with_check is not null then 'with check (' || r.with_check || ')' else '' end);
    n := n + 1;
  end loop;
  raise notice 'replayed % policies from public.%', n, v_tbl;
end
$bk$;

-- ----------------------------------------------------------------------------
-- 3. Table grants as before the cutover (RLS stays enabled on all of these tables)
--    activity / installment_events stay SELECT+INSERT (the app never updates them).
-- ----------------------------------------------------------------------------
do $grants$
declare
  r record;
begin
  if (select mode from _tcm_rollback_mode) = 'none' then
    return;
  end if;
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
      ('app_visits',                  'select, insert')
    ) as v(tbl, privs)
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', r.tbl);
    execute format('revoke all on public.%I from public, anon, authenticated', r.tbl);
    execute format('grant %s on public.%I to authenticated', r.privs, r.tbl);
  end loop;
end
$grants$;

-- The old shared-account app could call these; the helpers stay executable by authenticated.
grant execute on function public.tcm_today() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. undo_hardening = 'YES': remove what auth-01 added on top of the first design.
--    Safe because: every statement is guarded (if exists), clear_must_change_password() is
--    first re-created WITHOUT the marker check (so the column can be dropped), and nothing here
--    touches data rows other than dropping the pw_marker column.
--    NOT undone on purpose: the "no data access while must_change_password" condition inside
--    is_admin / is_exec / can_view_project / can_edit_project (a security control; undoing
--    it means re-creating the helpers from an old copy of auth-01). If a person is locked out
--    by it, unlock THAT person (after they really changed their password, or you reset it):
--        update public.profiles set must_change_password = false where email = 'x@y.z';
--    The last-admin trigger is removed here, so be careful with profiles edits afterwards.
-- ----------------------------------------------------------------------------
do $undo$
begin
  if (select undo_hardening from _tcm_rollback_mode) <> 'YES' then
    raise notice 'undo_hardening = NO: last-admin trigger, pw_marker, set_pw_marker, revoke_user_sessions and files_storage_path_uq are kept.';
    return;
  end if;

  drop trigger if exists trg_profiles_last_admin on public.profiles;
  drop function if exists public.tg_profiles_last_admin();
  drop trigger if exists trg_profiles_pw_marker on public.profiles;
  drop function if exists public.tg_profiles_pw_marker();

  -- plain version (as in the very first auth-01), then the column is no longer referenced
  create or replace function public.clear_must_change_password()
  returns void language sql security definer set search_path = public
  as 'update public.profiles set must_change_password = false where id = auth.uid()';

  drop function if exists public.set_pw_marker(uuid);
  drop function if exists public.begin_password_reset(uuid);
  drop function if exists public.revoke_user_sessions(uuid);
  if to_regclass('public.profiles') is not null then
    alter table public.profiles drop column if exists pw_marker;
  end if;
  drop function if exists public._pw_fingerprint(text);
  -- my_profile() listed pw_marker explicitly: back to the plain version
  create or replace function public.my_profile()
  returns public.profiles language sql stable security definer set search_path = public
  as 'select p.* from public.profiles p where p.id = auth.uid() and p.active limit 1';
  -- files.uploader_id UPDATE guard (auth-02)
  drop trigger if exists trg_files_uploader_guard on public.files;
  drop function if exists public.tg_files_uploader_guard();

  drop index if exists public.files_storage_path_uq;
  raise notice 'undo_hardening done: last-admin trigger, pw_marker (column, triggers, functions), set_pw_marker, begin_password_reset, revoke_user_sessions, uploader guard, files_storage_path_uq removed.';
end
$undo$;

-- ----------------------------------------------------------------------------
-- 5. undo_project_managers = 'YES': remove the project-manager feature (auth-04).
--    Order matters: managers are first LISTED in public._project_managers_backup (admin-only,
--    never readable by clients), then turned into editors (they keep their edit rights, lose the
--    right to manage people; the change is written to audit_log by the membership trigger), then
--    the functions are dropped, then the role CHECK is narrowed again (it would fail while a
--    'manager' row exists, hence the conversion first).
--    can_edit_project() is NOT reverted: its 'editor','manager' list is harmless without manager
--    rows and auth-01 / auth-02 insist on it, so they can be re-run safely afterwards.
--    To restore the managers later (after re-running auth-04) - ONLY the rows of the LATEST undo run
--    (every run stamps its rows with the same undone_at = the transaction time), so a second undo can
--    never re-promote somebody who was deliberately demoted in between:
--      update public.project_members m set role = 'manager'
--        from public._project_managers_backup b
--       where b.project_id = m.project_id and b.user_id = m.user_id and m.role = 'editor'
--         and b.undone_at = (select max(undone_at) from public._project_managers_backup);
-- ----------------------------------------------------------------------------
do $undopm$
declare
  n_conv bigint;
  c      record;
begin
  if (select undo_project_managers from _tcm_rollback_mode) <> 'YES' then
    raise notice 'undo_project_managers = NO: project-manager role and functions are kept.';
    return;
  end if;

  if to_regclass('public._project_managers_backup') is null then
    create table public._project_managers_backup (
      undone_at  timestamptz not null default now(),
      project_id uuid        not null,
      user_id    uuid        not null
    );
  end if;
  alter table public._project_managers_backup enable row level security;
  revoke all on public._project_managers_backup from public, anon, authenticated;

  insert into public._project_managers_backup (project_id, user_id)
  select m.project_id, m.user_id from public.project_members m where m.role = 'manager';

  update public.project_members set role = 'editor' where role = 'manager';
  get diagnostics n_conv = row_count;

  drop function if exists public.set_project_member(uuid, uuid, text);
  drop function if exists public.remove_project_member(uuid, uuid);
  drop function if exists public.find_user_for_project(uuid, text);
  drop function if exists public.list_project_members(uuid);
  drop function if exists public.is_project_manager(uuid);

  for c in
    select conname from pg_constraint
    where conrelid = 'public.project_members'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ~* '\mrole\M'
  loop
    execute format('alter table public.project_members drop constraint %I', c.conname);
  end loop;
  alter table public.project_members
    add constraint project_members_role_chk check (role in ('editor','viewer'));

  raise notice 'undo_project_managers done: % manager row(s) became editor (listed in public._project_managers_backup); functions dropped; role CHECK is (editor, viewer) again. Re-run auth-04 to bring the feature back.', n_conv;
end
$undopm$;

commit;

-- ============================================================================
-- Verify (read-only):
--   select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1,2;
--   after undo_project_managers = 'YES':
--   select role, count(*) from public.project_members group by 1;           -- no 'manager'
--   select * from public._project_managers_backup;                           -- who they were
-- ============================================================================
