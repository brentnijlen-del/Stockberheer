-- Dedicated schema: does not alter legacy tables, Auth users, or other applications.
-- Apply only to an isolated test project until the production cutover is approved.
begin;
create schema material_private;
revoke all on schema material_private from public, anon, authenticated;
grant usage on schema material_private to authenticated;
alter default privileges in schema material_private revoke execute on functions from public;
create table material_private.members (
 user_id uuid primary key references auth.users(id) on delete restrict,
 role text not null check(role in ('admin','volunteer'))
);
create table material_private.revision (singleton boolean primary key default true check(singleton), value bigint not null default 0);
insert into material_private.revision values(true,0);
create table material_private.categories (
 id uuid primary key, name text not null check(length(btrim(name)) between 1 and 120),
 active boolean not null default true, version integer not null default 1 check(version>0)
);
create unique index category_name_unique on material_private.categories(lower(name)) where active;
create table material_private.locations (
 id uuid primary key, name text not null check(length(btrim(name)) between 1 and 120),
 kind text not null check(kind in ('warehouse','case')), code text,
 code_key text generated always as (upper(regexp_replace(code,'[^a-zA-Z0-9]','','g'))) stored,
 description text not null default '' check(length(description)<=500),
 active boolean not null default true, version integer not null default 1 check(version>0),
 check(kind='warehouse' or (length(code) between 1 and 80 and code_key<>''))
);
create unique index location_code_unique on material_private.locations(code_key) where code is not null;
create table material_private.products (
 id uuid primary key, name text not null check(length(btrim(name)) between 1 and 120),
 code text not null check(length(code) between 1 and 80),
 code_key text generated always as (upper(regexp_replace(code,'[^a-zA-Z0-9]','','g'))) stored unique,
 category_id uuid references material_private.categories(id) on delete restrict,
 minimum integer not null default 0 check(minimum between 0 and 1000000),
 active boolean not null default true, version integer not null default 1 check(version>0),check(code_key<>'')
);
create index product_category on material_private.products(category_id);
create table material_private.targets (
 location_id uuid references material_private.locations(id) on delete restrict,
 product_id uuid references material_private.products(id) on delete restrict,
 quantity integer not null check(quantity between 0 and 1000000),primary key(location_id,product_id)
);
create index target_product on material_private.targets(product_id);
create table material_private.lots (
 id uuid primary key, product_id uuid not null references material_private.products(id) on delete restrict,
 location_id uuid not null references material_private.locations(id) on delete restrict,
 quantity integer not null check(quantity between 0 and 1000000), batch text not null default '' check(length(batch)<=120),
 expiry date check(expiry between date '1900-01-01' and date '9999-12-31'), version integer not null default 1 check(version>0)
);
create unique index lot_identity on material_private.lots(product_id,location_id,batch,expiry) nulls not distinct;
create index lot_location on material_private.lots(location_id);
create table material_private.loans (
 id uuid primary key, actor_id uuid not null references auth.users(id) on delete restrict,
 who text not null check(length(btrim(who)) between 1 and 120), event text not null default '' check(length(event)<=500),
 description text not null check(length(btrim(description)) between 1 and 120), created_at timestamptz not null default now()
);
create table material_private.loan_lines (
 id uuid primary key, loan_id uuid not null references material_private.loans(id) on delete restrict,
 lot_id uuid not null references material_private.lots(id) on delete restrict,
 quantity integer not null check(quantity>0),returned integer not null default 0 check(returned between 0 and quantity)
);
create index loan_line_loan on material_private.loan_lines(loan_id);
create index loan_line_lot on material_private.loan_lines(lot_id);
create index loan_actor on material_private.loans(actor_id);
create table material_private.shortages (
 id uuid primary key, location_id uuid not null references material_private.locations(id) on delete restrict,
 product_id uuid not null references material_private.products(id) on delete restrict,
 quantity integer not null check(quantity between 1 and 1000000), note text not null default '' check(length(note)<=1000),
 actor_id uuid not null references auth.users(id) on delete restrict, created_at timestamptz not null default now(),
 resolved_at timestamptz, resolution text check(length(resolution)<=1000)
);
create index shortage_location on material_private.shortages(location_id);
create index shortage_product on material_private.shortages(product_id);
create index shortage_actor on material_private.shortages(actor_id);
create table material_private.moves (
 id bigint generated always as identity primary key, actor_id uuid not null references auth.users(id) on delete restrict,
 request_id uuid not null, kind text not null, lot_id uuid references material_private.lots(id) on delete restrict,
 quantity integer not null, at timestamptz not null default now(), details jsonb not null default '{}'
);
create index move_lot on material_private.moves(lot_id);
create index move_actor on material_private.moves(actor_id);
create table material_private.requests (
 actor_id uuid references auth.users(id) on delete restrict, request_id uuid, command jsonb not null,
 result jsonb not null, primary key(actor_id,request_id)
);
create table material_private.acknowledgements (key text primary key check(length(key)<=300), fingerprint text not null check(length(fingerprint)<=300));
-- No direct writes, even for administrators: validation, audit and idempotency are mandatory.
do $$declare t text;begin
 for t in select tablename from pg_tables where schemaname='material_private' loop
  execute format('alter table material_private.%I enable row level security',t);
  execute format('revoke all on material_private.%I from public,anon,authenticated',t);
 end loop;
end$$;
create function material_private.member_role() returns text language plpgsql stable security definer set search_path='' as $$
declare result text; session_key uuid;
begin
 if auth.uid() is null then raise exception 'Aanmelden vereist' using errcode='42501';end if;
 -- A revoked session must stop granting access even before its JWT expires.
 session_key:=(auth.jwt()->>'session_id')::uuid;
 if session_key is null or not exists(select 1 from auth.sessions where id=session_key and user_id=auth.uid() and (not_after is null or not_after>now())) then
  raise exception 'Sessie verlopen; meld opnieuw aan' using errcode='42501';end if;
 select role into result from material_private.members where user_id=auth.uid();
 if result is null then raise exception 'Je account heeft geen toegang' using errcode='42501';end if;
 return result;
end$$;
create function material_private.snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r text:=material_private.member_role(); result jsonb;
begin
 select jsonb_build_object('schemaVersion',2,'role',r,'revision',(select value from material_private.revision),
 'categories',coalesce((select jsonb_agg(to_jsonb(x) order by name) from material_private.categories x),'[]'),
 'locations',coalesce((select jsonb_agg(to_jsonb(x) order by name) from material_private.locations x),'[]'),
 'products',coalesce((select jsonb_agg(to_jsonb(x) order by name) from material_private.products x),'[]'),
 'targets',coalesce((select jsonb_agg(to_jsonb(x)) from material_private.targets x),'[]'),
 'lots',coalesce((select jsonb_agg(to_jsonb(x)) from material_private.lots x),'[]'),
 'loans',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('who',case when r='admin' or actor_id=auth.uid() then who else 'Andere vrijwilliger' end,'event',case when r='admin' or actor_id=auth.uid() then event else '' end)) from material_private.loans x),'[]'),
 'loan_lines',coalesce((select jsonb_agg(to_jsonb(x)) from material_private.loan_lines x),'[]'),
 'shortages',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('note',case when r='admin' or actor_id=auth.uid() then note else '' end)) from material_private.shortages x),'[]'),
 'moves',case when r='admin' then coalesce((select jsonb_agg(to_jsonb(x) order by id desc) from material_private.moves x),'[]') else '[]'::jsonb end,
 'acknowledgements',coalesce((select jsonb_agg(to_jsonb(x)) from material_private.acknowledgements x),'[]')) into result;
 return result;
end$$;
create function material_private.whole(v jsonb, minimum integer default 0) returns integer language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if v is null or jsonb_typeof(v)<>'number' then raise exception 'Aantal moet een geheel getal zijn' using errcode='22023';end if;
 n:=(v#>>'{}')::numeric;
 if n<>trunc(n) or n<minimum or n>1000000 then raise exception 'Aantal buiten geldig bereik' using errcode='22023';end if;
 return n::integer;
end$$;
create function material_private.text_value(v jsonb, max_length integer, required boolean default false) returns text language plpgsql immutable set search_path='' as $$
declare s text;
begin
 if v is null or (v='null'::jsonb and not required) then v:='""'::jsonb;end if;
 if jsonb_typeof(v)<>'string' then raise exception 'Tekstveld ongeldig' using errcode='22023';end if;
 s:=btrim(v#>>'{}');if length(s)>max_length or (required and length(s)=0) or s ~ '[[:cntrl:]]' then raise exception 'Tekstveld ongeldig' using errcode='22023';end if;
 return s;
end$$;
create function material_private.available(product uuid, location uuid) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from material_private.products where id=product and active) or not exists(select 1 from material_private.locations where id=location and active) then raise exception 'Product of locatie bestaat niet' using errcode='22023';end if;
end$$;
create function material_private.audit(req uuid, kind text, lot uuid, amount integer, extra jsonb default '{}') returns void language sql set search_path='' as $$
 insert into material_private.moves(actor_id,request_id,kind,lot_id,quantity,details) values(auth.uid(),req,kind,lot,amount,extra);
$$;
create function material_private.validate_backup(b jsonb) returns void language plpgsql set search_path='' as $$
declare k text; item jsonb;
begin
 if jsonb_typeof(b)<>'object' or b->>'schemaVersion'<>'2' or b->>'format'<>'nijlen-inventory' or (b-array['schemaVersion','format','exportedAt','categories','locations','products','targets','lots'])<>'{}'::jsonb then raise exception 'Ongeldige back-upindeling' using errcode='22023';end if;
 foreach k in array array['categories','locations','products','targets','lots'] loop
  if jsonb_typeof(b->k) is distinct from 'array' or jsonb_array_length(b->k)>10000 then raise exception 'Ongeldige back-uplijst' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(b->k) loop
   if jsonb_typeof(item)<>'object' then raise exception 'Ongeldig back-uprecord' using errcode='22023';end if;
   if k<>'targets' then perform (item->>'id')::uuid;if item->>'id' is null then raise exception 'Record-ID ontbreekt';end if;end if;
   if k in ('categories','locations','products') then
    perform material_private.text_value(item->'name',120,true);
    if jsonb_typeof(item->'active') is distinct from 'boolean' then raise exception 'Ongeldige actiefstatus';end if;
   end if;
   if k='locations' and item->>'kind' not in ('warehouse','case') then raise exception 'Ongeldig locatietype';end if;
   if k='products' then perform material_private.whole(item->'minimum');perform material_private.text_value(item->'code',80,true);end if;
   if k in ('lots','targets') then perform material_private.whole(item->'quantity');end if;
  end loop;
  if k<>'targets' and (select count(*) from jsonb_array_elements(b->k))<>(select count(distinct value->>'id') from jsonb_array_elements(b->k)) then raise exception 'Dubbele IDs in back-up';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(b->'lots') x where not exists(select 1 from jsonb_array_elements(b->'products') p where p->>'id'=x->>'product_id') or not exists(select 1 from jsonb_array_elements(b->'locations') l where l->>'id'=x->>'location_id')) then raise exception 'Losse voorraadrelatie in back-up';end if;
 if exists(select 1 from jsonb_array_elements(b->'targets') x where not exists(select 1 from jsonb_array_elements(b->'products') p where p->>'id'=x->>'product_id') or not exists(select 1 from jsonb_array_elements(b->'locations') l where l->>'id'=x->>'location_id')) then raise exception 'Losse materiaallijstrelatie';end if;
 if exists(select 1 from jsonb_array_elements(b->'lots') x where (x->>'quantity')::integer>0 and (not exists(select 1 from jsonb_array_elements(b->'products') p where p->>'id'=x->>'product_id' and (p->>'active')::boolean) or not exists(select 1 from jsonb_array_elements(b->'locations') l where l->>'id'=x->>'location_id' and (l->>'active')::boolean))) then raise exception 'Voorraad bij gearchiveerd record';end if;
 if exists(select 1 from jsonb_array_elements(b->'targets') x where not exists(select 1 from jsonb_array_elements(b->'locations') l where l->>'id'=x->>'location_id' and l->>'kind'='case' and (l->>'active')::boolean) or not exists(select 1 from jsonb_array_elements(b->'products') p where p->>'id'=x->>'product_id' and (p->>'active')::boolean)) then raise exception 'Materiaallijst bij ongeldig record';end if;
 if exists(select 1 from jsonb_array_elements(b->'products') p join jsonb_array_elements(b->'locations') l on upper(regexp_replace(p->>'code','[^a-zA-Z0-9]','','g'))=upper(regexp_replace(l->>'code','[^a-zA-Z0-9]','','g'))) then raise exception 'Dubbele product-/koffercode';end if;
 if exists(select 1 from jsonb_array_elements(b->'products') x where x->>'category_id' is not null and not exists(select 1 from jsonb_array_elements(b->'categories') c where c->>'id'=x->>'category_id')) then raise exception 'Losse categorierelatie';end if;
end$$;
create function material_private.execute(command jsonb, request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r text:=material_private.member_role(); op text:=command->>'type'; p jsonb:=command->'payload';
 previous material_private.requests%rowtype; lot material_private.lots%rowtype; line material_private.loan_lines%rowtype;
 item jsonb; ident uuid; product uuid; location uuid; loan uuid; amount integer; remaining integer; take integer;
 result jsonb; exp date; current_revision bigint; entity text; nm text; code text; scan_key text; ver integer; existed boolean;
begin
 if request_id is null or jsonb_typeof(command)<>'object' or jsonb_typeof(p) is distinct from 'object' or octet_length(command::text)>5000000 then raise exception 'Ongeldig verzoek' using errcode='22023';end if;
 -- Small departmental inventory: serialize commands; clients submit operations, never stale state.
 perform pg_advisory_xact_lock(734621909);
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
  -- Archive, never delete, historical identities. Historic moves and requests remain immutable.
  update material_private.categories set active=false,version=version+1;
  update material_private.products set active=false,version=version+1;
  update material_private.locations set active=false,version=version+1;
  for item in select value from jsonb_array_elements(p->'backup'->'categories') loop
   insert into material_private.categories(id,name,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,active=excluded.active;
  end loop;
  for item in select value from jsonb_array_elements(p->'backup'->'locations') loop
   insert into material_private.locations(id,name,kind,code,description,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),item->>'kind',nullif(material_private.text_value(item->'code',80),''),material_private.text_value(item->'description',500),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,kind=excluded.kind,code=excluded.code,description=excluded.description,active=excluded.active;
  end loop;
  for item in select value from jsonb_array_elements(p->'backup'->'products') loop
   insert into material_private.products(id,name,code,category_id,minimum,active) values((item->>'id')::uuid,material_private.text_value(item->'name',120,true),material_private.text_value(item->'code',80,true),(item->>'category_id')::uuid,material_private.whole(item->'minimum'),(item->>'active')::boolean) on conflict(id) do update set name=excluded.name,code=excluded.code,category_id=excluded.category_id,minimum=excluded.minimum,active=excluded.active;
  end loop;
  delete from material_private.targets;
  insert into material_private.targets select (x->>'location_id')::uuid,(x->>'product_id')::uuid,material_private.whole(x->'quantity') from jsonb_array_elements(p->'backup'->'targets') x;
  for lot in select * from material_private.lots loop
   if lot.quantity<>0 then perform material_private.audit(request_id,'herstel',lot.id,-lot.quantity);end if;
  end loop;
  update material_private.lots set quantity=0,version=version+1;
  for item in select value from jsonb_array_elements(p->'backup'->'lots') loop
   ident:=(item->>'id')::uuid;amount:=material_private.whole(item->'quantity');
   if exists(select 1 from material_private.lots where id=ident and (product_id<>(item->>'product_id')::uuid or location_id<>(item->>'location_id')::uuid or batch is distinct from item->>'batch' or expiry is distinct from nullif(item->>'expiry','')::date)) then raise exception 'Historische lotidentiteit mag niet veranderen';end if;
   insert into material_private.lots(id,product_id,location_id,quantity,batch,expiry) values(ident,(item->>'product_id')::uuid,(item->>'location_id')::uuid,amount,material_private.text_value(item->'batch',120),nullif(item->>'expiry','')::date) on conflict(id) do update set quantity=excluded.quantity;
   if amount<>0 then perform material_private.audit(request_id,'herstel',ident,amount);end if;
  end loop;
  perform material_private.audit(request_id,'back-upherstel',null,0,jsonb_build_object('format',2));
 else raise exception 'Onbekende handeling' using errcode='22023';end if;
 update material_private.revision set value=value+1 returning value into current_revision;
 result:=jsonb_build_object('revision',current_revision,'saved',true);
 insert into material_private.requests values(auth.uid(),request_id,command,result);
 return result;
end$$;
-- Public entry points are invoker wrappers; privileged implementations live outside exposed schemas.
create function public.material_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$select material_private.snapshot()$$;
create function public.material_command(command jsonb, request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select material_private.execute(command,request_id)$$;
revoke all on function public.material_snapshot(), public.material_command(jsonb,uuid) from public,anon;
grant execute on function public.material_snapshot(), public.material_command(jsonb,uuid) to authenticated;
revoke all on all functions in schema material_private from public,anon,authenticated;
grant execute on function material_private.snapshot(),material_private.execute(jsonb,uuid) to authenticated;
-- Membership provisioning is a separate, explicit administrative step; no Auth users are changed.
commit;
