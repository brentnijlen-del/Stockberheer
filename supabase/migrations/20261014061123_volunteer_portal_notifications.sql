-- Additive upgrade. No account changes, stock reset, external mail or cron installation.
begin;
set local lock_timeout='5s';
create table material_private.support_settings (
 singleton boolean primary key default true check(singleton),
 contact_name text not null default '', contact_email text not null default '', contact_phone text not null default ''
);
insert into material_private.support_settings(singleton) values(true);
create table material_private.help_requests (
 id uuid primary key, actor_id uuid not null references auth.users(id),
 message text not null check(length(message) between 1 and 2000),
 created_at timestamptz not null default now(), resolved_at timestamptz,
 resolved_by uuid references auth.users(id)
);
create table material_private.mail_incidents (
 key text primary key, generation uuid not null default gen_random_uuid(),
 active boolean not null default true, payload jsonb not null, updated_at timestamptz not null default now()
);
create table material_private.mail_outbox (
 id uuid primary key default gen_random_uuid(), incident_key text not null references material_private.mail_incidents(key),
 generation uuid not null, recipient uuid not null references auth.users(id),
 delivery_email text not null, delivery_payload jsonb not null, first_attempt timestamptz,
 status text not null default 'pending' check(status in ('pending','sending','sent','cancelled','failed')),
 attempts integer not null default 0 check(attempts between 0 and 8), lease uuid, next_attempt timestamptz not null default now(),
 sent_at timestamptz, provider_id text,
 unique(incident_key,generation,recipient)
);
create index mail_pending on material_private.mail_outbox(status,next_attempt);
alter table material_private.support_settings enable row level security;
alter table material_private.help_requests enable row level security;
alter table material_private.mail_incidents enable row level security;
alter table material_private.mail_outbox enable row level security;
revoke all on material_private.support_settings,material_private.help_requests,material_private.mail_incidents,material_private.mail_outbox from public,anon,authenticated,service_role;

create function material_private.portal_execute(command jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; previous material_private.requests%rowtype; p jsonb:=command->'payload'; result jsonb; rev bigint;
begin
 perform pg_advisory_xact_lock(734621909);
 r:=material_private.member_role();
 if r='volunteer' and (command->>'type') not in ('consume','shortage','help') then
  raise exception 'Vrijwilligers kunnen alleen verbruik, tekorten en hulpvragen registreren' using errcode='42501';
 end if;
 if (command->>'type') not in ('help','support_settings','resolve_help') then
  return material_private.execute(command,request_id);
 end if;
 if request_id is null or jsonb_typeof(p) is distinct from 'object' or octet_length(command::text)>10000 then
  raise exception 'Ongeldig verzoek' using errcode='22023';
 end if;
 select * into previous from material_private.requests q where q.actor_id=auth.uid() and q.request_id=portal_execute.request_id;
 if found then
  if previous.command is distinct from command then raise exception 'Verzoek-ID opnieuw gebruikt' using errcode='22023';end if;
  return previous.result;
 end if;
 if command->>'type'='help' then
  if (select count(*) from material_private.help_requests where actor_id=auth.uid() and created_at>now()-interval '1 hour')>=5 then
   raise exception 'Maximum vijf hulpvragen per uur; contacteer bij urgentie je verantwoordelijke' using errcode='22023';
  end if;
  insert into material_private.help_requests(id,actor_id,message)
  values(request_id,auth.uid(),material_private.text_value(p->'message',2000,true));
 elsif command->>'type'='support_settings' then
  if coalesce(p->>'contact_email','')<>'' and p->>'contact_email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
   raise exception 'Ongeldig contactadres' using errcode='22023';
  end if;
  update material_private.support_settings set contact_name=material_private.text_value(p->'contact_name',120),
   contact_email=material_private.text_value(p->'contact_email',254),contact_phone=material_private.text_value(p->'contact_phone',80) where singleton=true;
 else
  update material_private.help_requests set resolved_at=now(),resolved_by=auth.uid() where id=(p->>'id')::uuid and resolved_at is null;
  if not found then raise exception 'Hulpvraag ontbreekt of is al verwerkt' using errcode='22023';end if;
 end if;
 update material_private.revision set value=value+1 where singleton=true returning value into rev;
 if not found then raise exception 'Revisierij ontbreekt';end if;
 result:=jsonb_build_object('saved',true,'revision',rev);
 insert into material_private.requests values(auth.uid(),request_id,command,result);
 return result;
end$$;
create or replace function public.material_command(command jsonb,request_id uuid) returns jsonb language sql security invoker set search_path='' as $$
 select material_private.portal_execute(command,request_id)
$$;
-- Core implementation is now owner-only: no bypass of the reduced volunteer permissions.
revoke all on function material_private.execute(jsonb,uuid) from authenticated;
revoke all on function material_private.portal_execute(jsonb,uuid) from public,anon;
grant execute on function material_private.portal_execute(jsonb,uuid) to authenticated;

create function material_private.portal_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb:=material_private.snapshot();r text:=s->>'role';
begin
 return s||jsonb_build_object('support',(select to_jsonb(x)-'singleton' from material_private.support_settings x where singleton=true),
 'help_requests',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('actor_email',u.email) order by x.created_at desc) from material_private.help_requests x join auth.users u on u.id=x.actor_id where r='admin' or x.actor_id=auth.uid()),'[]'),
 'mail_status',case when r='admin' then (select jsonb_build_object('pending',count(*) filter(where status in ('pending','sending')),'failed',count(*) filter(where status='failed'),'sent',count(*) filter(where status='sent'),'last_sent',max(sent_at)) from material_private.mail_outbox) else null end);
end$$;
create or replace function public.material_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$select material_private.portal_snapshot()$$;
revoke all on function material_private.portal_snapshot() from public,anon;
grant execute on function material_private.portal_snapshot() to authenticated;

-- Detect condition changes independently of anyone keeping the website open.
create function material_private.mail_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare item record; jobs jsonb; day date:=(now() at time zone 'Europe/Brussels')::date;
begin
 perform pg_advisory_xact_lock(734621909);
 create temporary table if not exists material_mail_current(key text primary key,payload jsonb) on commit drop;
 delete from pg_temp.material_mail_current where key is not null;
 insert into pg_temp.material_mail_current
 select 'expired:'||l.id,jsonb_build_object('kind','expired','title','Vervallen materiaal','product',p.name,'location',k.name,'batch',l.batch,'expiry',l.expiry,'quantity',l.quantity)
 from material_private.lots l join material_private.products p on p.id=l.product_id join material_private.locations k on k.id=l.location_id
 where l.quantity>0 and l.expiry<day and p.active and k.active;
 insert into pg_temp.material_mail_current
 select 'empty:'||p.id||':'||k.id,jsonb_build_object('kind','empty','title','Geen bruikbare voorraad','product',p.name,'location',k.name)
 from material_private.products p cross join material_private.locations k
 where p.active and k.active and
 (exists(select 1 from material_private.targets t where t.product_id=p.id and t.location_id=k.id and t.quantity>0)
 or (k.kind='warehouse' and (p.minimum>0 or exists(select 1 from material_private.lots l where l.product_id=p.id and l.location_id=k.id))))
 and not exists(select 1 from material_private.lots l where l.product_id=p.id and l.location_id=k.id and l.quantity>0 and (l.expiry is null or l.expiry>=day));
 insert into pg_temp.material_mail_current
 select 'help:'||h.id,jsonb_build_object('kind','help','title','Hulpvraag van vrijwilliger','message',h.message,'email',u.email)
 from material_private.help_requests h join auth.users u on u.id=h.actor_id where h.resolved_at is null;
 update material_private.mail_incidents i set active=false,updated_at=now() where active and not exists(select 1 from pg_temp.material_mail_current c where c.key=i.key);
 for item in select * from pg_temp.material_mail_current loop
  insert into material_private.mail_incidents(key,payload) values(item.key,item.payload)
  on conflict(key) do update set generation=case when material_private.mail_incidents.active then material_private.mail_incidents.generation else gen_random_uuid() end,
   active=true,payload=excluded.payload,updated_at=now();
 end loop;
 insert into material_private.mail_outbox(incident_key,generation,recipient,delivery_email,delivery_payload)
 select i.key,i.generation,m.user_id,u.email,i.payload from material_private.mail_incidents i cross join material_private.members m join auth.users u on u.id=m.user_id
 where i.active and m.role='admin' and m.status='active' and u.email_confirmed_at is not null
 on conflict(incident_key,generation,recipient) do nothing;
 update material_private.mail_outbox o set status='cancelled',lease=null
 where status in ('pending','sending') and (not exists(select 1 from material_private.mail_incidents i where i.key=o.incident_key and i.generation=o.generation and i.active)
 or not exists(select 1 from material_private.members m where m.user_id=o.recipient and m.role='admin' and m.status='active')
 or not exists(select 1 from auth.users u where u.id=o.recipient and u.email=o.delivery_email and u.email_confirmed_at is not null));
 update material_private.mail_outbox set status='failed',lease=null where status in ('pending','sending') and (attempts>=8 or first_attempt<now()-interval '23 hours') and next_attempt<=now();
 with selected as (
  select id from material_private.mail_outbox where status in ('pending','sending') and next_attempt<=now() and attempts<8 order by next_attempt,id limit 10 for update skip locked
 ), claimed as (
  update material_private.mail_outbox o set status='sending',attempts=attempts+1,first_attempt=coalesce(first_attempt,now()),lease=gen_random_uuid(),next_attempt=now()+interval '5 minutes'
  where o.id in(select id from selected) returning o.*
 ) select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'lease',c.lease,'email',c.delivery_email,'payload',c.delivery_payload)),'[]') into jobs
 from claimed c join auth.users u on u.id=c.recipient join material_private.mail_incidents i on i.key=c.incident_key;
 return jobs;
end$$;
create function material_private.mail_finish(job uuid,job_lease uuid,delivered boolean,provider text default null) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update material_private.mail_outbox set status=case when delivered then 'sent' when attempts>=8 then 'failed' else 'pending' end,
  sent_at=case when delivered then now() else null end,provider_id=case when delivered then left(provider,120) else null end,lease=null,
  next_attempt=now()+interval '5 minutes' where id=job and lease=job_lease and status='sending';
 return found;
end$$;
create or replace function public.material_mail_claim() returns jsonb language sql security invoker set search_path='' as $$select material_private.mail_claim()$$;
create or replace function public.material_mail_finish(job uuid,job_lease uuid,delivered boolean,provider text default null) returns boolean language sql security invoker set search_path='' as $$select material_private.mail_finish(job,job_lease,delivered,provider)$$;
revoke all on function material_private.mail_claim(),material_private.mail_finish(uuid,uuid,boolean,text),public.material_mail_claim(),public.material_mail_finish(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function material_private.mail_claim(),material_private.mail_finish(uuid,uuid,boolean,text),public.material_mail_claim(),public.material_mail_finish(uuid,uuid,boolean,text) to service_role;
commit;
