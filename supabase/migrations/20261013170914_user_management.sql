-- Issue #2. Idempotent, additive migration. No Auth accounts, stock or existing membership rows changed.
-- Review and explicitly authorize production installation separately.
begin;
set local lock_timeout='5s';
alter table material_private.members add column if not exists status text not null default 'active' check(status in ('active','blocked'));
alter table material_private.members add column if not exists activated_at timestamptz;
create table if not exists material_private.invitations (
 id uuid primary key default gen_random_uuid(),email text not null unique,
 role text not null default 'volunteer' check(role='volunteer'),
 user_id uuid unique references auth.users(id) on delete restrict,
 requested_by uuid not null references auth.users(id) on delete restrict,
 request_id uuid not null, state text not null check(state in ('sending','sent','failed','accepted')),
 created_at timestamptz not null default now(),last_attempt_at timestamptz not null default now(),
 sent_at timestamptz,expires_at timestamptz,accepted_at timestamptz
);
create table if not exists material_private.user_events (
 id bigint generated always as identity primary key,actor_id uuid not null references auth.users(id) on delete restrict,
 target_id uuid references auth.users(id) on delete restrict,email text,action text not null,at timestamptz not null default now()
);
create index if not exists user_event_actor on material_private.user_events(actor_id,at);
create index if not exists user_event_target on material_private.user_events(target_id);
create index if not exists invitation_actor on material_private.invitations(requested_by);
alter table material_private.invitations enable row level security;
alter table material_private.user_events enable row level security;
revoke all on material_private.invitations,material_private.user_events from public,anon,authenticated,service_role;
create or replace function material_private.member_role() returns text language plpgsql volatile security definer set search_path='' as $$
declare result text; session_key uuid;
begin
 if auth.uid() is null then raise exception 'Aanmelden vereist' using errcode='42501';end if;
 -- A revoked session must stop granting access even before its JWT expires.
 session_key:=(auth.jwt()->>'session_id')::uuid;
 if session_key is null or not exists(select 1 from auth.sessions where id=session_key and user_id=auth.uid() and (not_after is null or not_after>now())) then
  raise exception 'Sessie verlopen; meld opnieuw aan' using errcode='42501';end if;
 select role into result from material_private.members where user_id=auth.uid() and status='active';
 if result is null then raise exception 'Je account heeft geen toegang' using errcode='42501';end if;
 return result;
end$$;
create or replace function material_private.manage_users(action text,target uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare member material_private.members%rowtype; result jsonb;
begin
 perform pg_advisory_xact_lock(734621909);
 if material_private.member_role()<>'admin' then raise exception 'Beheerder vereist' using errcode='42501';end if;
 if action='list' then
  select coalesce(jsonb_agg(x order by x->>'email'),'[]') into result from (
   select jsonb_build_object('id',m.user_id,'email',u.email,'role',m.role,'status',m.status,'date',m.activated_at,'invitation_id',i.id,'expires_at',i.expires_at) x from material_private.members m join auth.users u on u.id=m.user_id left join material_private.invitations i on i.user_id=m.user_id
   union all
   select jsonb_build_object('id',i.user_id,'email',i.email,'role','volunteer','status','invited','date',i.sent_at,'invitation_id',i.id,'expires_at',i.expires_at,'delivery',i.state) x from material_private.invitations i where i.state<>'accepted' and not exists(select 1 from material_private.members where user_id=i.user_id)
  ) q;
  return result;
 end if;
 if action not in ('block','reactivate') then raise exception 'Onbekende beheeractie';end if;
 select * into member from material_private.members where user_id=target for update;
 if not found then raise exception 'Gebruiker heeft geen actieve of geblokkeerde toegang';end if;
 if target=auth.uid() then raise exception 'Je kunt je eigen toegang niet wijzigen';end if;
 if action='block' and member.role='admin' and member.status='active' and (select count(*) from material_private.members where role='admin' and status='active')<=1 then raise exception 'De laatste beheerder kan niet worden geblokkeerd';end if;
 if member.status=(case when action='block' then 'blocked' else 'active' end) then return jsonb_build_object('saved',true);end if;
 update material_private.members set status=case when action='block' then 'blocked' else 'active' end where user_id=target;
 insert into material_private.user_events(actor_id,target_id,action) values(auth.uid(),target,action);
 return jsonb_build_object('saved',true);
end$$;
create or replace function material_private.prepare_invite(email_input text,request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e text:=lower(btrim(email_input));inv material_private.invitations%rowtype;existing auth.users%rowtype;
begin
 perform pg_advisory_xact_lock(734621909);
 if material_private.member_role()<>'admin' then raise exception 'Beheerder vereist' using errcode='42501';end if;
 if request is null or e is null or length(e)>254 or e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Geef een geldig e-mailadres in';end if;
 select * into inv from material_private.invitations where email=e for update;
 if inv.state='accepted' then raise exception 'Dit account heeft al toegang; gebruik blokkeren of heractiveren';end if;
 if inv.request_id=request and inv.requested_by=auth.uid() then
  if inv.state='sent' then return jsonb_build_object('already_sent',true,'id',inv.id);end if;
  raise exception 'Deze verzending is nog niet bevestigd; wacht een minuut en gebruik opnieuw verzenden';
 end if;
 if inv.last_attempt_at>now()-interval '1 minute' then raise exception 'Wacht één minuut voordat je opnieuw verzendt';end if;
 select * into existing from auth.users where lower(email)=e;
 if found then
  -- Never invite/reset an unrelated existing account. A retry may reuse ONLY the new invited account.
  if inv.id is null or existing.invited_at is null or existing.created_at<inv.created_at or (inv.user_id is not null and inv.user_id<>existing.id) or (inv.user_id is null and existing.raw_user_meta_data->>'material_invitation_id' is distinct from inv.id::text) or exists(select 1 from material_private.members where user_id=existing.id) then raise exception 'Dit bestaande account wordt niet gewijzigd. Contacteer de projectbeheerder';end if;
 end if;
 if (select count(*) from material_private.user_events where actor_id=auth.uid() and action='invite_requested' and at>now()-interval '15 minutes')>=20 then raise exception 'Te veel uitnodigingen. Probeer later opnieuw';end if;
 if inv.id is null then
  insert into material_private.invitations(email,requested_by,request_id,state) values(e,auth.uid(),request,'sending') returning * into inv;
 else
  update material_private.invitations set requested_by=auth.uid(),request_id=request,state='sending',last_attempt_at=now() where id=inv.id returning * into inv;
 end if;
 insert into material_private.user_events(actor_id,email,action) values(auth.uid(),e,'invite_requested');
 return jsonb_build_object('id',inv.id,'email',e,'user_id',existing.id,'delivery',case when existing.email_confirmed_at is not null then 'recovery' else 'invite' end);
end$$;
create or replace function material_private.finish_invite(invitation uuid,request uuid,actor uuid,actor_session uuid,new_user uuid,delivered boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare inv material_private.invitations%rowtype;u auth.users%rowtype;
begin
 perform pg_advisory_xact_lock(734621909);
 if not exists(select 1 from material_private.members where user_id=actor and role='admin' and status='active') or not exists(select 1 from auth.sessions where id=actor_session and user_id=actor and (not_after is null or not_after>now())) then raise exception 'Beheerder vereist' using errcode='42501';end if;
 select * into inv from material_private.invitations where id=invitation and request_id=request and requested_by=actor for update;
 if not found or inv.state<>'sending' then raise exception 'Uitnodigingsverzoek is gewijzigd';end if;
 if delivered then
  select * into u from auth.users where id=new_user;
  if not found or lower(u.email)<>inv.email or u.invited_at is null or u.created_at<inv.created_at or (inv.user_id is not null and inv.user_id<>new_user) or (inv.user_id is null and u.raw_user_meta_data->>'material_invitation_id' is distinct from inv.id::text) or exists(select 1 from material_private.members where user_id=new_user) then raise exception 'Account hoort niet bij deze nieuwe uitnodiging';end if;
  update material_private.invitations set user_id=new_user,state='sent',sent_at=now(),expires_at=now()+interval '1 hour' where id=inv.id;
 else update material_private.invitations set state='failed' where id=inv.id;end if;
 insert into material_private.user_events(actor_id,target_id,email,action) values(actor,case when delivered then new_user else null end,inv.email,case when delivered then 'invite_sent' else 'invite_failed' end);
 return jsonb_build_object('saved',true);
end$$;
create or replace function material_private.accept_invite(invitation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare inv material_private.invitations%rowtype;session_key uuid:=(auth.jwt()->>'session_id')::uuid;
begin
 perform pg_advisory_xact_lock(734621909);
 if auth.uid() is null or not exists(select 1 from auth.sessions where id=session_key and user_id=auth.uid() and (not_after is null or not_after>now())) then raise exception 'Geldige uitnodigingssessie vereist' using errcode='42501';end if;
 select * into inv from material_private.invitations where id=invitation and user_id=auth.uid() for update;
 if not found then raise exception 'Uitnodiging hoort niet bij dit account' using errcode='42501';end if;
 if inv.state='accepted' and exists(select 1 from material_private.members where user_id=auth.uid() and status='active' and role='volunteer') then return jsonb_build_object('saved',true);end if;
 if not exists(select 1 from auth.sessions where id=session_key and user_id=auth.uid() and created_at>=inv.sent_at) then raise exception 'Gebruik de meest recente uitnodigingslink';end if;
 if inv.state<>'sent' or inv.expires_at<=now() then raise exception 'Uitnodiging verlopen of ongeldig. Vraag opnieuw verzenden';end if;
 if not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and lower(email)=inv.email) then raise exception 'Bevestig eerst je e-mailadres';end if;
 if exists(select 1 from material_private.members where user_id=auth.uid()) then raise exception 'Bestaande toegang wordt niet door een uitnodiging gewijzigd' using errcode='42501';end if;
 insert into material_private.members(user_id,role,status,activated_at) values(auth.uid(),'volunteer','active',now());
 update material_private.invitations set state='accepted',accepted_at=now() where id=inv.id;
 insert into material_private.user_events(actor_id,target_id,email,action) values(auth.uid(),auth.uid(),inv.email,'invite_accepted');
 return jsonb_build_object('saved',true);
end$$;
create or replace function material_private.invite_status(invitation uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from material_private.invitations i join auth.sessions s on s.user_id=i.user_id where i.id=invitation and i.user_id=auth.uid() and i.state='sent' and i.expires_at>now() and s.id=(auth.jwt()->>'session_id')::uuid and s.created_at>=i.sent_at and (s.not_after is null or s.not_after>now())) then raise exception 'Uitnodiging verlopen of ongeldig. Gebruik de nieuwste link of vraag opnieuw verzenden' using errcode='42501';end if;
 return jsonb_build_object('eligible',true);
end$$;
create or replace function public.material_invite_status(invitation uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.invite_status(invitation)$$;
revoke all on function public.material_invite_status(uuid),material_private.invite_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.material_invite_status(uuid),material_private.invite_status(uuid) to authenticated;
create or replace function public.material_manage_users(action text,target uuid default null) returns jsonb language sql security invoker set search_path='' as $$select material_private.manage_users(action,target)$$;
create or replace function public.material_prepare_invite(email_input text,request uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.prepare_invite(email_input,request)$$;
create or replace function public.material_finish_invite(invitation uuid,request uuid,actor uuid,actor_session uuid,new_user uuid,delivered boolean) returns jsonb language sql security invoker set search_path='' as $$select material_private.finish_invite(invitation,request,actor,actor_session,new_user,delivered)$$;
create or replace function public.material_accept_invite(invitation uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.accept_invite(invitation)$$;
revoke all on function public.material_manage_users(text,uuid),public.material_prepare_invite(text,uuid),public.material_finish_invite(uuid,uuid,uuid,uuid,uuid,boolean),public.material_accept_invite(uuid) from public,anon,authenticated,service_role;
revoke all on function material_private.manage_users(text,uuid),material_private.prepare_invite(text,uuid),material_private.finish_invite(uuid,uuid,uuid,uuid,uuid,boolean),material_private.accept_invite(uuid) from public,anon,authenticated,service_role;
grant execute on function public.material_manage_users(text,uuid),public.material_prepare_invite(text,uuid),public.material_accept_invite(uuid),material_private.manage_users(text,uuid),material_private.prepare_invite(text,uuid),material_private.accept_invite(uuid) to authenticated;
grant usage on schema material_private to service_role;
grant execute on function public.material_finish_invite(uuid,uuid,uuid,uuid,uuid,boolean),material_private.finish_invite(uuid,uuid,uuid,uuid,uuid,boolean) to service_role;
create or replace function material_private.execute(command jsonb, request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r text:=material_private.member_role(); op text:=command->>'type'; p jsonb:=command->'payload';
 previous material_private.requests%rowtype; lot material_private.lots%rowtype; line material_private.loan_lines%rowtype;
 item jsonb; ident uuid; product uuid; location uuid; loan uuid; amount integer; remaining integer; take integer;
 result jsonb; exp date; current_revision bigint; entity text; nm text; code text; scan_key text; ver integer; existed boolean;
 restore_category_ids uuid[]; restore_product_ids uuid[]; restore_location_ids uuid[]; restore_lot_ids uuid[];
begin
 if request_id is null or jsonb_typeof(command)<>'object' or jsonb_typeof(p) is distinct from 'object' or octet_length(command::text)>5000000 then raise exception 'Ongeldig verzoek' using errcode='22023';end if;
 -- Small departmental inventory: serialize commands; clients submit operations, never stale state.
 perform pg_advisory_xact_lock(734621909);
 -- Recheck after waiting: a blocked account must not write with a pre-lock role.
 r:=material_private.member_role();
 select * into previous from material_private.requests where actor_id=auth.uid() and material_private.requests.request_id=execute.request_id;
 if found then
  if previous.command is distinct from command then raise exception 'Verzoek-ID opnieuw gebruikt met andere inhoud' using errcode='22023';end if;
  return previous.result;
 end if;
 if op not in ('consume','inventory','shortage','loan','return') and r<>'admin' then raise exception 'Beheerder vereist' using errcode='42501';end if;
 -- Local date for expiry decisions, independent of database server timezone.
 if op='catalog' then
  entity:=p->>'entity';ident:=(p->>'id')::uuid;nm:=material_private.text_value(p->'name',120,true);
  if entity in ('product','location') then
   code:=material_private.text_value(p->'code',80,entity='product' or p->>'kind'='case');
   scan_key:=upper(regexp_replace(code,'[^a-zA-Z0-9]','','g'));
   if code<>'' and ((entity='product' and exists(select 1 from material_private.locations where code_key=scan_key)) or (entity='location' and exists(select 1 from material_private.products where code_key=scan_key))) then raise exception 'Code bestaat al bij product of koffer';end if;
  end if;
  if entity='category' then
   select version into ver from material_private.categories where id=ident;existed:=found;
   if existed and ver is distinct from (p->>'version')::int then raise exception 'Record gewijzigd; ververs en probeer opnieuw' using errcode='40001';end if;
   insert into material_private.categories(id,name) values(ident,nm) on conflict(id) do update set name=excluded.name,version=categories.version+1;
  elsif entity='product' then
   code:=material_private.text_value(p->'code',80,true);amount:=material_private.whole(p->'minimum');
   select version into ver from material_private.products where id=ident;existed:=found;
   if existed and ver is distinct from (p->>'version')::int then raise exception 'Record gewijzigd; ververs en probeer opnieuw' using errcode='40001';end if;
   if p->>'category_id' is not null and not exists(select 1 from material_private.categories where id=(p->>'category_id')::uuid and active) then raise exception 'Categorie bestaat niet';end if;
   insert into material_private.products(id,name,code,minimum,category_id) values(ident,nm,code,amount,(p->>'category_id')::uuid) on conflict(id) do update set name=excluded.name,code=excluded.code,minimum=excluded.minimum,category_id=excluded.category_id,version=products.version+1;
  elsif entity='location' then
   code:=nullif(material_private.text_value(p->'code',80),'');
   select version into ver from material_private.locations where id=ident;existed:=found;
   if existed and ver is distinct from (p->>'version')::int then raise exception 'Record gewijzigd; ververs en probeer opnieuw' using errcode='40001';end if;
   insert into material_private.locations(id,name,kind,code,description) values(ident,nm,p->>'kind',code,material_private.text_value(p->'description',500)) on conflict(id) do update set name=excluded.name,code=excluded.code,description=excluded.description,version=locations.version+1;
  else raise exception 'Onbekend catalogustype';end if;
  perform material_private.audit(request_id,'catalogus',null,0,jsonb_build_object('entity',entity,'id',ident));
 elsif op='archive' then
  ident:=(p->>'id')::uuid;entity:=p->>'entity';
  if entity='product' then
   if exists(select 1 from material_private.lots where product_id=ident and quantity>0) or exists(select 1 from material_private.loan_lines x join material_private.lots l on l.id=x.lot_id where l.product_id=ident and x.returned<x.quantity) or exists(select 1 from material_private.shortages where product_id=ident and resolved_at is null) then raise exception 'Product heeft voorraad, uitleningen of tekorten';end if;
   update material_private.products set active=false,version=version+1 where id=ident;
   delete from material_private.targets where product_id=ident;
  elsif entity='category' then
   if exists(select 1 from material_private.products where category_id=ident and active) then raise exception 'Categorie is nog in gebruik';end if;
   update material_private.categories set active=false,version=version+1 where id=ident;
  elsif entity='location' then
   if exists(select 1 from material_private.lots where location_id=ident and quantity>0) or exists(select 1 from material_private.loan_lines x join material_private.lots l on l.id=x.lot_id where l.location_id=ident and x.returned<x.quantity) or exists(select 1 from material_private.shortages where location_id=ident and resolved_at is null) then raise exception 'Locatie heeft voorraad, uitleningen of tekorten';end if;
   update material_private.locations set active=false,version=version+1 where id=ident;
   delete from material_private.targets where location_id=ident;
  else raise exception 'Onbekend catalogustype';end if;
  perform material_private.audit(request_id,'archivering',null,0,p);
 elsif op='target' then
  location:=(p->>'location_id')::uuid;product:=(p->>'product_id')::uuid;perform material_private.available(product,location);
  if not exists(select 1 from material_private.locations where id=location and kind='case') then raise exception 'Materiaallijst vereist koffer';end if;
  select version into ver from material_private.locations where id=location;
  if ver is distinct from (p->>'version')::int then raise exception 'Materiaallijst gewijzigd; ververs' using errcode='40001';end if;
  amount:=material_private.whole(p->'quantity');
  if amount=0 then delete from material_private.targets where product_id=product and location_id=location;
  else insert into material_private.targets values(location,product,amount) on conflict(location_id,product_id) do update set quantity=excluded.quantity;end if;
  update material_private.locations set version=version+1 where id=location;
  perform material_private.audit(request_id,'materiaallijst',null,0,p);
 elsif op='receive' then
  product:=(p->>'product_id')::uuid;location:=(p->>'location_id')::uuid;perform material_private.available(product,location);
  amount:=material_private.whole(p->'quantity',1);exp:=nullif(p->>'expiry','')::date;
  code:=material_private.text_value(p->'batch',120);
  select * into lot from material_private.lots where product_id=product and location_id=location and batch=code and expiry is not distinct from exp;
  if found then update material_private.lots set quantity=quantity+amount,version=version+1 where id=lot.id;
  else insert into material_private.lots(id,product_id,location_id,quantity,batch,expiry) values(gen_random_uuid(),product,location,amount,code,exp) returning * into lot;end if;
  perform material_private.audit(request_id,'aanvulling',lot.id,amount);
 elsif op in ('consume','loan') then
  product:=(p->>'product_id')::uuid;location:=(p->>'location_id')::uuid;perform material_private.available(product,location);
  amount:=material_private.whole(p->'quantity',1);remaining:=amount;
  if (select coalesce(sum(quantity),0) from material_private.lots where product_id=product and location_id=location and (expiry is null or expiry>=(now() at time zone 'Europe/Brussels')::date))<amount then raise exception 'Onvoldoende bruikbare voorraad';end if;
  if op='loan' then
   loan:=gen_random_uuid();
   insert into material_private.loans(id,actor_id,who,event,description) values(loan,auth.uid(),material_private.text_value(p->'who',120,true),material_private.text_value(p->'event',500),(select name from material_private.products where id=product));
  end if;
  for lot in select * from material_private.lots where product_id=product and location_id=location and quantity>0 and (expiry is null or expiry>=(now() at time zone 'Europe/Brussels')::date) order by expiry nulls last,id for update loop
   take:=least(remaining,lot.quantity);update material_private.lots set quantity=quantity-take,version=version+1 where id=lot.id;
   if op='loan' then insert into material_private.loan_lines(id,loan_id,lot_id,quantity) values(gen_random_uuid(),loan,lot.id,take);end if;
   perform material_private.audit(request_id,case when op='loan' then 'uitlening' else 'verbruik' end,lot.id,-take,jsonb_build_object('loan_id',loan));
   remaining:=remaining-take;exit when remaining=0;
  end loop;
 elsif op='return' then
  loan:=(p->>'loan_id')::uuid;amount:=material_private.whole(p->'quantity',1);remaining:=amount;
  if (select coalesce(sum(quantity-returned),0) from material_private.loan_lines where loan_id=loan)<amount then raise exception 'Retour overschrijdt openstaand aantal';end if;
  for line in select * from material_private.loan_lines where loan_id=loan and returned<quantity order by id for update loop
   take:=least(remaining,line.quantity-line.returned);
   update material_private.loan_lines set returned=returned+take where id=line.id;
   update material_private.lots set quantity=quantity+take,version=version+1 where id=line.lot_id;
   perform material_private.audit(request_id,'retour',line.lot_id,take,jsonb_build_object('loan_id',loan));
   remaining:=remaining-take;exit when remaining=0;
  end loop;
 elsif op in ('inventory','adjust') then
  if op='inventory' then
   if not exists(select 1 from material_private.locations where id=(p->>'location_id')::uuid and active and kind='case') then raise exception 'Controle vereist een actieve koffer';end if;
   if jsonb_typeof(p->'lots') is distinct from 'array' or jsonb_array_length(p->'lots')=0 or jsonb_array_length(p->'lots')>10000 then raise exception 'Geen geldige lotcontrole';end if;
   if (select count(*) from jsonb_array_elements(p->'lots'))<>(select count(distinct value->>'id') from jsonb_array_elements(p->'lots')) then raise exception 'Dubbel lot in controle';end if;
  end if;
  for item in select value from jsonb_array_elements(case when op='adjust' then jsonb_build_array(p) else p->'lots' end) loop
   select * into lot from material_private.lots where id=(item->>'id')::uuid for update;
   if not found then raise exception 'Lot bestaat niet';end if;
   if op='inventory' and lot.location_id is distinct from (p->>'location_id')::uuid then raise exception 'Lot hoort bij andere locatie';end if;
   if lot.version is distinct from (item->>'version')::int then raise exception 'Voorraad gewijzigd; ververs de lotcontrole' using errcode='40001';end if;
   amount:=material_private.whole(item->'quantity');
   if amount<>lot.quantity then
    update material_private.lots set quantity=amount,version=version+1 where id=lot.id;
    perform material_private.audit(request_id,'voorraadcorrectie',lot.id,amount-lot.quantity,jsonb_build_object('reason',material_private.text_value(p->'reason',500,true)));
   end if;
  end loop;
 elsif op='shortage' then
  location:=(p->>'location_id')::uuid;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 1000 then raise exception 'Geen tekorten aangeduid';end if;
  if (select count(*) from jsonb_array_elements(p->'items'))<>(select count(distinct value->>'product_id') from jsonb_array_elements(p->'items')) then raise exception 'Dubbel product in tekortmelding';end if;
  for item in select value from jsonb_array_elements(p->'items') loop
   product:=(item->>'product_id')::uuid;perform material_private.available(product,location);amount:=material_private.whole(item->'quantity',1);
   if not exists(select 1 from material_private.targets where product_id=product and location_id=location and quantity>=amount) then raise exception 'Tekort buiten materiaallijst';end if;
   insert into material_private.shortages(id,location_id,product_id,quantity,note,actor_id) values(gen_random_uuid(),location,product,amount,material_private.text_value(p->'note',1000),auth.uid());
  end loop;
  perform material_private.audit(request_id,'tekortmelding',null,0,p-'note');
 elsif op='resolve' then
  update material_private.shortages set resolved_at=now(),resolution=material_private.text_value(p->'resolution',1000,true) where id=(p->>'id')::uuid and resolved_at is null;
  if not found then raise exception 'Tekort bestaat niet of is al opgelost';end if;
  perform material_private.audit(request_id,'tekortoplossing',null,0,p);
 elsif op='acknowledge' then
  insert into material_private.acknowledgements values(material_private.text_value(p->'key',300,true),material_private.text_value(p->'fingerprint',300,true)) on conflict(key) do update set fingerprint=excluded.fingerprint;
 elsif op='restore' then
  select value into current_revision from material_private.revision;
  if current_revision is distinct from (p->>'revision')::bigint then raise exception 'Voorraad gewijzigd sinds importvoorbeeld; ververs' using errcode='40001';end if;
  if exists(select 1 from material_private.loan_lines where returned<quantity) then raise exception 'Breng openstaande uitleningen eerst terug';end if;
  perform material_private.validate_backup(p->'backup');
  -- Capture the existing inventory identities under the command lock. Restore only these rows.
  -- Explicit key predicates keep safeupdate active; no blanket WHERE true or security overrides.
  select array_agg(id) into restore_category_ids from material_private.categories;
  select array_agg(id) into restore_product_ids from material_private.products;
  select array_agg(id) into restore_location_ids from material_private.locations;
  select array_agg(id) into restore_lot_ids from material_private.lots;
  -- Archive, never delete, historical identities. Historic moves and requests remain immutable.
  update material_private.categories set active=false,version=version+1 where id = any(restore_category_ids);
  update material_private.products set active=false,version=version+1 where id = any(restore_product_ids);
  update material_private.locations set active=false,version=version+1 where id = any(restore_location_ids);
  for item in select value from jsonb_array_elements(p->'backup'->'categories') loop
   insert into material_private.categories(id,name,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,active=excluded.active;
  end loop;
  for item in select value from jsonb_array_elements(p->'backup'->'locations') loop
   insert into material_private.locations(id,name,kind,code,description,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),item->>'kind',nullif(material_private.text_value(item->'code',80),''),material_private.text_value(item->'description',500),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,kind=excluded.kind,code=excluded.code,description=excluded.description,active=excluded.active;
  end loop;
  for item in select value from jsonb_array_elements(p->'backup'->'products') loop
   insert into material_private.products(id,name,code,category_id,minimum,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),material_private.text_value(item->'code',80,true),(item->>'category_id')::uuid,material_private.whole(item->'minimum'),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,code=excluded.code,category_id=excluded.category_id,minimum=excluded.minimum,active=excluded.active;
  end loop;
  delete from material_private.targets where location_id = any(restore_location_ids);
  insert into material_private.targets select (x->>'location_id')::uuid,(x->>'product_id')::uuid,material_private.whole(x->'quantity') from jsonb_array_elements(p->'backup'->'targets') x;
  for lot in select * from material_private.lots loop
   if lot.quantity<>0 then perform material_private.audit(request_id,'herstel',lot.id,-lot.quantity);end if;
  end loop;
  update material_private.lots set quantity=0,version=version+1 where id = any(restore_lot_ids);
  for item in select value from jsonb_array_elements(p->'backup'->'lots') loop
   ident:=(item->>'id')::uuid;amount:=material_private.whole(item->'quantity');
   if exists(select 1 from material_private.lots where id=ident and (product_id<>(item->>'product_id')::uuid or location_id<>(item->>'location_id')::uuid or batch is distinct from item->>'batch' or expiry is distinct from nullif(item->>'expiry','')::date)) then raise exception 'Historische lotidentiteit mag niet veranderen';end if;
   insert into material_private.lots(id,product_id,location_id,quantity,batch,expiry) values(ident,(item->>'product_id')::uuid,(item->>'location_id')::uuid,amount,material_private.text_value(item->'batch',120),nullif(item->>'expiry','')::date) on conflict(id) do update set quantity=excluded.quantity;
   if amount<>0 then perform material_private.audit(request_id,'herstel',ident,amount);end if;
  end loop;
  perform material_private.audit(request_id,'back-upherstel',null,0,jsonb_build_object('format',2));
 else raise exception 'Onbekende handeling' using errcode='22023';end if;
 update material_private.revision set value=value+1 where singleton=true returning value into current_revision;
 if not found then raise exception 'Revisierij ontbreekt; handeling teruggedraaid' using errcode='P0001';end if;
 result:=jsonb_build_object('revision',current_revision,'saved',true);
 insert into material_private.requests values(auth.uid(),request_id,command,result);
 return result;
end$$;
commit;
