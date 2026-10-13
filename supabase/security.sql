-- This old single-JSON security installer has been superseded.
-- Do NOT use it for v2: it cannot validate inventory operations or secure legacy tables.
-- See migrations/*material_management_v2.sql, preflight.sql and production_cutover.sql.
-- Production cutover requires explicit approval and is deliberately separate from migrations.
do $$begin raise exception 'Superseded installer: use the v2 migration and approved cutover procedure';end$$;
