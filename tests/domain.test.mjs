import { test } from "node:test";
import assert from "node:assert/strict";
import {
  whole,
  codeKey,
  findCode,
  esc,
  localDay,
  validateBackup,
  validateSnapshot,
  quantity,
  replenishments,
  alerts,
  inventoryBackup,
} from "../src/domain.js";
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const base = () => ({
  schemaVersion: 2,
  role: "admin",
  revision: 1,
  categories: [],
  products: [
    {
      id: id(1),
      name: "Verband",
      code: "P1",
      code_key: "P1",
      minimum: 1,
      version: 1,
      active: true,
      category_id: null,
    },
  ],
  locations: [
    {
      id: id(2),
      name: "Tas",
      code: "K1",
      code_key: "K1",
      version: 1,
      kind: "case",
      active: true,
    },
  ],
  targets: [{ product_id: id(1), location_id: id(2), quantity: 10 }],
  lots: [
    {
      id: id(3),
      product_id: id(1),
      location_id: id(2),
      quantity: 10,
      batch: "A",
      expiry: "2090-01-01",
      version: 1,
    },
  ],
  loans: [],
  loan_lines: [],
  shortages: [],
  moves: [],
  acknowledgements: [],
});
test("integer validation rejects negative, missing, fractional and infinite quantities", () => {
  for (const x of [-1, "", null, 1.5, Infinity, NaN, 1000001])
    assert.throws(() => whole(x));
  assert.equal(whole("2", 1), 2);
  assert.throws(() => whole(0, 1));
});
test("HTML escaping protects text and attribute contexts", () => {
  assert.equal(esc(`<img a="'&">`), "&lt;img a=&quot;&#39;&amp;&quot;&gt;");
});
test("exact scan match takes precedence and ambiguous fallback is refused", () => {
  const data = [
    { active: true, id: "a", code: "AB-C", code_key: "ABC" },
    { active: true, id: "b", code: "ABC", code_key: "ABC" },
  ];
  assert.equal(findCode(data, "ABC").id, "b");
  assert.throws(() => findCode(data, "a-b-c"));
  assert.equal(codeKey("KOF–1"), "KOF1");
});
test("Belgian expiry day handles UTC midnight boundaries", () => {
  assert.equal(localDay(new Date("2026-10-12T22:30:00Z")), "2026-10-13");
  assert.equal(localDay(new Date("2026-01-12T23:30:00Z")), "2026-01-13");
});
test("reported shortages feed replenishment once and expiry reduces usable stock", () => {
  const s = base();
  s.shortages = [
    { id: id(4), product_id: id(1), location_id: id(2), quantity: 3 },
    { id: id(5), product_id: id(1), location_id: id(2), quantity: 3 },
  ];
  assert.equal(replenishments(s, id(2))[0].need, 3);
  s.lots[0].expiry = "2020-01-01";
  assert.equal(quantity(s, id(1), id(2)), 0);
  assert.equal(replenishments(s, id(2))[0].need, 10);
});
test("only configured case products alert and new events reactivate warnings", () => {
  const s = base();
  s.products.push({ ...s.products[0], id: id(6), code: "P2", minimum: 0 });
  assert.equal(alerts(s).length, 0);
  s.lots[0].quantity = 0;
  const a = alerts(s);
  s.acknowledgements = a.map((x) => ({
    key: x.key,
    fingerprint: x.fingerprint,
  }));
  assert.equal(alerts(s).length, 0);
  s.lots[0].version++;
  assert.equal(alerts(s).length, 2);
});
test("backup format and relational types are fully checked before upload", () => {
  const s = base();
  assert.equal(validateSnapshot(s), s);
  const b = inventoryBackup(s);
  assert.equal(validateBackup(b), b);
  assert.throws(() => validateBackup({ ...b, lots: {} }));
  assert.throws(() =>
    validateBackup({ ...b, lots: [{ ...b.lots[0], quantity: "<img src=x>" }] }),
  );
  assert.throws(() => validateBackup({ ...b, products: [] }));
  assert.throws(() => validateBackup({ ...b, pin: "unsafe" }));
  assert.throws(() => validateBackup({ ...b, lots: [b.lots[0], b.lots[0]] }));
});
test("old backups convert deterministically without importing PINs, roles or invented loans", async () => {
  const { convertLegacy } = await import(
    "../scripts/convert-legacy-backup.mjs"
  );
  const old = {
    pin: "private",
    userMode: "admin",
    products: [{ id: "p", name: "Verband", code: "P1", min: 1 }],
    locations: [{ id: "mag", name: "Magazijn" }],
    cases: [{ id: "k", name: "Tas", code: "K1", contents: { p: 10 } }],
    lots: [
      { id: "l", pid: "p", loc: "k", qty: 3, batch: "A", exp: "2090-01-01" },
    ],
    loans: [{ desc: "legacy" }],
  };
  const a = convertLegacy(old),
    b = convertLegacy(old);
  assert.equal(a.products[0].id, b.products[0].id);
  assert.equal(a.lots[0].quantity, 3);
  assert.equal("pin" in a, false);
  assert.equal("loans" in a, false);
  assert.throws(() =>
    convertLegacy({ ...old, lots: [{ ...old.lots[0], qty: -1 }] }),
  );
});
