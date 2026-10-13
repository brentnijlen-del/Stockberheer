import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { whole, codeKey, validateBackup } from "../src/domain.js";
export function convertLegacy(old) {
  if (
    !old ||
    !Array.isArray(old.products) ||
    !Array.isArray(old.lots) ||
    !Array.isArray(old.cases) ||
    !Array.isArray(old.locations)
  )
    throw new Error("Ongeldige oude back-up.");
  const uuid = (type, id) => {
    const bytes = createHash("sha256")
      .update(`nijlen-v1:${type}:${id}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const h = bytes.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const unique = (items, type) => {
    if (
      items.some((x) => typeof x.id !== "string" || !x.id) ||
      new Set(items.map((x) => x.id)).size !== items.length
    )
      throw new Error(`Ongeldige of dubbele ${type}-ID.`);
  };
  for (const [type, items] of Object.entries({
    product: old.products,
    lot: old.lots,
    location: [...old.locations, ...old.cases],
    category: old.categories || [],
  }))
    unique(items, type);
  const categories = (old.categories || []).map((x) => ({
    id: uuid("category", x.id),
    name: x.name,
    active: true,
    version: 1,
  }));
  const products = old.products.map((x) => ({
    id: uuid("product", x.id),
    name: x.name,
    code: x.code,
    code_key: codeKey(x.code),
    category_id: x.categoryId ? uuid("category", x.categoryId) : null,
    minimum: whole(x.min ?? 0),
    active: true,
    version: 1,
  }));
  const locations = [
    ...old.locations.map((x) => ({
      id: uuid("location", x.id),
      name: x.name,
      kind: "warehouse",
      code: null,
      code_key: null,
      description: "",
      active: true,
      version: 1,
    })),
    ...old.cases.map((x) => ({
      id: uuid("location", x.id),
      name: x.name,
      kind: "case",
      code: x.code,
      code_key: codeKey(x.code),
      description: x.loc || "",
      active: true,
      version: 1,
    })),
  ];
  const codes = [...products, ...locations.filter((x) => x.code)].map(
    (x) => x.code_key,
  );
  if (codes.some((x) => !x) || new Set(codes).size !== codes.length)
    throw new Error("Dubbele of onbruikbare genormaliseerde codes.");
  const targets = old.cases.flatMap((x) =>
    Object.entries(x.contents || {}).map(([pid, q]) => ({
      location_id: uuid("location", x.id),
      product_id: uuid("product", pid),
      quantity: whole(q),
    })),
  );
  const lots = [];
  for (const x of old.lots) {
    const l = {
      id: uuid("lot", x.id),
      product_id: uuid("product", x.pid),
      location_id: uuid("location", x.loc),
      quantity: whole(x.qty),
      batch: x.batch || "",
      expiry: x.exp || null,
      version: 1,
    };
    const same = lots.find(
      (y) =>
        y.product_id === l.product_id &&
        y.location_id === l.location_id &&
        y.batch === l.batch &&
        y.expiry === l.expiry,
    );
    if (same) same.quantity = whole(same.quantity + l.quantity);
    else lots.push(l);
  }
  return validateBackup({
    format: "nijlen-inventory",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    categories,
    products,
    locations,
    targets,
    lots,
  });
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      "Gebruik: node scripts/convert-legacy-backup.mjs oude.json voorraad-v2.json",
    );
  const old = JSON.parse(await readFile(input, "utf8"));
  await writeFile(output, JSON.stringify(convertLegacy(old), null, 2), {
    flag: "wx",
  });
  await writeFile(
    output + ".legacy-history.json",
    JSON.stringify(
      {
        format: "nijlen-legacy-history",
        moves: old.moves || [],
        loans: old.loans || [],
        shortages: old.shortages || [],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    "Voorraad geconverteerd; oude historiek apart bewaard. Controleer open oude uitleningen handmatig. Niets geüpload.",
  );
}
