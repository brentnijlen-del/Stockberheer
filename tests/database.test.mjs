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
