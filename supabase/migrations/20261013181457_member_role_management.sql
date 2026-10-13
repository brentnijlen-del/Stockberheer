-- Add role selection without changing any existing account, role or inventory.
-- Install only after separately approving the SQL/Edge/website release.
begin;
set local lock_timeout = '5s';

alter table material_private.user_events
  add column if not exists old_role text check (old_role in ('admin', 'volunteer')),
  add column if not exists new_role text check (new_role in ('admin', 'volunteer'));

create or replace function material_private.set_member_role(
  target uuid, new_role text, expected_role text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare member material_private.members%rowtype;
begin
  -- Same lock as stock commands and blocking: re-evaluate the actor after waiting.
  perform pg_advisory_xact_lock(734621909);
  if material_private.member_role() <> 'admin' then
    raise exception 'Beheerder vereist' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('admin', 'volunteer')
     or expected_role is null or expected_role not in ('admin', 'volunteer') then
    raise exception 'Kies beheerder of vrijwilliger' using errcode = '22023';
  end if;
  if target = auth.uid() then
    raise exception 'Je kunt je eigen rol niet wijzigen' using errcode = '42501';
  end if;
  select * into member from material_private.members where user_id = target for update;
  if not found then
    raise exception 'Laat deze gebruiker eerst de uitnodiging accepteren';
  end if;
  if member.status <> 'active' then
    raise exception 'Heractiveer de gebruiker voordat je de rol wijzigt';
  end if;
  -- A lost response may be retried without applying the change or audit twice.
  if member.role = new_role then return jsonb_build_object('saved', true); end if;
  if member.role is distinct from expected_role then
    raise exception 'Rol ondertussen gewijzigd; ververs het overzicht' using errcode = '40001';
  end if;
  if member.role = 'admin' and new_role = 'volunteer'
     and (select count(*) from material_private.members where role = 'admin' and status = 'active') <= 1 then
    raise exception 'De laatste beheerder kan niet worden omgezet naar vrijwilliger' using errcode = '42501';
  end if;
  update material_private.members set role = new_role where user_id = target;
  insert into material_private.user_events(actor_id, target_id, action, old_role, new_role)
    values (auth.uid(), target, 'role_changed', member.role, new_role);
  return jsonb_build_object('saved', true);
end $$;

create or replace function public.material_set_member_role(
  target uuid, new_role text, expected_role text
) returns jsonb language sql security invoker set search_path = '' as $$
  select material_private.set_member_role(target, new_role, expected_role)
$$;

revoke all on function material_private.set_member_role(uuid, text, text),
  public.material_set_member_role(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function material_private.set_member_role(uuid, text, text),
  public.material_set_member_role(uuid, text, text) to authenticated;
commit;
