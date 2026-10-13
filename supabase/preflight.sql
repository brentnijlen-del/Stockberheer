-- READ ONLY. Run before planning a production cutover. Does not prove absence of external apps.
select c.oid::regclass as table_name,c.relrowsecurity,c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('app_state','categories','locations','products','cases','lots','loans','moves');
select * from pg_policies where schemaname='public';
select conrelid::regclass as source,confrelid::regclass as target,conname
from pg_constraint where contype='f' and (conrelid in (select oid from pg_class where relnamespace='public'::regnamespace) or confrelid in (select oid from pg_class where relnamespace='public'::regnamespace));
select distinct dependent_ns.nspname as dependent_schema,dependent.relname as dependent_object,source.relname as source_table
from pg_depend d join pg_rewrite rw on rw.oid=d.objid join pg_class dependent on dependent.oid=rw.ev_class
join pg_namespace dependent_ns on dependent_ns.oid=dependent.relnamespace join pg_class source on source.oid=d.refobjid
where source.relnamespace='public'::regnamespace and source.relname in ('app_state','categories','locations','products','cases','lots','loans','moves');
select tgrelid::regclass as table_name,tgname,pg_get_triggerdef(oid) from pg_trigger where not tgisinternal;
select schemaname,tablename,grantee,privilege_type from information_schema.role_table_grants g
cross join lateral(select g.table_schema as schemaname,g.table_name as tablename) t
where g.table_schema='public' and grantee in ('anon','authenticated','PUBLIC');
