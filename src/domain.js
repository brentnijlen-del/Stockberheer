export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function whole(value, minimum = 0) {
  if (value === "" || value == null) throw new Error("Vul een aantal in.");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || n > 1000000)
    throw new Error(`Geef een geheel getal van ${minimum} tot 1000000 in.`);
  return n;
}
export const codeKey = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
export function findCode(items, code) {
  const active = items.filter((x) => x.active);
  const exact = active.find((x) => x.code === String(code).trim());
  if (exact) return exact;
  const matches = active.filter((x) => x.code_key === codeKey(code));
  if (matches.length > 1)
    throw new Error(
      "Code is niet uniek. Vraag de beheerder om de codes aan te passen.",
    );
  return matches[0];
}
export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function validDate(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1900-01-01" ||
    value > "9999-12-31"
  )
    return false;
  const d = new Date(value + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export const usable = (lot, day = localDay()) =>
  !lot.expiry || lot.expiry >= day;
export function quantity(state, product, location, onlyUsable = true) {
  return state.lots
    .filter(
      (x) =>
        x.product_id === product &&
        (!location || x.location_id === location) &&
        (!onlyUsable || usable(x)),
    )
    .reduce((sum, x) => sum + x.quantity, 0);
}
export function outstanding(state, loan) {
  return state.loan_lines
    .filter((x) => x.loan_id === loan)
    .reduce((sum, x) => sum + x.quantity - x.returned, 0);
}
export function replenishments(state, location) {
  return state.targets
    .filter((t) => t.location_id === location)
    .map((t) => {
      const present = quantity(state, t.product_id, location);
      const reported = Math.max(
        0,
        ...state.shortages
          .filter(
            (s) =>
              s.location_id === location &&
              s.product_id === t.product_id &&
              !s.resolved_at,
          )
          .map((s) => s.quantity),
      );
      return {
        ...t,
        present,
        reported,
        need: Math.max(0, t.quantity - present, reported),
      };
    })
    .filter((x) => x.need > 0);
}
export function alerts(state, day = localDay()) {
  const rows = [];
  const add = (key, title, text, fingerprint, kind, extra = {}) => {
    if (
      !state.acknowledgements.some(
        (a) => a.key === key && a.fingerprint === fingerprint,
      )
    )
      rows.push({ key, title, text, fingerprint, kind, ...extra });
  };
  const fingerprint = (lots) =>
    `${lots.length}:${lots.reduce((sum, x) => sum + x.version, 0)}`;
  for (const p of state.products.filter((p) => p.active)) {
    const n = quantity(state, p.id);
    if (p.minimum > 0 && n <= p.minimum)
      add(
        `product:${p.id}`,
        "Lage voorraad",
        `${p.name}: ${n} bruikbaar (minimum ${p.minimum})`,
        `${p.version}:${n}:${fingerprint(state.lots.filter((x) => x.product_id === p.id))}`,
        "low",
      );
  }
  for (const t of state.targets) {
    const p = state.products.find((p) => p.id === t.product_id),
      l = state.locations.find((l) => l.id === t.location_id);
    if (!p?.active || !l?.active || t.quantity === 0) continue;
    const n = quantity(state, p.id, l.id);
    if (n < t.quantity)
      add(
        `case:${l.id}:${p.id}`,
        n === 0 ? "Product op in koffer" : "Tekort in koffer",
        `${p.name} — ${l.name}: ${n} van ${t.quantity}`,
        `${l.version}:${t.quantity}:${n}:${fingerprint(state.lots.filter((x) => x.product_id === p.id && x.location_id === l.id))}`,
        "low",
      );
  }
  const soon = new Date(`${day}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 30);
  const limit = soon.toISOString().slice(0, 10);
  for (const lot of state.lots.filter(
    (x) => x.quantity > 0 && x.expiry && x.expiry <= limit,
  )) {
    const p = state.products.find((p) => p.id === lot.product_id),
      l = state.locations.find((l) => l.id === lot.location_id),
      expired = lot.expiry < day;
    add(
      `lot:${lot.id}`,
      expired ? "Vervallen product" : "Vervalt binnenkort",
      `${p.name} — ${l.name} — lot ${lot.batch || "zonder nummer"} — ${lot.expiry}`,
      `${expired}:${lot.version}:${lot.expiry}`,
      expired ? "expired" : "soon",
    );
  }
  for (const s of state.shortages.filter((x) => !x.resolved_at))
    rows.push({
      key: `shortage:${s.id}`,
      title: "Gemeld tekort",
      text: `${state.products.find((p) => p.id === s.product_id).name} — ${state.locations.find((l) => l.id === s.location_id).name}: ${s.quantity} tekort${s.note ? " — " + s.note : ""}`,
      kind: "shortage",
      shortage: s,
    });
  return rows;
}
export function validateSnapshot(s) {
  if (
    !s ||
    s.schemaVersion !== 2 ||
    !["admin", "volunteer"].includes(s.role) ||
    !Number.isSafeInteger(s.revision)
  )
    throw new Error("Ongeldige servergegevens.");
  for (const key of [
    "categories",
    "products",
    "locations",
    "targets",
    "lots",
    "loans",
    "loan_lines",
    "shortages",
    "moves",
    "acknowledgements",
  ])
    if (!Array.isArray(s[key])) throw new Error(`Ongeldige gegevens: ${key}.`);
  const ids = (key) =>
    new Set(
      s[key].map((x) => {
        if (!UUID.test(x.id)) throw new Error("Ongeldig record-ID.");
        return x.id;
      }),
    );
  const products = ids("products"),
    locations = ids("locations"),
    categories = ids("categories"),
    lots = ids("lots"),
    loans = ids("loans");
  ids("shortages");
  ids("loan_lines");
  for (const key of ["categories", "products", "locations"])
    for (const x of s[key]) {
      if (typeof x.name !== "string" || typeof x.active !== "boolean")
        throw new Error("Ongeldige catalogus.");
      whole(x.version, 1);
    }
  for (const p of s.products) {
    whole(p.minimum);
    if (
      typeof p.code !== "string" ||
      typeof p.code_key !== "string" ||
      (p.category_id && !categories.has(p.category_id))
    )
      throw new Error("Ongeldig product.");
  }
  for (const x of s.lots) {
    whole(x.quantity);
    whole(x.version, 1);
    if (
      !products.has(x.product_id) ||
      !locations.has(x.location_id) ||
      typeof x.batch !== "string" ||
      (x.expiry !== null && !validDate(x.expiry))
    )
      throw new Error("Ongeldig lot.");
  }
  for (const x of s.targets) {
    whole(x.quantity);
    if (!products.has(x.product_id) || !locations.has(x.location_id))
      throw new Error("Ongeldige materiaallijst.");
  }
  for (const x of s.shortages) {
    whole(x.quantity, 1);
    if (!products.has(x.product_id) || !locations.has(x.location_id))
      throw new Error("Ongeldig tekort.");
  }
  for (const x of s.loan_lines) {
    whole(x.quantity, 1);
    whole(x.returned);
    if (x.returned > x.quantity || !lots.has(x.lot_id) || !loans.has(x.loan_id))
      throw new Error("Ongeldige uitlening.");
  }
  return s;
}
export function inventoryBackup(state) {
  return {
    format: "nijlen-inventory",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    ...Object.fromEntries(
      ["categories", "locations", "products", "targets", "lots"].map((k) => [
        k,
        state[k],
      ]),
    ),
  };
}
export function validateBackup(b) {
  if (
    b?.format !== "nijlen-inventory" ||
    b.schemaVersion !== 2 ||
    Object.keys(b).some(
      (k) =>
        ![
          "format",
          "schemaVersion",
          "exportedAt",
          "categories",
          "locations",
          "products",
          "targets",
          "lots",
        ].includes(k),
    )
  )
    throw new Error("Dit is geen geldige Nijlen-back-up versie 2.");
  for (const k of ["categories", "locations", "products", "targets", "lots"])
    if (!Array.isArray(b[k]) || b[k].length > 10000)
      throw new Error("Back-up bevat een ongeldige lijst.");
  validateSnapshot({
    ...b,
    role: "admin",
    revision: 0,
    loans: [],
    loan_lines: [],
    shortages: [],
    moves: [],
    acknowledgements: [],
  });
  for (const k of ["categories", "locations", "products", "lots"])
    if (new Set(b[k].map((x) => x.id)).size !== b[k].length)
      throw new Error("Dubbele IDs in back-up.");
  return b;
}
