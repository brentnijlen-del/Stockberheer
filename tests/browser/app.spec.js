import { test, expect } from "@playwright/test";
const login = async (page, role = "admin") => {
  await page.goto("/");
  await page.locator("#email").fill(role + "@example.invalid");
  await page.locator("#password").fill("fictional");
  await page.locator("#loginButton").click();
  if (role !== "nonmember") await expect(page.locator("#app")).toBeVisible();
};
const nav = async (page, title) => {
  await page
    .locator("#nav")
    .getByRole("button", { name: title, exact: true })
    .click();
};
test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:8040/_test/reset");
});
test("anonymous login isolation, nonmember rejection and volunteer permissions", async ({
  page,
}) => {
  let snapshots = 0;
  page.on("request", (r) => {
    if (r.url().includes("material_snapshot")) snapshots++;
  });
  await page.goto("/");
  await expect(page.locator("#app")).toBeHidden();
  expect(snapshots).toBe(0);
  await login(page, "nonmember");
  await expect(page.locator("#loginError")).toContainText("geen toegang");
  await expect(page.locator("#app")).toBeHidden();
  await login(page, "volunteer");
  await expect(page.locator("#nav")).not.toContainText(
    "Producten & categorieën",
  );
  await nav(page, "📷 Scanner");
  await expect(page.locator("#content h2")).toHaveText("Scanner");
});
test("product category creation, editing and safe rendering of malicious-looking values", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await nav(page, "Producten & categorieën");
  await page
    .getByRole("button", { name: "Nieuw product", exact: true })
    .click();
  await page
    .locator('#editor [name="name"]')
    .fill("<img src=x onerror=window.injected=1>");
  await page
    .locator('#editor [name="code"]')
    .fill("X' onmouseover='window.injected=1");
  await page.locator('#editor [name="minimum"]').fill("2");
  await page.locator('#editor [name="category_id"]').selectOption({ index: 1 });
  await page
    .locator("#editor")
    .getByRole("button", { name: "Opslaan", exact: true })
    .click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator(".product-row")).toHaveCount(2);
  await expect(
    page.locator(".product-row").filter({ hasText: "<img" }),
  ).toContainText("EHBO");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(errors).toEqual([]);
});
test("per-lot inventory, printing, shortage from consumption and replenishment", async ({
  page,
}) => {
  await login(page);
  await nav(page, "Koffercontrole");
  await page.locator("#caseSelect").selectOption({ index: 1 });
  await page.locator('[name^="lot_"]').first().fill("3");
  await page.getByRole("button", { name: "Controle opslaan" }).click();
  await expect(page.locator("#saveStatus")).toHaveText("Opgeslagen.");
  await nav(page, "🧰 Koffers & locaties");
  await page.getByRole("button", { name: "Inventaris afdrukken" }).click();
  await expect(page.locator("#printArea")).toContainText("2090-01-01");
  await expect(page.locator("#printArea")).toContainText("2091-01-01");
  await nav(page, "Scanner");
  const code = await page.request.post(
    "http://127.0.0.1:8040/rest/v1/rpc/material_snapshot",
    { headers: { Authorization: "Bearer token-admin" } },
  );
  const s = await code.json();
  const k = s.locations.find((x) => x.kind === "case");
  await page.locator('[name="scan_code"]').fill(k.code);
  await page.getByRole("button", { name: "Code gebruiken" }).click();
  await page
    .getByRole("button", { name: "Tekort melden voor deze koffer" })
    .click();
  await expect(page.locator("#content h2")).toHaveText("Snel tekort melden");
  await page.locator('[name^="short_"]').fill("2");
  await page.getByRole("button", { name: "Tekorten doorgeven" }).click();
  await expect(page.locator("#saveStatus")).toHaveText("Opgeslagen.");
  await nav(page, "Aanvullijsten");
  await page.locator("#caseSelect").selectOption({ index: 1 });
  await expect(page.locator("#content table")).toContainText("2");
});
test("loan decrements stock and partial return restores original lot", async ({
  page,
}) => {
  await login(page, "volunteer");
  await nav(page, "↔️ Uitlenen");
  await page.locator('[data-command="loan"] [name="who"]').fill("Testpersoon");
  await page.locator('[data-command="loan"] [name="quantity"]').fill("3");
  await page.getByRole("button", { name: "Uitlenen registreren" }).click();
  await expect(page.locator('[data-command="return"]')).toHaveCount(1);
  await page.locator('[data-command="return"] [name="quantity"]').fill("1");
  await page.getByRole("button", { name: "Terugbrengen", exact: true }).click();
  await expect(page.locator("#content")).toContainText("Openstaand: 2");
});
test("network uncertainty is visible; idempotent retry causes one stock mutation", async ({
  page,
}) => {
  await login(page, "volunteer");
  await nav(page, "↔️ Uitlenen");
  let lost = true;
  await page.route("**/material_command", async (route) => {
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.locator('[name="who"]').fill("Fictief");
  await page.locator('[data-command="loan"] [name="quantity"]').fill("2");
  await page.getByRole("button", { name: "Uitlenen registreren" }).click();
  await expect(page.locator("#saveStatus")).toContainText("niet bevestigd");
  await page.locator("#retry").click();
  await expect(page.locator("#saveStatus")).toHaveText("Opgeslagen.");
  await expect(page.locator('[data-command="return"]')).toHaveCount(1);
  await expect(page.locator("#content")).toContainText("Openstaand: 2");
});
test("two browsers consume concurrently without lost changes and synchronize", async ({
  browser,
  request,
}) => {
  const s = await (
    await request.post("http://127.0.0.1:8040/rest/v1/rpc/material_snapshot", {
      headers: { Authorization: "Bearer token-admin" },
    })
  ).json();
  const k = s.locations[0],
    p = s.products[0];
  const a = await browser.newPage({ baseURL: "http://127.0.0.1:8000" }),
    b = await browser.newPage({ baseURL: "http://127.0.0.1:8000" });
  for (const page of [a, b]) {
    await login(page, "volunteer");
    await nav(page, "📦 Verbruik");
    await page.locator('[name="case_code"]').fill(k.code);
    await page.getByRole("button", { name: "Koffer bevestigen" }).click();
    await page.locator('[name="product_code"]').fill(p.code);
    await page.locator('[name="quantity"]').fill("2");
  }
  await Promise.all([
    a.getByRole("button", { name: "Verbruik bevestigen" }).click(),
    b.getByRole("button", { name: "Verbruik bevestigen" }).click(),
  ]);
  for (const page of [a, b])
    await expect(page.locator("#saveStatus")).toHaveText("Opgeslagen.");
  const after = await (
    await request.post("http://127.0.0.1:8040/rest/v1/rpc/material_snapshot", {
      headers: { Authorization: "Bearer token-admin" },
    })
  ).json();
  expect(after.lots.reduce((n, l) => n + l.quantity, 0)).toBe(6);
  await a.close();
  await b.close();
});
test("USB scans stay in shortage flow; login Enter is not intercepted", async ({
  page,
  request,
}) => {
  const s = await (
    await request.post("http://127.0.0.1:8040/rest/v1/rpc/material_snapshot", {
      headers: { Authorization: "Bearer token-admin" },
    })
  ).json();
  await page.goto("/");
  await page.locator("#email").fill("volunteer@example.invalid");
  await page.locator("#password").pressSequentially("fictional", { delay: 5 });
  await page.locator("#password").press("Enter");
  await expect(page.locator("#app")).toBeVisible();
  await nav(page, "⚠️ Tekort melden");
  await page.locator('[name="case_code"]').focus();
  await page.keyboard.type(s.locations[0].code, { delay: 2 });
  await page.keyboard.press("Enter");
  await expect(page.locator("#content h2")).toHaveText("Snel tekort melden");
  await expect(page.locator('[name^="short_"]')).toBeVisible();
});
test("labels are generated locally; backup export and restore preview", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (/qrserver|tec-it|unpkg/.test(r.url())) external.push(r.url());
  });
  await login(page);
  await nav(page, "Producten & categorieën");
  await page.getByRole("button", { name: "QR/barcode", exact: true }).click();
  await expect(page.locator("#editor")).toBeVisible();
  expect(await page.locator("#qrLabel").getAttribute("width")).toBe("240");
  await expect(page.locator("#barcodeLabel rect").first()).toBeAttached();
  expect(external).toEqual([]);
  await page.getByRole("button", { name: "Sluiten", exact: true }).click();
  await nav(page, "Instellingen");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Voorraadback-up exporteren" })
    .click();
  const download = await downloadPromise;
  const path = await download.path();
  await page.locator("#backupFile").setInputFiles(path);
  await expect(page.locator("#backupPreview")).toContainText(
    "1 producten en 2 loten",
  );
});
test("desktop and mobile layouts render all permitted screens without page overflow or JS errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const title of [
      "🏠 Overzicht",
      "Producten & categorieën",
      "🧰 Koffers & locaties",
      "📦 Voorraad",
      "⚠️ Meldingen",
      "↔️ Uitlenen",
      "Aanvullijsten",
      "Koffercontrole",
      "Historiek",
      "Scanner",
      "Instellingen",
    ]) {
      await nav(page, title);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
  }
  expect(errors).toEqual([]);
});
test("automatic synchronization preserves dirty lot counts and refuses a stale submission", async ({
  page,
  request,
}) => {
  await page.clock.install();
  await login(page, "volunteer");
  await nav(page, "Koffer controleren");
  await page.locator("#caseSelect").selectOption({ index: 1 });
  const field = page.locator('[name^="lot_"]').first();
  await field.fill("3");
  const s = await (
    await request.post("http://127.0.0.1:8040/rest/v1/rpc/material_snapshot", {
      headers: { Authorization: "Bearer token-admin" },
    })
  ).json();
  const lot = s.lots[0];
  await request.post("http://127.0.0.1:8040/rest/v1/rpc/material_command", {
    headers: { Authorization: "Bearer token-admin" },
    data: {
      request_id: crypto.randomUUID(),
      command: {
        type: "receive",
        payload: {
          product_id: lot.product_id,
          location_id: lot.location_id,
          quantity: 1,
          batch: lot.batch,
          expiry: lot.expiry,
        },
      },
    },
  });
  await page.clock.fastForward(16000);
  await expect(page.locator("#refreshNotice")).toBeVisible();
  await expect(field).toHaveValue("3");
  await page.getByRole("button", { name: "Controle opslaan" }).click();
  await expect(page.locator("#message")).toContainText("Voorraad gewijzigd");
});
test("expired access tokens refresh automatically while remaining in the same account", async ({
  page,
}) => {
  let refreshes = 0;
  page.on("request", (r) => {
    if (r.url().includes("grant_type=refresh_token")) refreshes++;
  });
  await page.route("**/auth/v1/token?grant_type=password", async (route) => {
    const r = await route.fetch();
    const b = await r.json();
    b.expires_in = 1;
    b.expires_at = Math.floor(Date.now() / 1000) + 1;
    await route.fulfill({ response: r, json: b });
  });
  await login(page, "volunteer");
  await expect(page.locator("#app")).toBeVisible();
  expect(refreshes).toBeGreaterThan(0);
  await expect(page.locator("#mode")).toHaveText("Vrijwilligersmodus");
});

test("admin can create a category through the RPC with pg-safeupdate enabled", async ({
  page,
}) => {
  await login(page);
  await nav(page, "Producten & categorieën");
  await page
    .getByRole("button", { name: "Nieuwe categorie", exact: true })
    .click();
  await page.locator('#editor [name="name"]').fill("Safeupdate categorie");
  await page
    .locator("#editor")
    .getByRole("button", { name: "Opslaan", exact: true })
    .click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await expect(page.locator("#saveStatus")).toHaveText("Opgeslagen.");
  await expect(page.locator("#content")).toContainText("Safeupdate categorie");
  await expect(page.locator("#message")).not.toBeVisible();
});
