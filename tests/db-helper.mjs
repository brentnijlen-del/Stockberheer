import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
export const IDS = {
  admin: "11111111-1111-4111-8111-111111111111",
  volunteer: "22222222-2222-4222-8222-222222222222",
  nonmember: "33333333-3333-4333-8333-333333333333",
  sessionAdmin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionVolunteer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sessionNonmember: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
export const pool = new pg.Pool({
  // Every test connection exercises the same WHERE guard as the production RPC.
  options: "-c session_preload_libraries=safeupdate",
  connectionString:
    process.env.TEST_DATABASE_URL ||
    "postgres://postgres:fictitious-local-only@127.0.0.1:55432/material_test",
});
export async function setup() {
  const url = new URL(
    process.env.TEST_DATABASE_URL ||
      "postgres://postgres:fictitious-local-only@127.0.0.1:55432/material_test",
  );
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname != "/material_test"
  )
    throw new Error(
      "Tests may reset only an explicitly disposable local database.",
    );
  await pool.query(
    "drop schema if exists material_private cascade;drop function if exists public.material_snapshot();drop function if exists public.material_command(jsonb,uuid);drop schema if exists auth cascade;",
  );
  const bootstrap = await readFile(
    new URL("./bootstrap.sql", import.meta.url),
    "utf8",
  );
  await pool.query(
    bootstrap
      .replace(
        "create role anon nologin;",
        () =>
          "do $$begin if not exists(select from pg_roles where rolname='anon')then create role anon nologin;end if;end$$;",
      )
      .replace(
        "create role authenticated nologin;",
        () =>
          "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin;end if;end$$;",
      ),
  );
  const migrations = await readdir(
    new URL("../supabase/migrations", import.meta.url),
  );
  for (const f of migrations.sort())
    await pool.query(
      await readFile(
        new URL("../supabase/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  await pool.query("insert into auth.users values($1),($2),($3);", [
    IDS.admin,
    IDS.volunteer,
    IDS.nonmember,
  ]);
  await pool.query(
    "insert into auth.sessions(id,user_id) values($1,$2),($3,$4),($5,$6)",
    [
      IDS.sessionAdmin,
      IDS.admin,
      IDS.sessionVolunteer,
      IDS.volunteer,
      IDS.sessionNonmember,
      IDS.nonmember,
    ],
  );
  await pool.query(
    "insert into material_private.members values($1,'admin'),($2,'volunteer')",
    [IDS.admin, IDS.volunteer],
  );
}
export async function asUser(role, sql, args = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      `set local role ${role === "anon" ? "anon" : "authenticated"}`,
    );
    const uid = IDS[role],
      session = IDS["session" + role[0]?.toUpperCase() + role.slice(1)];
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(uid ? { sub: uid, session_id: session } : {}),
    ]);
    const r = await c.query(sql, args);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
export async function command(role, type, payload, id = crypto.randomUUID()) {
  return (
    await asUser(
      role,
      "select public.material_command($1::jsonb,$2::uuid) as result",
      [JSON.stringify({ type, payload }), id],
    )
  )[0].result;
}
export async function snapshot(role = "admin") {
  return (await asUser(role, "select public.material_snapshot() as result"))[0]
    .result;
}
export const catalog = (entity, values) =>
  command("admin", "catalog", {
    entity,
    id: crypto.randomUUID(),
    name: entity,
    ...values,
  });
export async function fixture() {
  const product = crypto.randomUUID(),
    location = crypto.randomUUID(),
    category = crypto.randomUUID();
  await command("admin", "catalog", {
    entity: "category",
    id: category,
    name: "EHBO " + category,
  });
  await command("admin", "catalog", {
    entity: "product",
    id: product,
    name: "Verband",
    code: "P-" + product,
    minimum: 2,
    category_id: category,
  });
  await command("admin", "catalog", {
    entity: "location",
    id: location,
    name: "Tas A",
    code: "K-" + location,
    kind: "case",
  });
  await command("admin", "target", {
    location_id: location,
    product_id: product,
    quantity: 10,
    version: 1,
  });
  return { product, location, category };
}
