-- ============================================================================
-- AUTH 04 - PROJECT MANAGERS  ("Project Co as project admin")
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   ทั้งไฟล์อยู่ใน transaction เดียว (ผิดพลาด = ไม่มีอะไรเปลี่ยน) และรันซ้ำได้ (idempotent)
--
-- RUN ORDER
--   auth-01  ->  auth-02  ->  THIS FILE  (auth-04).  On the LIVE database run it AFTER auth-02.
--   It is SAFE TO RUN WHILE THE APP IS LIVE: nothing changes for anybody until an admin makes
--   somebody a 'manager' (the role value is unused today; no existing row, policy, grant or
--   helper answer changes for editor / viewer / exec / admin).
--   It may be re-run at any time, and auth-01 / auth-02 may be re-run AFTER it: the current
--   auth-01 keeps 'manager' rows and the 3-value CHECK, and the current auth-02 preflight
--   refuses to run on helpers / constraints that do not know 'manager'.
--
-- WHAT IT ADDS
--   A per-project role 'manager' in public.project_members. A manager of project P:
--     * is also an EDITOR of P  (can_edit_project(P) = true) and sees it (can_view_project(P))
--     * may add / remove / change the people of P - through the RPCs below ONLY
--     * may appoint OTHER managers of P (not himself: nobody but an admin can change or remove
--       his own membership row)
--     * may only add EXISTING accounts that are active, global role 'user' - never creates
--       accounts (api/admin-users stays admin-only), never touches admin / exec accounts
--     * finds people by EXACT full e-mail only (case-insensitive); there is no listing
--     * can NOT create / delete projects, change profiles / global roles, touch other projects,
--       read or write audit_log, or write project_members directly (RLS: admin only)
--
--   columns/constraint  project_members_role_chk now: role in ('editor','viewer','manager')
--   functions (all SECURITY DEFINER, SET search_path = public, EXECUTE: authenticated only)
--     public.is_project_manager(p uuid)                          returns boolean
--     public.list_project_members(p_project uuid)                returns table(user_id uuid, email text, full_name text, role text, active boolean)
--     public.find_user_for_project(p_project uuid, p_email text) returns table(user_id uuid, email text, full_name text, member_role text)
--     public.set_project_member(p_project uuid, p_user uuid, p_role text)   returns void
--     public.remove_project_member(p_project uuid, p_user uuid)             returns void
--     public.can_edit_project(uuid)   re-created (manager counts as editor; SAME body as auth-01)
--
--   ERRORS (message is exactly the code; human text is in DETAIL; PostgREST: {code,message,details})
--     42501 FORBIDDEN               caller is not an active, password-changed admin / manager of the project
--                                   (also: no JWT / anon / viewer / editor / exec / non-member / inactive / must-change)
--     42501 SELF_CHANGE_FORBIDDEN   a non-admin tried to set / remove his OWN membership
--     22023 INVALID_ROLE            p_role not in ('editor','viewer','manager')
--     P0002 PROJECT_NOT_FOUND       set_project_member on a project that does not exist (reachable by an admin only;
--                                   a non-admin asking about a missing project gets FORBIDDEN)
--     P0002 TARGET_NOT_ELIGIBLE     target is not an ACTIVE profile with global role 'user' (or is null)
--     anon without EXECUTE gets 42501 "permission denied for function" from Postgres itself.
--   Concurrency: set_/remove_project_member take a transaction-scoped advisory lock per project
--   (hashtextextended(project_id::text, 0)) before the authorisation check, so two managers who remove or
--   demote each other at the same moment cannot both succeed (the second is refused with FORBIDDEN).
--   There is deliberately NO "last manager" rule: an admin can always fix a project without a manager.
--   If the target account is deleted while set_project_member runs, the FK error becomes
--   P0002 TARGET_NOT_ELIGIBLE (never a raw 23503).
--   Check order in set_project_member: authorisation -> role value -> project exists -> self -> target.
--
--   AUDIT: the existing trigger trg_audit_project_members writes the row. SECURITY DEFINER does not
--   change auth.uid() / the JWT claims, so audit_log shows the REAL actor (the manager: user_id,
--   user_email) plus project_id, row_id 'project:user', details.target_email and the role
--   (insert: details.role; update: details.role = {old,new}; delete: the removed row).
--   Setting a role the person already has changes nothing and writes no audit row.
--
-- UNDO: scripts/auth-03-rollback.sql, option undo_project_managers = 'YES'
--   (managers become editors - listed first in public._project_managers_backup - then the
--   functions are dropped and the old 2-value CHECK is restored).
-- ============================================================================

begin;
-- give up (and roll everything back) instead of queueing behind a long-running query
set local lock_timeout = '10s';

-- ----------------------------------------------------------------------------
-- 0. Preflight
-- ----------------------------------------------------------------------------
do $pre$
declare
  f text;
begin
  if to_regclass('public.projects') is null or to_regclass('public.profiles') is null
     or to_regclass('public.project_members') is null then
    raise exception 'public.projects / profiles / project_members missing. Run scripts/auth-01-foundation.sql first.';
  end if;
  foreach f in array array['public.my_profile()','public.is_admin()','public.is_exec()',
                           'public.can_view_project(uuid)','public.can_edit_project(uuid)']
  loop
    if to_regprocedure(f) is null then
      raise exception 'Missing function %. Run the CURRENT scripts/auth-01-foundation.sql first.', f;
    end if;
  end loop;
  -- the unique key the upsert below relies on
  if not exists (
    select 1 from pg_index i
    where i.indrelid = 'public.project_members'::regclass
      and i.indisunique and i.indpred is null and i.indnatts = 2
      and (select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[]))
          = array['project_id','user_id']
  ) then
    raise exception 'public.project_members has no UNIQUE (project_id, user_id). Run the CURRENT scripts/auth-01-foundation.sql first.';
  end if;
end
$pre$;

-- ----------------------------------------------------------------------------
-- 2. can_edit_project: manager counts as editor.
--    IDENTICAL to the definition in auth-01 (a live DB that ran an older auth-01 gets it here).
--    CREATE OR REPLACE keeps the existing privileges; they are re-stated below anyway.
-- ----------------------------------------------------------------------------
create or replace function public.can_edit_project(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles pr
    where pr.id = auth.uid()
      and pr.active
      and not pr.must_change_password         -- temp-password holder: no data access yet
      and (
        pr.role = 'admin'
        or (pr.role = 'user' and exists (
              select 1 from public.project_members m
              where m.project_id = p and m.user_id = pr.id and m.role in ('editor','manager')))
      )
  )
$$;

-- ----------------------------------------------------------------------------
-- 3. is_project_manager(p): active admin (any project) or active 'user' profile with a
--    'manager' row for p. Same gate as the other helpers: a profile that is inactive or still
--    holds a temporary password (must_change_password) is never a manager. exec never is.
-- ----------------------------------------------------------------------------
create or replace function public.is_project_manager(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles pr
    where pr.id = auth.uid()
      and pr.active
      and not pr.must_change_password
      and (
        pr.role = 'admin'
        or (pr.role = 'user' and exists (
              select 1 from public.project_members m
              where m.project_id = p and m.user_id = pr.id and m.role = 'manager'))
      )
  )
$$;

-- ----------------------------------------------------------------------------
-- 4. list_project_members(p_project): the members of ONE project (admin / manager of it only).
--    Order: manager -> editor -> viewer, then name (e-mail when no name).
-- ----------------------------------------------------------------------------
create or replace function public.list_project_members(p_project uuid)
returns table(user_id uuid, email text, full_name text, role text, active boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if p_project is null or not public.is_project_manager(p_project) then
    raise exception 'FORBIDDEN' using errcode = '42501',
      detail = 'only an admin or a manager of this project may list its members';
  end if;
  return query
    select m.user_id, pf.email, pf.full_name, m.role, pf.active
    from public.project_members m
    join public.profiles pf on pf.id = m.user_id
    where m.project_id = p_project
    order by case m.role when 'manager' then 0 when 'editor' then 1 else 2 end,
             lower(coalesce(nullif(btrim(pf.full_name), ''), pf.email)),
             lower(pf.email);
end $$;

-- ----------------------------------------------------------------------------
-- 5. find_user_for_project(p_project, p_email): EXACT, case-insensitive, trimmed e-mail match.
--    Equality only (no LIKE, no wildcard, no prefix): wildcards in the input are ordinary
--    characters that simply match nothing. Only ACTIVE profiles with global role 'user' are
--    returned; admin / exec / inactive / unknown -> 0 rows (indistinguishable from "not found").
--    member_role = the person's current role in p_project, or NULL.
--    empty / NULL / longer than 254 characters -> 0 rows.
-- ----------------------------------------------------------------------------
create or replace function public.find_user_for_project(p_project uuid, p_email text)
returns table(user_id uuid, email text, full_name text, member_role text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_email text;
begin
  if p_project is null or not public.is_project_manager(p_project) then
    raise exception 'FORBIDDEN' using errcode = '42501',
      detail = 'only an admin or a manager of this project may look people up';
  end if;
  v_email := btrim(p_email, E' \t\r\n');
  if v_email is null or v_email = '' or length(v_email) > 254 then
    return;
  end if;
  return query
    select pf.id, pf.email, pf.full_name,
           (select m.role from public.project_members m
             where m.project_id = p_project and m.user_id = pf.id)
    from public.profiles pf
    where lower(pf.email) = lower(v_email)
      and pf.active
      and pf.role = 'user'
    limit 1;
end $$;

-- ----------------------------------------------------------------------------
-- 6. set_project_member(p_project, p_user, p_role): add or change one membership (upsert).
-- ----------------------------------------------------------------------------
create or replace function public.set_project_member(p_project uuid, p_user uuid, p_role text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- Serialise every membership change of ONE project BEFORE the authorisation check: a second caller
  -- waits here, then re-evaluates is_project_manager() against the first one's committed result (READ
  -- COMMITTED takes a fresh snapshot per statement). Two managers removing / demoting each other at
  -- the same moment therefore cannot both succeed. (NULL project: no lock; the check refuses anyway.)
  if p_project is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_project::text, 0));
  end if;
  if p_project is null or not public.is_project_manager(p_project) then
    raise exception 'FORBIDDEN' using errcode = '42501',
      detail = 'only an admin or a manager of this project may change its members';
  end if;
  if p_role is null or p_role not in ('editor','viewer','manager') then
    raise exception 'INVALID_ROLE' using errcode = '22023',
      detail = 'role must be editor, viewer or manager';
  end if;
  if not exists (select 1 from public.projects pj where pj.id = p_project) then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_user is not distinct from auth.uid() and not public.is_admin() then
    raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501',
      detail = 'a manager cannot change his own membership; ask an admin';
  end if;
  if p_user is null or not exists (
       select 1 from public.profiles pf
       where pf.id = p_user and pf.active and pf.role = 'user') then
    raise exception 'TARGET_NOT_ELIGIBLE' using errcode = 'P0002',
      detail = 'the target must be an existing, active account with global role user';
  end if;

  begin
    insert into public.project_members (project_id, user_id, role)
    values (p_project, p_user, p_role)
    on conflict (project_id, user_id) do update set role = excluded.role;
  exception when foreign_key_violation then
    -- the account (or, for an admin, the project) was deleted between the checks above and the write
    if not exists (select 1 from public.projects pj where pj.id = p_project) then
      raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'TARGET_NOT_ELIGIBLE' using errcode = 'P0002',
      detail = 'the target account no longer exists';
  end;
end $$;

-- ----------------------------------------------------------------------------
-- 7. remove_project_member(p_project, p_user): delete one membership (no-op when absent).
--    Works for any member row of the project (also an inactive person's, also a fellow
--    manager's); a non-admin can never remove himself.
-- ----------------------------------------------------------------------------
create or replace function public.remove_project_member(p_project uuid, p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- same per-project serialisation as set_project_member (see there)
  if p_project is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_project::text, 0));
  end if;
  if p_project is null or not public.is_project_manager(p_project) then
    raise exception 'FORBIDDEN' using errcode = '42501',
      detail = 'only an admin or a manager of this project may change its members';
  end if;
  if p_user is not distinct from auth.uid() and not public.is_admin() then
    raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501',
      detail = 'a manager cannot remove his own membership; ask an admin';
  end if;
  delete from public.project_members m
   where m.project_id = p_project and m.user_id = p_user;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Privileges: signed-in users only (anon and PUBLIC lose EXECUTE; the functions themselves
--    refuse everyone who is not an admin / manager of the project).
-- ----------------------------------------------------------------------------
revoke all on function public.can_edit_project(uuid)                      from public, anon;
revoke all on function public.is_project_manager(uuid)                    from public, anon;
revoke all on function public.list_project_members(uuid)                  from public, anon;
revoke all on function public.find_user_for_project(uuid, text)           from public, anon;
revoke all on function public.set_project_member(uuid, uuid, text)        from public, anon;
revoke all on function public.remove_project_member(uuid, uuid)           from public, anon;
grant execute on function public.can_edit_project(uuid)                   to authenticated;
grant execute on function public.is_project_manager(uuid)                 to authenticated;
grant execute on function public.list_project_members(uuid)               to authenticated;
grant execute on function public.find_user_for_project(uuid, text)        to authenticated;
grant execute on function public.set_project_member(uuid, uuid, text)     to authenticated;
grant execute on function public.remove_project_member(uuid, uuid)        to authenticated;

-- ----------------------------------------------------------------------------
-- 9a. role CHECK: allow 'manager'  (only touched when it does not allow it yet).
--    Deliberately the LAST DDL of the transaction: dropping / adding the CHECK takes an ACCESS
--    EXCLUSIVE lock on project_members that is held until COMMIT, so everything else is done first and
--    the table is blocked for milliseconds only. Nothing above depends on the new value.
--    Every old CHECK that mentions `role` is replaced by project_members_role_chk.
--    No row can violate the wider set, so there is no data change and no risk to the live app.
-- ----------------------------------------------------------------------------
do $chk$
declare
  c record;
  v_ok boolean;
begin
  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.project_members'::regclass and conname = 'project_members_role_chk'
      and pg_get_constraintdef(oid) ~ '''manager''' and pg_get_constraintdef(oid) ~ '''editor'''
      and pg_get_constraintdef(oid) ~ '''viewer'''
  ) into v_ok;
  if v_ok then
    raise notice 'project_members_role_chk already allows manager - unchanged.';
    return;
  end if;
  for c in
    select conname from pg_constraint
    where conrelid = 'public.project_members'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ~* '\mrole\M'
  loop
    execute format('alter table public.project_members drop constraint %I', c.conname);
  end loop;
  alter table public.project_members
    add constraint project_members_role_chk check (role in ('editor','viewer','manager'));
  raise notice 'project_members_role_chk now allows editor, viewer, manager.';
end
$chk$;

-- ----------------------------------------------------------------------------
-- 9b. Self-check (the whole run is rolled back if any of this is not true)
-- ----------------------------------------------------------------------------
do $verify$
declare
  f   text;
  r   text;
  rec record;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.project_members'::regclass and conname = 'project_members_role_chk'
      and pg_get_constraintdef(oid) ~ '''manager'''
  ) then
    raise exception 'project_members_role_chk does not allow manager';
  end if;

  if (select prosrc from pg_proc where oid = 'public.can_edit_project(uuid)'::regprocedure) !~ '''manager''' then
    raise exception 'can_edit_project(uuid) does not treat manager as editor';
  end if;

  foreach f in array array['public.is_project_manager(uuid)','public.list_project_members(uuid)',
                           'public.find_user_for_project(uuid,text)','public.set_project_member(uuid,uuid,text)',
                           'public.remove_project_member(uuid,uuid)']
  loop
    select p.prosecdef, p.proconfig into rec from pg_proc p where p.oid = f::regprocedure;
    if not rec.prosecdef then
      raise exception 'SECURITY: % is not SECURITY DEFINER', f;
    end if;
    if rec.proconfig is null or not ('search_path=public' = any (rec.proconfig)) then
      raise exception 'SECURITY: % has no fixed search_path', f;
    end if;
    foreach r in array array['anon'] loop
      if has_function_privilege(r, f::regprocedure, 'execute') then
        raise exception 'SECURITY: role % can EXECUTE %', r, f;
      end if;
    end loop;
    if not has_function_privilege('authenticated', f::regprocedure, 'execute') then
      raise exception 'authenticated cannot EXECUTE % - the app could not call it', f;
    end if;
  end loop;
  raise notice 'auth-04 self-check OK: manager role + 5 functions in place, anon closed, authenticated open.';
end
$verify$;

-- make PostgREST pick up the new functions at once (delivered at COMMIT)
notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- AFTER COMMIT (read-only; run separately):
--   select proname, prosecdef, proconfig from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('is_project_manager','list_project_members','find_user_for_project',
--                     'set_project_member','remove_project_member','can_edit_project') order by 1;
--   select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.project_members'::regclass and conname = 'project_members_role_chk';
--   -- who is a manager where:
--   select p.code, pf.email from public.project_members m
--   join public.projects p on p.id = m.project_id join public.profiles pf on pf.id = m.user_id
--   where m.role = 'manager' order by 1, 2;
--   Then run scripts/auth-test.sql (it exercises everything above).
-- ============================================================================
