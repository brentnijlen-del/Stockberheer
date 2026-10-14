export function validPin(pin) {
  return typeof pin === "string" && /^[0-9]{4,8}$/.test(pin);
}
export async function derivePassword(userId, pepper, pin) {
  if (!validPin(pin) || !/^[0-9a-f]{64}$/.test(pepper))
    throw new Error("Invalid PIN configuration");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`material-pin-v1|${userId}|${pin}`),
  );
  return (
    "Aa1!Pin!" +
    [...new Uint8Array(digest)]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
  );
}
