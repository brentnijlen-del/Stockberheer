-- REQUIRES EXPLICIT PRODUCTION APPROVAL. NOT PART OF AUTOMATIC MIGRATIONS.
-- This closes the OLD website's API and may affect other applications using these tables.
-- Review preflight.sql, take a backup, disable automatic deploys and arrange a cutover first.
-- Execute `set material.approved_legacy_cutover = 'yes';` in the SAME SQL Editor session only after approval.
begin;
do $$declare t text; p record;
begin
 if current_setting('material.approved_legacy_cutover',true) is distinct from 'yes' then
  raise exception 'Production cutover requires explicit approval';
 end if;
 if to_regclass('material_private.members') is null or not exists(select 1 from material_private.members where role='admin') then
  raise exception 'Install and test v2 and provision an administrator first';
 end if;
 foreach t in array array['app_state','categories','locations','products','cases','lots','loans','moves'] loop
  if to_regclass('public.'||t) is not null then
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
    execute format('drop policy %I on public.%I',p.policyname,t);
   end loop;
  end if;
 end loop;
 if to_regprocedure('public.save_material_state(jsonb,jsonb)') is not null then
  revoke all on function public.save_material_state(jsonb,jsonb) from public,anon,authenticated;
 end if;
end$$;
-- No tables, legacy stock, Auth users or sessions are deleted by this script.
commit;
