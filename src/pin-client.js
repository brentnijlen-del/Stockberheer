export const validPin = (pin) =>
  typeof pin === "string" && /^[0-9]{4,8}$/.test(pin);
export async function publicPinRequest(
  url,
  key,
  body,
  { fetchImpl = fetch, timeout = 15000 } = {},
) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetchImpl(url + "/functions/v1/pin-auth", {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await r.json();
    if (!r.ok) {
      const e = new Error(result.message || "Pincode-aanvraag mislukt.");
      e.status = r.status;
      throw e;
    }
    return result;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(
        "Pincode-aanvraag niet bevestigd. Controleer de verbinding en probeer opnieuw.",
      );
    if (!e.status)
      throw new Error(
        "Pincode-aanvraag niet bevestigd. Controleer de verbinding en probeer opnieuw.",
      );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
