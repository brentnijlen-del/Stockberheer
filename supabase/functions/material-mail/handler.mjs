export function mailText(payload, appOrigin) {
  const lines = [
    payload.title,
    "Hulpdienst Materiaalbeheer — Afdeling Nijlen",
    "",
  ];
  if (payload.kind === "help")
    lines.push(`Van: ${payload.email}`, payload.message);
  else {
    lines.push(`Product: ${payload.product}`, `Locatie: ${payload.location}`);
    if (payload.kind === "expired")
      lines.push(
        `Lot: ${payload.batch || "zonder nummer"}`,
        `Vervaldatum: ${payload.expiry}`,
        `Aantal: ${payload.quantity}`,
      );
    else
      lines.push(
        "Er is geen niet-vervallen voorraad beschikbaar op deze locatie.",
      );
  }
  lines.push(
    "",
    `Open het beheerdersoverzicht: ${appOrigin}`,
    "Dit is een automatische melding. Controleer de actuele voorraad in de website.",
  );
  return lines.join("\n");
}
async function sameSecret(a, b) {
  const digest = async (s) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
export function materialMailHandler({
  server,
  jobToken,
  resendKey,
  from,
  appOrigin,
  fetchImpl = fetch,
}) {
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  return async (req) => {
    if (req.method !== "POST") return reply(405, { message: "POST required" });
    if (!jobToken || jobToken.length < 32 || !resendKey || !from)
      return reply(503, { message: "Mail service is not configured" });
    const token =
      req.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    if (token.length > 512 || !(await sameSecret(token, jobToken)))
      return reply(401, { message: "Unauthorized" });
    try {
      const claimed = await server.rpc("material_mail_claim");
      if (claimed.error || !Array.isArray(claimed.data))
        return reply(503, { message: "Queue unavailable" });
      let sent = 0,
        failed = 0,
        uncertain = 0;
      for (const job of claimed.data) {
        let delivered = false,
          provider = null;
        try {
          const response = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            signal: AbortSignal.timeout(10000),
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": `material-${job.id}`,
            },
            body: JSON.stringify({
              from,
              to: [job.email],
              subject: `${job.payload.title} — Materiaalbeheer Nijlen`,
              text: mailText(job.payload, appOrigin),
            }),
          });
          if (response.ok) {
            const result = await response.json();
            delivered = typeof result.id === "string" && result.id.length > 0;
            provider = delivered ? result.id : null;
          }
        } catch {
          /* No secrets or personal data in logs. Provider key allows safe retry. */
        }
        const finished = await server.rpc("material_mail_finish", {
          job: job.id,
          job_lease: job.lease,
          delivered,
          provider,
        });
        if (finished.error || finished.data !== true) uncertain++;
        else if (delivered) sent++;
        else failed++;
      }
      return reply(uncertain || failed ? 503 : 200, {
        sent,
        failed,
        uncertain,
      });
    } catch {
      return reply(503, {
        message: "Mail processing interrupted; retry scheduled",
      });
    }
  };
}
