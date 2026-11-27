-- ROLLBACK of scripts/file-access-log.sql  (the access log is DELETED - export it first if needed)
-- After this /api/drive-url serves files again WITHOUT logging (it treats a missing
-- log_file_access function as "logging not installed").
do $falrb$
begin
  perform set_config('lock_timeout', '5s', true);
  drop function if exists public.log_file_access(uuid[], text);
  drop table if exists public.file_access_log;
  perform pg_notify('pgrst', 'reload schema');
  raise notice 'file-access-log removed.';
end
$falrb$;
