-- ============================================================================
-- AUTH 01 - FOUNDATION  (real per-person login: profiles, membership, helpers, audit)
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์นี้ -> Run
--   รันซ้ำได้อย่างปลอดภัย (idempotent) และทั้งไฟล์อยู่ใน transaction เดียว
--   ถ้าผิดพลาดตรงไหน จะไม่มีอะไรถูกเปลี่ยนค้างครึ่งๆ กลางๆ
--
-- THIS FILE IS ADDITIVE.  It is SAFE TO RUN WHILE THE CURRENT (shared-account) APP
-- IS LIVE:
--   * it does NOT drop, rename or alter any existing policy
--   * it does NOT revoke any existing grant of `authenticated` (the one exception: an
--     already-existing public.project_members loses its `anon` grant - anon never had a
--     policy there, and the live app does not use that table)
--   * it does NOT turn RLS on/off on any existing app table
--   * the only existing table it modifies is public.project_members (see section 2;
--     the live app never reads or writes it - grep of src/ shows no use)
--   * it adds AFTER-row audit triggers to the app tables. They write to
--     public.audit_log, can never make the original statement fail (an audit error
--     is turned into a Postgres WARNING in the logs, the statement still succeeds)
--     and are cheap (see section 8).
--   The shared account keeps working exactly as today until scripts/auth-02-enforce-rls.sql.
--
-- ORDER OF OPERATIONS FOR THE CUTOVER
--   1. Run the read-only PRE-FLIGHT queries at the bottom of this file (optional but
--      recommended - they confirm assumptions about the live DB).
--   2. Run THIS file.
--   2b. Read the LAST RESULT ROW and the WARNINGs: if the old signup-whitelist trigger is
--      still on auth.users, turn OFF "Allow new users to sign up" FIRST, then drop it
--      (exact statements are printed; full runbook: scripts/AUTH_CUTOVER.md).
--   3. Dashboard -> Authentication -> Users -> Add user (your own email + password,
--      tick "Auto confirm"), then run the BOOTSTRAP block at the bottom -> you are admin.
--   4. Deploy the new app + the admin serverless function; create users and assign
--      projects from the admin UI.
--   5. Run scripts/auth-test.sql (after 01 only the function/profile checks apply).
--   6. Run scripts/auth-02-enforce-rls.sql  (the cutover; old shared-account app stops).
--   7. Run scripts/auth-test.sql again - every check must be PASS.
--   Emergency: scripts/auth-03-rollback.sql.
--
-- WHAT THIS FILE CREATES
--   tables     public.profiles, public.audit_log
--              public.project_members (created, or migrated in place if it exists)
--              public._project_members_pre_auth (backup copy; only if project_members existed)
--   functions  public.my_profile()  public.is_admin()  public.is_exec()
--              public.can_view_project(uuid)  public.can_edit_project(uuid)
--              public.clear_must_change_password()           (needs a REAL password change)
--              public.bootstrap_first_admin(text)            (SQL editor only)
--              public.set_pw_marker(uuid)                    (service_role only; admin API)
--              public.begin_password_reset(uuid)             (service_role only; admin API, FIRST step of a reset)
--              public.revoke_user_sessions(uuid)             (service_role only; admin API)
--              internal: _audit_trunc/_audit_clean/_audit_diff/_audit_write,
--                        tg_audit_generic(), tg_audit_files(), _pw_fingerprint(text),
--                        tg_profiles_last_admin(), tg_profiles_pw_marker()
--   columns    public.profiles.pw_marker (sha256 fingerprint of the password hash that was
--              current when an admin set/reset the password; never the hash itself)
--   triggers   trg_audit_<table> on projects, project_installments, progress_updates,
--              installment_documents, project_checklist_templates, project_members;
--              trg_audit_files_ins/_upd/_del; trg_audit_profiles_ins/_upd/_del
--              trg_profiles_last_admin (BEFORE UPDATE/DELETE: never leave 0 USABLE admins (active, no temp password);
--                                       also binds service_role)
--              trg_profiles_pw_marker  (BEFORE INSERT / must_change flip: auto pw_marker)
--   indexes    files_storage_path_uq (unique, ONLY created if no duplicate storage_path exists)
--   policies   profiles_select_own, profiles_select_admin,
--              pm_admin_all, pm_select_own, pm_select_exec, audit_log_select_admin
--
-- SECURITY NOTES (lessons from the earlier whitelist-trigger incident)
--   * Every SECURITY DEFINER function here has `SET search_path = public` and uses
--     schema-qualified names (public.xxx, auth.xxx).
--   * Helper functions are SECURITY DEFINER so that the RLS policies on profiles /
--     project_members can call them WITHOUT re-entering RLS (no recursion): the
--     functions run as their owner (postgres), who owns those tables and is not
--     subject to RLS (we never use FORCE ROW LEVEL SECURITY). Section 9 verifies
--     this at the end of the run and aborts the whole transaction if it is not true.
--   * EXECUTE is revoked from public/anon on every function; internal functions,
--     bootstrap_first_admin, set_pw_marker and revoke_user_sessions are also revoked from
--     `authenticated` (nobody can forge audit rows, make themselves admin or kill other
--     people's sessions through the API). set_pw_marker/revoke_user_sessions are granted
--     to service_role only.
--   * MUST-CHANGE-PASSWORD IS ENFORCED IN THE DATABASE once auth-02 has run (before it the legacy
--     USING(true) policies still expose the data): while
--     profiles.must_change_password is true, is_admin / is_exec / can_view_project /
--     can_edit_project all answer false, so a holder of an admin-issued temporary password
--     can read or write NO project data through PostgREST. Still usable by that person:
--     my_profile(), reading their own profiles row, auth.updateUser (GoTrue, not SQL) and
--     clear_must_change_password(), which succeeds only after auth.users.encrypted_password
--     has really changed compared with the fingerprint stored in profiles.pw_marker.
--   * LAST-ADMIN BACKSTOP: trg_profiles_last_admin refuses any UPDATE/DELETE that would
--     leave zero usable admins (active AND must_change_password = false), for every role incl.
--     service_role / postgres. An admin still holding a temporary password does not count.
-- ============================================================================

begin;
-- give up (and roll everything back) instead of queueing behind a long-running query
set local lock_timeout = '10s';

-- ----------------------------------------------------------------------------
-- 0. Preflight: refuse to run on a database that does not look like ours
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.projects') is null then
    raise exception 'public.projects does not exist - wrong database?';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'auth.users does not exist - this must run on the Supabase project database';
  end if;
  -- projects.id must be uuid (it is: project-tracking.sql has uuid FKs to it)
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects'
      and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'public.projects.id is not uuid; this migration assumes uuid';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. public.profiles
--    One row per person allowed to use the app. NO row (or active = false) means
--    NO access to anything once auth-02 has run - that is how the shared account
--    public@teamcm.co.th is shut out.
--    Written only by the service role (admin serverless function), by
--    bootstrap_first_admin() and by clear_must_change_password().
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text not null,
  full_name            text,
  role                 text not null,
  active               boolean not null default true,
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  constraint profiles_role_chk check (role in ('admin','exec','user'))
);

-- added after the fact so a re-run on an older copy of this table also gets it.
-- pw_marker = sha256 hex of auth.users.encrypted_password at the moment an admin issued a
-- temporary password (see set_pw_marker / tg_profiles_pw_marker). NULL = no marker
-- (bootstrap admin / legacy row): clear_must_change_password() then behaves as before.
alter table public.profiles add column if not exists pw_marker text;

create unique index if not exists profiles_email_lower_uq on public.profiles (lower(email));

alter table public.profiles enable row level security;

-- brand-new table: lock the grants down to what the API may do (SELECT; RLS narrows it)
revoke all on public.profiles from public, anon, authenticated;
-- COLUMN-level SELECT: pw_marker (a fingerprint of a password hash) is never readable by a
-- client. Consequence: a client query must NAME its columns; `select *` / `?select=*` on
-- public.profiles from a signed-in user fails with 42501. (src/ and api/ do name them.)
grant select (id, email, full_name, role, active, must_change_password, created_at, created_by)
  on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- 2. public.project_members  (create, or migrate the OLD ACL shape in place)
--    Old shape (SQL_SCHEMA.sql): id uuid PK, project_id, user_id, role default
--    'viewer' (owner/manager/editor/viewer), created_at timestamp, UNIQUE(project_id,user_id).
--    New contract: (project_id, user_id, role in ('editor','viewer'), created_at),
--    exactly one row per (project, user).
--    If the table exists:
--      a. a backup copy is taken ONCE into public._project_members_pre_auth
--      b. missing columns are added (project_id, user_id, role, created_at)
--      c. role mapping: owner/manager/editor -> 'editor'; viewer -> 'viewer';
--         NULL or any unknown value -> 'viewer' (least privilege)
--      d. rows with NULL project_id/user_id, or pointing at a project / auth user that
--         no longer exists, are deleted (unusable; they are in the backup)
--      e. duplicate (project_id,user_id) rows are collapsed (editor wins)
--      f. NOT NULL on project_id/user_id/role; FKs added if absent (ON DELETE CASCADE);
--         a UNIQUE index on (project_id,user_id) is added if none exists
--      g. every old CHECK that mentions `role` is dropped and replaced by
--         project_members_role_chk (role in ('editor','viewer'))
--      The legacy `id` column (if present) is KEPT; nothing depends on it.
--      Existing policies/grants on it are untouched.
-- ----------------------------------------------------------------------------
do $pm$
declare
  v_existed boolean := to_regclass('public.project_members') is not null;
  c         record;
  v_mapped  bigint := 0;
  v_deleted bigint := 0;
  v_deduped bigint := 0;
  v_has_uq  boolean;
begin
  if not v_existed then
    create table public.project_members (
      project_id uuid        not null references public.projects(id) on delete cascade,
      user_id    uuid        not null references auth.users(id)      on delete cascade,
      role       text        not null default 'viewer',
      created_at timestamptz not null default now(),
      primary key (project_id, user_id)
    );
    -- brand-new table: no anon access at all
    revoke all on public.project_members from public, anon;
    raise notice 'project_members: did not exist -> CREATED with the new shape.';
  else
    -- a. one-time backup (kept if it already exists, so a re-run never overwrites it)
    if to_regclass('public._project_members_pre_auth') is null then
      create table public._project_members_pre_auth as select * from public.project_members;
      raise notice 'project_members: backup copy created in public._project_members_pre_auth';
    end if;
    alter table public._project_members_pre_auth enable row level security;
    revoke all on public._project_members_pre_auth from public, anon, authenticated;
    -- anon never had a policy on this table; take the privilege away as well
    revoke all on public.project_members from public, anon;

    -- b. columns
    alter table public.project_members add column if not exists project_id uuid;
    alter table public.project_members add column if not exists user_id    uuid;
    alter table public.project_members add column if not exists role       text;
    alter table public.project_members add column if not exists created_at timestamptz default now();

    -- g (first half). drop every CHECK mentioning role so the mapping below cannot trip it
    for c in
      select conname from pg_constraint
      where conrelid = 'public.project_members'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ~* '\mrole\M'
    loop
      execute format('alter table public.project_members drop constraint %I', c.conname);
      raise notice 'project_members: dropped old CHECK constraint %', c.conname;
    end loop;

    -- c. role mapping
    update public.project_members
       set role = case when role in ('owner','manager','editor') then 'editor' else 'viewer' end
     where role is distinct from case when role in ('owner','manager','editor') then 'editor' else 'viewer' end;
    get diagnostics v_mapped = row_count;

    -- d. unusable rows
    delete from public.project_members m
     where m.project_id is null
        or m.user_id is null
        or not exists (select 1 from public.projects p where p.id = m.project_id)
        or not exists (select 1 from auth.users u where u.id = m.user_id);
    get diagnostics v_deleted = row_count;

    -- e. duplicates (keep the editor row, else the oldest)
    delete from public.project_members
     where ctid in (
       select d.ctid from (
         select ctid,
                row_number() over (
                  partition by project_id, user_id
                  order by (role = 'editor') desc, created_at nulls last
                ) as rn
         from public.project_members
       ) d
       where d.rn > 1
     );
    get diagnostics v_deduped = row_count;

    -- f. NOT NULLs, default, FKs, uniqueness
    alter table public.project_members alter column project_id set not null;
    alter table public.project_members alter column user_id    set not null;
    alter table public.project_members alter column role       set default 'viewer';
    alter table public.project_members alter column role       set not null;

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.project_members'::regclass and contype = 'f'
        and confrelid = 'public.projects'::regclass
    ) then
      alter table public.project_members
        add constraint project_members_project_fk
        foreign key (project_id) references public.projects(id) on delete cascade;
    end if;
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.project_members'::regclass and contype = 'f'
        and confrelid = 'auth.users'::regclass
    ) then
      alter table public.project_members
        add constraint project_members_user_fk
        foreign key (user_id) references auth.users(id) on delete cascade;
    end if;

    select exists (
      select 1 from pg_index i
      where i.indrelid = 'public.project_members'::regclass
        and i.indisunique and i.indpred is null and i.indnatts = 2
        and (select array_agg(a.attname::text order by a.attname)
               from pg_attribute a
              where a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[]))
            = array['project_id','user_id']
    ) into v_has_uq;
    if not v_has_uq then
      create unique index project_members_project_user_uq
        on public.project_members (project_id, user_id);
    end if;

    raise notice 'project_members: existed -> migrated. roles rewritten: %, unusable rows deleted: %, duplicates removed: %',
      v_mapped, v_deleted, v_deduped;
  end if;

  -- g (second half). the new CHECK (both paths)
  alter table public.project_members drop constraint if exists project_members_role_chk;
  alter table public.project_members
    add constraint project_members_role_chk check (role in ('editor','viewer'));
end
$pm$;

create index if not exists idx_project_members_user_id on public.project_members (user_id);

alter table public.project_members enable row level security;
-- additive: admin UI may write through the API under the admin policy below
grant select, insert, update, delete on public.project_members to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Helper functions
--    All: LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, schema-qualified.
--    "Active" = a profiles row exists with active = true. No profile / inactive
--    => every function answers false / null.
--    RECURSION: the policies on profiles and project_members call these functions;
--    the functions read those same tables. This cannot loop because the functions
--    execute as their owner, and an owner is exempt from RLS on tables it owns
--    (FORCE ROW LEVEL SECURITY is never used). So the inner SELECTs never evaluate
--    any policy, hence never call the functions again. Section 9 asserts the premise.
-- ----------------------------------------------------------------------------

-- row of the caller's ACTIVE profile, or null (callers: check `id is null`)
create or replace function public.my_profile()
returns public.profiles
language sql
stable
security definer
set search_path = public
as $$
  -- explicit column list (NOT p.*): pw_marker is returned as NULL, never to the client.
  -- Keep this list in table order and complete: the SQL function body is validated against
  -- the composite type, so a profiles column added later makes this CREATE fail loudly.
  select p.id, p.email, p.full_name, p.role, p.active, p.must_change_password,
         p.created_at, p.created_by, null::text as pw_marker
  from public.profiles p
  where p.id = auth.uid() and p.active
  limit 1
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'
      and not p.must_change_password          -- temp-password holder: no privileges yet
  )
$$;

create or replace function public.is_exec()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'exec'
      and not p.must_change_password          -- temp-password holder: no privileges yet
  )
$$;

-- admin or exec: every project. user: only projects with any membership row.
create or replace function public.can_view_project(p uuid)
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
        pr.role in ('admin','exec')
        or (pr.role = 'user' and exists (
              select 1 from public.project_members m
              where m.project_id = p and m.user_id = pr.id))
      )
  )
$$;

-- admin: every project. user: only projects where membership role = 'editor'.
-- exec is NEVER an editor (read-only), even if a membership row exists.
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
              where m.project_id = p and m.user_id = pr.id and m.role = 'editor'))
      )
  )
$$;

-- Fingerprint of a password hash (sha256 hex). pw_marker stores THIS, never the hash itself.
-- STRICT: null in -> null out.
create or replace function public._pw_fingerprint(p_hash text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select encode(sha256(convert_to(p_hash, 'utf8')), 'hex')
$$;

-- Called by the app after the user has set a new password (auth.updateUser). Touches ONLY the
-- caller's row.
-- ENFORCED: if the profile carries a pw_marker (an admin issued a temporary password, see
-- set_pw_marker / tg_profiles_pw_marker) the call succeeds only when the caller's CURRENT
-- auth.users.encrypted_password differs from it, i.e. a real password change happened.
-- Otherwise it raises PASSWORD_NOT_CHANGED (SQLSTATE P0001). pw_marker NULL (bootstrap admin /
-- legacy row) = no check, as before. After success the marker is cleared.
create or replace function public.clear_must_change_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_must   boolean;
  v_marker text;
  v_cur    text;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: no signed-in user' using errcode = '28000';
  end if;

  select pf.must_change_password, pf.pw_marker into v_must, v_marker
  from public.profiles pf where pf.id = v_uid for update;
  if not found then
    return;                                   -- no profile: nothing to clear (as before)
  end if;

  if v_must and v_marker is not null then
    -- 'RESET_PENDING' (set by begin_password_reset) is refused ALWAYS: an admin reset is in
    -- flight, so no password state can be trusted until set_pw_marker stamps the real one.
    select u.encrypted_password into v_cur from auth.users u where u.id = v_uid;
    if v_marker = 'RESET_PENDING'
       or (v_cur is not null and public._pw_fingerprint(v_cur) = v_marker) then
      raise exception 'PASSWORD_NOT_CHANGED: รหัสผ่านยังไม่ได้ถูกเปลี่ยน กรุณาตั้งรหัสผ่านใหม่ก่อน / the password has not been changed yet; set a new password first'
        using errcode = 'P0001',
              hint = 'Call supabase.auth.updateUser({ password }) first, then clear_must_change_password().';
    end if;
  end if;

  update public.profiles
     set must_change_password = false, pw_marker = null
   where id = v_uid;
end $$;

-- Service-role only (admin serverless function): call it right after creating a user / resetting
-- a password (and after the profile row exists). Records the fingerprint of the CURRENT
-- (temporary) password hash so clear_must_change_password() can tell when it really changed.
-- It also REPLACES the 'RESET_PENDING' sentinel left by begin_password_reset().
-- Returns true when a profile row was stamped; FALSE (and nothing is stamped) when there is no
-- profile or the user's password hash is NULL/empty (a marker of "nothing" would be meaningless).
create or replace function public.set_pw_marker(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n      bigint;
  v_hash text;
begin
  select u.encrypted_password into v_hash from auth.users u where u.id = p_user;
  if v_hash is null or btrim(v_hash) = '' then
    return false;
  end if;
  update public.profiles pf
     set pw_marker = public._pw_fingerprint(v_hash)
   where pf.id = p_user;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Service-role only. FIRST step of an admin password RESET (call it BEFORE writing the new
-- password): forces must_change_password = true and sets pw_marker to the sentinel
-- 'RESET_PENDING', which clear_must_change_password() refuses unconditionally. Closes the
-- window in which the flag was already true, the marker still held the OLD fingerprint and the
-- person's live session could clear the flag as soon as the new hash was written.
-- Sequence for the API:  begin_password_reset(id) -> write the new password ->
-- revoke_user_sessions(id) -> set_pw_marker(id)  (stamps the real fingerprint; replaces the
-- sentinel). If the sequence dies half-way the person simply stays blocked; run it again.
-- Returns false when the user has no profile.
create or replace function public.begin_password_reset(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  update public.profiles pf
     set must_change_password = true, pw_marker = 'RESET_PENDING'
   where pf.id = p_user;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Service-role only: kill every session / refresh token of a user (deactivation, password
-- reset). Returns the number of rows deleted (refresh_tokens + sessions). Tolerant of GoTrue
-- versions that lack either table or the user_id column (that table is skipped with a NOTICE);
-- any other error (e.g. privileges) is raised so the caller knows the revoke did NOT happen.
-- NOTE: an already-issued access token stays valid until it expires (GoTrue JWT expiry, 1 h by
-- default); data access stops at once anyway because profiles.active=false makes every RLS
-- helper answer false.
create or replace function public.revoke_user_sessions(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n       bigint;
  v_total integer := 0;
  t       text;
begin
  if p_user is null then
    raise exception 'revoke_user_sessions: p_user is null';
  end if;
  foreach t in array array['refresh_tokens','sessions']      -- tokens first (FK to sessions)
  loop
    if to_regclass('auth.' || t) is null
       or not exists (select 1 from pg_attribute a
                      where a.attrelid = to_regclass('auth.' || t) and a.attname = 'user_id'
                        and a.attnum > 0 and not a.attisdropped)
    then
      raise notice 'revoke_user_sessions: auth.% (or its user_id column) not present - skipped', t;
      continue;
    end if;
    begin
      execute format('delete from auth.%I where user_id::text = $1', t) using p_user::text;
      get diagnostics n = row_count;
      v_total := v_total + n::integer;
    exception when undefined_table or undefined_column then
      raise notice 'revoke_user_sessions: auth.% changed shape - skipped (%)', t, sqlerrm;
    end;
  end loop;
  return v_total;
end $$;

-- LAST-ADMIN BACKSTOP. BEFORE UPDATE/DELETE on profiles: refuse any change that would leave
-- zero EFFECTIVE admins. "Effective admin" = role 'admin' AND active AND must_change_password =
-- false: an admin who has never replaced the temporary password cannot use the system yet
-- (the helper functions answer false for them), so he is NOT a safe "remaining" admin.
-- Refused: demoting / deactivating / deleting (also the cascade from deleting the auth user)
-- the last effective admin, and flagging him must_change_password (begin_password_reset).
-- Binds every role incl. service_role / postgres (the trigger is ENABLE ALWAYS, so it even
-- fires under session_replication_role=replica).
-- RACE: a transaction-scoped advisory lock serialises every change to an effective admin;
-- after acquiring it the other admins are RE-COUNTED with a fresh snapshot (READ COMMITTED, the
-- Supabase default), so two concurrent "demote the other admin" statements cannot both succeed.
-- INSERT is not covered on purpose: bootstrap_first_admin must work on an empty table (and it
-- clears the flag, so the bootstrapped admin is effective at once).
create or replace function public.tg_profiles_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left bigint;
begin
  if not (old.role = 'admin' and old.active and not old.must_change_password) then
    return case when tg_op = 'DELETE' then old else new end;   -- not an effective admin: irrelevant
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' and new.active and not new.must_change_password then
    return new;                                                -- still an effective admin
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tcm.profiles.last_admin', 0));
  select count(*) into v_left
  from public.profiles p
  where p.role = 'admin' and p.active and not p.must_change_password and p.id <> old.id;
  if v_left = 0 then
    raise exception 'LAST_ADMIN: ไม่สามารถทำรายการนี้ได้ เพราะจะไม่เหลือผู้ดูแลระบบ (admin) ที่ใช้งานได้จริงเลย (แอดมินที่ยังไม่ได้เปลี่ยนรหัสผ่านชั่วคราวไม่นับ) / refused: this would leave zero usable admins (admins who have not yet changed their temporary password do not count) (%)', old.email
      using errcode = '23514',
            hint = 'Make sure another admin is active AND has already changed the temporary password; or use public.bootstrap_first_admin(email) in the SQL editor.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Marks a temporary password automatically: on INSERT of a profile with must_change_password
-- = true, and when must_change_password flips false -> true, pw_marker is taken from the user's
-- CURRENT auth.users.encrypted_password (when the admin API creates the auth user first and the
-- profile second, the marker is correct without any further call). An explicit pw_marker on
-- INSERT is kept, and the sentinel 'RESET_PENDING' (begin_password_reset) is NEVER overwritten.
-- For password RESETS the API uses begin_password_reset -> new password -> set_pw_marker.
create or replace function public.tg_profiles_pw_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.must_change_password and new.pw_marker is distinct from 'RESET_PENDING' then
    if tg_op = 'INSERT' then
      if new.pw_marker is null then
        new.pw_marker := public._pw_fingerprint((select u.encrypted_password from auth.users u where u.id = new.id));
      end if;
    elsif not old.must_change_password then
      new.pw_marker := public._pw_fingerprint((select u.encrypted_password from auth.users u where u.id = new.id));
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_last_admin on public.profiles;
create trigger trg_profiles_last_admin
  before update or delete on public.profiles
  for each row execute function public.tg_profiles_last_admin();
alter table public.profiles enable always trigger trg_profiles_last_admin;

drop trigger if exists trg_profiles_pw_marker on public.profiles;
create trigger trg_profiles_pw_marker
  before insert or update of must_change_password on public.profiles
  for each row execute function public.tg_profiles_pw_marker();

revoke all on function public.tg_profiles_last_admin() from public, anon, authenticated;
revoke all on function public.tg_profiles_pw_marker()  from public, anon, authenticated;

revoke all on function public.my_profile()                from public, anon;
revoke all on function public.is_admin()                  from public, anon;
revoke all on function public.is_exec()                   from public, anon;
revoke all on function public.can_view_project(uuid)      from public, anon;
revoke all on function public.can_edit_project(uuid)      from public, anon;
revoke all on function public.clear_must_change_password() from public, anon;
-- service-role-only / internal (nobody on the client side may call these)
revoke all on function public._pw_fingerprint(text)        from public, anon, authenticated;
revoke all on function public.set_pw_marker(uuid)          from public, anon, authenticated;
revoke all on function public.begin_password_reset(uuid)   from public, anon, authenticated;
revoke all on function public.revoke_user_sessions(uuid)   from public, anon, authenticated;
do $sr$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.set_pw_marker(uuid)        to service_role;
    grant execute on function public.begin_password_reset(uuid) to service_role;
    grant execute on function public.revoke_user_sessions(uuid) to service_role;
  else
    raise warning 'role service_role not found: set_pw_marker / revoke_user_sessions are callable by nobody but the owner';
  end if;
end
$sr$;
grant execute on function public.my_profile()                 to authenticated;
grant execute on function public.is_admin()                   to authenticated;
grant execute on function public.is_exec()                    to authenticated;
grant execute on function public.can_view_project(uuid)       to authenticated;
grant execute on function public.can_edit_project(uuid)       to authenticated;
grant execute on function public.clear_must_change_password() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. RLS policies for profiles and project_members  (new names; nothing dropped
--    except our own previous versions, so re-running is safe)
--    The OLD project_members policy ("Users can view their memberships") is left
--    in place; policies are OR-ed, so ours only add admin/exec access.
-- ----------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin
  on public.profiles for select to authenticated
  using (public.is_admin());
-- no INSERT/UPDATE/DELETE policy and no such grant: clients cannot write profiles.

drop policy if exists pm_admin_all on public.project_members;
create policy pm_admin_all
  on public.project_members for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- own membership rows, but only while the profile is ACTIVE (a deactivated person sees nothing)
drop policy if exists pm_select_own on public.project_members;
create policy pm_select_own
  on public.project_members for select to authenticated
  using (user_id = (select auth.uid())
         and (public.my_profile()).id is not null
         and not (public.my_profile()).must_change_password);

drop policy if exists pm_select_exec on public.project_members;
create policy pm_select_exec
  on public.project_members for select to authenticated
  using (public.is_exec());

-- ----------------------------------------------------------------------------
-- 5. Bootstrap helper: make an EXISTING auth user the first admin.
--    Only callable from the SQL editor / service role (revoked from clients).
--    Idempotent. After use you may drop it:  drop function public.bootstrap_first_admin(text);
-- ----------------------------------------------------------------------------
create or replace function public.bootstrap_first_admin(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_email text;
begin
  select u.id, u.email into v_id, v_email
  from auth.users u
  where lower(u.email) = lower(btrim(p_email))
  limit 1;

  if v_id is null then
    raise exception 'No auth user with email "%". Create it first: Supabase Dashboard -> Authentication -> Users -> Add user (tick Auto Confirm), then run this again.', p_email
      using errcode = 'P0002';
  end if;

  insert into public.profiles (id, email, role, active, must_change_password)
  values (v_id, v_email, 'admin', true, false)
  on conflict (id) do update
    set role = 'admin', active = true, must_change_password = false, pw_marker = null;

  return format('OK: %s (%s) is now an active admin', v_email, v_id);
end $$;

revoke all on function public.bootstrap_first_admin(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. public.audit_log  (admin-only, append-only)
--    No foreign keys on purpose: audit rows must outlive the user / project / row.
--    SELECT: admin only. No client INSERT/UPDATE/DELETE (no grant, no policy):
--    rows are written by the SECURITY DEFINER triggers below, or by the service role.
--    The admin serverless function should add its own rows for things triggers cannot
--    attribute (it runs as service role): action 'admin.create_user' etc., with
--    user_id/user_email = the calling admin.
-- ----------------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_email text,            -- copied from profiles at write time ('service' = no end user)
  action     text not null,   -- 'insert' | 'update' | 'delete' (triggers) or a custom label
  table_name text,
  row_id     text,
  project_id uuid,            -- resolved per table; null when not project-scoped
  details    jsonb
);

-- access patterns: newest first; per project; per person
create index if not exists idx_audit_log_at          on public.audit_log (at desc);
create index if not exists idx_audit_log_project_at  on public.audit_log (project_id, at desc) where project_id is not null;
create index if not exists idx_audit_log_user_at     on public.audit_log (user_id, at desc)    where user_id is not null;

alter table public.audit_log enable row level security;
revoke all on public.audit_log from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;
grant select on public.audit_log to authenticated;

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
  on public.audit_log for select to authenticated
  using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 7. Audit helpers
-- ----------------------------------------------------------------------------

-- strings longer than 300 chars are cut (details must stay small)
create or replace function public._audit_trunc(v jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
           when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 300
             then to_jsonb(left(v #>> '{}', 300) || '...')
           else v
         end
$$;

-- whole row as jsonb, minus skipped keys and nulls
create or replace function public._audit_clean(j jsonb, skip text[])
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(
           jsonb_object_agg(e.key, public._audit_trunc(e.value)),
           '{}'::jsonb)
  from jsonb_each(j) as e(key, value)
  where e.key <> all (skip) and e.value <> 'null'::jsonb
$$;

-- only changed keys: {"col": {"old": ..., "new": ...}}; NULL when nothing relevant changed
create or replace function public._audit_diff(o jsonb, n jsonb, skip text[])
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_object_agg(
           nv.key,
           jsonb_build_object('old', public._audit_trunc(ov.value),
                              'new', public._audit_trunc(nv.value)))
  from jsonb_each(n) as nv(key, value)
  left join jsonb_each(o) as ov(key, value) on ov.key = nv.key
  where nv.key <> all (skip)
    and nv.value is distinct from ov.value
$$;

-- the single place that resolves "who" and inserts the audit row.
--   end user (auth.uid() not null): user_email from profiles, else the JWT email claim
--     (that is how the old shared account shows up before auth-02)
--   no end user (SQL editor, service role, cascades from admin tooling):
--     user_email = 'service', details._via = JWT role or the DB session user
-- It has NO exception block of its own: it is only called from the audit trigger
-- functions below, which each have exactly ONE exception block per audited row
-- (nested blocks = nested subtransactions, which hurt on cascades / bulk statements).
create or replace function public._audit_write(
  p_action text, p_table text, p_row_id text, p_project uuid, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_email  text;
  v_det    jsonb := p_details;
begin
  if v_uid is null then
    v_email := 'service';
    v_det   := coalesce(v_det, '{}'::jsonb)
               || jsonb_build_object('_via', coalesce(v_claims ->> 'role', session_user::text));
  else
    select pf.email into v_email from public.profiles pf where pf.id = v_uid;
    v_email := coalesce(v_email, v_claims ->> 'email');
  end if;

  insert into public.audit_log (user_id, user_email, action, table_name, row_id, project_id, details)
  values (v_uid, v_email, p_action, p_table, p_row_id, p_project, v_det);
end $$;

-- generic row trigger for the small tables
create or replace function public.tg_audit_generic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- never logged: big text / noise columns
  v_skip constant text[] := array['content_text','mom_logo','mom_topics','created_at','updated_at',
                                  'updated_by','updated_by_uid','created_by_uid','status_changed_at',
                                  'pw_marker'];
  v_old    jsonb;
  v_new    jsonb;
  v_row    jsonb;
  v_det    jsonb;
  v_proj   uuid;
  v_rowid  text;
  v_target text;
begin
  begin
    if tg_op = 'INSERT' then
      v_new := to_jsonb(new);
      v_row := v_new;
      v_det := public._audit_clean(v_new, v_skip);
    elsif tg_op = 'UPDATE' then
      v_old := to_jsonb(old);
      v_new := to_jsonb(new);
      v_row := v_new;
      v_det := public._audit_diff(v_old, v_new, v_skip);
      if v_det is null then
        return null;            -- only skipped columns changed: nothing worth logging
      end if;
    else
      v_old := to_jsonb(old);
      v_row := v_old;
      v_det := public._audit_clean(v_old, v_skip);
    end if;

    v_proj := (case tg_table_name
                 when 'projects' then v_row ->> 'id'
                 when 'profiles' then null
                 else v_row ->> 'project_id'
               end)::uuid;

    v_rowid := case tg_table_name
                 when 'project_members' then (v_row ->> 'project_id') || ':' || (v_row ->> 'user_id')
                 else v_row ->> 'id'
               end;

    if tg_table_name = 'project_members' then
      select pf.email into v_target from public.profiles pf where pf.id = (v_row ->> 'user_id')::uuid;
      v_det := coalesce(v_det, '{}'::jsonb) || jsonb_build_object('target_email', v_target);
    end if;

    perform public._audit_write(lower(tg_op), tg_table_name, v_rowid, v_proj, v_det);
  exception when others then
    -- auditing must never break the audited statement, but a failure must be visible in the logs
    raise warning 'audit failed: table=% op=% row=% sqlstate=% error=%',
      tg_table_name, tg_op, v_rowid, sqlstate, sqlerrm;
  end;
  return null;
end $$;

-- files: explicit columns only, so content_text (can be hundreds of KB) is never read.
-- `rev` and `uploader_name` are included only if those columns exist in the live table
-- (SQL_SCHEMA.sql has them, the live DB was not inspected), so the function and the
-- UPDATE trigger's WHEN list are generated here instead of being hard-coded.
do $files$
declare
  v_col  text;
  v_o    text := '';
  v_n    text := '';
  v_when text := '';
  v_src  text := $fmt$
create or replace function public.tg_audit_files()
returns trigger
language plpgsql
security definer
set search_path = public
as $b$
declare
  v_o  jsonb;
  v_n  jsonb;
  v_d  jsonb;
  v_id text;
begin
  begin
    if tg_op = 'INSERT' then
      v_id := new.id::text;
      perform public._audit_write('insert', 'files', v_id, new.project_id,
        jsonb_build_object('name', new.name, 'type', new.type, 'project_id', new.project_id,
                           'base_name', new.base_name, 'size_kb', new.size,
                           'ext', new.ext, 'storage_path', new.storage_path @@NEW@@));
    elsif tg_op = 'UPDATE' then
      v_id := new.id::text;
      v_o := jsonb_build_object('name', old.name, 'type', old.type, 'project_id', old.project_id,
                                'base_name', old.base_name, 'size_kb', old.size,
                                'ext', old.ext, 'storage_path', old.storage_path @@OLD@@);
      v_n := jsonb_build_object('name', new.name, 'type', new.type, 'project_id', new.project_id,
                                'base_name', new.base_name, 'size_kb', new.size,
                                'ext', new.ext, 'storage_path', new.storage_path @@NEW@@);
      v_d := public._audit_diff(v_o, v_n, array[]::text[]);
      if v_d is not null then
        perform public._audit_write('update', 'files', v_id, new.project_id, v_d);
      end if;
    else
      v_id := old.id::text;
      perform public._audit_write('delete', 'files', v_id, old.project_id,
        jsonb_build_object('name', old.name, 'type', old.type, 'project_id', old.project_id,
                           'base_name', old.base_name, 'size_kb', old.size,
                           'ext', old.ext, 'storage_path', old.storage_path @@OLD@@));
    end if;
  exception when others then
    raise warning 'audit failed: table=% op=% row=% sqlstate=% error=%',
      tg_table_name, tg_op, v_id, sqlstate, sqlerrm;
  end;
  return null;
end $b$
$fmt$;
begin
  foreach v_col in array array['rev','uploader_name','uploader_id'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'files' and column_name = v_col) then
      v_o    := v_o    || format(', %L, old.%I', v_col, v_col);
      v_n    := v_n    || format(', %L, new.%I', v_col, v_col);
      v_when := v_when || format(' or old.%I is distinct from new.%I', v_col, v_col);
    end if;
  end loop;

  execute replace(replace(v_src, '@@NEW@@', v_n), '@@OLD@@', v_o);

  -- UPDATE trigger carries a WHEN clause so is_latest flips and content_text re-index
  -- updates never even invoke the function
  execute 'drop trigger if exists trg_audit_files_upd on public.files';
  execute 'create trigger trg_audit_files_upd after update on public.files for each row when ('
       || 'old.name is distinct from new.name or old.type is distinct from new.type'
       || ' or old.project_id is distinct from new.project_id or old.base_name is distinct from new.base_name'
       || ' or old.size is distinct from new.size or old.ext is distinct from new.ext'
       || ' or old.storage_path is distinct from new.storage_path' || v_when
       || ') execute function public.tg_audit_files()';
end
$files$;

revoke all on function public._audit_trunc(jsonb)                      from public, anon, authenticated;
revoke all on function public._audit_clean(jsonb, text[])              from public, anon, authenticated;
revoke all on function public._audit_diff(jsonb, jsonb, text[])        from public, anon, authenticated;
revoke all on function public._audit_write(text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.tg_audit_generic()                       from public, anon, authenticated;
revoke all on function public.tg_audit_files()                         from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. Audit triggers  (AFTER ... FOR EACH ROW; they fire only for rows really changed)
--    Cost: one profiles PK lookup + one small INSERT per changed row, no reads of
--    big columns. files UPDATE is filtered by a WHEN clause, so the frequent
--    is_latest flips (uploadFile) and content_text re-index updates do not even
--    invoke the function. Upload of N files = N audit rows.
--    Cascades (deleting a project) fire the child triggers too: one row per child.
-- ----------------------------------------------------------------------------
do $trg$
declare
  t text;
begin
  foreach t in array array['projects','project_installments','progress_updates',
                           'installment_documents','project_checklist_templates','project_members']
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'audit: table public.% not found - no trigger created', t;
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_audit_' || t, t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function public.tg_audit_generic()',
      'trg_audit_' || t, t);
  end loop;
end
$trg$;

-- files: INSERT and DELETE triggers here (the UPDATE one carries a WHEN clause, see section 7)
drop trigger if exists trg_audit_files_ins on public.files;
create trigger trg_audit_files_ins
  after insert on public.files
  for each row execute function public.tg_audit_files();

-- (trg_audit_files_upd is created together with tg_audit_files() in section 7)

drop trigger if exists trg_audit_files_del on public.files;
create trigger trg_audit_files_del
  after delete on public.files
  for each row execute function public.tg_audit_files();

-- profiles: creation, deletion, and role / active changes only
drop trigger if exists trg_audit_profiles_ins on public.profiles;
create trigger trg_audit_profiles_ins
  after insert on public.profiles
  for each row execute function public.tg_audit_generic();

drop trigger if exists trg_audit_profiles_upd on public.profiles;
create trigger trg_audit_profiles_upd
  after update on public.profiles
  for each row
  when (old.role is distinct from new.role or old.active is distinct from new.active)
  execute function public.tg_audit_generic();

drop trigger if exists trg_audit_profiles_del on public.profiles;
create trigger trg_audit_profiles_del
  after delete on public.profiles
  for each row execute function public.tg_audit_generic();

-- ----------------------------------------------------------------------------
-- 8b. Unique files.storage_path (= Google Drive file id; one row per stored object).
--     Created ONLY if no duplicate exists (NULL / empty values are ignored); otherwise a
--     NOTICE says how many and the index is skipped - fix the duplicates, then re-run.
--     Note: this takes a short SHARE lock on public.files (inserts wait a moment).
-- ----------------------------------------------------------------------------
do $uq$
declare
  v_dup_values bigint;
  v_dup_rows   bigint;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'files' and column_name = 'storage_path') then
    raise notice 'files.storage_path does not exist - unique index skipped';
    return;
  end if;

  select count(*), coalesce(sum(c), 0) into v_dup_values, v_dup_rows
  from (select count(*) as c from public.files
        where storage_path is not null and storage_path <> ''
        group by storage_path having count(*) > 1) d;

  if v_dup_values > 0 then
    raise notice 'files_storage_path_uq SKIPPED: % duplicated storage_path value(s) in % rows. List them with:  select storage_path, count(*) from public.files where storage_path <> '''' group by 1 having count(*) > 1;  then fix and re-run auth-01.',
      v_dup_values, v_dup_rows;
  else
    create unique index if not exists files_storage_path_uq
      on public.files (storage_path)
      where storage_path is not null and storage_path <> '';
    raise notice 'files_storage_path_uq: unique index in place';
  end if;
end
$uq$;

-- ----------------------------------------------------------------------------
-- 8c. Old signup-whitelist trigger on auth.users  (NOT dropped by this script)
--     enforce_email_whitelist (whitelist-emails.sql) rejects every insert into auth.users whose
--     e-mail is not in allowed_emails. The Admin console creates users through the Auth admin
--     API, which then fails with a generic error. We only DETECT it here and print the exact
--     statements; the safe order is in scripts/AUTH_CUTOVER.md:
--       1. Dashboard -> Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up"
--       2. only then drop the trigger (otherwise anybody could register while it is gone).
-- ----------------------------------------------------------------------------
do $wl$
declare
  r record;
  n int := 0;
begin
  for r in
    select t.tgname, t.tgenabled, p.proname
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'auth.users'::regclass
      and not t.tgisinternal
      and (t.tgname = 'enforce_email_whitelist' or p.proname = 'check_email_allowed')
  loop
    n := n + 1;
    if r.tgenabled = 'D' then
      raise notice 'auth.users trigger % exists but is DISABLED - fine.', r.tgname;
    else
      raise warning E'ACTION REQUIRED before creating users in the Admin console:\n  auth.users has the old signup-whitelist trigger "%" (function public.%). It makes user creation fail with a generic error.\n  1) FIRST turn OFF "Allow new users to sign up" (Dashboard -> Authentication -> Sign In / Providers).\n  2) THEN run:\n       drop trigger if exists enforce_email_whitelist on auth.users;\n       drop function if exists public.check_email_allowed();\n  (see scripts/AUTH_CUTOVER.md; allowed_emails table can stay)', r.tgname, r.proname;
    end if;
  end loop;
  if n = 0 then
    raise notice 'auth.users: no signup-whitelist trigger found.';
  end if;
end
$wl$;

-- ----------------------------------------------------------------------------
-- 9. Self-check: the RLS-recursion premise must hold or the whole run is rolled back.
--    The owner of the helper functions must be exempt from RLS on profiles and
--    project_members: superuser / BYPASSRLS, or table owner without FORCE RLS.
-- ----------------------------------------------------------------------------
do $chk$
declare
  r record;
begin
  for r in
    select c.relname, c.relforcerowsecurity,
           fo.rolname as fn_owner, fo.rolsuper, fo.rolbypassrls,
           (c.relowner = fo.oid) as same_owner
    from pg_class c
    cross join (
      select o.oid, o.rolname, o.rolsuper, o.rolbypassrls
      from pg_proc p join pg_roles o on o.oid = p.proowner
      where p.oid = 'public.is_admin()'::regprocedure
    ) fo
    where c.oid in ('public.profiles'::regclass, 'public.project_members'::regclass)
  loop
    if not (r.rolsuper or r.rolbypassrls or (r.same_owner and not r.relforcerowsecurity)) then
      raise exception 'RLS recursion risk: function owner % neither bypasses RLS nor owns (without FORCE) table public.%. Fix ownership: ALTER TABLE public.% OWNER TO %;',
        r.fn_owner, r.relname, r.relname, r.fn_owner;
    end if;
  end loop;
  raise notice 'auth-01 self-check OK: helper-function owner is exempt from RLS on profiles/project_members.';
end
$chk$;

-- 9b. Self-check: service-role-only / internal functions must not be callable by clients,
--     and the last-admin trigger must be enabled for ALL sessions ('A' = always).
do $chk2$
declare
  f text;
  r text;
begin
  foreach f in array array['public.set_pw_marker(uuid)','public.begin_password_reset(uuid)','public.revoke_user_sessions(uuid)',
                           'public.bootstrap_first_admin(text)','public._pw_fingerprint(text)',
                           'public.tg_profiles_last_admin()','public.tg_profiles_pw_marker()',
                           'public._audit_write(text,text,text,uuid,jsonb)']
  loop
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r, f::regprocedure, 'execute') then
        raise exception 'SECURITY: role % can EXECUTE % - it must be service-role/owner only', r, f;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_last_admin'
                   and tgenabled = 'A') then
    raise exception 'trg_profiles_last_admin is missing or not ENABLE ALWAYS';
  end if;
  if has_column_privilege('authenticated', 'public.profiles', 'pw_marker', 'select')
     or has_column_privilege('anon', 'public.profiles', 'pw_marker', 'select') then
    raise exception 'SECURITY: profiles.pw_marker is readable by a client role';
  end if;
  raise notice 'auth-01 self-check OK: privileged functions closed to clients, pw_marker hidden, last-admin trigger active.';
end
$chk2$;

-- make PostgREST pick up the new functions / columns at once (delivered at COMMIT)
notify pgrst, 'reload schema';

commit;

-- Last result shown in the SQL editor: is the old signup-whitelist trigger still installed?
select 'auth.users signup-whitelist trigger'                      as check_name,
       case when exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                         where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
                           and (t.tgname = 'enforce_email_whitelist' or p.proname = 'check_email_allowed'))
            then 'STILL INSTALLED - see AUTH_CUTOVER.md step 5 (turn OFF sign-ups first, then drop it)'
            else 'OK (not installed)' end                          as status;

-- ============================================================================
-- BOOTSTRAP THE FIRST ADMIN   <<< EDIT THE EMAIL, THEN RUN THIS LINE ON ITS OWN >>>
-- ============================================================================
-- Prerequisite: create your login first - Supabase Dashboard -> Authentication ->
-- Users -> "Add user" -> email + password, tick "Auto Confirm User".
-- (If that fails with 'อีเมลนี้ไม่ได้รับอนุญาต...' the old signup-whitelist trigger
--  is still installed - see pre-flight query 6 below.)
--
--   select public.bootstrap_first_admin('their-email@example.com');
--
-- Re-running is harmless. It errors clearly if the auth user does not exist.

-- ============================================================================
-- PRE-FLIGHT / VERIFY queries  (read-only; run separately, any time)
-- ============================================================================
-- 1. Types this migration assumes (both must be uuid):
--      select table_name, column_name, data_type from information_schema.columns
--      where table_schema='public' and table_name in ('projects','files') and column_name='id';
-- 2. Does project_members exist, and in what shape?
--      select column_name, data_type, is_nullable, column_default from information_schema.columns
--      where table_schema='public' and table_name='project_members' order by ordinal_position;
--      select role, count(*) from public.project_members group by 1;   -- BEFORE running 01
-- 3. Existing policies (names are NOT assumed anywhere in these scripts):
--      select tablename, policyname, cmd, roles, qual, with_check from pg_policies
--      where schemaname='public' order by tablename, policyname;
-- 4. Existing triggers on the app tables (expect the tg_installment_* ones only):
--      select tgrelid::regclass, tgname from pg_trigger
--      where not tgisinternal and tgrelid::regclass::text like 'public.%' order by 1,2;
-- 5. Which role owns the tables / will own the new functions (must be postgres):
--      select c.relname, o.rolname, o.rolbypassrls from pg_class c join pg_roles o on o.oid=c.relowner
--      where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1;
-- 6. Is the old signup whitelist trigger still on auth.users? It would reject
--    admin-created users whose email is not in allowed_emails (and its function has no
--    search_path, the exact bug from the earlier incident):
--      select tgname, tgenabled from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal;
--    If 'enforce_email_whitelist' is listed, THIS SCRIPT DOES NOT DROP IT (it prints a WARNING and
--    the last result row says STILL INSTALLED). Safe order (AUTH_CUTOVER.md):
--      a. Dashboard -> Authentication -> Sign In / Providers: turn OFF "Allow new users to sign up"
--      b. then (profiles is the new gate):
--      -- drop trigger if exists enforce_email_whitelist on auth.users;
--      -- drop function if exists public.check_email_allowed();
--    (Alternative that keeps the trigger: add every new user's e-mail to allowed_emails first.)
-- 7. After running: triggers and objects exist?
--      select tgrelid::regclass, tgname from pg_trigger where tgname like 'trg_audit_%' order by 1,2;
--      select proname, prosecdef, proconfig from pg_proc
--      where pronamespace='public'::regnamespace
--        and proname in ('my_profile','is_admin','is_exec','can_view_project','can_edit_project',
--                        'clear_must_change_password','bootstrap_first_admin') order by 1;
-- ============================================================================
