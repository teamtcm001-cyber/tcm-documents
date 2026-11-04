-- ============================================================================
-- AUTH TEST  -  self-test for the per-person login / RLS model
-- ============================================================================
-- วิธีรัน (How to run):
--   Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์ -> Run
--   Run it (a) after scripts/auth-01-foundation.sql and (b) again after
--   scripts/auth-02-enforce-rls.sql.
--
--   !!! THE RESULT IS AN ERROR MESSAGE. !!!
--   The script ends by deliberately raising an exception whose text is the report:
--       ERROR: AUTH TEST (all data rolled back)
--       == SUMMARY: n PASS, n FAIL, n SKIP ==
--       FAIL lines first (if any), then the full PASS/FAIL/SKIP list
--   An error message that starts with "AUTH TEST" is therefore the NORMAL, SUCCESSFUL
--   outcome (the exception is what rolls everything back and carries the text to the
--   screen). Any OTHER error text means the test itself broke (read it; nothing was kept).
--   Each check is also emitted as a RAISE NOTICE if your dashboard shows notices.
--   Why not a result grid: session settings/counters made inside the transaction are
--   undone by a ROLLBACK, so the report has to be produced BEFORE the rollback.
--
-- NOTHING IS KEPT: everything runs inside one transaction that always ends in an exception. Synthetic rows use ids
-- starting with aaaaaaaa-/bbbbbbbb-/... and emails tcmtest.*@example.invalid and are
-- rolled back. Real data is never modified. (Brief side effect: at the very end, for a moment
-- the transaction holds a lock on public.audit_log (the last check, 'failing audit insert').
-- lock_timeout is 3s, so the test fails fast rather than queueing behind a long query;
-- run it at a quiet moment.)
--
-- HOW IT WORKS
--   * Identities are simulated with SET LOCAL ROLE authenticated/anon plus
--     set_config('request.jwt.claims', ...) / 'request.jwt.claim.sub' - exactly what
--     PostgREST does - so RLS, grants and auth.uid() behave as for a real login.
--   * Synthetic users (8 + 1 created inside the last-admin test): admin, exec, editor (editor of project A), viewer (viewer of A),
--     nonmember (user, no membership), noprofile (auth user, no profiles row),
--     inactive (profile active=false, editor membership of A). Two synthetic projects A, B
--     with one row of every kind in each.
--   * profiles / project_members reference auth.users, so the test INSERTs 8 minimal rows
--     into auth.users (id, aud, role, email) inside the rolled-back transaction. If your
--     project refuses that (a custom trigger on auth.users), the test falls back to
--     SET LOCAL session_replication_role = replica, which skips FK checks and user
--     triggers while seeding (needs the right to set it; Supabase's postgres role usually
--     has it) and returns to normal before any check runs. If both fail you get a clear error.
--     If the old signup-whitelist trigger exists, the synthetic emails are first added to
--     allowed_emails (also rolled back).
--   * Helper functions live in pg_temp (session-local, dropped at the end).
--   * Every per-identity suite runs inside a sub-block that is rolled back afterwards, so
--     one identity's inserts/deletes never influence the next.
--
-- ADDED IN THE HARDENING ROUND (all valid after 01; the data-table parts after 02)
--   * 'mustchange' identity: an editor of A who still holds an admin-issued temporary password.
--     Every helper answers false, no data readable/writable, but my_profile() and the own
--     profiles row still work; clear_must_change_password() is REJECTED (P0001) until
--     auth.users.encrypted_password has really changed, then access opens; an admin password
--     reset (flag back on + set_pw_marker) blocks again; legacy rows (no marker) and the
--     bootstrap admin are unaffected.
--   * last-admin backstop: two sequential "demote the other admin" statements cannot leave 0
--     admins (also for service_role, for DELETE and for the auth.users cascade, and for one
--     statement demoting everyone); the advisory lock is taken; bootstrap works on an empty table.
--     (A real two-session race cannot be shown in one transaction; the lock + re-count is what closes it.)
--   * revoke_user_sessions / set_pw_marker callable by service_role only; EXECUTE privileges of
--     anon / authenticated checked from the catalogue AND by a direct call.
--   * files.uploader_id cannot be forged on INSERT. The anon helper check uses dynamic SQL
--     (a plain plpgsql expression caches its privilege check across role switches).
--
-- WHAT IS CHECKED
--   Always (after 01):  helper functions per identity (admin/exec/editor/viewer/non-member/
--     no-profile/inactive/anon), my_profile(), profiles + project_members + audit_log
--     visibility and write protection (nobody can promote themselves, write profiles,
--     forge audit rows, call bootstrap_first_admin or _audit_write), clear_must_change_password()
--     touches only the caller, audit triggers (insert/update/delete/profile role change/
--     membership change, content_text never stored, is_latest flips not logged, an audit
--     failure never fails the original statement, 'service' for non-end-user writes).
--   Only when auth-02 is detected (policies files_select etc. present, no policy with
--     USING true on files/projects): per table projects, files, progress_updates,
--     project_installments, installment_documents, project_checklist_templates, activity,
--     installment_events, app_visits and the 3 tracking views: admin sees/edits all; exec
--     sees all but cannot write; editor reads+writes only project A and cannot move a row
--     into B; viewer reads A only and writes nothing; non-member / no-profile / inactive
--     see zero rows and write nothing; anon is refused; activity/installment_events are
--     append-only. Before auth-02 these are reported as SKIP (the old permissive policies
--     would make them fail by design).
-- ============================================================================

begin;
set local lock_timeout = '3s';

-- fresh counters (read back inside the final DO block, before the rollback)
select set_config('tcm_test.pass', '0', false),
       set_config('tcm_test.fail', '0', false),
       set_config('tcm_test.skip', '0', false),
       set_config('tcm_test.log',  '', false);

-- ---------------------------------------------------------------------------
-- helpers (pg_temp = this session only)
-- ---------------------------------------------------------------------------
create function pg_temp.chk(p_name text, p_ok boolean, p_info text default '')
returns void language plpgsql as $$
declare v_line text;
begin
  if coalesce(p_ok, false) then
    perform set_config('tcm_test.pass', (current_setting('tcm_test.pass')::int + 1)::text, false);
    v_line := 'PASS  ' || p_name;
  else
    perform set_config('tcm_test.fail', (current_setting('tcm_test.fail')::int + 1)::text, false);
    v_line := 'FAIL  ' || p_name || case when coalesce(p_info, '') <> '' then '   [' || p_info || ']' else '' end;
  end if;
  perform set_config('tcm_test.log', current_setting('tcm_test.log') || v_line || E'\n', false);
  raise notice '%', v_line;
end $$;

create function pg_temp.skip(p_name text, p_why text)
returns void language plpgsql as $$
declare v_line text := 'SKIP  ' || p_name || '   [' || p_why || ']';
begin
  perform set_config('tcm_test.skip', (current_setting('tcm_test.skip')::int + 1)::text, false);
  perform set_config('tcm_test.log', current_setting('tcm_test.log') || v_line || E'\n', false);
  raise notice '%', v_line;
end $$;

-- become a user: role + JWT claims (transaction-local). p_uid null = no JWT at all.
create function pg_temp.act(p_uid uuid, p_email text, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then ''
         else json_build_object('sub', p_uid, 'role', p_role, 'aud', 'authenticated', 'email', p_email)::text end,
    true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('role', p_role, true);
end $$;

create function pg_temp.reset_actor()
returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- 'n:<count>' or 'err:<sqlstate>'
create function pg_temp.cnt(p_sql text)
returns text language plpgsql as $$
declare n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into n;
  return 'n:' || n;
exception when others then
  return 'err:' || sqlstate;
end $$;

-- 'rows:<n>' or 'err:<sqlstate>'
create function pg_temp.dml(p_sql text)
returns text language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'rows:' || n;
exception when others then
  return 'err:' || sqlstate;
end $$;

-- first column of the first row as text, '<null>' if null, 'err:<sqlstate>' on error
create function pg_temp.val(p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, '<null>');
exception when others then
  return 'err:' || sqlstate;
end $$;

-- what the helper functions answer for project p, for the CURRENT role/claims
-- DYNAMIC SQL on purpose: a plain plpgsql expression ("return public.is_admin() ...") is
-- cached per session and its EXECUTE-privilege check is NOT repeated after the role switches
-- (authenticated -> anon), which produced false results for anon. EXECUTE re-plans and
-- re-checks privileges on every call.
create function pg_temp.caps(p uuid)
returns text language plpgsql as $$
declare v text;
begin
  execute format(
    'select ''admin='' || public.is_admin() || '',exec='' || public.is_exec()
         || '',view='' || public.can_view_project(%L::uuid) || '',edit='' || public.can_edit_project(%L::uuid)', p, p)
    into v;
  return v;
exception when others then
  return 'err:' || sqlstate;
end $$;

-- collect an observation: [label, got, want]. want = 'a|b' alternatives, '!x' = anything but x (and no error)
create function pg_temp.ex(q jsonb, p_label text, p_got text, p_want text)
returns jsonb language sql immutable as $$
  select q || jsonb_build_array(jsonb_build_array(p_label, p_got, p_want))
$$;

create function pg_temp.flush(q jsonb)
returns void language plpgsql as $$
declare
  e    jsonb;
  got  text;
  want text;
  ok   boolean;
begin
  perform pg_temp.reset_actor();
  for e in select * from jsonb_array_elements(q) loop
    if (e ->> 0) like 'SKIP:%' then          -- a sub-block could not build its fixture
      perform pg_temp.skip(substr(e ->> 0, 6), e ->> 1);
      continue;
    end if;
    got  := e ->> 1;
    want := e ->> 2;
    if want like '!%' then
      ok := got <> substr(want, 2) and got not like 'err:%';
    else
      ok := got = any (string_to_array(want, '|'));
    end if;
    perform pg_temp.chk(e ->> 0, ok, 'got ' || coalesce(got, 'NULL') || ', want ' || want);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- one identity's whole suite. Runs inside a sub-block that is ROLLED BACK at the end
-- (the local variable q keeps its value; database changes and SET LOCAL do not).
--   p_label: admin | exec | editor | viewer | nonmember | noprofile | inactive | anon
-- ---------------------------------------------------------------------------
create function pg_temp.suite(p_label text, p_uid uuid, p_email text, p_enforced boolean)
returns jsonb
language plpgsql
as $fn$
declare
  q     jsonb := '[]'::jsonb;
  c_pa  constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000a';
  c_pb  constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  c_ia  constant uuid := 'eeeeeeee-0000-4000-8000-0000000000a1';
  c_ib  constant uuid := 'eeeeeeee-0000-4000-8000-0000000000b1';
  k     text := case p_label
                  when 'admin'  then 'admin'  when 'exec'   then 'exec'
                  when 'editor' then 'editor' when 'viewer' then 'viewer'
                  when 'anon'   then 'anon'   else 'none' end;
  v_role text := case when p_label = 'anon' then 'anon' else 'authenticated' end;
  r      record;
  lbl    text;
  capA   text; capB text;
  seeA   text; seeB text; tot text;
  insA   text; insB text; updA text; updB text; mov text; delA text; delB text;
  insa_sql text; insb_sql text;
  v_pm   text; v_prof text; v_my text;
begin
  begin
    perform pg_temp.act(p_uid, p_email, v_role);

    -- ======================= expectations by identity =======================
    capA := case k
              when 'admin'  then 'admin=true,exec=false,view=true,edit=true'
              when 'exec'   then 'admin=false,exec=true,view=true,edit=false'
              when 'editor' then 'admin=false,exec=false,view=true,edit=true'
              when 'viewer' then 'admin=false,exec=false,view=true,edit=false'
              when 'anon'   then 'err:42501'
              else               'admin=false,exec=false,view=false,edit=false' end;
    capB := case k
              when 'admin'  then 'admin=true,exec=false,view=true,edit=true'
              when 'exec'   then 'admin=false,exec=true,view=true,edit=false'
              when 'anon'   then 'err:42501'
              else               'admin=false,exec=false,view=false,edit=false' end;
    v_my   := case when p_label in ('noprofile','inactive') then '<null>'
                   when p_label = 'anon' then 'err:42501'
                   else p_uid::text end;
    v_prof := case p_label when 'admin' then 'n:7' when 'noprofile' then 'n:0'
                           when 'anon' then 'err:42501|n:0' else 'n:1' end;
    -- inactive: pm_select_own requires an ACTIVE profile -> 0. (Before auth-02 the pre-existing
    -- legacy policy "Users can view their memberships" may still show the row: accept 1 then.)
    -- admin/exec see all 4 seeded membership rows (editor A, viewer A, inactive A, mustchange A)
    v_pm   := case p_label when 'admin' then 'n:4' when 'exec' then 'n:4'
                           when 'editor' then 'n:1' when 'viewer' then 'n:1'
                           when 'inactive' then case when p_enforced then 'n:0' else 'n:0|n:1' end
                           -- temp-password holder: pm_select_own is closed (legacy policy may still show it before 02)
                           when 'mustchange' then case when p_enforced then 'n:0' else 'n:0|n:1' end
                           when 'anon' then 'err:42501|n:0' else 'n:0' end;

    -- ======================= A. helper functions (valid after 01) =======================
    q := pg_temp.ex(q, p_label || ': helpers on project A', pg_temp.caps(c_pa), capA);
    q := pg_temp.ex(q, p_label || ': helpers on project B', pg_temp.caps(c_pb), capB);
    q := pg_temp.ex(q, p_label || ': my_profile()',
                    pg_temp.val('select (public.my_profile()).id::text'), v_my);

    -- ======================= B. profiles / membership / audit (valid after 01) =======================
    q := pg_temp.ex(q, p_label || ': profiles rows visible',
                    pg_temp.cnt('select 1 from public.profiles where email like ''tcmtest.%@example.invalid'''), v_prof);
    q := pg_temp.ex(q, p_label || ': project_members rows visible',
                    pg_temp.cnt(format('select 1 from public.project_members where project_id in (%L, %L)', c_pa, c_pb)), v_pm);
    q := pg_temp.ex(q, p_label || ': audit_log rows visible',
                    pg_temp.cnt('select 1 from public.audit_log'),
                    case k when 'admin' then '!n:0' when 'anon' then 'err:42501|n:0' else 'n:0|err:42501' end);

    q := pg_temp.ex(q, p_label || ': cannot INSERT a profile',
                    pg_temp.dml('insert into public.profiles (id, email, role) values (gen_random_uuid(), ''tcmtest.x@example.invalid'', ''admin'')'),
                    'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot UPDATE a profile (self-promotion)',
                    pg_temp.dml(format('update public.profiles set role = ''admin'' where id = %L', p_uid)),
                    'err:42501|rows:0');
    q := pg_temp.ex(q, p_label || ': cannot DELETE a profile',
                    pg_temp.dml(format('delete from public.profiles where id = %L', p_uid)),
                    'err:42501|rows:0');
    q := pg_temp.ex(q, p_label || ': cannot INSERT into audit_log',
                    pg_temp.dml('insert into public.audit_log (action) values (''forged'')'), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot UPDATE audit_log',
                    pg_temp.dml('update public.audit_log set action = ''x'''), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot DELETE audit_log',
                    pg_temp.dml('delete from public.audit_log'), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot call _audit_write()',
                    pg_temp.dml('select public._audit_write(''x'', ''x'', ''x'', null, ''{}''::jsonb)'), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot call bootstrap_first_admin()',
                    pg_temp.dml('select public.bootstrap_first_admin(''tcmtest.admin@example.invalid'')'), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot call set_pw_marker() (service_role only)',
                    pg_temp.dml(format('select public.set_pw_marker(%L::uuid)', p_uid)), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot call revoke_user_sessions() (service_role only)',
                    pg_temp.dml(format('select public.revoke_user_sessions(%L::uuid)', p_uid)), 'err:42501');
    q := pg_temp.ex(q, p_label || ': cannot call begin_password_reset() (service_role only)',
                    pg_temp.dml(format('select public.begin_password_reset(%L::uuid)', p_uid)), 'err:42501');
    -- pw_marker (fingerprint of a password hash) is never readable by a client; SELECT is granted per column
    q := pg_temp.ex(q, p_label || ': cannot read profiles.pw_marker',
                    pg_temp.cnt('select pw_marker from public.profiles'), 'err:42501');
    q := pg_temp.ex(q, p_label || ': select * from profiles is refused (column privileges)',
                    pg_temp.cnt('select * from public.profiles'), 'err:42501');

    -- forensic / backup / legacy tables are not readable by any client role
    for r in
      select tablename::text as tn from pg_tables
      where schemaname = 'public'
        and (tablename like '\_policy\_backup\_%' or tablename like '\_grant\_backup\_%'
             or tablename = '_project_members_pre_auth')
    loop
      q := pg_temp.ex(q, p_label || ': cannot read public.' || r.tn,
                      pg_temp.cnt(format('select 1 from public.%I', r.tn)), 'err:42501');
    end loop;
    if to_regclass('public.allowed_emails') is not null and k <> 'admin' then
      q := pg_temp.ex(q, p_label || ': cannot read public.allowed_emails',
                      pg_temp.cnt('select 1 from public.allowed_emails'), 'n:0|err:42501');
    end if;

    -- membership: self-promotion / tampering is impossible for everyone but admin
    q := pg_temp.ex(q, p_label || ': INSERT membership (B) for self',
                    pg_temp.dml(format('insert into public.project_members (project_id, user_id, role) values (%L, %L, ''editor'')', c_pb, p_uid)),
                    case k when 'admin' then 'rows:1' else 'err:42501' end);
    q := pg_temp.ex(q, p_label || ': UPDATE own membership role to editor',
                    pg_temp.dml(format('update public.project_members set role = ''editor'' where user_id = %L and project_id = %L', p_uid, c_pa)),
                    case k when 'admin' then 'rows:0|rows:1' when 'anon' then 'err:42501' else 'rows:0|err:42501' end);
    q := pg_temp.ex(q, p_label || ': DELETE own membership',
                    pg_temp.dml(format('delete from public.project_members where user_id = %L and project_id = %L', p_uid, c_pa)),
                    case k when 'admin' then 'rows:0|rows:1' when 'anon' then 'err:42501' else 'rows:0|err:42501' end);

    -- ======================= C. data tables (only once auth-02 is in force) =======================
    if p_enforced then

      -- views: security_invoker => same visibility as the base tables
      for r in
        select * from (values
          ('project_tracking_overview'), ('installment_summary'), ('project_progress_latest')
        ) as v(vw)
      loop
        continue when to_regclass('public.' || r.vw) is null;
        lbl := p_label || ' view ' || r.vw;
        seeA := case when k in ('admin','exec','editor','viewer') then 'n:1' when k = 'anon' then 'err:42501|n:0' else 'n:0' end;
        seeB := case when k in ('admin','exec') then 'n:1' when k = 'anon' then 'err:42501|n:0' else 'n:0' end;
        q := pg_temp.ex(q, lbl || ': project A rows', pg_temp.cnt(format('select 1 from public.%I where project_id = %L', r.vw, c_pa)), seeA);
        q := pg_temp.ex(q, lbl || ': project B rows', pg_temp.cnt(format('select 1 from public.%I where project_id = %L', r.vw, c_pb)), seeB);
        tot := case when k in ('editor','viewer') then 'n:1' when k = 'none' then 'n:0' when k = 'anon' then 'err:42501|n:0' else null end;
        if tot is not null then
          q := pg_temp.ex(q, lbl || ': total rows (no leak of other projects)', pg_temp.cnt(format('select 1 from public.%I', r.vw)), tot);
        end if;
      end loop;

      -- expectations for table writes
      insA := case k when 'admin' then 'rows:1' when 'editor' then 'rows:1' else 'err:42501' end;
      insB := case k when 'admin' then 'rows:1' else 'err:42501' end;
      updA := case when k in ('admin','editor') then 'rows:1' when k = 'anon' then 'err:42501' else 'rows:0' end;
      updB := case k when 'admin' then 'rows:1' when 'anon' then 'err:42501' else 'rows:0' end;
      mov  := case k when 'admin' then 'rows:1|err:23503|err:23505'   -- admin may move; FKs/uniques may still object
                     when 'editor' then 'err:42501'                    -- WITH CHECK on the NEW project_id
                     when 'anon' then 'err:42501' else 'rows:0' end;
      delA := case when k in ('admin','editor') then 'rows:1' when k = 'anon' then 'err:42501' else 'rows:0' end;
      delB := case k when 'admin' then 'rows:1' when 'anon' then 'err:42501' else 'rows:0' end;
      seeA := case when k in ('admin','exec','editor','viewer') then 'n:1' when k = 'anon' then 'err:42501|n:0' else 'n:0' end;
      seeB := case when k in ('admin','exec') then 'n:1' when k = 'anon' then 'err:42501|n:0' else 'n:0' end;
      tot  := case when k in ('editor','viewer') then 'n:1' when k = 'none' then 'n:0' when k = 'anon' then 'err:42501|n:0' else null end;

      -- installment_events: append-only. MUST run before the table loop below: that loop DELETEs
      -- the seeded installments, and an event for a deleted installment fails with 23503 (FK),
      -- which made this check meaningless for admin/editor.
      lbl := p_label || ' installment_events';
      q := pg_temp.ex(q, lbl || ': INSERT into A',
                      pg_temp.dml(format('insert into public.installment_events (installment_id, project_id, from_status, to_status) values (%L, %L, null, ''planned'')', c_ia, c_pa)), insA);
      q := pg_temp.ex(q, lbl || ': INSERT into B',
                      pg_temp.dml(format('insert into public.installment_events (installment_id, project_id, from_status, to_status) values (%L, %L, null, ''planned'')', c_ib, c_pb)), insB);
      q := pg_temp.ex(q, lbl || ': UPDATE refused (append-only)',
                      pg_temp.dml('update public.installment_events set note = ''zz'''), 'err:42501');
      q := pg_temp.ex(q, lbl || ': DELETE refused (append-only)',
                      pg_temp.dml('delete from public.installment_events'), 'err:42501');

      -- files.uploader_id cannot be re-attributed by UPDATE (trg_files_uploader_guard): NULL or own id only
      if exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'files' and column_name = 'uploader_id') then
        q := pg_temp.ex(q, p_label || ' files: UPDATE uploader_id to someone else',
              pg_temp.dml(format('update public.files set uploader_id = %L where id = ''cccccccc-0000-4000-8000-0000000000a1''',
                                 case when p_uid = 'aaaaaaaa-0000-4000-8000-000000000003'::uuid
                                      then 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
                                      else 'aaaaaaaa-0000-4000-8000-000000000003'::uuid end)),
              case when k in ('admin','editor','anon') then 'err:42501' else 'rows:0' end);
        q := pg_temp.ex(q, p_label || ' files: UPDATE uploader_id to own id',
              pg_temp.dml(format('update public.files set uploader_id = %L where id = ''cccccccc-0000-4000-8000-0000000000a1''', p_uid)), updA);
        q := pg_temp.ex(q, p_label || ' files: UPDATE uploader_id to NULL',
              pg_temp.dml('update public.files set uploader_id = null where id = ''cccccccc-0000-4000-8000-0000000000a1'''), updA);
      end if;

      -- ordered so that FK children are touched before their parents
      for r in
        select * from (values
          ('files', 'cccccccc-0000-4000-8000-0000000000a1', 'cccccccc-0000-4000-8000-0000000000b1',
           'name = ''zz''',
           'insert into public.files (project_id, name, type, base_name, size, ext, storage_path, is_latest) values ({P}, ''e.pdf'', ''other'', ''e'', 1, ''pdf'', ''e-path-'' || {P}::text, true)'),
          ('progress_updates', 'dddddddd-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-0000000000b1',
           'note = ''zz''',
           'insert into public.progress_updates (project_id, percent_complete, updated_by) values ({P}, 10, ''t'')'),
          ('installment_documents', 'ffffffff-0000-4000-8000-0000000000a1', 'ffffffff-0000-4000-8000-0000000000b1',
           'label = ''zz''',
           'insert into public.installment_documents (installment_id, project_id, label) values ({I}, {P}, ''e1'')'),
          ('project_checklist_templates', '11111111-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000b1',
           'label = ''zz''',
           'insert into public.project_checklist_templates (project_id, label) values ({P}, ''e1'')'),
          ('project_installments', 'eeeeeeee-0000-4000-8000-0000000000a1', 'eeeeeeee-0000-4000-8000-0000000000b1',
           'note = ''zz''',
           'insert into public.project_installments (project_id, installment_no) values ({P}, 2)')
        ) as v(tbl, ida, idb, setcol, tpl)
      loop
        lbl := p_label || ' ' || r.tbl;
        insa_sql := replace(replace(r.tpl, '{P}', quote_literal(c_pa)), '{I}', quote_literal(c_ia));
        insb_sql := replace(replace(r.tpl, '{P}', quote_literal(c_pb)), '{I}', quote_literal(c_ib));

        q := pg_temp.ex(q, lbl || ': sees project A row', pg_temp.cnt(format('select 1 from public.%I where id = %L', r.tbl, r.ida)), seeA);
        q := pg_temp.ex(q, lbl || ': sees project B row', pg_temp.cnt(format('select 1 from public.%I where id = %L', r.tbl, r.idb)), seeB);
        if tot is not null then
          q := pg_temp.ex(q, lbl || ': total rows visible', pg_temp.cnt(format('select 1 from public.%I', r.tbl)), tot);
        end if;

        q := pg_temp.ex(q, lbl || ': INSERT into A', pg_temp.dml(insa_sql), insA);
        q := pg_temp.ex(q, lbl || ': INSERT into B', pg_temp.dml(insb_sql), insB);
        q := pg_temp.ex(q, lbl || ': UPDATE A row',  pg_temp.dml(format('update public.%I set %s where id = %L', r.tbl, r.setcol, r.ida)), updA);
        q := pg_temp.ex(q, lbl || ': UPDATE B row',  pg_temp.dml(format('update public.%I set %s where id = %L', r.tbl, r.setcol, r.idb)), updB);
        q := pg_temp.ex(q, lbl || ': MOVE A row into B', pg_temp.dml(format('update public.%I set project_id = %L where id = %L', r.tbl, c_pb, r.ida)), mov);
        q := pg_temp.ex(q, lbl || ': DELETE A row',  pg_temp.dml(format('delete from public.%I where id = %L', r.tbl, r.ida)), delA);
        q := pg_temp.ex(q, lbl || ': DELETE B row',  pg_temp.dml(format('delete from public.%I where id = %L', r.tbl, r.idb)), delB);
      end loop;

      -- files.uploader_id cannot be forged on INSERT (own id or NULL only)
      if exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'files' and column_name = 'uploader_id') then
        q := pg_temp.ex(q, p_label || ' files: INSERT into A with own uploader_id',
              pg_temp.dml(format('insert into public.files (project_id, name, type, base_name, size, ext, storage_path, uploader_id, is_latest) values (%L, ''u.pdf'', ''other'', ''u'', 1, ''pdf'', ''u-own-path'', %L, true)', c_pa, p_uid)), insA);
        q := pg_temp.ex(q, p_label || ' files: INSERT into A forging someone else as uploader_id',
              pg_temp.dml(format('insert into public.files (project_id, name, type, base_name, size, ext, storage_path, uploader_id, is_latest) values (%L, ''u.pdf'', ''other'', ''u'', 1, ''pdf'', ''u-forged-path'', %L, true)', c_pa,
                                 case when p_uid = 'aaaaaaaa-0000-4000-8000-000000000003'::uuid
                                      then 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
                                      else 'aaaaaaaa-0000-4000-8000-000000000003'::uuid end)),
              'err:42501');
      end if;

      -- activity: append-only
      lbl := p_label || ' activity';
      q := pg_temp.ex(q, lbl || ': sees project A row', pg_temp.cnt('select 1 from public.activity where id = ''22222222-0000-4000-8000-0000000000a1'''), seeA);
      q := pg_temp.ex(q, lbl || ': sees project B row', pg_temp.cnt('select 1 from public.activity where id = ''22222222-0000-4000-8000-0000000000b1'''), seeB);
      if tot is not null then
        q := pg_temp.ex(q, lbl || ': total rows visible', pg_temp.cnt('select 1 from public.activity'), tot);
      end if;
      q := pg_temp.ex(q, lbl || ': INSERT into A',
                      pg_temp.dml(format('insert into public.activity (project_id, action, details, user_id) values (%L, ''t'', ''t'', %L)', c_pa, p_uid)), insA);
      q := pg_temp.ex(q, lbl || ': INSERT into B',
                      pg_temp.dml(format('insert into public.activity (project_id, action, details, user_id) values (%L, ''t'', ''t'', %L)', c_pb, p_uid)), insB);
      q := pg_temp.ex(q, lbl || ': INSERT with someone else as user_id',
                      pg_temp.dml(format('insert into public.activity (project_id, action, details, user_id) values (%L, ''t'', ''t'', %L)', c_pa,
                                         case when p_uid = 'aaaaaaaa-0000-4000-8000-000000000003'::uuid
                                              then 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
                                              else 'aaaaaaaa-0000-4000-8000-000000000003'::uuid end)),
                      'err:42501');
      q := pg_temp.ex(q, lbl || ': UPDATE refused (append-only)',
                      pg_temp.dml('update public.activity set details = ''zz'' where id = ''22222222-0000-4000-8000-0000000000a1'''), 'err:42501');
      q := pg_temp.ex(q, lbl || ': DELETE refused (append-only)',
                      pg_temp.dml('delete from public.activity where id = ''22222222-0000-4000-8000-0000000000a1'''), 'err:42501');

      -- projects
      lbl := p_label || ' projects';
      q := pg_temp.ex(q, lbl || ': sees project A', pg_temp.cnt(format('select 1 from public.projects where id = %L', c_pa)), seeA);
      q := pg_temp.ex(q, lbl || ': sees project B', pg_temp.cnt(format('select 1 from public.projects where id = %L', c_pb)), seeB);
      if tot is not null then
        q := pg_temp.ex(q, lbl || ': total rows visible', pg_temp.cnt('select 1 from public.projects'), tot);
      end if;
      q := pg_temp.ex(q, lbl || ': INSERT (create project)',
                      pg_temp.dml('insert into public.projects (name, code) values (''t'', ''ZZ-TCMTEST-X'')'),
                      case k when 'admin' then 'rows:1' else 'err:42501' end);
      q := pg_temp.ex(q, lbl || ': UPDATE A', pg_temp.dml(format('update public.projects set client = ''zz'' where id = %L', c_pa)), updA);
      q := pg_temp.ex(q, lbl || ': UPDATE B', pg_temp.dml(format('update public.projects set client = ''zz'' where id = %L', c_pb)), updB);
      q := pg_temp.ex(q, lbl || ': DELETE A (admin only)', pg_temp.dml(format('delete from public.projects where id = %L', c_pa)),
                      case k when 'admin' then 'rows:1' when 'anon' then 'err:42501' else 'rows:0' end);

      -- legacy visit log: nobody inserts any more
      if to_regclass('public.app_visits') is not null then
        q := pg_temp.ex(q, p_label || ' app_visits: INSERT refused',
                        pg_temp.dml('insert into public.app_visits (display_name) values (''t'')'), 'err:42501');
      end if;
    end if;

    raise exception 'rollback this identity' using errcode = 'TC001';
  exception when sqlstate 'TC001' then
    null;   -- expected: undoes every change this identity made; q survives
  end;
  return q;
end
$fn$;

-- ---------------------------------------------------------------------------
-- forced password change, session revocation. Runs in a sub-block that is ROLLED BACK.
-- Flow under test = exactly what the app does: my_profile() -> auth.updateUser (changes
-- auth.users.encrypted_password, simulated by an UPDATE) -> clear_must_change_password().
-- ---------------------------------------------------------------------------
create function pg_temp.pw_tests(c_temp uuid, e_temp text, c_admin uuid, e_admin text,
                                 c_view uuid, c_pa uuid, p_enf boolean)
returns jsonb
language plpgsql
as $fn$
declare
  q      jsonb := '[]'::jsonb;
  v_have boolean := true;
begin
  begin
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'mustchange: pw_marker holds the fingerprint of the temporary hash (not the hash)',
         pg_temp.val(format('select (pw_marker = public._pw_fingerprint(''tcmtest-temp-hash'') and pw_marker <> ''tcmtest-temp-hash'')::text from public.profiles where id = %L', c_temp)), 'true');

    -- ===== 1. still on the temporary password =====
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'mustchange: my_profile() stays readable (forced-change screen works)',
         pg_temp.val('select (public.my_profile()).must_change_password::text'), 'true');
    q := pg_temp.ex(q, 'mustchange: my_profile() does NOT return pw_marker (NULL although the row has one)',
         pg_temp.val('select ((public.my_profile()).pw_marker is null)::text'), 'true');
    q := pg_temp.ex(q, 'mustchange: own profiles row stays readable',
         pg_temp.cnt(format('select 1 from public.profiles where id = %L', c_temp)), 'n:1');
    q := pg_temp.ex(q, 'mustchange: every helper answers false (even though editor of A)',
         pg_temp.caps(c_pa), 'admin=false,exec=false,view=false,edit=false');
    if p_enf then
      q := pg_temp.ex(q, 'mustchange: cannot read files', pg_temp.cnt('select 1 from public.files'), 'n:0');
      q := pg_temp.ex(q, 'mustchange: cannot read projects', pg_temp.cnt('select 1 from public.projects'), 'n:0');
      q := pg_temp.ex(q, 'mustchange: cannot INSERT a file into project A',
           pg_temp.dml(format('insert into public.files (project_id, name, type, base_name, size, ext, storage_path, is_latest) values (%L, ''m.pdf'', ''other'', ''m'', 1, ''pdf'', ''mc-path-1'', true)', c_pa)), 'err:42501');
      q := pg_temp.ex(q, 'mustchange: cannot UPDATE project A',
           pg_temp.dml(format('update public.projects set client = ''zz'' where id = %L', c_pa)), 'rows:0');
    end if;
    q := pg_temp.ex(q, 'mustchange: clear_must_change_password() BEFORE the password changed is rejected (P0001)',
         pg_temp.dml('select public.clear_must_change_password()'), 'err:P0001');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'mustchange: ...and the flag is still set',
         pg_temp.val(format('select must_change_password::text from public.profiles where id = %L', c_temp)), 'true');

    -- ===== 2. the user really changes the password (GoTrue rewrites encrypted_password) =====
    update auth.users set encrypted_password = 'tcmtest-new-hash' where id = c_temp;
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'mustchange: clear_must_change_password() AFTER a real change succeeds',
         pg_temp.dml('select public.clear_must_change_password()'), 'rows:1');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'mustchange: flag cleared and marker dropped',
         pg_temp.val(format('select (not must_change_password and pw_marker is null)::text from public.profiles where id = %L', c_temp)), 'true');
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'mustchange: after clearing, access opens (editor of A)',
         pg_temp.caps(c_pa), 'admin=false,exec=false,view=true,edit=true');
    if p_enf then
      q := pg_temp.ex(q, 'mustchange: after clearing, reads project A files', pg_temp.cnt(format('select 1 from public.files where project_id = %L', c_pa)), 'n:1');
      q := pg_temp.ex(q, 'mustchange: after clearing, can INSERT a file into project A',
           pg_temp.dml(format('insert into public.files (project_id, name, type, base_name, size, ext, storage_path, is_latest) values (%L, ''m.pdf'', ''other'', ''m'', 1, ''pdf'', ''mc-path-2'', true)', c_pa)), 'rows:1');
    end if;

    -- ===== 3. admin resets the password: flag back on, marker re-armed =====
    perform pg_temp.reset_actor();
    update public.profiles set must_change_password = true where id = c_temp;
    q := pg_temp.ex(q, 'trigger: false->true flip stamps pw_marker from the current hash',
         pg_temp.val(format('select (pw_marker = public._pw_fingerprint(''tcmtest-new-hash''))::text from public.profiles where id = %L', c_temp)), 'true');
    update auth.users set encrypted_password = 'tcmtest-reset-hash' where id = c_temp;   -- the API writes the new temp password
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'set_pw_marker(): service_role can re-arm the marker',
         pg_temp.val(format('select public.set_pw_marker(%L::uuid)::text', c_temp)), 'true');
    q := pg_temp.ex(q, 'set_pw_marker(): unknown user -> false',
         pg_temp.val('select public.set_pw_marker(''99999999-0000-4000-8000-000000000999''::uuid)::text'), 'false');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'set_pw_marker(): marker = fingerprint of the NEW temporary hash',
         pg_temp.val(format('select (pw_marker = public._pw_fingerprint(''tcmtest-reset-hash''))::text from public.profiles where id = %L', c_temp)), 'true');
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'mustchange after reset: blocked again', pg_temp.caps(c_pa), 'admin=false,exec=false,view=false,edit=false');
    q := pg_temp.ex(q, 'mustchange after reset: clear before the user changes it is rejected',
         pg_temp.dml('select public.clear_must_change_password()'), 'err:P0001');
    perform pg_temp.reset_actor();
    update auth.users set encrypted_password = 'tcmtest-user-chosen' where id = c_temp;
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'mustchange after reset: clear after the user chose a new password succeeds',
         pg_temp.dml('select public.clear_must_change_password()'), 'rows:1');

    -- ===== 4. legacy row (flag set, no marker): behaves as before =====
    perform pg_temp.reset_actor();
    update public.profiles set must_change_password = true where id = c_temp;
    update public.profiles set pw_marker = null where id = c_temp;
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'legacy row (pw_marker NULL): clear succeeds without proof (as before)',
         pg_temp.dml('select public.clear_must_change_password()'), 'rows:1');

    -- ===== 4b. begin_password_reset: the "flag already true" window (QA repro D1) =====
    -- person holds password 'tcmtest-user-chosen' and a LIVE session, flag TRUE, marker = fp(that hash)
    perform pg_temp.reset_actor();
    update public.profiles set must_change_password = true where id = c_temp;
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'begin_password_reset(): service_role call returns true',
         pg_temp.val(format('select public.begin_password_reset(%L::uuid)::text', c_temp)), 'true');
    q := pg_temp.ex(q, 'begin_password_reset(): unknown user -> false',
         pg_temp.val('select public.begin_password_reset(''99999999-0000-4000-8000-000000000999''::uuid)::text'), 'false');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'begin_password_reset(): flag true + sentinel marker',
         pg_temp.val(format('select (must_change_password and pw_marker = ''RESET_PENDING'')::text from public.profiles where id = %L', c_temp)), 'true');
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'reset step 1 (sentinel set, old password): live session cannot clear',
         pg_temp.dml('select public.clear_must_change_password()'), 'err:P0001');
    perform pg_temp.reset_actor();
    update auth.users set encrypted_password = 'tcmtest-admin-temp-2' where id = c_temp;   -- step 2: the API wrote the new temp password
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'reset step 2 (NEW hash written, marker not yet stamped): live session cannot clear',
         pg_temp.dml('select public.clear_must_change_password()'), 'err:P0001');
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'reset step 3: revoke_user_sessions() is callable and returns a count',
         pg_temp.val(format('select (public.revoke_user_sessions(%L::uuid) >= 0)::text', c_temp)), 'true');
    q := pg_temp.ex(q, 'reset step 4: set_pw_marker() stamps the new fingerprint',
         pg_temp.val(format('select public.set_pw_marker(%L::uuid)::text', c_temp)), 'true');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'reset step 4: sentinel replaced by the real fingerprint',
         pg_temp.val(format('select (pw_marker = public._pw_fingerprint(''tcmtest-admin-temp-2''))::text from public.profiles where id = %L', c_temp)), 'true');
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'reset step 5 (stamped, temp password still unchanged): clear refused',
         pg_temp.dml('select public.clear_must_change_password()'), 'err:P0001');
    perform pg_temp.reset_actor();
    update auth.users set encrypted_password = 'tcmtest-chosen-3' where id = c_temp;
    perform pg_temp.act(c_temp, e_temp);
    q := pg_temp.ex(q, 'reset step 6: after the person really changed the password clear succeeds',
         pg_temp.dml('select public.clear_must_change_password()'), 'rows:1');

    -- flag FALSE -> begin_password_reset flips it; the pw trigger must not overwrite the sentinel
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'begin_password_reset() on a cleared user flips the flag back on',
         pg_temp.val(format('select public.begin_password_reset(%L::uuid)::text', c_temp)), 'true');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'begin_password_reset(): flip trigger did not overwrite the sentinel',
         pg_temp.val(format('select (must_change_password and pw_marker = ''RESET_PENDING'')::text from public.profiles where id = %L', c_temp)), 'true');
    -- set_pw_marker with an empty / NULL hash: false and nothing stamped (sentinel stays => fail closed)
    update auth.users set encrypted_password = null where id = c_temp;
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'set_pw_marker(): NULL password hash -> false',
         pg_temp.val(format('select public.set_pw_marker(%L::uuid)::text', c_temp)), 'false');
    perform pg_temp.reset_actor();
    update auth.users set encrypted_password = '' where id = c_temp;
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'set_pw_marker(): empty password hash -> false',
         pg_temp.val(format('select public.set_pw_marker(%L::uuid)::text', c_temp)), 'false');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'set_pw_marker(): ...and nothing was stamped (sentinel intact)',
         pg_temp.val(format('select (pw_marker = ''RESET_PENDING'')::text from public.profiles where id = %L', c_temp)), 'true');
    update auth.users set encrypted_password = 'tcmtest-hash-4' where id = c_temp;
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'set_pw_marker(): a real hash replaces the sentinel',
         pg_temp.val(format('select public.set_pw_marker(%L::uuid)::text', c_temp)), 'true');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'set_pw_marker(): ...marker is now the fingerprint',
         pg_temp.val(format('select (pw_marker = public._pw_fingerprint(''tcmtest-hash-4''))::text from public.profiles where id = %L', c_temp)), 'true');
    -- leave the user cleared for the next sections
    update auth.users set encrypted_password = 'tcmtest-hash-5' where id = c_temp;
    perform pg_temp.act(c_temp, e_temp);
    perform pg_temp.dml('select public.clear_must_change_password()');

    -- ===== 5. bootstrap admin (must_change = false) is unaffected =====
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'bootstrap_first_admin(): still works',
         pg_temp.val(format('select left(public.bootstrap_first_admin(%L), 2)', e_admin)), 'OK');
    perform pg_temp.act(c_admin, e_admin);
    q := pg_temp.ex(q, 'bootstrap admin: full admin capabilities', pg_temp.caps(c_pa), 'admin=true,exec=false,view=true,edit=true');
    q := pg_temp.ex(q, 'bootstrap admin: clear_must_change_password() is a harmless no-op',
         pg_temp.dml('select public.clear_must_change_password()'), 'rows:1');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'bootstrap admin: flag false, no marker',
         pg_temp.val(format('select (not must_change_password and pw_marker is null)::text from public.profiles where id = %L', c_admin)), 'true');

    -- ===== 6. revoke_user_sessions =====
    begin
      insert into auth.sessions (id, user_id) values
        ('99999999-0000-4000-8000-0000000000a1', c_temp),
        ('99999999-0000-4000-8000-0000000000a2', c_temp),
        ('99999999-0000-4000-8000-0000000000b1', c_view);
    exception when others then
      v_have := false;
      q := q || jsonb_build_array(jsonb_build_array('SKIP:revoke_user_sessions()', 'cannot build auth.sessions fixture: ' || sqlstate || ' ' || sqlerrm, ''));
    end;
    if v_have then
      perform pg_temp.act(null, null, 'service_role');
      q := pg_temp.ex(q, 'revoke_user_sessions(): service_role deletes exactly the 2 sessions of the user',
           pg_temp.val(format('select public.revoke_user_sessions(%L::uuid)::text', c_temp)), '2');
      perform pg_temp.reset_actor();
      q := pg_temp.ex(q, 'revoke_user_sessions(): the user has no session left',
           pg_temp.cnt(format('select 1 from auth.sessions where user_id = %L', c_temp)), 'n:0');
      q := pg_temp.ex(q, 'revoke_user_sessions(): other users sessions are untouched',
           pg_temp.cnt(format('select 1 from auth.sessions where user_id = %L', c_view)), 'n:1');
    end if;

    raise exception 'rollback pw tests' using errcode = 'TC001';
  exception when sqlstate 'TC001' then
    null;
  end;
  return q;
end
$fn$;

-- ---------------------------------------------------------------------------
-- last-admin backstop. Sub-block, ROLLED BACK (it deactivates every other real admin and even
-- empties profiles temporarily).
-- ---------------------------------------------------------------------------
create function pg_temp.admin_tests(c_admin uuid, e_admin text, c_adm2 uuid, e_adm2 text)
returns jsonb
language plpgsql
as $fn$
declare
  q jsonb := '[]'::jsonb;
begin
  begin
    perform pg_temp.reset_actor();
    insert into auth.users (id, aud, role, email) values (c_adm2, 'authenticated', 'authenticated', e_adm2);
    insert into public.profiles (id, email, full_name, role, active, must_change_password)
    values (c_adm2, e_adm2, 'T admin2', 'admin', true, false);
    -- every OTHER (real) admin is deactivated: allowed, because two test admins stay active
    update public.profiles set active = false where role = 'admin' and active and id not in (c_admin, c_adm2);
    q := pg_temp.ex(q, 'last-admin: setup has exactly 2 active admins',
         pg_temp.val('select count(*)::text from public.profiles where role = ''admin'' and active'), '2');

    -- an admin who still holds a TEMPORARY password is not a safe "remaining" admin
    update public.profiles set must_change_password = true where id = c_adm2;
    q := pg_temp.ex(q, 'last-admin: the only OTHER admin holds a temporary password -> demoting admin1 is REFUSED',
         pg_temp.dml(format('update public.profiles set role = ''user'' where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: ...deactivating admin1 is REFUSED too',
         pg_temp.dml(format('update public.profiles set active = false where id = %L', c_admin)), 'err:23514');
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'last-admin: begin_password_reset() on the only usable admin is REFUSED',
         pg_temp.dml(format('select public.begin_password_reset(%L::uuid)', c_admin)), 'err:23514');
    perform pg_temp.reset_actor();
    q := pg_temp.ex(q, 'last-admin: a temporary-password admin can still be removed (he is not counted)',
         pg_temp.dml(format('update public.profiles set active = false where id = %L', c_adm2)), 'rows:1');
    update public.profiles set active = true, must_change_password = false where id = c_adm2;   -- adm2 changed the password

    -- two SEQUENTIAL "demote the other admin" statements
    q := pg_temp.ex(q, 'last-admin: 1st demotion (admin2 deactivated) is allowed',
         pg_temp.dml(format('update public.profiles set active = false where id = %L', c_adm2)), 'rows:1');
    q := pg_temp.ex(q, 'last-admin: the demotion took the advisory lock that serialises concurrent demotions',
         pg_temp.val('select exists (select 1 from pg_locks where locktype = ''advisory'' and pid = pg_backend_pid())::text'), 'true');
    q := pg_temp.ex(q, 'last-admin: 2nd demotion (admin1 -> role user) is REFUSED',
         pg_temp.dml(format('update public.profiles set role = ''user'' where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: deactivating the last active admin is REFUSED',
         pg_temp.dml(format('update public.profiles set active = false where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: deleting the last active admin is REFUSED',
         pg_temp.dml(format('delete from public.profiles where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: deleting the auth user (FK cascade) of the last admin is REFUSED',
         pg_temp.dml(format('delete from auth.users where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: exactly 1 active admin is left',
         pg_temp.val('select count(*)::text from public.profiles where role = ''admin'' and active'), '1');
    q := pg_temp.ex(q, 'last-admin: changing an unrelated column of the last admin is fine',
         pg_temp.dml(format('update public.profiles set full_name = ''renamed'' where id = %L', c_admin)), 'rows:1');

    -- binds service_role as well
    perform pg_temp.act(null, null, 'service_role');
    q := pg_temp.ex(q, 'last-admin: service_role demotion is REFUSED too',
         pg_temp.dml(format('update public.profiles set role = ''exec'' where id = %L', c_admin)), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: service_role delete is REFUSED too',
         pg_temp.dml(format('delete from public.profiles where id = %L', c_admin)), 'err:23514');
    perform pg_temp.reset_actor();

    -- one statement that would demote ALL admins at once: refused as a whole
    update public.profiles set active = true where id = c_adm2;
    q := pg_temp.ex(q, 'last-admin: ONE statement demoting every admin is REFUSED',
         pg_temp.dml('update public.profiles set active = false where role = ''admin'' and active'), 'err:23514');
    q := pg_temp.ex(q, 'last-admin: ...and nothing was changed (still 2 active admins)',
         pg_temp.val('select count(*)::text from public.profiles where role = ''admin'' and active'), '2');
    q := pg_temp.ex(q, 'last-admin: with 2 admins, ONE may be demoted',
         pg_temp.dml(format('update public.profiles set role = ''user'' where id = %L', c_adm2)), 'rows:1');

    -- bootstrap on an EMPTY table (trigger switched off just to empty it, then back ON)
    alter table public.profiles disable trigger trg_profiles_last_admin;
    delete from public.profiles;
    alter table public.profiles enable always trigger trg_profiles_last_admin;
    q := pg_temp.ex(q, 'last-admin: bootstrap_first_admin() works on an empty profiles table',
         pg_temp.val(format('select left(public.bootstrap_first_admin(%L), 2)', e_admin)), 'OK');
    q := pg_temp.ex(q, 'last-admin: ...and the bootstrapped admin is protected again',
         pg_temp.dml(format('update public.profiles set active = false where id = %L', c_admin)), 'err:23514');

    raise exception 'rollback admin tests' using errcode = 'TC001';
  exception when sqlstate 'TC001' then
    null;
  end;
  return q;
end
$fn$;

-- ---------------------------------------------------------------------------
-- main run
-- ---------------------------------------------------------------------------
do $run$
declare
  c_admin constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  c_exec  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  c_edit  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  c_view  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000004';
  c_nonm  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000005';
  c_nopr  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000006';
  c_inac  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000007';
  c_temp  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000008';   -- holds an admin-issued TEMPORARY password
  c_adm2  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000009';   -- second admin (last-admin tests only; created inside a sub-block)
  e_admin constant text := 'tcmtest.admin@example.invalid';
  e_exec  constant text := 'tcmtest.exec@example.invalid';
  e_edit  constant text := 'tcmtest.editor@example.invalid';
  e_view  constant text := 'tcmtest.viewer@example.invalid';
  e_nonm  constant text := 'tcmtest.nonmember@example.invalid';
  e_nopr  constant text := 'tcmtest.noprofile@example.invalid';
  e_inac  constant text := 'tcmtest.inactive@example.invalid';
  e_temp  constant text := 'tcmtest.mustchange@example.invalid';
  e_adm2  constant text := 'tcmtest.admin2@example.invalid';
  c_pa    constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000a';
  c_pb    constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  c_file  constant uuid := 'cccccccc-0000-4000-8000-0000000000a2';   -- file created by the audit tests
  v_mode  text := 'auth.users';
  v_enf   boolean;
  n       bigint;
  s       text;
  v_fails text;
begin
  -- ---------- preflight ----------
  if to_regprocedure('public.is_admin()') is null or to_regclass('public.profiles') is null then
    raise exception 'auth-01-foundation.sql has not been run yet.';
  end if;

  -- ---------- seed (as the editor's own role, RLS bypassed) ----------
  if to_regclass('public.allowed_emails') is not null then
    -- old signup whitelist trigger on auth.users would reject unknown emails
    insert into public.allowed_emails (email)
    select e from unnest(array[e_admin, e_exec, e_edit, e_view, e_nonm, e_nopr, e_inac, e_temp, e_adm2]) as e
    on conflict do nothing;
  end if;

  begin
    insert into auth.users (id, aud, role, email) values
      (c_admin, 'authenticated', 'authenticated', e_admin),
      (c_exec,  'authenticated', 'authenticated', e_exec),
      (c_edit,  'authenticated', 'authenticated', e_edit),
      (c_view,  'authenticated', 'authenticated', e_view),
      (c_nonm,  'authenticated', 'authenticated', e_nonm),
      (c_nopr,  'authenticated', 'authenticated', e_nopr),
      (c_inac,  'authenticated', 'authenticated', e_inac),
      (c_temp,  'authenticated', 'authenticated', e_temp);
    -- the temporary password hash the admin API would have created
    update auth.users set encrypted_password = 'tcmtest-temp-hash' where id = c_temp;
  exception when others then
    raise notice 'insert into auth.users failed (% %); falling back to session_replication_role = replica for seeding', sqlstate, sqlerrm;
    v_mode := 'replica';
  end;

  if v_mode = 'replica' then
    begin
      set local session_replication_role = replica;
    exception when others then
      raise exception 'Cannot seed: INSERT into auth.users failed AND SET session_replication_role is not permitted (%). Ask for help; no data was changed.', sqlerrm;
    end;
  end if;

  insert into public.profiles (id, email, full_name, role, active, must_change_password) values
    (c_admin, e_admin, 'T admin',     'admin', true,  false),
    (c_exec,  e_exec,  'T exec',      'exec',  true,  false),
    (c_edit,  e_edit,  'T editor',    'user',  true,  false),
    (c_view,  e_view,  'T viewer',    'user',  true,  false),
    (c_nonm,  e_nonm,  'T nonmember', 'user',  true,  false),
    (c_inac,  e_inac,  'T inactive',  'user',  false, false);
  -- temp-password holder: explicit marker (the BEFORE INSERT trigger would compute the same value)
  insert into public.profiles (id, email, full_name, role, active, must_change_password, pw_marker) values
    (c_temp,  e_temp,  'T mustchange', 'user', true,  true, public._pw_fingerprint('tcmtest-temp-hash'));
  -- c_nopr deliberately has NO profile

  insert into public.projects (id, name, code) values
    (c_pa, 'TCM TEST A', 'ZZ-TCMTEST-A'),
    (c_pb, 'TCM TEST B', 'ZZ-TCMTEST-B');

  insert into public.project_members (project_id, user_id, role) values
    (c_pa, c_edit, 'editor'),
    (c_pa, c_view, 'viewer'),
    (c_pa, c_inac, 'editor'),
    (c_pa, c_temp, 'editor');

  insert into public.files (id, project_id, name, type, base_name, size, ext, storage_path, is_latest) values
    ('cccccccc-0000-4000-8000-0000000000a1', c_pa, 't-a.pdf', 'other', 't-a', 1, 'pdf', 'test-a', true),
    ('cccccccc-0000-4000-8000-0000000000b1', c_pb, 't-b.pdf', 'other', 't-b', 1, 'pdf', 'test-b', true);

  insert into public.progress_updates (id, project_id, percent_complete, updated_by) values
    ('dddddddd-0000-4000-8000-0000000000a1', c_pa, 5, 't'),
    ('dddddddd-0000-4000-8000-0000000000b1', c_pb, 5, 't');

  insert into public.project_installments (id, project_id, installment_no) values
    ('eeeeeeee-0000-4000-8000-0000000000a1', c_pa, 1),
    ('eeeeeeee-0000-4000-8000-0000000000b1', c_pb, 1);

  insert into public.installment_documents (id, installment_id, project_id, label) values
    ('ffffffff-0000-4000-8000-0000000000a1', 'eeeeeeee-0000-4000-8000-0000000000a1', c_pa, 'seed-doc'),
    ('ffffffff-0000-4000-8000-0000000000b1', 'eeeeeeee-0000-4000-8000-0000000000b1', c_pb, 'seed-doc');

  insert into public.project_checklist_templates (id, project_id, label) values
    ('11111111-0000-4000-8000-0000000000a1', c_pa, 'seed-tmpl'),
    ('11111111-0000-4000-8000-0000000000b1', c_pb, 'seed-tmpl');

  insert into public.activity (id, project_id, action, details) values
    ('22222222-0000-4000-8000-0000000000a1', c_pa, 'seed', 'seed'),
    ('22222222-0000-4000-8000-0000000000b1', c_pb, 'seed', 'seed');

  if v_mode = 'replica' then
    set local session_replication_role = origin;   -- triggers + FK checks back on before any test
  end if;
  -- guarantees the admin has something to read even if seeding ran with triggers off
  insert into public.audit_log (user_email, action, table_name, details)
  values ('service', 'tcmtest', 'seed', '{}'::jsonb);
  raise notice 'seeded 8 synthetic users (via %), 2 projects', v_mode;

  -- ---------- is auth-02 in force? ----------
  v_enf := exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'files' and policyname = 'files_select')
       and not exists (select 1 from pg_policies
                       where schemaname = 'public' and tablename in ('files','projects')
                         and cmd in ('SELECT','ALL') and qual = 'true');
  raise notice 'RLS enforcement (auth-02) detected: %', v_enf;
  if not v_enf then
    perform pg_temp.skip('data-table RLS checks (projects, files, progress, installments, views, activity ...)',
                         'auth-02-enforce-rls.sql not run yet; the old permissive policies are still active. Re-run this test after auth-02.');
  end if;

  -- ---------- per-identity suites (each is rolled back inside) ----------
  perform pg_temp.flush(pg_temp.suite('admin',     c_admin, e_admin, v_enf));
  perform pg_temp.flush(pg_temp.suite('exec',      c_exec,  e_exec,  v_enf));
  perform pg_temp.flush(pg_temp.suite('editor',    c_edit,  e_edit,  v_enf));
  perform pg_temp.flush(pg_temp.suite('viewer',    c_view,  e_view,  v_enf));
  perform pg_temp.flush(pg_temp.suite('nonmember', c_nonm,  e_nonm,  v_enf));
  perform pg_temp.flush(pg_temp.suite('noprofile', c_nopr,  e_nopr,  v_enf));
  perform pg_temp.flush(pg_temp.suite('inactive',  c_inac,  e_inac,  v_enf));
  perform pg_temp.flush(pg_temp.suite('mustchange', c_temp, e_temp,  v_enf));   -- editor of A, but password change pending
  perform pg_temp.flush(pg_temp.suite('anon',      null,    null,    v_enf));

  -- ---------- helper functions: who may EXECUTE what (privilege catalogue, not role simulation) ----------
  perform pg_temp.chk('privileges: anon cannot EXECUTE any helper / profile function',
    not (has_function_privilege('anon', 'public.is_admin()', 'execute')
      or has_function_privilege('anon', 'public.is_exec()', 'execute')
      or has_function_privilege('anon', 'public.my_profile()', 'execute')
      or has_function_privilege('anon', 'public.can_view_project(uuid)', 'execute')
      or has_function_privilege('anon', 'public.can_edit_project(uuid)', 'execute')
      or has_function_privilege('anon', 'public.clear_must_change_password()', 'execute')));
  perform pg_temp.chk('privileges: authenticated can EXECUTE the helpers',
    has_function_privilege('authenticated', 'public.is_admin()', 'execute')
    and has_function_privilege('authenticated', 'public.is_exec()', 'execute')
    and has_function_privilege('authenticated', 'public.my_profile()', 'execute')
    and has_function_privilege('authenticated', 'public.can_view_project(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.can_edit_project(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.clear_must_change_password()', 'execute'));
  perform pg_temp.chk('privileges: set_pw_marker / begin_password_reset / revoke_user_sessions are service_role-only',
    not (has_function_privilege('anon', 'public.set_pw_marker(uuid)', 'execute')
      or has_function_privilege('authenticated', 'public.set_pw_marker(uuid)', 'execute')
      or has_function_privilege('anon', 'public.begin_password_reset(uuid)', 'execute')
      or has_function_privilege('authenticated', 'public.begin_password_reset(uuid)', 'execute')
      or has_function_privilege('anon', 'public.revoke_user_sessions(uuid)', 'execute')
      or has_function_privilege('authenticated', 'public.revoke_user_sessions(uuid)', 'execute'))
    and has_function_privilege('service_role', 'public.set_pw_marker(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.begin_password_reset(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.revoke_user_sessions(uuid)', 'execute'));
  -- direct call as anon in a fresh dynamic statement (no plpgsql expression caching involved)
  perform pg_temp.act(null, null, 'anon');
  s := pg_temp.val('select public.is_admin()::text');
  perform pg_temp.reset_actor();
  perform pg_temp.chk('anon: direct call of is_admin() is refused (42501)', s = 'err:42501', 'got ' || s);

  -- ---------- FORCED PASSWORD CHANGE + SESSION REVOCATION ----------
  perform pg_temp.flush(pg_temp.pw_tests(c_temp, e_temp, c_admin, e_admin, c_view, c_pa, v_enf));

  -- ---------- LAST-ADMIN backstop ----------
  perform pg_temp.flush(pg_temp.admin_tests(c_admin, e_admin, c_adm2, e_adm2));

  -- ---------- clear_must_change_password() touches only the caller ----------
  -- (both flagged here without a marker = legacy rows: no password-change proof required)
  update public.profiles set must_change_password = true, pw_marker = null where id in (c_edit, c_nonm);
  perform pg_temp.act(c_edit, e_edit);
  s := pg_temp.dml('select public.clear_must_change_password()');
  perform pg_temp.reset_actor();
  perform pg_temp.chk('clear_must_change_password(): call succeeds for a signed-in user', s = 'rows:1', 'got ' || s);
  perform pg_temp.chk('clear_must_change_password(): caller flag cleared',
    (select must_change_password from public.profiles where id = c_edit) = false);
  perform pg_temp.chk('clear_must_change_password(): other users untouched',
    (select must_change_password from public.profiles where id = c_nonm) = true);

  -- ---------- audit triggers (simulate an end-user JWT while staying superuser-ish, so
  --            these checks run identically before and after auth-02) ----------
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_edit, 'role', 'authenticated', 'email', e_edit)::text, true);
  perform set_config('request.jwt.claim.sub', c_edit::text, true);

  insert into public.files (id, project_id, name, type, base_name, size, ext, storage_path, is_latest)
  values (c_file, c_pa, 'audit-test.pdf', 'other', 'audit-test', 1, 'pdf', 'audit-path', true);

  select count(*) into n from public.audit_log
   where table_name = 'files' and row_id = c_file::text and action = 'insert'
     and user_id = c_edit and user_email = e_edit and project_id = c_pa
     and details ->> 'name' = 'audit-test.pdf' and (details -> 'content_text') is null;
  perform pg_temp.chk('audit: file INSERT logged with the actor, project and name (no content_text)', n = 1, 'rows=' || n);

  update public.files set is_latest = false where id = c_file;
  select count(*) into n from public.audit_log where table_name = 'files' and row_id = c_file::text and action = 'update';
  perform pg_temp.chk('audit: an is_latest flip is NOT logged (upload versioning noise)', n = 0, 'rows=' || n);

  update public.files set name = 'audit-test2.pdf' where id = c_file;
  select count(*) into n from public.audit_log
   where table_name = 'files' and row_id = c_file::text and action = 'update'
     and details -> 'name' ->> 'old' = 'audit-test.pdf' and details -> 'name' ->> 'new' = 'audit-test2.pdf'
     and user_email = e_edit;
  perform pg_temp.chk('audit: file rename logged as old/new', n = 1, 'rows=' || n);

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'files' and column_name = 'uploader_id') then
    update public.files set uploader_id = c_edit where id = c_file;
    select count(*) into n from public.audit_log
     where table_name = 'files' and row_id = c_file::text and action = 'update'
       and details -> 'uploader_id' ->> 'new' = c_edit::text and user_email = e_edit;
    perform pg_temp.chk('audit: a files.uploader_id change is logged', n = 1, 'rows=' || n);
  end if;

  delete from public.files where id = c_file;
  select count(*) into n from public.audit_log
   where table_name = 'files' and row_id = c_file::text and action = 'delete' and details ->> 'name' = 'audit-test2.pdf';
  perform pg_temp.chk('audit: file DELETE logged', n = 1, 'rows=' || n);

  -- profile role change is logged; a must_change_password-only change is not
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_admin, 'role', 'authenticated', 'email', e_admin)::text, true);
  perform set_config('request.jwt.claim.sub', c_admin::text, true);
  update public.profiles set role = 'exec' where id = c_nonm;
  update public.profiles set must_change_password = false where id = c_nonm;
  select count(*) into n from public.audit_log
   where table_name = 'profiles' and row_id = c_nonm::text and action = 'update'
     and details -> 'role' ->> 'old' = 'user' and details -> 'role' ->> 'new' = 'exec' and user_email = e_admin;
  perform pg_temp.chk('audit: profile role change logged (old/new, by the admin)', n = 1, 'rows=' || n);
  select count(*) into n from public.audit_log where table_name = 'profiles' and row_id = c_nonm::text and action = 'update';
  perform pg_temp.chk('audit: must_change_password change is not logged', n = 1, 'rows=' || n);

  -- membership change is logged with the target's email
  insert into public.project_members (project_id, user_id, role) values (c_pb, c_view, 'viewer');
  select count(*) into n from public.audit_log
   where table_name = 'project_members' and row_id = c_pb::text || ':' || c_view::text and action = 'insert'
     and project_id = c_pb and details ->> 'target_email' = e_view and user_email = e_admin;
  perform pg_temp.chk('audit: membership INSERT logged with project, target email and admin', n = 1, 'rows=' || n);
  delete from public.project_members where project_id = c_pb and user_id = c_view;
  select count(*) into n from public.audit_log
   where table_name = 'project_members' and row_id = c_pb::text || ':' || c_view::text and action = 'delete';
  perform pg_temp.chk('audit: membership DELETE logged', n = 1, 'rows=' || n);

  -- no JWT at all (SQL editor / service role): logged as 'service'
  perform pg_temp.reset_actor();
  update public.projects set client = 'svc' where id = c_pb;
  select count(*) into n from public.audit_log
   where table_name = 'projects' and row_id = c_pb::text and action = 'update'
     and user_id is null and user_email = 'service' and project_id = c_pb and details -> 'client' ->> 'new' = 'svc';
  perform pg_temp.chk('audit: write without end user is logged as user_email = service', n = 1, 'rows=' || n);

  -- delete cascade from a project is audited per child and survives the project
  delete from public.projects where id = c_pb;
  select count(*) into n from public.audit_log where project_id = c_pb and table_name = 'files' and action = 'delete';
  perform pg_temp.chk('audit: cascade-deleted children are logged and the log outlives the project', n >= 1, 'rows=' || n);
  -- an audit failure must never fail the audited statement (it becomes a WARNING in the
  -- Postgres logs). LAST on purpose: ALTER TABLE takes an ACCESS EXCLUSIVE lock on audit_log
  -- that is held until the transaction ends.
  perform pg_temp.reset_actor();
  alter table public.audit_log add constraint zz_tcmtest_block check (false) not valid;
  begin
    insert into public.files (id, project_id, name, type, base_name, size, ext, storage_path, is_latest)
    values ('cccccccc-0000-4000-8000-0000000000a3', c_pa, 'swallow.pdf', 'other', 'swallow', 1, 'pdf', 'x', true);
    s := 'ok';
  exception when others then
    s := 'statement failed: ' || sqlerrm;
  end;
  alter table public.audit_log drop constraint zz_tcmtest_block;
  perform pg_temp.chk('audit: a failing audit insert does not fail the original statement (WARNING only)', s = 'ok', s);
  select count(*) into n from public.audit_log where row_id = 'cccccccc-0000-4000-8000-0000000000a3';
  perform pg_temp.chk('audit: ...and (as expected) no audit row was written in that case', n = 0, 'rows=' || n);

  -- ---------- report: raised as an exception => EVERYTHING above is rolled back ----------
  v_fails := coalesce((
    select string_agg(l, E'
')
    from regexp_split_to_table(current_setting('tcm_test.log'), E'
') as l
    where l like 'FAIL%'), '(none)');
  raise exception E'AUTH TEST (all data rolled back; this error is the NORMAL result)
== SUMMARY: % PASS, % FAIL, % SKIP ==
--- FAILURES ---
%
--- ALL CHECKS ---
%',
    current_setting('tcm_test.pass'), current_setting('tcm_test.fail'), current_setting('tcm_test.skip'),
    v_fails, current_setting('tcm_test.log');
end
$run$;
