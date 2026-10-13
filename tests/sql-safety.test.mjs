import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const directory = new URL("../supabase/migrations/", import.meta.url);
export function standaloneMutations(source) {
  // Ignore SQL comments and literal values, not dollar-quoted function bodies.
  const sql = source
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:''|[^'])*'/g, "''");
  return [
    ...sql.matchAll(
      /\b(?:update\s+(?:material_private|public)\.\w+\s+set\b|delete\s+from\s+(?:material_private|public)\.\w+\b)[^;]*;/gi,
    ),
  ].map((x) => x[0]);
}
test("every standalone UPDATE/DELETE in both migrations has a non-blanket WHERE", async () => {
  for (const file of (await readdir(directory)).filter((x) =>
    x.endsWith(".sql"),
  )) {
    const sql = await readFile(new URL(file, directory), "utf8");
    const mutations = standaloneMutations(sql);
    assert.ok(mutations.length > 0);
    for (const statement of mutations) {
      assert.match(statement, /\bwhere\b/i, `${file}: ${statement}`);
      assert.doesNotMatch(statement, /\bwhere\s+(?:true|1\s*=\s*1)\b/i);
    }
  }
});
test("upgrade function matches fresh-install function and does not modify data or disable guards", async () => {
  const files = await readdir(directory);
  const original = await readFile(
    new URL(
      files.find((f) => f.endsWith("material_management_v2.sql")),
      directory,
    ),
    "utf8",
  );
  const patch = await readFile(
    new URL(
      files.find((f) => f.endsWith("safeupdate_where_fix.sql")),
      directory,
    ),
    "utf8",
  );
  const getFunction = (sql) =>
    sql
      .match(
        /create(?: or replace)? function material_private\.execute\([\s\S]*?end\s*\$\$;/i,
      )[0]
      .replace("create or replace function", "create function");
  assert.equal(getFunction(original), getFunction(patch));
  const outside = patch
    .replace(/--[^\n]*/g, "")
    .replace(/do \$\$[\s\S]*?end\$\$;/i, "")
    .replace(/create or replace function[\s\S]*?end\s*\$\$;/i, "");
  assert.doesNotMatch(
    outside,
    /\b(update|delete|insert|truncate|drop|grant|revoke|alter)\b/i,
  );
  assert.doesNotMatch(
    patch,
    /\b(?:set|set_config)\b[^;]*(?:safeupdate|row_security|session_replication_role)/i,
  );
  assert.match(patch, /create or replace function material_private\.execute/i);
});
test("frozen pre-fix function really contains all six unqualified mutations", async () => {
  const old = await readFile(
    new URL("./fixtures/execute-before-safeupdate.sql", import.meta.url),
    "utf8",
  );
  const unsafe = standaloneMutations(old).filter((x) => !/\bwhere\b/i.test(x));
  assert.equal(unsafe.length, 6);
  assert.ok(unsafe.some((x) => /revision/.test(x)));
  assert.ok(unsafe.some((x) => /^delete/i.test(x)));
});
