-- Repair for databases with material_management_v2 already installed.
-- Review and obtain separate approval before applying to production.
-- Changes ONLY the existing command function; does not run commands, change data,
-- modify users, alter RLS/grants, close legacy tables or disable safeupdate.
-- CREATE OR REPLACE preserves function ownership and existing EXECUTE grants.
begin;
set local lock_timeout = '5s';
do $$begin
 if to_regprocedure('material_private.execute(jsonb,uuid)') is null then
  raise exception 'Install material_management_v2 first; this is an upgrade, not an initializer';
 end if;
end$$;

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
