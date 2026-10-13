-- PIN broker: no existing passwords/accounts/roles/stock are changed by installation.
-- Personal enrolment replaces ONLY that user's Auth password, after verified consent.
begin;
set local lock_timeout='5s';
create table if not exists material_private.pin_credentials (
 user_id uuid primary key references auth.users(id) on delete restrict,
 pepper text not null default replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
 active boolean not null default false,pending_id uuid,pending_at timestamptz,last_request_id uuid,
 updated_at timestamptz not null default now()
);
alter table material_private.pin_credentials add column if not exists last_request_id uuid;
create table if not exists material_private.pin_limits (
 key text primary key,window_started timestamptz not null default now(),attempts integer not null default 0 check(attempts>=0)
);
alter table material_private.pin_credentials enable row level security;
alter table material_private.pin_limits enable row level security;
revoke all on material_private.pin_credentials,material_private.pin_limits from public,anon,authenticated,service_role;

create or replace function material_private.pin_actor(actor uuid,actor_session uuid,invitation uuid) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from auth.sessions where id=actor_session and user_id=actor and created_at>now()-interval '15 minutes' and (not_after is null or not_after>now())) then
  raise exception 'Meld opnieuw aan om je pincode in te stellen' using errcode='42501';end if;
 if exists(select 1 from material_private.members where user_id=actor and status='blocked') then raise exception 'Geen toegang' using errcode='42501';end if;
 if invitation is null then
  if not exists(select 1 from material_private.members where user_id=actor and status='active') then raise exception 'Geen toegang' using errcode='42501';end if;
 else
  if not exists(select 1 from material_private.invitations i join auth.users u on u.id=i.user_id join auth.sessions s on s.user_id=u.id
    where i.id=invitation and i.user_id=actor and i.state='sent' and i.expires_at>now() and lower(u.email)=i.email and u.email_confirmed_at is not null and s.id=actor_session and s.created_at>=i.sent_at) then
   raise exception 'Uitnodiging verlopen of ongeldig; gebruik de nieuwste link' using errcode='42501';end if;
 end if;
end$$;
create or replace function material_private.pin_prepare_enrol(actor uuid,actor_session uuid,invitation uuid,request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c material_private.pin_credentials%rowtype;
begin
 perform pg_advisory_xact_lock(734621909);
 perform material_private.pin_actor(actor,actor_session,invitation);
 if request is null then raise exception 'Ongeldig verzoek';end if;
 insert into material_private.pin_credentials(user_id) values(actor) on conflict(user_id) do nothing;
 select * into c from material_private.pin_credentials where user_id=actor for update;
 if c.active and c.last_request_id=request and c.pending_id is null then
  return jsonb_build_object('user_id',actor,'pepper',c.pepper,'already_saved',true);end if;
 if c.pending_id is not null and c.pending_id<>request and c.pending_at>now()-interval '5 minutes' then
  raise exception 'Pincode-opslag nog niet bevestigd; wacht vijf minuten en probeer opnieuw';end if;
 update material_private.pin_credentials set pending_id=request,pending_at=now() where user_id=actor;
 -- Immutable per-user pepper remains server-only, including uncertain/retried Auth updates.
 return jsonb_build_object('user_id',actor,'pepper',c.pepper);
end$$;
create or replace function material_private.pin_finish_enrol(actor uuid,actor_session uuid,invitation uuid,request uuid,succeeded boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare old_active boolean;e text;
begin
 perform pg_advisory_xact_lock(734621909);
 perform material_private.pin_actor(actor,actor_session,invitation);
 if succeeded and exists(select 1 from material_private.pin_credentials where user_id=actor and active and last_request_id=request and pending_id is null) then
  return jsonb_build_object('saved',true);end if;
 select active into old_active from material_private.pin_credentials where user_id=actor and pending_id=request for update;
 if not found then raise exception 'Pincodeverzoek gewijzigd';end if;
 update material_private.pin_credentials set active=case when succeeded then true else active end,last_request_id=case when succeeded then request else last_request_id end,pending_id=null,pending_at=null,updated_at=now() where user_id=actor and pending_id=request;
 if succeeded then
  select lower(email) into e from auth.users where id=actor;
  perform pg_advisory_xact_lock(734621910);
  update material_private.pin_limits set attempts=0,window_started=now() where key='login:'||e;
  insert into material_private.user_events(actor_id,target_id,action) values(actor,actor,case when old_active then 'pin_changed' else 'pin_enabled' end);
 end if;
 return jsonb_build_object('saved',succeeded);
end$$;
create or replace function material_private.pin_budget(bucket text,maximum integer,window_length interval) returns boolean language plpgsql set search_path='' as $$
declare n integer;
begin
 insert into material_private.pin_limits(key) values(bucket) on conflict(key) do nothing;
 update material_private.pin_limits set
  attempts=case when window_started<=now()-window_length then 1 else attempts+1 end,
  window_started=case when window_started<=now()-window_length then now() else window_started end
  where key=bucket returning attempts into n;
 return n<=maximum;
end$$;
create or replace function material_private.pin_prepare_login(email_input text) returns jsonb language plpgsql security definer set search_path='' as $$
declare e text:=lower(btrim(email_input));c material_private.pin_credentials%rowtype;
begin
 perform pg_advisory_xact_lock(734621910);
 if e is null or length(e)>254 or e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return jsonb_build_object('allowed',false);end if;
 delete from material_private.pin_limits where window_started<now()-interval '1 day';
 if not material_private.pin_budget('login-global',120,interval '15 minutes') then return jsonb_build_object('allowed',false);end if;
 if not material_private.pin_budget('login:'||e,5,interval '15 minutes') then return jsonb_build_object('allowed',false);end if;
 select p.* into c from material_private.pin_credentials p join auth.users u on u.id=p.user_id join material_private.members m on m.user_id=u.id where lower(u.email)=e and p.active and m.status='active';
 if not found then return jsonb_build_object('allowed',true);end if;
 return jsonb_build_object('allowed',true,'user_id',c.user_id,'pepper',c.pepper);
end$$;
create or replace function material_private.pin_finish_login(actor uuid,actor_session uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e text;
begin
 perform pg_advisory_xact_lock(734621909);
 if not exists(select 1 from material_private.members where user_id=actor and status='active') or not exists(select 1 from material_private.pin_credentials where user_id=actor and active)
  or not exists(select 1 from auth.sessions where id=actor_session and user_id=actor and (not_after is null or not_after>now())) then return jsonb_build_object('allowed',false);end if;
 select lower(email) into e from auth.users where id=actor;
 -- Serialize with login budgets; never acquire the stock lock from a budget transaction.
 perform pg_advisory_xact_lock(734621910);
 update material_private.pin_limits set attempts=0,window_started=now() where key='login:'||e;
 insert into material_private.user_events(actor_id,target_id,action) values(actor,actor,'pin_login');
 return jsonb_build_object('allowed',true);
end$$;
create or replace function material_private.pin_prepare_reset(email_input text) returns jsonb language plpgsql security definer set search_path='' as $$
declare e text:=lower(btrim(email_input)); allowed boolean;
begin
 perform pg_advisory_xact_lock(734621910);
 if e is null or length(e)>254 or e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return jsonb_build_object('allowed',false);end if;
 delete from material_private.pin_limits where window_started<now()-interval '1 day';
 if not material_private.pin_budget('reset-global',20,interval '1 hour') then return jsonb_build_object('allowed',false);end if;
 if not material_private.pin_budget('reset:'||e,1,interval '15 minutes') then return jsonb_build_object('allowed',false);end if;
 select exists(select 1 from auth.users u join material_private.members m on m.user_id=u.id where lower(u.email)=e and m.status='active') into allowed;
 return jsonb_build_object('allowed',allowed);
end$$;
create or replace function material_private.pin_status() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform material_private.member_role();
 return jsonb_build_object('enabled',exists(select 1 from material_private.pin_credentials where user_id=auth.uid() and active));
end$$;

create or replace function public.material_pin_prepare_enrol(actor uuid,actor_session uuid,invitation uuid,request uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_prepare_enrol(actor,actor_session,invitation,request)$$;
create or replace function public.material_pin_finish_enrol(actor uuid,actor_session uuid,invitation uuid,request uuid,succeeded boolean) returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_finish_enrol(actor,actor_session,invitation,request,succeeded)$$;
create or replace function public.material_pin_prepare_login(email_input text) returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_prepare_login(email_input)$$;
create or replace function public.material_pin_finish_login(actor uuid,actor_session uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_finish_login(actor,actor_session)$$;
create or replace function public.material_pin_prepare_reset(email_input text) returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_prepare_reset(email_input)$$;
create or replace function public.material_pin_status() returns jsonb language sql security invoker set search_path='' as $$select material_private.pin_status()$$;

revoke all on function material_private.pin_actor(uuid,uuid,uuid),material_private.pin_budget(text,integer,interval),
 material_private.pin_prepare_enrol(uuid,uuid,uuid,uuid),material_private.pin_finish_enrol(uuid,uuid,uuid,uuid,boolean),material_private.pin_prepare_login(text),material_private.pin_finish_login(uuid,uuid),material_private.pin_prepare_reset(text),material_private.pin_status(),
 public.material_pin_prepare_enrol(uuid,uuid,uuid,uuid),public.material_pin_finish_enrol(uuid,uuid,uuid,uuid,boolean),public.material_pin_prepare_login(text),public.material_pin_finish_login(uuid,uuid),public.material_pin_prepare_reset(text),public.material_pin_status()
 from public,anon,authenticated,service_role;
grant usage on schema material_private to service_role;
grant execute on function material_private.pin_prepare_enrol(uuid,uuid,uuid,uuid),material_private.pin_finish_enrol(uuid,uuid,uuid,uuid,boolean),material_private.pin_prepare_login(text),material_private.pin_finish_login(uuid,uuid),material_private.pin_prepare_reset(text),
 public.material_pin_prepare_enrol(uuid,uuid,uuid,uuid),public.material_pin_finish_enrol(uuid,uuid,uuid,uuid,boolean),public.material_pin_prepare_login(text),public.material_pin_finish_login(uuid,uuid),public.material_pin_prepare_reset(text) to service_role;
grant execute on function public.material_pin_status(),material_private.pin_status() to authenticated;
commit;
