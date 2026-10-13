import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  setup,
  command,
  snapshot,
  fixture,
  asUser,
  IDS,
} from "./db-helper.mjs";
import { inventoryBackup, replenishments, alerts } from "../src/domain.js";
before(setup);
after(() => pool.end());
test("anonymous and nonmember cannot read or write; member roles are server-derived", async () => {
  for (const role of ["anon", "nonmember"]) {
    await assert.rejects(snapshot(role));
    await assert.rejects(command(role, "receive", {}));
  }
  assert.equal((await snapshot("volunteer")).role, "volunteer");
  assert.equal((await snapshot()).role, "admin");
  await assert.rejects(
    asUser("volunteer", "select * from material_private.lots"),
  );
  await assert.rejects(
    asUser(
      "admin",
      "insert into material_private.moves(actor_id,request_id,kind,quantity)values($1,$2,'forged',1)",
      [IDS.admin, crypto.randomUUID()],
    ),
  );
});
test("server validates integers, references, catalogue roles and normalized code uniqueness", async () => {
  const f = await fixture();
  for (const quantity of [-1, 0, 1.5, "3", null, 1000001])
    await assert.rejects(
      command("admin", "receive", {
        product_id: f.product,
        location_id: f.location,
        quantity,
      }),
    );
  await assert.rejects(
    command("admin", "receive", {
      product_id: crypto.randomUUID(),
      location_id: f.location,
      quantity: 1,
    }),
  );
  await assert.rejects(
    command("volunteer", "catalog", {
      entity: "category",
      id: crypto.randomUUID(),
      name: "bad",
    }),
  );
  const s = await snapshot();
  const p = s.products.find((x) => x.id === f.product);
  await assert.rejects(
    command("admin", "catalog", {
      entity: "product",
      id: crypto.randomUUID(),
      name: "Duplicate",
      code: p.code.replaceAll("-", ""),
      minimum: 0,
    }),
  );
});
test("FEFO consumption preserves lots, excludes expired stock and writes signed audit", async () => {
  const f = await fixture();
  for (const [batch, expiry, quantity] of [
    ["old", "2020-01-01", 5],
    ["early", "2090-01-01", 4],
    ["later", "2091-01-01", 6],
  ])
    await command("admin", "receive", {
      product_id: f.product,
      location_id: f.location,
      quantity,
      batch,
      expiry,
    });
  await command("volunteer", "consume", {
    product_id: f.product,
    location_id: f.location,
    quantity: 5,
  });
  const s = await snapshot();
  assert.deepEqual(
    s.lots
      .filter((x) => x.product_id === f.product)
      .sort((a, b) => a.batch.localeCompare(b.batch))
      .map((x) => [x.batch, x.quantity]),
    [
      ["early", 0],
      ["later", 5],
      ["old", 5],
    ],
  );
  assert.equal(
    s.moves
      .filter(
        (x) =>
          x.kind === "verbruik" &&
          s.lots.find((l) => l.id === x.lot_id)?.product_id === f.product,
      )
      .reduce((n, x) => n + x.quantity, 0),
    -5,
  );
  await assert.rejects(
    command("volunteer", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 6,
    }),
  );
});
test("concurrent operations both commit; overconsumption has one winner; retry is idempotent", async () => {
  const f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 10,
  });
  await Promise.all([
    command("volunteer", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 2,
    }),
    command("admin", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 3,
    }),
  ]);
  assert.equal(
    (await snapshot()).lots.find((x) => x.product_id === f.product).quantity,
    5,
  );
  const outcomes = await Promise.allSettled([
    command("volunteer", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 4,
    }),
    command("admin", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 4,
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const id = crypto.randomUUID(),
    payload = { product_id: f.product, location_id: f.location, quantity: 1 };
  const a = await command("volunteer", "consume", payload, id),
    b = await command("volunteer", "consume", payload, id);
  assert.deepEqual(a, b);
  assert.equal(
    (await snapshot()).lots.find((x) => x.product_id === f.product).quantity,
    0,
  );
  await assert.rejects(
    command("volunteer", "consume", { ...payload, quantity: 2 }, id),
  );
});
test("inventory adjusts per lot and rejects stale, negative or cross-location counts atomically", async () => {
  const f = await fixture();
  for (const batch of ["A", "B"])
    await command("admin", "receive", {
      product_id: f.product,
      location_id: f.location,
      quantity: 5,
      batch,
      expiry: batch === "A" ? "2090-01-01" : "2091-01-01",
    });
  const lots = (await snapshot()).lots.filter(
    (x) => x.product_id === f.product,
  );
  await command("volunteer", "inventory", {
    location_id: f.location,
    reason: "Telling",
    lots: lots.map((x, i) => ({
      id: x.id,
      version: x.version,
      quantity: i ? 5 : 4,
    })),
  });
  const next = (await snapshot()).lots.filter(
    (x) => x.product_id === f.product,
  );
  assert.equal(
    next.reduce((n, x) => n + x.quantity, 0),
    9,
  );
  assert.equal(new Set(next.map((x) => x.expiry)).size, 2);
  await assert.rejects(
    command("volunteer", "inventory", {
      location_id: f.location,
      reason: "stale",
      lots: lots.map((x) => ({ id: x.id, version: x.version, quantity: 1 })),
    }),
  );
  await assert.rejects(
    command("volunteer", "inventory", {
      location_id: crypto.randomUUID(),
      reason: "bad",
      lots: [{ id: next[0].id, version: next[0].version, quantity: 1 }],
    }),
  );
  await assert.rejects(
    command("volunteer", "inventory", {
      location_id: f.location,
      reason: "bad",
      lots: [{ id: next[0].id, version: next[0].version, quantity: -1 }],
    }),
  );
});
test("shortages feed replenishment, unrelated products do not alert, new conditions reactivate alerts", async () => {
  const f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 10,
  });
  await command("volunteer", "shortage", {
    location_id: f.location,
    note: "Tekort",
    items: [{ product_id: f.product, quantity: 3 }],
  });
  let s = await snapshot();
  assert.equal(replenishments(s, f.location)[0].need, 3);
  await assert.rejects(
    command("volunteer", "shortage", {
      location_id: f.location,
      items: [{ product_id: f.product, quantity: 11 }],
    }),
  );
  await command("admin", "resolve", {
    id: s.shortages.find((x) => x.product_id === f.product).id,
    resolution: "Fysiek gecontroleerd en aangevuld",
  });
  await command("volunteer", "consume", {
    product_id: f.product,
    location_id: f.location,
    quantity: 9,
  });
  s = await snapshot();
  const alert = alerts(s).find((x) => x.key === "product:" + f.product);
  await command("admin", "acknowledge", {
    key: alert.key,
    fingerprint: alert.fingerprint,
  });
  assert.ok(!alerts(await snapshot()).some((x) => x.key === alert.key));
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 10,
  });
  await command("volunteer", "consume", {
    product_id: f.product,
    location_id: f.location,
    quantity: 10,
  });
  assert.ok(alerts(await snapshot()).some((x) => x.key === alert.key));
});
test("loan allocations and partial returns preserve lot identities and redact personal data", async () => {
  const f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 6,
    batch: "A",
    expiry: "2090-01-01",
  });
  await command("admin", "loan", {
    product_id: f.product,
    location_id: f.location,
    quantity: 4,
    who: "Fictieve persoon",
    event: "Privé-notitie",
  });
  let s = await snapshot();
  const lot = s.lots.find((x) => x.product_id === f.product),
    loan = s.loans.find(
      (x) =>
        x.description === "Verband" &&
        s.loan_lines.some((y) => y.loan_id === x.id && y.lot_id === lot.id),
    );
  assert.equal(lot.quantity, 2);
  assert.equal(
    (await snapshot("volunteer")).loans.find((x) => x.id === loan.id).who,
    "Andere vrijwilliger",
  );
  await command("volunteer", "return", { loan_id: loan.id, quantity: 1 });
  s = await snapshot();
  assert.equal(s.lots.find((x) => x.id === lot.id).quantity, 3);
  assert.equal(s.loan_lines.find((x) => x.loan_id === loan.id).returned, 1);
  await assert.rejects(
    command("volunteer", "return", { loan_id: loan.id, quantity: 4 }),
  );
  await command("volunteer", "return", { loan_id: loan.id, quantity: 3 });
  assert.equal(
    (await snapshot()).lots.find((x) => x.id === lot.id).quantity,
    6,
  );
});
test("stale catalogue writes fail; archiving removes targets but preserves history", async () => {
  const f = await fixture(),
    p = (await snapshot()).products.find((x) => x.id === f.product);
  await command("admin", "catalog", {
    entity: "product",
    ...p,
    name: "Changed",
  });
  await assert.rejects(
    command("admin", "catalog", { entity: "product", ...p, name: "Stale" }),
  );
  await command("admin", "archive", { entity: "product", id: f.product });
  const s = await snapshot();
  assert.equal(s.products.find((x) => x.id === f.product).active, false);
  assert.ok(!s.targets.some((x) => x.product_id === f.product));
  assert.ok(s.moves.some((x) => x.kind === "archivering"));
});
test("backup restore validates entire file, requires admin and revision; history cannot be rewritten", async () => {
  let s = await snapshot();
  const b = inventoryBackup(s);
  await assert.rejects(
    command("volunteer", "restore", { revision: s.revision, backup: b }),
  );
  await assert.rejects(
    command("admin", "restore", {
      revision: s.revision,
      backup: { ...b, lots: {} },
    }),
  );
  await assert.rejects(
    command("admin", "restore", { revision: s.revision - 1, backup: b }),
  );
  const before = s.moves.length;
  await command("admin", "restore", { revision: s.revision, backup: b });
  s = await snapshot();
  assert.ok(s.moves.length > before);
  assert.deepEqual(
    s.lots.map((x) => x.id).sort(),
    b.lots.map((x) => x.id).sort(),
  );
});
test("revoked membership and revoked Auth session immediately stop access", async () => {
  await pool.query("delete from material_private.members where user_id=$1", [
    IDS.volunteer,
  ]);
  await assert.rejects(snapshot("volunteer"));
  await pool.query(
    "insert into material_private.members values($1,'volunteer')",
    [IDS.volunteer],
  );
  await pool.query("delete from auth.sessions where id=$1", [
    IDS.sessionVolunteer,
  ]);
  await assert.rejects(snapshot("volunteer"));
  await pool.query("insert into auth.sessions(id,user_id) values($1,$2)", [
    IDS.sessionVolunteer,
    IDS.volunteer,
  ]);
  await pool.query(
    "update auth.sessions set not_after=now()-interval '1 minute' where id=$1",
    [IDS.sessionVolunteer],
  );
  await assert.rejects(snapshot("volunteer"));
  await pool.query("update auth.sessions set not_after=null where id=$1", [
    IDS.sessionVolunteer,
  ]);
});
test("warehouse backups, server date bounds, cross-entity codes and duplicate shortage validation", async () => {
  const f = await fixture(),
    warehouse = crypto.randomUUID();
  await command("admin", "catalog", {
    entity: "location",
    id: warehouse,
    name: "Magazijn",
    kind: "warehouse",
    code: null,
  });
  await assert.rejects(
    command("admin", "receive", {
      product_id: f.product,
      location_id: f.location,
      quantity: 1,
      expiry: "infinity",
    }),
  );
  const s = await snapshot(),
    p = s.products.find((x) => x.id === f.product);
  await assert.rejects(
    command("admin", "catalog", {
      entity: "location",
      id: crypto.randomUUID(),
      name: "Duplicate",
      code: p.code,
      kind: "case",
    }),
  );
  await assert.rejects(
    command("volunteer", "shortage", {
      location_id: f.location,
      items: [
        { product_id: f.product, quantity: 1 },
        { product_id: f.product, quantity: 1 },
      ],
    }),
  );
  await command("admin", "restore", {
    revision: s.revision,
    backup: inventoryBackup(s),
  });
  assert.equal(
    (await snapshot()).locations.find((x) => x.id === warehouse).code,
    null,
  );
});
test("multi-lot loans and returns preserve each expiry, including material expired while away", async () => {
  const f = await fixture();
  for (const batch of ["A", "B"])
    await command("admin", "receive", {
      product_id: f.product,
      location_id: f.location,
      quantity: 2,
      batch,
      expiry: "2090-01-01",
    });
  await command("admin", "loan", {
    product_id: f.product,
    location_id: f.location,
    quantity: 3,
    who: "Test",
  });
  const s = await snapshot(),
    lots = s.lots.filter((x) => x.product_id === f.product),
    loan = s.loans.find((x) =>
      s.loan_lines.some((y) => y.loan_id === x.id && y.lot_id === lots[0].id),
    );
  assert.equal(s.loan_lines.filter((x) => x.loan_id === loan.id).length, 2);
  await pool.query(
    "update material_private.lots set expiry='2020-01-01' where id=$1",
    [lots[0].id],
  );
  await command("admin", "return", { loan_id: loan.id, quantity: 3 });
  const next = await snapshot();
  assert.deepEqual(
    next.lots.filter((x) => x.product_id === f.product).map((x) => x.quantity),
    [2, 2],
  );
});
test("all private relations use RLS, privileged helper access is closed, and SQL cutover is approval-gated", async () => {
  const rows = (
    await pool.query(
      "select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='material_private' and c.relkind='r'",
    )
  ).rows;
  assert.ok(rows.length >= 10);
  assert.ok(rows.every((x) => x.relrowsecurity));
  await assert.rejects(
    asUser("admin", "select material_private.audit($1,'forged',null,1)", [
      crypto.randomUUID(),
    ]),
  );
  const { readFile } = await import("node:fs/promises");
  const cutover = await readFile(
    new URL("../supabase/production_cutover.sql", import.meta.url),
    "utf8",
  );
  const c = await pool.connect();
  try {
    await assert.rejects(c.query(cutover), /explicit approval/);
    await c.query("rollback");
    for (const table of [
      "app_state",
      "categories",
      "locations",
      "products",
      "cases",
      "lots",
      "loans",
      "moves",
    ])
      await c.query(
        `create table if not exists public.${table}(id text primary key);alter table public.${table} enable row level security;grant select,insert,update,delete on public.${table} to anon,authenticated;create policy dev_access on public.${table} for all to anon,authenticated using(true) with check(true)`,
      );
    await c.query("set material.approved_legacy_cutover='yes'");
    await c.query(cutover);
    const privileges = (
      await c.query(
        "select has_table_privilege('anon','public.app_state','SELECT') as read,has_table_privilege('authenticated','public.app_state','UPDATE') as write",
      )
    ).rows[0];
    assert.equal(privileges.read, false);
    assert.equal(privileges.write, false);
    for (const table of [
      "app_state",
      "categories",
      "locations",
      "products",
      "cases",
      "lots",
      "loans",
      "moves",
    ])
      await c.query(`drop table public.${table}`);
  } finally {
    await c.query("rollback");
    c.release();
  }
});
test("volunteers cannot invoke any administrative command or submit forged role claims", async () => {
  for (const type of [
    "catalog",
    "archive",
    "target",
    "receive",
    "adjust",
    "resolve",
    "acknowledge",
    "restore",
  ])
    await assert.rejects(
      command("volunteer", type, { role: "admin" }),
      (e) => e.code === "42501",
    );
});
test("failed multi-lot corrections roll back every preceding change", async () => {
  const f = await fixture();
  for (const batch of ["A", "B"])
    await command("admin", "receive", {
      product_id: f.product,
      location_id: f.location,
      quantity: 5,
      batch,
    });
  const lots = (await snapshot()).lots.filter(
    (x) => x.product_id === f.product,
  );
  await assert.rejects(
    command("volunteer", "inventory", {
      location_id: f.location,
      reason: "atomic check",
      lots: [
        { id: lots[0].id, version: lots[0].version, quantity: 3 },
        { id: lots[1].id, version: lots[1].version, quantity: -1 },
      ],
    }),
  );
  const s = await snapshot();
  assert.ok(
    s.lots
      .filter((x) => x.product_id === f.product)
      .every((x) => x.quantity === 5),
  );
});
test("concurrent receipts accumulate without lost stock or duplicate lot identities", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 20 }, () =>
      command("admin", "receive", {
        product_id: f.product,
        location_id: f.location,
        quantity: 1,
        batch: "same",
      }),
    ),
  );
  const lots = (await snapshot()).lots.filter(
    (x) => x.product_id === f.product,
  );
  assert.equal(lots.length, 1);
  assert.equal(lots[0].quantity, 20);
});

test("real safeupdate remains enabled and rejects bare UPDATE and DELETE", async () => {
  const c = await pool.connect();
  try {
    const enabled = (
      await c.query("select current_setting('safeupdate.enabled') as enabled")
    ).rows[0].enabled;
    assert.equal(enabled, "on");
    await c.query(
      "create temporary table safety_probe(id integer primary key, value integer);insert into safety_probe values(1,1)",
    );
    for (const sql of [
      "update safety_probe set value=2",
      "delete from safety_probe",
    ])
      await assert.rejects(
        c.query(sql),
        (e) => e.code === "21000" && /requires a WHERE clause/.test(e.message),
      );
    await c.query("update safety_probe set value=2 where id=1");
    await c.query("delete from safety_probe where id=1");
  } finally {
    c.release();
  }
});

test("installed-database upgrade fixes category creation without changing existing data or grants", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  const file = (await readdir(migrations)).find((x) =>
    x.endsWith("safeupdate_where_fix.sql"),
  );
  const patch = await readFile(new URL(file, migrations), "utf8");
  const old = await readFile(
    new URL("./fixtures/execute-before-safeupdate.sql", import.meta.url),
    "utf8",
  );
  await pool.query(
    "create table public.app_state(id text primary key,data jsonb not null);insert into public.app_state values('legacy','{}');alter table public.app_state enable row level security;grant select on public.app_state to anon;create policy legacy_probe on public.app_state for select to anon using(true)",
  );
  const unrelated = async () =>
    (
      await pool.query(`select jsonb_build_object(
    'users',(select jsonb_agg(to_jsonb(x) order by id) from auth.users x),
    'sessions',(select jsonb_agg(to_jsonb(x) order by id) from auth.sessions x),
    'members',(select jsonb_agg(to_jsonb(x) order by user_id) from material_private.members x),
    'legacy',(select jsonb_agg(to_jsonb(x)) from public.app_state x),
    'legacy_read',has_table_privilege('anon','public.app_state','SELECT'),
    'legacy_policies',(select jsonb_agg(to_jsonb(x)) from pg_policies x where schemaname='public' and tablename='app_state')
  ) as state`)
    ).rows[0].state;
  const unrelatedBefore = await unrelated();
  const before = await snapshot();
  const metadata = async () =>
    (
      await pool.query(
        "select proowner,proacl,proconfig,prosecdef from pg_proc where oid='material_private.execute(jsonb,uuid)'::regprocedure",
      )
    ).rows[0];
  const acl = await metadata();
  await pool.query(old);
  const category = crypto.randomUUID(),
    request = crypto.randomUUID(),
    payload = {
      entity: "category",
      id: category,
      name: "Safeupdate regression",
    };
  await assert.rejects(
    command("admin", "catalog", payload, request),
    (e) =>
      e.code === "21000" &&
      e.message === "UPDATE requires a WHERE clause" &&
      e.where.includes("revision"),
  );
  assert.deepEqual(
    await snapshot(),
    before,
    "failed category creation must roll back category, revision and audit",
  );
  await pool.query(patch);
  assert.deepEqual(
    await snapshot(),
    before,
    "installing the repair itself must leave all data unchanged",
  );
  assert.deepEqual(
    await metadata(),
    acl,
    "ownership, grants, search_path and definer status must be preserved",
  );
  assert.deepEqual(
    await unrelated(),
    unrelatedBefore,
    "Auth accounts, membership and old-table data/access must remain unchanged",
  );
  const saved = await command("admin", "catalog", payload, request);
  assert.equal(saved.saved, true);
  const after = await snapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.categories.filter((x) => x.id === category).length, 1);
  assert.deepEqual(after.lots, before.lots);
  assert.deepEqual(after.products, before.products);
  assert.deepEqual(after.locations, before.locations);
  assert.deepEqual(after.loans, before.loans);
  assert.deepEqual(await command("admin", "catalog", payload, request), saved);
  assert.equal((await snapshot()).revision, after.revision);
  await pool.query(patch);
  assert.deepEqual(await snapshot(), after, "repair can be safely reapplied");
  assert.deepEqual(await unrelated(), unrelatedBefore);
  await pool.query("drop table public.app_state");
});

test("each of the five restore statements is reproduced separately with the real guard", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const file = (await readdir(directory)).find((x) =>
    x.endsWith("safeupdate_where_fix.sql"),
  );
  const patch = await readFile(new URL(file, directory), "utf8");
  const definition = patch.match(
    /create or replace function material_private\.execute\([\s\S]*?end\s*\$\$;/i,
  )[0];
  const predicates = [
    " where id = any(restore_category_ids)",
    " where id = any(restore_product_ids)",
    " where id = any(restore_location_ids)",
    " where location_id = any(restore_location_ids)",
    " where id = any(restore_lot_ids)",
  ];
  const before = await snapshot();
  const backup = inventoryBackup(before);
  try {
    for (const predicate of predicates) {
      assert.ok(definition.includes(predicate));
      await pool.query(definition.replace(predicate, ""));
      await assert.rejects(
        command("admin", "restore", { revision: before.revision, backup }),
        (e) =>
          e.code === "21000" &&
          e.message ===
            (predicate.startsWith(" where location_id")
              ? "DELETE requires a WHERE clause"
              : "UPDATE requires a WHERE clause"),
      );
      assert.deepEqual(
        await snapshot(),
        before,
        `must roll back every change before ${predicate}`,
      );
    }
  } finally {
    await pool.query(patch);
  }
  await command("admin", "restore", { revision: before.revision, backup });
  const after = await snapshot();
  assert.deepEqual(
    after.lots.map(({ version, ...x }) => x),
    before.lots.map(({ version, ...x }) => x),
  );
  assert.deepEqual(after.targets, before.targets);
  assert.deepEqual(after.loans, before.loans);
  assert.equal(after.revision, before.revision + 1);
  assert.ok(after.moves.length > before.moves.length);
});

test("missing revision singleton fails closed instead of committing an untracked write", async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from material_private.revision where singleton=true");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: IDS.admin, session_id: IDS.sessionAdmin }),
    ]);
    await assert.rejects(
      c.query("select public.material_command($1::jsonb,$2::uuid)", [
        JSON.stringify({
          type: "catalog",
          payload: {
            entity: "category",
            id: crypto.randomUUID(),
            name: "Must roll back",
          },
        }),
        crypto.randomUUID(),
      ]),
      /Revisierij ontbreekt/,
    );
  } finally {
    await c.query("rollback");
    c.release();
  }
});

test("user management migration is additive/idempotent and keeps existing members and inventory", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const migration = await readFile(
    new URL(
      (await readdir(dir)).find((x) => x.endsWith("user_management.sql")),
      dir,
    ),
    "utf8",
  );
  const before = await snapshot();
  const users = (await pool.query("select * from auth.users order by id")).rows;
  const members = (
    await pool.query("select * from material_private.members order by user_id")
  ).rows;
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    (await pool.query("select * from auth.users order by id")).rows,
    users,
  );
  assert.deepEqual(
    (
      await pool.query(
        "select * from material_private.members order by user_id",
      )
    ).rows,
    members,
  );
});
async function manage(role, action, target = null) {
  return (
    await asUser(
      role,
      "select public.material_manage_users($1,$2::uuid) as result",
      [action, target],
    )
  )[0].result;
}
async function invite(email, request = crypto.randomUUID()) {
  return (
    await asUser(
      "admin",
      "select public.material_prepare_invite($1,$2::uuid) as result",
      [email, request],
    )
  )[0].result;
}
async function finish(inv, request, user, delivered = true) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    const r = await c.query(
      "select public.material_finish_invite($1,$2,$3,$4,$5,$6) as result",
      [inv, request, IDS.admin, IDS.sessionAdmin, user, delivered],
    );
    await c.query("commit");
    return r.rows[0].result;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
async function invitedUser(user, session, sql, args = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, session_id: session }),
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
test("directory is admin-only, exposes no passwords/tokens and audit/helpers remain inaccessible", async () => {
  const list = await manage("admin", "list");
  assert.ok(list.some((x) => x.email === "volunteer@example.invalid"));
  assert.ok(
    list.every(
      (x) => !Object.keys(x).some((k) => /token|password|secret/i.test(k)),
    ),
  );
  for (const role of ["anon", "nonmember", "volunteer"])
    await assert.rejects(manage(role, "list"));
  await assert.rejects(
    asUser(
      "volunteer",
      "select public.material_prepare_invite('bad@example.invalid',$1)",
      [crypto.randomUUID()],
    ),
  );
  await assert.rejects(
    asUser(
      "admin",
      "select public.material_finish_invite(null,null,null,null,null,true)",
    ),
  );
  await assert.rejects(
    asUser("admin", "select * from material_private.user_events"),
  );
  await assert.rejects(
    asUser("volunteer", "select * from material_private.invitations"),
  );
});
test("block/reactivate preserves accounts and inventory; old volunteer JWTs cannot mutate", async () => {
  const before = await snapshot(),
    accounts = (await pool.query("select * from auth.users order by id")).rows;
  await manage("admin", "block", IDS.volunteer);
  await assert.rejects(snapshot("volunteer"));
  const f = await fixture();
  await assert.rejects(
    command("volunteer", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 1,
    }),
    (e) => e.code === "42501",
  );
  await assert.rejects(
    command("volunteer", "inventory", { location_id: f.location, lots: [] }),
    (e) => e.code === "42501",
  );
  await assert.rejects(
    command("volunteer", "shortage", { location_id: f.location, items: [] }),
    (e) => e.code === "42501",
  );
  await manage("admin", "reactivate", IDS.volunteer);
  assert.equal((await snapshot("volunteer")).role, "volunteer");
  assert.deepEqual(
    (await pool.query("select * from auth.users order by id")).rows,
    accounts,
  );
  assert.deepEqual((await snapshot()).lots, before.lots);
  assert.ok(
    (
      await pool.query(
        "select action from material_private.user_events where target_id=$1",
        [IDS.volunteer],
      )
    ).rows.some((x) => x.action === "block"),
  );
  await assert.rejects(manage("admin", "block", IDS.admin), /eigen toegang/);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from material_private.members where role='admin' and status='active'",
      )
    ).rows[0].n,
    1,
  );
});
test("blocking serializes with a waiting stock command and invalidates its pre-lock permissions", async () => {
  const f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 3,
  });
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(734621909)");
    const pending = command("volunteer", "consume", {
      product_id: f.product,
      location_id: f.location,
      quantity: 1,
    });
    const rejected = assert.rejects(pending, (e) => e.code === "42501");
    for (let i = 0; i < 50; i++) {
      const waiting = (
        await pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event='advisory' and query like 'select public.material_command%'",
        )
      ).rows[0].n;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: IDS.admin, session_id: IDS.sessionAdmin }),
    ]);
    await c.query("select public.material_manage_users('block',$1)", [
      IDS.volunteer,
    ]);
    await c.query("commit");
    await rejected;
  } finally {
    await c.query("rollback");
    c.release();
    await manage("admin", "reactivate", IDS.volunteer);
  }
  assert.equal(
    (await snapshot()).lots.find((x) => x.product_id === f.product).quantity,
    3,
  );
});
test("new volunteer invitation, duplicate/expiry/resend and acceptance grant only volunteer permissions", async () => {
  const request = crypto.randomUUID(),
    email = "new-volunteer@example.invalid";
  const inv = await invite(email, request);
  const user = crypto.randomUUID(),
    session = crypto.randomUUID();
  await pool.query(
    "insert into auth.users(id,email,invited_at,raw_user_meta_data)values($1,$2,now(),$3);",
    [user, email, JSON.stringify({ material_invitation_id: inv.id })],
  );
  await pool.query("insert into auth.sessions(id,user_id)values($1,$2)", [
    session,
    user,
  ]);
  await finish(inv.id, request, user);
  await pool.query("update auth.sessions set created_at=now() where id=$1", [
    session,
  ]);
  assert.equal((await invite(email, request)).already_sent, true);
  await assert.rejects(invite(email), /één minuut/);
  await assert.rejects(
    invitedUser(user, session, "select public.material_snapshot()"),
  );
  await assert.rejects(
    invitedUser(user, session, "select public.material_accept_invite($1)", [
      inv.id,
    ]),
    /e-mailadres/,
  );
  await pool.query(
    "update auth.users set email_confirmed_at=now() where id=$1",
    [user],
  );
  await pool.query(
    "update material_private.invitations set expires_at=now()-interval '1 second',last_attempt_at=now()-interval '2 minutes' where id=$1",
    [inv.id],
  );
  await assert.rejects(
    invitedUser(user, session, "select public.material_accept_invite($1)", [
      inv.id,
    ]),
    /verlopen/,
  );
  const resendRequest = crypto.randomUUID(),
    again = await invite(email, resendRequest);
  assert.equal(again.id, inv.id);
  assert.equal(again.user_id, user);
  assert.equal(again.delivery, "recovery");
  await finish(inv.id, resendRequest, user);
  await assert.rejects(
    invitedUser(user, session, "select public.material_accept_invite($1)", [
      inv.id,
    ]),
    /meest recente/,
  );
  await pool.query("update auth.sessions set created_at=now() where id=$1", [
    session,
  ]);
  await invitedUser(user, session, "select public.material_accept_invite($1)", [
    inv.id,
  ]);
  assert.equal(
    (
      await invitedUser(
        user,
        session,
        "select public.material_snapshot() as result",
      )
    )[0].result.role,
    "volunteer",
  );
  await invitedUser(user, session, "select public.material_accept_invite($1)", [
    inv.id,
  ]);
  const f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 3,
  });
  for (const [type, payload] of [
    [
      "consume",
      { product_id: f.product, location_id: f.location, quantity: 1 },
    ],
    [
      "inventory",
      {
        location_id: f.location,
        reason: "test",
        lots: (await snapshot()).lots
          .filter((x) => x.product_id === f.product)
          .map((x) => ({ id: x.id, version: x.version, quantity: x.quantity })),
      },
    ],
    [
      "shortage",
      {
        location_id: f.location,
        items: [{ product_id: f.product, quantity: 1 }],
      },
    ],
  ]) {
    if (type === "inventory")
      payload.lots = (await snapshot()).lots
        .filter((x) => x.product_id === f.product)
        .map((x) => ({ id: x.id, version: x.version, quantity: x.quantity }));
    await invitedUser(
      user,
      session,
      "select public.material_command($1::jsonb,$2)",
      [JSON.stringify({ type, payload }), crypto.randomUUID()],
    );
  }
  await assert.rejects(
    invitedUser(user, session, "select public.material_command($1::jsonb,$2)", [
      JSON.stringify({ type: "catalog", payload: {} }),
      crypto.randomUUID(),
    ]),
    (e) => e.code === "42501",
  );
  await assert.rejects(
    invitedUser(user, session, "select public.material_manage_users('list')"),
    (e) => e.code === "42501",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from auth.users where email=$1",
        [email],
      )
    ).rows[0].n,
    1,
  );
  await manage("admin", "block", user);
  await assert.rejects(
    invitedUser(user, session, "select public.material_accept_invite($1)", [
      inv.id,
    ]),
  );
  await manage("admin", "reactivate", user);
  await assert.rejects(invite("admin@example.invalid"), /bestaande account/);
});

test("an unrelated Auth invite created after reservation cannot be rebound or reset", async () => {
  const email = "other-application@example.invalid",
    request = crypto.randomUUID();
  const inv = await invite(email, request),
    user = crypto.randomUUID();
  await pool.query(
    "insert into auth.users(id,email,invited_at) values($1,$2,now())",
    [user, email],
  );
  await assert.rejects(finish(inv.id, request, user), /Account hoort niet/);
  await pool.query(
    "update material_private.invitations set last_attempt_at=now()-interval '2 minutes' where id=$1",
    [inv.id],
  );
  await assert.rejects(invite(email), /bestaande account/);
  assert.equal(
    (
      await pool.query(
        "select user_id from material_private.invitations where id=$1",
        [inv.id],
      )
    ).rows[0].user_id,
    null,
  );
});

test("two admins cannot concurrently disable all administrators", async () => {
  const other = crypto.randomUUID(),
    session = crypto.randomUUID();
  await pool.query(
    "insert into auth.users(id,email) values($1,'other-admin@example.invalid')",
    [other],
  );
  await pool.query("insert into auth.sessions(id,user_id) values($1,$2)", [
    session,
    other,
  ]);
  await pool.query(
    "insert into material_private.members(user_id,role) values($1,'admin')",
    [other],
  );
  const results = await Promise.allSettled([
    manage("admin", "block", other),
    invitedUser(
      other,
      session,
      "select public.material_manage_users('block',$1)",
      [IDS.admin],
    ),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((x) => x.status === "rejected" && x.reason.code === "42501")
      .length,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from material_private.members where role='admin' and status='active'",
      )
    ).rows[0].n,
    1,
  );
});
