import { createClient } from "@supabase/supabase-js";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";
import {
  esc,
  whole,
  findCode,
  quantity,
  usable,
  localDay,
  outstanding,
  replenishments,
  alerts,
  validateSnapshot,
  inventoryBackup,
  validateBackup,
} from "./domain.js";
import { MaterialService } from "./service.js";
import { validPin, publicPinRequest } from "./pin-client.js";
import { CameraScanner, hardwareListener } from "./scanner.js";
const URL = __SUPABASE_URL__,
  KEY = __SUPABASE_KEY__;
const client = createClient(URL, KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
const $ = (id) => document.getElementById(id);
let state = null,
  page = "dashboard",
  selectedCase = "",
  dirty = false,
  syncing = false,
  syncEpoch = 0,
  lastSync = 0,
  backupPreview = null,
  users = [],
  invitationId = null,
  pinReset = false,
  pinEnrolled = false,
  legacyLogin = false,
  pinRequestId = null;
const service = new MaterialService(client.auth, {
  onStatus: (kind, text) => {
    const n = $("saveStatus");
    n.dataset.status = kind;
    n.textContent = text;
    $("retry").hidden = kind !== "uncertain";
  },
});
service.url = URL;
service.key = KEY;
const scanner = new CameraScanner({
  factory: (reader) =>
    new Html5Qrcode(reader, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
      ],
    }),
  onStatus: (text) => {
    if ($("scanStatus")) $("scanStatus").textContent = text;
  },
});
const volunteerPages = [
  "volunteerHome",
  "use",
  "inventory",
  "shortage",
  "loans",
  "scan",
  "help",
  "account",
];
const label = (text, body) => `<label>${esc(text)}${body}</label>`;
const input = (name, value = "", type = "text", attrs = "") =>
  `<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
const number = (name, value = 0, min = 0) =>
  input(
    name,
    value,
    "number",
    `min="${min}" max="1000000" step="1" required inputmode="numeric"`,
  );
const button = (text, action, data = "", cls = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${data}>${esc(text)}</button>`;
const opt = (items, selected = "") =>
  items
    .map(
      (x) =>
        `<option value="${esc(x.id)}" ${x.id === selected ? "selected" : ""}>${esc(x.name)}</option>`,
    )
    .join("");
const selector = (name, items, selected = "") =>
  `<select name="${name}" required>${opt(items, selected)}</select>`;
const products = () => state.products.filter((x) => x.active);
const locations = () => state.locations.filter((x) => x.active);
const cases = () => locations().filter((x) => x.kind === "case");
const name = (type, id) =>
  state[type].find((x) => x.id === id)?.name || "Onbekend";
const form = (type, body, submit = "Opslaan") =>
  `<form data-command="${type}">${body}<button type="submit">${esc(submit)}</button></form>`;
const card = (body) => `<div class="card">${body}</div>`;
const meta = () =>
  `<p class="muted">Bruikbare voorraad sluit vervallen loten uit. Vandaag: ${localDay()}.</p>`;
const scanInput = (name, placeholder) =>
  input(
    name,
    "",
    "text",
    `data-scan autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${esc(placeholder)}"`,
  ) + button("📷 Camera", "camera", `data-field="${name}"`);
function error(e) {
  $("message").textContent = e?.message || String(e);
  $("message").hidden = false;
}
function clearError() {
  $("message").hidden = true;
  $("message").textContent = "";
}
function showLogin(text = "") {
  if (legacyLogin) $("legacyLogin").click();
  service.invalidate();
  syncEpoch++;
  state = null;
  dirty = false;
  selectedCase = "";
  backupPreview = null;
  users = [];
  invitationId = null;
  pinReset = false;
  pinEnrolled = false;
  for (const id of ["invitePassword", "inviteRepeat"]) {
    $(id).disabled = false;
    $(id).required = true;
  }
  pinRequestId = null;
  $("invitation").classList.add("hidden");
  scanner.stop();
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("content").replaceChildren();
  $("nav").replaceChildren();
  $("printArea").replaceChildren();
  $("mode").textContent = "Afgemeld";
  $("loginError").textContent = text;
  $("editor").close();
  $("editorBody").replaceChildren();
  $("camera").close();
  $("retry").hidden = true;
}
client.auth.onAuthStateChange((event, session) => {
  if (
    event === "SIGNED_OUT" ||
    (service.user && session?.user.id !== service.user)
  )
    showLogin("Je sessie is beëindigd. Meld opnieuw aan.");
});
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginButton").disabled = true;
  $("loginError").textContent = "";
  try {
    let data, e;
    if (legacyLogin) {
      ({ data, error: e } = await client.auth.signInWithPassword({
        email: $("email").value.trim(),
        password: $("password").value,
      }));
    } else {
      const result = await publicPinRequest(URL, KEY, {
        action: "login",
        email: $("email").value.trim(),
        pin: $("password").value,
      });
      if (!result.session?.access_token || !result.session?.refresh_token)
        throw new Error("Aanmelding is niet bevestigd.");
      const response = await client.auth.setSession(result.session);
      data = response.data;
      e = response.error;
    }
    if (e) throw e;
    service.activate(data.user.id);
    await sync(true);
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    page = state.role === "admin" ? "dashboard" : "volunteerHome";
    $("mode").textContent =
      state.role === "admin" ? "Beheerdersmodus" : "Vrijwilligersmodus";
    renderNav();
    render();
  } catch (e) {
    await client.auth.signOut({ scope: "local" });
    showLogin(e.message);
  } finally {
    $("password").value = "";
    $("loginButton").disabled = false;
  }
});
$("legacyLogin").addEventListener("click", () => {
  legacyLogin = !legacyLogin;
  const field = $("password");
  field.value = "";
  $("loginSecretLabel").textContent = legacyLogin
    ? "Bestaand wachtwoord"
    : "Pincode";
  $("legacyLogin").textContent = legacyLogin
    ? "Aanmelden met pincode"
    : "Aanmelden met bestaand wachtwoord";
  field.inputMode = legacyLogin ? "text" : "numeric";
  if (legacyLogin) {
    field.removeAttribute("pattern");
    field.removeAttribute("minlength");
    field.removeAttribute("maxlength");
  } else {
    field.pattern = "[0-9]{4,8}";
    field.minLength = 4;
    field.maxLength = 8;
  }
});
$("forgotPin").addEventListener("click", async () => {
  $("forgotPin").disabled = true;
  try {
    const result = await publicPinRequest(URL, KEY, {
      action: "reset",
      email: $("email").value.trim(),
    });
    $("loginError").textContent = result.message;
  } catch (e) {
    $("loginError").textContent = e.message;
  } finally {
    $("forgotPin").disabled = false;
    $("password").value = "";
  }
});
async function sync(force = false) {
  if (!service.user || (!force && syncing)) return;
  const token = ++syncEpoch,
    epoch = service.epoch;
  syncing = true;
  try {
    const next = validateSnapshot(await service.snapshot());
    if (token !== syncEpoch || epoch !== service.epoch) return;
    if (state && next.role !== state.role) {
      await client.auth.signOut({ scope: "local" });
      showLogin("Je rechten zijn gewijzigd. Meld opnieuw aan.");
      return;
    }
    const changed = state && next.revision !== state.revision;
    state = next;
    lastSync = Date.now();
    $("syncStatus").textContent =
      "Gesynchroniseerd " + new Date().toLocaleTimeString("nl-BE");
    if (changed) {
      if (dirty || $("editor").open || $("camera").open) {
        $("refreshNotice").hidden = false;
      } else render();
    }
  } catch (e) {
    if (epoch !== service.epoch) return;
    $("syncStatus").textContent =
      "Synchronisatie mislukt; controleer de verbinding.";
    if (e.code === "42501" || e.status === 401) {
      await client.auth.signOut({ scope: "local" });
      showLogin(e.message);
    }
    if (force) throw e;
  } finally {
    if (token === syncEpoch) syncing = false;
  }
}
async function execute(type, payload, retry = false) {
  clearError();
  const epoch = service.epoch;
  try {
    await service.command(type, payload, { retry });
    if (epoch !== service.epoch) return;
    dirty = false;
    backupPreview = null;
    $("editor").close();
    $("editorBody").replaceChildren();
    try {
      await sync(true);
      if (epoch === service.epoch) render();
    } catch (e) {
      error(
        new Error(
          "De handeling is opgeslagen, maar het overzicht kon niet verversen. " +
            e.message,
        ),
      );
    }
  } catch (e) {
    if (epoch !== service.epoch) return;
    error(e);
    if (e.code === "42501" || e.status === 401) {
      await client.auth.signOut({ scope: "local" });
      showLogin(e.message);
    } else if (e.code === "40001") await sync(true);
  }
}
async function navigate(next) {
  if (!state || (state.role !== "admin" && !volunteerPages.includes(next)))
    return;
  if (
    (dirty || service.pending) &&
    !confirm(
      "Er is niet-opgeslagen of niet-bevestigde invoer. Naar een andere pagina gaan?",
    )
  )
    return;
  await scanner.stop();
  $("camera").close();
  page = next;
  dirty = false;
  clearError();
  render();
}
function renderNav() {
  const links =
    state.role === "admin"
      ? [
          ["dashboard", "🏠 Overzicht"],
          ["cases", "🧰 Koffers & locaties"],
          ["stock", "📦 Voorraad"],
          ["alerts", "⚠️ Meldingen"],
          ["loans", "↔️ Uitlenen"],
          ["products", "Producten & categorieën"],
          ["replenish", "Aanvullijsten"],
          ["inventory", "Koffercontrole"],
          ["moves", "Historiek"],
          ["scan", "Scanner"],
          ["settings", "Instellingen"],
          ["account", "Mijn account"],
        ]
      : [
          ["volunteerHome", "🏠 Start"],
          ["use", "📦 Verbruik"],
          ["inventory", "Koffer controleren"],
          ["shortage", "⚠️ Tekort melden"],
          ["loans", "↔️ Uitlenen"],
          ["scan", "📷 Scanner"],
          ["help", "❓ Hulp"],
          ["account", "Mijn account"],
        ];
  $("nav").innerHTML =
    `<div class="nav-title">${state.role === "admin" ? "Beheer" : "Vrijwilliger"}</div>` +
    links
      .map(([id, title]) => button(title, "navigate", `data-page="${id}"`))
      .join("") +
    button("Afmelden", "logout", "", "secondary nav-logout");
}
function render() {
  if (!state) return;
  $("refreshNotice").hidden = true;
  const s = $("content");
  const views = {
    dashboard,
    volunteerHome,
    products: productPage,
    cases: casePage,
    stock: stockPage,
    alerts: alertPage,
    replenish: replenishPage,
    inventory: inventoryPage,
    use: usePage,
    shortage: shortagePage,
    loans: loanPage,
    moves: movePage,
    settings: settingsPage,
    users: userPage,
    account: accountPage,
    scan: scanPage,
    help: () =>
      "<h2>Hulp</h2>" +
      card(
        "<p>Contacteer je afdelingsbeheerder via de interne contactlijst.</p><p>Scan een koffer, registreer verbruik of tel per lot. Een tekortmelding verandert de geregistreerde voorraad niet. De beheerder vergelijkt je melding met de voorraad en verwerkt de aanvulling.</p>",
      ),
  };
  s.innerHTML = (views[page] || dashboard)();
  for (const n of $("nav").querySelectorAll("[data-page]"))
    n.classList.toggle("active", n.dataset.page === page);
}
function dashboard() {
  const a = alerts(state),
    low = a.filter((x) => x.kind === "low").length,
    expired = a.filter((x) => x.kind === "expired").length;
  return (
    "<h2>Beheerdersoverzicht</h2>" +
    meta() +
    `<div class="admin-kpis">${[
      ["Koffers", cases().length],
      ["Producten", products().length],
      ["Lage voorraad", low],
      ["Vervallen", expired],
    ]
      .map(([t, n]) =>
        card(`<div class="muted">${t}</div><strong class="stat">${n}</strong>`),
      )
      .join("")}</div><div class="action-grid">${[
      ["cases", "🧰 Koffers beheren"],
      ["stock", "📦 Voorraad beheren"],
      ["alerts", `⚠️ ${a.length} meldingen bekijken`],
      ["loans", "↔️ Uitlenen en terugbrengen"],
    ]
      .map(([id, t]) =>
        button(t, "navigate", `data-page="${id}"`, "big-action"),
      )
      .join("")}</div>`
  );
}
function volunteerHome() {
  return (
    '<div class="vol-home"><h2>Welkom 👋</h2><p>Wat wil je doen?</p><div class="vol-actions">' +
    [
      ["inventory", "📦 Koffer controleren"],
      ["use", "Verbruik registreren"],
      ["shortage", "⚠️ Snel tekort melden"],
      ["loans", "↔️ Materiaal uitlenen"],
      ["scan", "📷 Scanner"],
      ["help", "❓ Hulp"],
    ]
      .map(([id, t]) =>
        button(t, "navigate", `data-page="${id}"`, "vol-action"),
      )
      .join("") +
    "</div></div>"
  );
}
function productPage() {
  return (
    "<h2>Producten & categorieën</h2>" +
    card(
      button("Nieuw product", "edit", `data-entity="product"`) +
        label(
          "Filter op categorie",
          `<select id="categoryFilter"><option value="">Alle categorieën</option>${opt(state.categories.filter((x) => x.active))}</select>`,
        ) +
        products()
          .map(
            (p) =>
              `<div class="item product-row" data-category="${esc(p.category_id)}"><b>${esc(p.name)}</b><p>${esc(p.code)} · ${esc(p.category_id ? name("categories", p.category_id) : "Geen categorie")} · minimum ${p.minimum}</p>${button("QR/barcode", "label", `data-entity="product" data-id="${p.id}"`)} ${button("Aanpassen", "edit", `data-entity="product" data-id="${p.id}"`, "secondary")} ${button("Verwijderen", "archive", `data-entity="product" data-id="${p.id}"`, "danger")}</div>`,
          )
          .join(""),
    ) +
    card(
      "<h3>Categorieën</h3>" +
        button("Nieuwe categorie", "edit", `data-entity="category"`) +
        state.categories
          .filter((x) => x.active)
          .map(
            (c) =>
              `<div class="item">${esc(c.name)} ${button("Hernoemen", "edit", `data-entity="category" data-id="${c.id}"`)} ${button("Verwijderen", "archive", `data-entity="category" data-id="${c.id}"`, "danger")}</div>`,
          )
          .join(""),
    )
  );
}
function casePage() {
  return (
    "<h2>Koffers, tassen en locaties</h2>" +
    card(
      button(
        "Nieuwe koffer/tas",
        "edit",
        `data-entity="location" data-kind="case"`,
      ) +
        " " +
        button(
          "Nieuwe magazijnlocatie",
          "edit",
          `data-entity="location" data-kind="warehouse"`,
        ),
    ) +
    locations()
      .map((k) =>
        card(
          `<h3>${esc(k.name)}</h3><p>${esc(k.code)} · ${esc(k.description)}</p>${button("Aanpassen", "edit", `data-entity="location" data-id="${k.id}"`)} ${button("Verwijderen", "archive", `data-entity="location" data-id="${k.id}"`, "danger")} ${
            k.kind === "case"
              ? button(
                  "QR/barcode-label",
                  "label",
                  `data-entity="location" data-id="${k.id}"`,
                ) +
                button(
                  "Inventaris afdrukken",
                  "printCase",
                  `data-id="${k.id}"`,
                ) +
                `<h4>Materiaallijst</h4>` +
                form(
                  "target",
                  input("location_id", k.id, "hidden") +
                    input("version", k.version, "hidden") +
                    label("Product", selector("product_id", products())) +
                    label(
                      "Gewenst aantal (0 verwijdert)",
                      number("quantity", 1),
                    ),
                  "Toevoegen / aanpassen",
                ) +
                state.targets
                  .filter((t) => t.location_id === k.id)
                  .map(
                    (t) =>
                      `<p>${esc(name("products", t.product_id))}: ${t.quantity} stuks</p>`,
                  )
                  .join("")
              : ""
          }`,
        ),
      )
      .join("")
  );
}
function stockPage() {
  return (
    "<h2>Voorraad</h2>" +
    meta() +
    card(
      "<h3>Voorraad toevoegen</h3>" +
        form(
          "receive",
          label("Product", selector("product_id", products())) +
            label("Locatie", selector("location_id", locations())) +
            label("Aantal", number("quantity", 1, 1)) +
            label("Lotnummer", input("batch")) +
            label("Vervaldatum", input("expiry", "", "date")),
          "Toevoegen",
        ),
    ) +
    card(
      "<h3>Actuele voorraad per lot</h3>" +
        state.lots
          .map(
            (l) =>
              `<div class="item"><b>${esc(name("products", l.product_id))}</b> · ${l.quantity} stuks<br>${esc(name("locations", l.location_id))} · lot ${esc(l.batch || "—")} · ${esc(l.expiry || "geen vervaldatum")} ${usable(l) ? "" : '<span class="pill">Vervallen</span>'}<p>${button("Hoeveelheid aanpassen", "adjust", `data-id="${l.id}"`)} ${button("Voorraad verwijderen", "zero", `data-id="${l.id}"`, "danger")}</p></div>`,
          )
          .join(""),
    )
  );
}
function alertPage() {
  return (
    "<h2>Meldingen</h2>" +
    meta() +
    label(
      "Filter",
      `<select id="alertFilter"><option value="">Alle meldingen</option><option value="expired">Vervallen</option><option value="low">Lage voorraad</option><option value="shortage">Gemelde tekorten</option><option value="soon">Vervalt binnenkort</option></select>`,
    ) +
    card(
      alerts(state)
        .map(
          (a) =>
            `<div class="item alert-row" data-kind="${a.kind}"><b>${esc(a.title)}</b><p>${esc(a.text)}</p>${a.kind === "shortage" ? button("Tekort verwerken", "resolve", `data-id="${a.shortage.id}"`) : button("Gezien / verwerkt", "acknowledge", `data-key="${esc(a.key)}" data-fingerprint="${esc(a.fingerprint)}"`)}</div>`,
        )
        .join("") || "<p>✅ Geen actieve meldingen.</p>",
    ) +
    card(
      "<p>Een waarschuwing als gezien markeren verandert geen voorraad. Na een nieuwe voorraadwijziging verschijnt een actuele waarschuwing opnieuw. Vervallen materiaal moet afzonderlijk worden afgevoerd.</p>",
    )
  );
}
function caseSelector(action) {
  return label(
    "Koffer/tas",
    `<select id="caseSelect" data-view="${action}"><option value="">Kies een koffer/tas</option>${opt(cases(), selectedCase)}</select>`,
  );
}
function replenishPage() {
  const k = state.locations.find((x) => x.id === selectedCase);
  return (
    "<h2>Aanvullijsten per koffer</h2>" +
    caseSelector("replenish") +
    (!k
      ? ""
      : card(
          `<h3>${esc(k.name)}</h3>` +
            table(
              ["Product", "Bruikbaar", "Gewenst", "Gemeld tekort", "Bijvullen"],
              replenishments(state, k.id).map((t) => [
                name("products", t.product_id),
                t.present,
                t.quantity,
                t.reported,
                t.need,
              ]),
            ) +
            button(
              "Aanvullijst afdrukken",
              "printReplenish",
              `data-id="${k.id}"`,
            ),
        )) +
    card(
      "<p>De aanvullijst combineert bruikbare voorraad met open tekortmeldingen. Meerdere meldingen van hetzelfde tekort worden niet opgeteld. Registreer aanvulling via Voorraad en sluit daarna de gecontroleerde tekortmelding.</p>",
    )
  );
}
function table(headers, rows) {
  return `<div class="table-scroll"><table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${headers.length}">Geen gegevens.</td></tr>`}</tbody></table></div>`;
}
function inventoryPage() {
  const k = state.locations.find((x) => x.id === selectedCase),
    lots = state.lots.filter((l) => l.location_id === selectedCase);
  return (
    "<h2>Koffercontrole per lot</h2>" +
    caseSelector("inventory") +
    (!k
      ? ""
      : card(
          `<h3>${esc(k.name)}</h3><p>Tel elk lot afzonderlijk. Lotnummer en vervaldatum blijven behouden. Nieuwe, niet-geregistreerde loten laat je door de beheerder toevoegen.</p>` +
            (!lots.length
              ? "<p>Geen loten geregistreerd.</p>"
              : form(
                  "inventory",
                  input("location_id", k.id, "hidden") +
                    lots
                      .map(
                        (l) =>
                          `<div class="item"><b>${esc(name("products", l.product_id))}</b> · lot ${esc(l.batch || "—")} · ${esc(l.expiry || "geen vervaldatum")} · geregistreerd ${l.quantity}${input(`version_${l.id}`, l.version, "hidden")}${label("Geteld", number(`lot_${l.id}`, l.quantity))}</div>`,
                      )
                      .join("") +
                    label(
                      "Reden / controle",
                      input(
                        "reason",
                        "Koffercontrole",
                        "text",
                        'required maxlength="500"',
                      ),
                    ),
                  "Controle opslaan",
                )),
        ))
  );
}
function usePage() {
  const k = state.locations.find((x) => x.id === selectedCase);
  return (
    "<h2>Verbruik registreren</h2>" +
    meta() +
    card(
      form(
        "selectCase",
        label("Koffercode", scanInput("case_code", "Scan of typ koffercode")),
        "Koffer bevestigen",
      ),
    ) +
    (!k
      ? ""
      : card(
          `<h3>${esc(k.name)}</h3>` +
            form(
              "consume",
              input("location_id", k.id, "hidden") +
                label(
                  "Productcode",
                  scanInput("product_code", "Scan of typ productcode"),
                ) +
                label("Aantal", number("quantity", 1, 1)),
              "Verbruik bevestigen",
            ) +
            button(
              "Tekort melden voor deze koffer",
              "shortageForCase",
              `data-id="${k.id}"`,
            ),
        ))
  );
}
function shortagePage() {
  const k = state.locations.find((x) => x.id === selectedCase),
    targets = state.targets.filter(
      (t) => t.location_id === selectedCase && t.quantity > 0,
    );
  return (
    "<h2>Snel tekort melden</h2>" +
    caseSelector("shortage") +
    card(
      form(
        "selectCase",
        label("Koffercode", scanInput("case_code", "Scan koffercode")),
        "Koffer bevestigen",
      ),
    ) +
    (!k
      ? ""
      : card(
          `<h3>${esc(k.name)}</h3><p>Geef ontbrekend materiaal door. Dit verandert de geregistreerde voorraad niet.</p>` +
            (!targets.length
              ? "<p>Geen materiaallijst ingesteld. Contacteer de beheerder.</p>"
              : form(
                  "shortage",
                  input("location_id", k.id, "hidden") +
                    targets
                      .map(
                        (t) =>
                          `<div class="short-row"><b>${esc(name("products", t.product_id))}</b> · gewenst ${t.quantity}<div class="short-actions">${button("−5", "step", `data-field="short_${t.product_id}" data-delta="-5"`)}${button("−1", "step", `data-field="short_${t.product_id}" data-delta="-1"`)}${number(`short_${t.product_id}`, 0)}${button("+1", "step", `data-field="short_${t.product_id}" data-delta="1"`)}${button("+5", "step", `data-field="short_${t.product_id}" data-delta="5"`)}</div></div>`,
                      )
                      .join("") +
                    label(
                      "Opmerking",
                      input("note", "", "text", 'maxlength="1000"'),
                    ),
                  "Tekorten doorgeven",
                )),
        ))
  );
}
function loanPage() {
  return (
    "<h2>Uitlenen en terugbrengen</h2>" +
    meta() +
    card(
      "<h3>Uitlenen</h3>" +
        form(
          "loan",
          label("Product", selector("product_id", products())) +
            label("Uit locatie/koffer", selector("location_id", locations())) +
            label("Aantal", number("quantity", 1, 1)) +
            label(
              "Uitgeleend aan",
              input("who", "", "text", 'required maxlength="120"'),
            ) +
            label(
              "Activiteit / interventie",
              input("event", "", "text", 'maxlength="500"'),
            ),
          "Uitlenen registreren",
        ),
    ) +
    card(
      "<h3>Openstaande uitleningen</h3>" +
        state.loans
          .filter((l) => outstanding(state, l.id) > 0)
          .map(
            (l) =>
              `<div class="item"><b>${esc(l.description)}</b> · ${esc(l.who)} · ${esc(l.event)}<p>Openstaand: ${outstanding(state, l.id)}</p>${form("return", input("loan_id", l.id, "hidden") + label("Aantal teruggebracht", number("quantity", outstanding(state, l.id), 1)), "Terugbrengen")}</div>`,
          )
          .join(""),
    ) +
    card(
      "<h3>Teruggebracht</h3>" +
        state.loans
          .filter((l) => outstanding(state, l.id) === 0)
          .map(
            (l) =>
              `<p>${esc(l.description)} · ${esc(l.who)} · ${new Date(l.created_at).toLocaleDateString("nl-BE")}</p>`,
          )
          .join(""),
    )
  );
}
function movePage() {
  return (
    "<h2>Mutatiehistoriek</h2>" +
    card(
      table(
        [
          "Datum",
          "Handeling",
          "Product",
          "Locatie",
          "Aantal (+/−)",
          "Lot",
          "Vervaldatum",
          "Gebruiker",
        ],
        state.moves.map((m) => {
          const l = state.lots.find((l) => l.id === m.lot_id);
          return [
            new Date(m.at).toLocaleString("nl-BE"),
            m.kind,
            l ? name("products", l.product_id) : "—",
            l ? name("locations", l.location_id) : "—",
            m.quantity,
            l?.batch || "—",
            l?.expiry || "—",
            m.actor_id,
          ];
        }),
      ),
    ) +
    card(
      "<p>Mutaties worden op de server vastgelegd en kunnen niet via de toepassing worden gewijzigd of gewist.</p>",
    )
  );
}
function settingsPage() {
  return (
    "<h2>Instellingen & back-ups</h2>" +
    card(
      "<p>Beheer persoonlijke vrijwilligerstoegang via Gebruikersbeheer.</p>" +
        button("Gebruikersbeheer", "openUsers") +
        button("Voorraadback-up exporteren", "backup") +
        button("Historiek en uitleningen exporteren", "archiveExport"),
    ) +
    card(
      "<h3>Voorraad herstellen</h3><p>Herstel overschrijft de huidige catalogus en voorraad, behoudt historiek en vereist dat alle uitleningen terug zijn. Een oude versie-1-back-up moet eerst worden geconverteerd.</p>" +
        label(
          "Back-upbestand",
          input(
            "backupFile",
            "",
            "file",
            'id="backupFile" accept="application/json,.json"',
          ),
        ) +
        `<div id="backupPreview"></div>`,
    )
  );
}
function accountPage() {
  return (
    "<h2>Mijn account</h2>" +
    card(
      "<p>Kies een persoonlijke pincode van 4 tot en met 8 cijfers. Niemand kan je pincode in Gebruikersbeheer bekijken. Je oude wachtwoord wordt vervangen wanneer je dit bevestigt.</p>" +
        "<p>Gebruik je dit account ook in andere toepassingen? Dan verandert ook het wachtwoord voor dat account. Vraag bij twijfel je beheerder. Meld opnieuw aan als je aanmelding ouder is dan 15 minuten.</p>" +
        form(
          "setPin",
          label(
            "Nieuwe pincode",
            input(
              "pin",
              "",
              "password",
              'inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" required',
            ),
          ) +
            label(
              "Pincode herhalen",
              input(
                "repeat",
                "",
                "password",
                'inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="new-password" required',
              ),
            ),
          "Pincode opslaan",
        ) +
        '<p id="pinStatus" role="status" aria-live="polite"></p>',
    )
  );
}
function scanPage() {
  return (
    "<h2>Scanner</h2>" +
    card(
      form(
        "scanCode",
        label("QR- of barcode", scanInput("scan_code", "Scan of typ code")),
        "Code gebruiken",
      ) +
        "<p>Een koffercode opent de geselecteerde koffer. Een productcode wordt gebruikt in de verbruiksflow.</p>",
    )
  );
}
function editor(body, title) {
  $("editorTitle").textContent = title;
  $("editorBody").innerHTML = body;
  $("editor").showModal();
}
function edit(entity, id, kind) {
  const collection = {
      product: "products",
      category: "categories",
      location: "locations",
    }[entity],
    x = state[collection].find((x) => x.id === id) || {
      id: crypto.randomUUID(),
      name: "",
      code: "",
      minimum: 0,
      kind: kind || "case",
      description: "",
    };
  const code =
    entity !== "category"
      ? label(
          "Unieke code",
          input(
            "code",
            x.code || "",
            "text",
            `${entity === "product" || x.kind === "case" ? "required" : ""} maxlength="80"`,
          ),
        ) + button("Code genereren", "generate", `data-entity="${entity}"`)
      : "";
  editor(
    form(
      "catalog",
      input("entity", entity, "hidden") +
        input("id", x.id, "hidden") +
        input("version", x.version || "", "hidden") +
        label(
          "Naam",
          input("name", x.name, "text", 'required maxlength="120"'),
        ) +
        code +
        (entity === "product"
          ? label(
              "Categorie",
              `<select name="category_id"><option value="">Geen categorie</option>${opt(
                state.categories.filter((x) => x.active),
                x.category_id,
              )}</select>`,
            ) + label("Minimumvoorraad", number("minimum", x.minimum))
          : entity === "location"
            ? input("kind", x.kind, "hidden") +
              label(
                "Locatie / beschrijving",
                input("description", x.description, "text", 'maxlength="500"'),
              )
            : ""),
    ),
    id ? "Aanpassen" : "Nieuw record",
  );
}
async function startCamera(field) {
  const scope = $("editor").open ? $("editor") : $("content");
  const target = scope.querySelector(`[name="${field}"]`);
  if (!target) throw new Error("Scanveld ontbreekt.");
  $("camera").showModal();
  $("scanStatus").textContent = "Camera wordt gestart…";
  try {
    await scanner.start("reader", (code) => {
      if (!target.isConnected) return;
      target.value = code.trim();
      dirty = true;
      $("camera").close();
      target.focus();
    });
  } catch (e) {
    $("scanStatus").textContent = "Camera kon niet starten: " + e.message;
  }
}
async function hardwareCode(code, target) {
  try {
    if (target?.matches?.("[data-scan]")) {
      target.value = code.trim();
      if (target.name === "case_code") {
        const k = findCode(cases(), code);
        if (!k) throw new Error("Koffer niet gevonden.");
        selectedCase = k.id;
        dirty = false;
        render();
      }
      return;
    }
    const k = findCode(cases(), code);
    if (k) {
      selectedCase = k.id;
      if (!["shortage", "inventory", "replenish"].includes(page)) page = "use";
      dirty = false;
      render();
      return;
    }
    const p = findCode(products(), code),
      n = $("content").querySelector('[name="product_code"]');
    if (p && n) {
      n.value = p.code;
      dirty = true;
    }
  } catch (e) {
    error(e);
  }
}
document.addEventListener(
  "keydown",
  hardwareListener({
    onCode: hardwareCode,
    active: () => Boolean(state) && !$("camera").open && !$("editor").open,
  }),
  true,
);
document.addEventListener("input", (e) => {
  if (e.target.closest("#content,#editor")) dirty = true;
});
document.addEventListener("change", async (e) => {
  try {
    if (e.target.id === "caseSelect") {
      selectedCase = e.target.value;
      dirty = false;
      render();
    }
    if (e.target.id === "categoryFilter")
      for (const n of document.querySelectorAll(".product-row"))
        n.hidden =
          Boolean(e.target.value) && n.dataset.category !== e.target.value;
    if (e.target.id === "alertFilter")
      for (const n of document.querySelectorAll(".alert-row"))
        n.hidden = Boolean(e.target.value) && n.dataset.kind !== e.target.value;
    if (e.target.id === "backupFile") {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5000000) throw new Error("Back-upbestand is te groot.");
      backupPreview = {
        backup: validateBackup(JSON.parse(await file.text())),
        revision: state.revision,
      };
      dirty = true;
      $("backupPreview").innerHTML =
        `<p>${backupPreview.backup.products.length} producten en ${backupPreview.backup.lots.length} loten. Huidige voorraad wordt vervangen; historiek blijft behouden.</p>${button("Herstel bevestigen", "restore", "", "danger")}`;
    }
  } catch (e) {
    backupPreview = null;
    error(e);
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-command]");
  if (!f) return;
  e.preventDefault();
  if (!f.reportValidity()) return;
  try {
    const data = Object.fromEntries(new FormData(f)),
      type = f.dataset.command;
    if (type === "setPin") {
      if (!validPin(data.pin) || data.pin !== data.repeat)
        throw new Error(
          "Vul tweemaal dezelfde pincode van 4 tot en met 8 cijfers in.",
        );
      if (
        !confirm(
          "Je persoonlijke pincode instellen en je oude wachtwoord vervangen?",
        )
      )
        return;
      const epoch = service.epoch;
      const submit = f.querySelector('[type="submit"]');
      submit.disabled = true;
      $("pinStatus").textContent = "Pincode wordt opgeslagen…";
      try {
        pinRequestId ||= crypto.randomUUID();
        const result = await service.pin({
          action: "enrol",
          pin: data.pin,
          request_id: pinRequestId,
        });
        if (epoch !== service.epoch) return;
        if (result.saved !== true)
          throw new Error("Pincode-opslag niet bevestigd.");
        const fresh = await client.auth.setSession(result.session);
        if (fresh.error) throw fresh.error;
        if (epoch !== service.epoch) return;
        pinRequestId = null;
        dirty = false;
        if ($("pinStatus"))
          $("pinStatus").textContent =
            "Pincode opgeslagen. Gebruik voortaan je e-mailadres en pincode.";
      } catch (e) {
        if (epoch === service.epoch) {
          if ($("pinStatus")) $("pinStatus").textContent = e.message;
          error(e);
        }
      } finally {
        for (const n of f.querySelectorAll('input[type="password"]'))
          n.value = "";
        if (epoch === service.epoch) submit.disabled = false;
      }
      return;
    }
    if (type === "setUserRole") {
      if (data.role === data.expected_role) return;
      const roleName = data.role === "admin" ? "beheerder" : "vrijwilliger";
      if (
        !confirm(
          `Rol van ${data.email} wijzigen naar ${roleName}?` +
            (data.role === "admin"
              ? " Deze persoon krijgt toegang tot alle beheerfuncties."
              : " De beheerrechten worden ingetrokken."),
        )
      )
        return;
      const epoch = service.epoch;
      const submit = f.querySelector('[type="submit"]');
      submit.disabled = true;
      $("userStatus").textContent = "Gebruikersrol wordt opgeslagen…";
      try {
        const result = await service.edge({
          action: "set_role",
          target: data.user_id,
          role: data.role,
          expected_role: data.expected_role,
          confirmed: true,
        });
        if (epoch !== service.epoch) return;
        if (result?.saved !== true)
          throw new Error("Rolwijziging is niet bevestigd.");
        dirty = false;
        await loadUsers();
        if (page === "users" && $("userStatus"))
          $("userStatus").textContent = "Gebruikersrol opgeslagen.";
      } catch (e) {
        if (epoch === service.epoch) {
          const message =
            e.status && e.status < 500
              ? e.message
              : "Rolwijziging niet bevestigd. Ververs het overzicht voordat je opnieuw probeert.";
          if ($("userStatus")) $("userStatus").textContent = message;
          error(new Error(message));
        }
      } finally {
        if (epoch === service.epoch) submit.disabled = false;
      }
      return;
    }
    if (type === "inviteUser") {
      const epoch = service.epoch;
      $("userStatus").textContent = "Uitnodiging wordt verstuurd…";
      try {
        const result = await service.edge({
          action: "invite",
          email: data.email,
          role: "volunteer",
          request_id: crypto.randomUUID(),
        });
        if (epoch !== service.epoch) return;
        dirty = false;
        await loadUsers();
        $("userStatus").textContent = result.message;
      } catch (e) {
        if (epoch === service.epoch) {
          $("userStatus").textContent = e.message;
          error(e);
        }
      }
      return;
    }
    if (["selectCase", "scanCode"].includes(type)) {
      const code = data.case_code || data.scan_code,
        k = findCode(cases(), code);
      if (k) {
        selectedCase = k.id;
        dirty = false;
        if (type === "scanCode") page = "use";
        render();
        return;
      }
      if (type === "scanCode") {
        const p = findCode(products(), code);
        if (p && selectedCase) {
          page = "use";
          dirty = false;
          render();
          $("content").querySelector('[name="product_code"]').value = p.code;
          return;
        }
      }
      throw new Error(
        "Code niet gevonden. Kies eerst een koffer voor productverbruik.",
      );
    }
    if (type === "catalog") {
      if (data.entity === "product") {
        data.minimum = whole(data.minimum);
        data.category_id = data.category_id || null;
      }
      data.version = data.version ? whole(data.version, 1) : null;
    }
    if (
      ["receive", "consume", "loan", "return", "target", "adjust"].includes(
        type,
      )
    )
      data.quantity = whole(
        data.quantity,
        type === "target" || type === "adjust" ? 0 : 1,
      );
    if (type === "target" || type === "adjust")
      data.version = whole(data.version, 1);
    if (type === "consume") {
      const p = findCode(products(), data.product_code);
      if (!p) throw new Error("Product niet gevonden.");
      data.product_id = p.id;
      delete data.product_code;
    }
    if (type === "inventory") {
      data.lots = Object.entries(data)
        .filter(([key]) => key.startsWith("lot_"))
        .map(([key, value]) => ({
          id: key.slice(4),
          quantity: whole(value),
          version: whole(data["version_" + key.slice(4)], 1),
        }));
      for (const k of Object.keys(data))
        if (k.startsWith("lot_") || k.startsWith("version_")) delete data[k];
    }
    if (type === "shortage") {
      data.items = Object.entries(data)
        .filter(([key]) => key.startsWith("short_"))
        .map(([key, value]) => ({
          product_id: key.slice(6),
          quantity: whole(value),
        }))
        .filter((x) => x.quantity > 0);
      for (const k of Object.keys(data))
        if (k.startsWith("short_")) delete data[k];
      if (!data.items.length) throw new Error("Geen tekort aangeduid.");
    }
    await execute(type, data);
  } catch (e) {
    error(e);
  }
});
async function printLabel(entity, id) {
  const x = state[entity === "product" ? "products" : "locations"].find(
    (x) => x.id === id,
  );
  if (!x?.code) throw new Error("Geen code ingesteld.");
  const area = $("printArea");
  area.innerHTML = `<h2>${esc(x.name)}</h2><p>${esc(x.code)}</p><canvas id="qrLabel"></canvas><svg id="barcodeLabel"></svg>`;
  await QRCode.toCanvas($("qrLabel"), x.code, { width: 240 });
  JsBarcode($("barcodeLabel"), x.code, {
    format: "CODE128",
    displayValue: true,
    width: 2,
  });
  editor(
    `<h3>${esc(x.name)}</h3><p>${esc(x.code)}</p><div id="labelPreview"></div>` +
      button("Afdrukken", "print"),
    "Label afdrukken",
  );
  const image = document.createElement("img");
  image.src = $("qrLabel").toDataURL();
  image.alt = "QR-code";
  const barcode = $("barcodeLabel").cloneNode(true);
  barcode.removeAttribute("id");
  $("labelPreview").append(image, barcode);
}
function printCase(id, replenish = false) {
  const k = state.locations.find((x) => x.id === id);
  let rows;
  if (replenish)
    rows = replenishments(state, id).map((t) => [
      name("products", t.product_id),
      t.present,
      t.quantity,
      t.reported,
      t.need,
    ]);
  else {
    rows = state.lots
      .filter((l) => l.location_id === id)
      .map((l) => {
        const p = state.products.find((p) => p.id === l.product_id);
        return [
          p.name,
          p.category_id ? name("categories", p.category_id) : "Geen categorie",
          p.code,
          state.targets.find(
            (t) => t.location_id === id && t.product_id === p.id,
          )?.quantity || 0,
          l.quantity,
          l.batch,
          l.expiry || "—",
        ];
      });
    for (const t of state.targets.filter(
      (t) =>
        t.location_id === id &&
        !state.lots.some(
          (l) => l.location_id === id && l.product_id === t.product_id,
        ),
    )) {
      const p = state.products.find((p) => p.id === t.product_id);
      rows.push([
        p.name,
        p.category_id ? name("categories", p.category_id) : "Geen categorie",
        p.code,
        t.quantity,
        0,
        "—",
        "—",
      ]);
    }
  }
  $("printArea").innerHTML =
    `<h2>Rode Kruis-Vlaanderen — Afdeling Nijlen</h2><h3>${replenish ? "Aanvullijst" : "Inventaris"}: ${esc(k.name)} (${esc(k.code)})</h3><p>${localDay()}</p>` +
    table(
      replenish
        ? ["Product", "Bruikbaar", "Gewenst", "Gemeld tekort", "Bijvullen"]
        : [
            "Product",
            "Categorie",
            "Code",
            "Gewenst per product",
            "Aanwezig",
            "Lot",
            "Vervaldatum",
          ],
      rows,
    );
  window.print();
}
function download(data, filename) {
  const url = window.URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}
document.addEventListener("click", async (e) => {
  const n = e.target.closest("[data-action]");
  if (!n) return;
  try {
    const d = n.dataset;
    switch (d.action) {
      case "openUsers":
        await navigate("users");
        await loadUsers();
        break;
      case "reloadUsers":
        await loadUsers();
        break;
      case "resendInvite": {
        if (!confirm("Opnieuw een uitnodiging versturen naar " + d.email + "?"))
          return;
        const epoch = service.epoch;
        const result = await service.edge({
          action: "invite",
          email: d.email,
          role: "volunteer",
          request_id: crypto.randomUUID(),
        });
        if (epoch !== service.epoch) return;
        await loadUsers();
        $("userStatus").textContent = result.message;
        break;
      }
      case "blockUser":
      case "reactivateUser": {
        if (
          !confirm(
            d.action === "blockUser"
              ? "Toegang blokkeren? Voorraad en historiek blijven behouden."
              : "Toegang heractiveren?",
          )
        )
          return;
        const epoch = service.epoch;
        await service.edge({
          action: d.action === "blockUser" ? "block" : "reactivate",
          target: d.id,
        });
        if (epoch !== service.epoch) return;
        await loadUsers();
        $("userStatus").textContent = "Toegang bijgewerkt.";
        break;
      }
      case "navigate":
        await navigate(d.page);
        break;
      case "logout":
        if (
          service.pending &&
          !confirm(
            "Opslag is nog niet bevestigd. Afmelden? Controleer daarna de historiek voordat je opnieuw registreert.",
          )
        )
          return;
        service.invalidate();
        showLogin();
        $("loginButton").disabled = true;
        try {
          await client.auth.signOut({ scope: "local" });
        } finally {
          $("loginButton").disabled = false;
        }
        break;
      case "refresh":
        if (
          dirty &&
          !confirm("Niet-opgeslagen invoer vervangen door de actuele gegevens?")
        )
          return;
        dirty = false;
        await sync(true);
        render();
        break;
      case "retry":
        await execute(null, null, true);
        break;
      case "edit":
        edit(d.entity, d.id, d.kind);
        break;
      case "closeEditor":
        $("editor").close();
        $("editorBody").replaceChildren();
        $("printArea").replaceChildren();
        dirty = false;
        break;
      case "archive":
        if (confirm("Dit record archiveren? Historiek blijft behouden."))
          await execute("archive", { entity: d.entity, id: d.id });
        break;
      case "generate":
        n.closest("form").elements.code.value =
          (d.entity === "product" ? "PROD-" : "KOF-") +
          crypto.randomUUID().slice(0, 12).toUpperCase();
        dirty = true;
        break;
      case "label":
        await printLabel(d.entity, d.id);
        break;
      case "print":
        window.print();
        break;
      case "printCase":
        printCase(d.id);
        break;
      case "printReplenish":
        printCase(d.id, true);
        break;
      case "adjust":
      case "zero": {
        const l = state.lots.find((l) => l.id === d.id);
        editor(
          form(
            "adjust",
            input("id", l.id, "hidden") +
              input("version", l.version, "hidden") +
              label(
                "Nieuw aantal",
                number("quantity", d.action === "zero" ? 0 : l.quantity),
              ) +
              label(
                "Reden",
                input("reason", "", "text", 'required maxlength="500"'),
              ),
          ),
          "Voorraadcorrectie",
        );
        break;
      }
      case "resolve": {
        const s = state.shortages.find((s) => s.id === d.id);
        editor(
          form(
            "resolve",
            input("id", s.id, "hidden") +
              `<p>${esc(name("products", s.product_id))} · ${s.quantity} tekort. Registreer een eventuele aanvulling eerst bij Voorraad.</p>` +
              label(
                "Uitgevoerde oplossing",
                input("resolution", "", "text", 'required maxlength="1000"'),
              ),
          ),
          "Tekort verwerken",
        );
        break;
      }
      case "acknowledge":
        await execute("acknowledge", {
          key: d.key,
          fingerprint: d.fingerprint,
        });
        break;
      case "shortageForCase":
        selectedCase = d.id;
        await navigate("shortage");
        break;
      case "step": {
        const field = n.closest("form").elements[d.field];
        field.value = Math.max(
          0,
          Math.min(1000000, Number(field.value) + Number(d.delta)),
        );
        dirty = true;
        break;
      }
      case "camera":
        await startCamera(d.field);
        break;
      case "closeCamera":
        await scanner.stop();
        $("camera").close();
        break;
      case "backup":
        download(
          inventoryBackup(state),
          "nijlen-voorraad-" + localDay() + ".json",
        );
        break;
      case "archiveExport":
        download(
          {
            schemaVersion: 2,
            exportedAt: new Date().toISOString(),
            moves: state.moves,
            loans: state.loans,
            loan_lines: state.loan_lines,
            shortages: state.shortages,
          },
          "nijlen-historiek-" + localDay() + ".json",
        );
        break;
      case "restore":
        if (
          backupPreview &&
          confirm("De huidige voorraad vervangen door deze back-up?")
        )
          await execute("restore", backupPreview);
        break;
    }
  } catch (e) {
    error(e);
  }
});
$("editor").addEventListener("cancel", () => {
  $("editorBody").replaceChildren();
  $("printArea").replaceChildren();
  dirty = false;
});
$("camera").addEventListener("cancel", () => scanner.stop());
window.addEventListener("pagehide", () => scanner.stop());
window.addEventListener("beforeunload", (e) => {
  if (dirty || service.pending) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("online", () => sync());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
  else scanner.stop();
});
setInterval(() => {
  if (state && !document.hidden) {
    if (Date.now() - lastSync > 60000)
      $("syncStatus").textContent = "Gegevens mogelijk verouderd.";
    sync();
  }
}, 15000);
try {
  localStorage.removeItem("rk_material_v3");
} catch {} // Remove legacy private inventory; it never authorizes access.

function userPage() {
  if (state.role !== "admin") return "";
  return (
    "<h2>Gebruikersbeheer</h2>" +
    card(
      "<p>Alleen beheerders kunnen vrijwilligers uitnodigen, rollen wijzigen en toegang blokkeren. Een nieuwe gebruiker accepteert eerst de uitnodiging; daarna kun je de rol wijzigen. Accounts, voorraad en historiek worden niet verwijderd.</p>" +
        form(
          "inviteUser",
          label(
            "E-mailadres vrijwilliger",
            input("email", "", "email", 'required maxlength="254"'),
          ),
          "Vrijwilliger uitnodigen",
        ) +
        '<p id="userStatus" role="status" aria-live="polite"></p>' +
        button("Overzicht verversen", "reloadUsers"),
    ) +
    card(
      users
        .map((u) => {
          const expired =
            u.status === "invited" &&
            (!u.expires_at || new Date(u.expires_at) <= new Date());
          const status =
            u.status === "active"
              ? "Actief"
              : u.status === "blocked"
                ? "Geblokkeerd"
                : expired
                  ? "Uitnodiging verlopen / niet bevestigd"
                  : "Uitgenodigd";
          const actions =
            u.status === "invited"
              ? button(
                  "Opnieuw verzenden",
                  "resendInvite",
                  `data-email="${esc(u.email)}"`,
                )
              : u.id === service.user
                ? "<span>Je eigen account</span>"
                : button(
                    u.status === "blocked" ? "Heractiveren" : "Blokkeren",
                    u.status === "blocked" ? "reactivateUser" : "blockUser",
                    `data-id="${esc(u.id)}"`,
                    "secondary",
                  );
          const roles =
            u.status === "active" && u.id !== service.user
              ? form(
                  "setUserRole",
                  input("user_id", u.id, "hidden") +
                    input("email", u.email, "hidden") +
                    input("expected_role", u.role, "hidden") +
                    label(
                      "Gebruikersrol",
                      selector(
                        "role",
                        [
                          { id: "volunteer", name: "Vrijwilliger" },
                          { id: "admin", name: "Beheerder" },
                        ],
                        u.role,
                      ),
                    ),
                  "Rol opslaan",
                )
              : "";
          const roleName = u.role === "admin" ? "Beheerder" : "Vrijwilliger";
          return `<div class="item"><b>${esc(u.email || "E-mailadres niet beschikbaar")}</b><p>${roleName} · ${status} · ${u.date ? esc(new Date(u.date).toLocaleString("nl-BE")) : "Datum niet geregistreerd"}</p>${roles}${actions}</div>`;
        })
        .join("") || "<p>Overzicht wordt geladen.</p>",
    )
  );
}
async function loadUsers() {
  if (state?.role !== "admin") return;
  const epoch = service.epoch;
  try {
    const list = await service.edge({ action: "list" });
    if (epoch !== service.epoch) return;
    if (!Array.isArray(list)) throw new Error("Ongeldig gebruikersoverzicht.");
    users = list;
    if (page === "users") render();
  } catch (e) {
    if (epoch === service.epoch)
      error(new Error("Gebruikersbeheer niet beschikbaar: " + e.message));
  }
}
$("invitationForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!invitationId && !pinReset) return;
  const password = $("invitePassword").value;
  if (
    !pinEnrolled &&
    (!validPin(password) || password !== $("inviteRepeat").value)
  ) {
    $("inviteError").textContent =
      "Vul tweemaal dezelfde pincode van 4 tot en met 8 cijfers in.";
    return;
  }
  const epoch = service.epoch;
  $("acceptInvitation").disabled = true;
  try {
    if (!pinEnrolled) {
      pinRequestId ||= crypto.randomUUID();
      const result = await service.pin({
        action: "enrol",
        pin: password,
        invitation: invitationId,
        request_id: pinRequestId,
      });
      if (epoch !== service.epoch) return;
      if (result.saved !== true)
        throw new Error("Pincode-opslag niet bevestigd.");
      const fresh = await client.auth.setSession(result.session);
      if (fresh.error) throw fresh.error;
      if (epoch !== service.epoch) return;
      pinEnrolled = true;
      for (const id of ["invitePassword", "inviteRepeat"]) {
        $(id).disabled = true;
        $(id).required = false;
      }
    }
    if (invitationId)
      await service.call("material_accept_invite", {
        invitation: invitationId,
      });
    if (epoch !== service.epoch) return;
    invitationId = null;
    pinReset = false;
    pinEnrolled = false;
    pinRequestId = null;
    $("invitation").classList.add("hidden");
    await sync(true);
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    page = state.role === "admin" ? "dashboard" : "volunteerHome";
    renderNav();
    render();
    $("mode").textContent =
      state.role === "admin" ? "Beheerdersmodus" : "Vrijwilligersmodus";
  } catch (e) {
    if (epoch === service.epoch)
      $("inviteError").textContent = pinEnrolled
        ? "Pincode opgeslagen. Toegang nog niet bevestigd; klik opnieuw om de activering te controleren. " +
          e.message
        : e.message;
  } finally {
    $("invitePassword").value = "";
    $("inviteRepeat").value = "";
    $("acceptInvitation").disabled = false;
  }
});
async function incomingInvitation() {
  const query = new URLSearchParams(location.search),
    hash = new URLSearchParams(location.hash.slice(1)),
    id = query.get("invitation"),
    reset = query.get("pin_reset") === "1";
  if (hash.has("error_code") || hash.has("error")) {
    history.replaceState(null, "", location.pathname);
    $("loginError").textContent = reset
      ? "Herstellink ongeldig, verlopen of al gebruikt. Kies Pincode vergeten en open alleen de nieuwste herstelmail."
      : "Uitnodigingslink ongeldig, verlopen of al gebruikt. Vraag de beheerder om opnieuw te verzenden en open alleen de nieuwste mail.";
    return;
  }
  if (
    !id &&
    !reset &&
    (hash.has("access_token") ||
      ["invite", "recovery"].includes(hash.get("type")))
  ) {
    history.replaceState(null, "", location.pathname);
    $("loginError").textContent =
      "Uitnodigingslink onvolledig. Laat de beheerder de Supabase-URL-instellingen controleren en opnieuw verzenden.";
    return;
  }
  if (!id && !reset) return;
  history.replaceState(null, "", location.pathname);
  if (
    !hash.get("access_token") ||
    !hash.get("refresh_token") ||
    !["invite", "recovery"].includes(hash.get("type"))
  ) {
    $("loginError").textContent =
      "Uitnodigingslink ongeldig of verlopen. Vraag de beheerder om opnieuw te verzenden.";
    return;
  }
  try {
    const { data, error: e } = await client.auth.setSession({
      access_token: hash.get("access_token"),
      refresh_token: hash.get("refresh_token"),
    });
    if (e) throw e;
    const verified = await client.auth.getUser();
    if (verified.error || verified.data.user?.id !== data.session.user.id)
      throw new Error("Uitnodigingssessie ongeldig.");
    service.activate(data.session.user.id);
    if (reset) await service.call("material_pin_status", {});
    else await service.call("material_invite_status", { invitation: id });
    invitationId = id;
    pinReset = reset;
    $("invitation").querySelector("h2").textContent = reset
      ? "Pincode herstellen"
      : "Welkom bij Hulpdienst Materiaalbeheer Nijlen";
    $("acceptInvitation").textContent = reset
      ? "Pincode opslaan"
      : "Uitnodiging accepteren";
    $("login").classList.add("hidden");
    $("invitation").classList.remove("hidden");
    $("mode").textContent = "Uitnodiging accepteren";
  } catch (e) {
    showLogin("Uitnodiging niet geaccepteerd: " + e.message);
  }
}
incomingInvitation();
