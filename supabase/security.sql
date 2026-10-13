-- Review and run in Supabase SQL Editor before deploying this application.
-- Preserve existing inventory. Replace all old app_state policies and grants.
begin;
create table if not exists public.app_state (id text primary key, data jsonb not null);
create table if not exists public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'volunteer'))
);
alter table public.app_members enable row level security;
alter table public.app_state enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
    where schemaname='public' and tablename in ('app_state','app_members')
  loop execute format('drop policy %I on public.%I',p.policyname,p.tablename); end loop;
end $$;
revoke all on public.app_state, public.app_members from anon, authenticated;
grant select on public.app_state, public.app_members to authenticated;
create policy own_membership on public.app_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy member_read on public.app_state for select to authenticated
  using (exists (select 1 from public.app_members where user_id = (select auth.uid())));
-- Only this function can write inventory. Role changes require dashboard/SQL administration.
create or replace function public.save_material_state(new_data jsonb, expected_data jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare member_role text; previous jsonb;
begin
  select role into member_role from public.app_members where user_id=auth.uid();
  if member_role is null then raise exception 'Access denied'; end if;
  if new_data is null or jsonb_typeof(new_data)<>'object'
     or new_data ? 'pin' or new_data ? 'userMode' then raise exception 'Invalid state'; end if;
  -- Serialize updates, including initial creation, to prevent lost changes.
  perform pg_advisory_xact_lock(734621908);
  select data into previous from public.app_state where id='main' for update;
  if previous is distinct from expected_data then raise exception 'State changed; reload'; end if;
  if member_role='volunteer' then
    if previous is null then raise exception 'Administrator must initialize inventory'; end if;
    -- Volunteers can change operational records, never catalogue/configuration or roles.
    if (new_data - array['lots','moves','shortages','loans']) is distinct from
       (previous - array['pin','userMode','lots','moves','shortages','loans']) then
      raise exception 'Administrator access required';
    end if;
  end if;
  insert into public.app_state(id,data) values ('main',new_data)
    on conflict (id) do update set data=excluded.data;
  return true;
end $$;
revoke all on function public.save_material_state(jsonb,jsonb) from public, anon;
grant execute on function public.save_material_state(jsonb,jsonb) to authenticated;
commit;
