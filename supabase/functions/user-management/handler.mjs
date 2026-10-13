export function userManagementHandler({
  createClient,
  url,
  publishableKey,
  serviceKey,
  appOrigin,
}) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": appOrigin,
    "Access-Control-Allow-Headers":
      "authorization,apikey,content-type,x-client-info",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  return async (request) => {
    if (request.headers.get("Origin") !== appOrigin)
      return reply({ message: "Deze website is niet toegestaan." }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "POST")
      return reply({ message: "Alleen POST is toegestaan." }, 405);
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer "))
      return reply({ message: "Meld eerst aan." }, 401);
    try {
      const userClient = createClient(url, publishableKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // getUser verifies the JWT with Auth; user_metadata is never used for permissions.
      const { data, error } = await userClient.auth.getUser(
        authorization.slice(7),
      );
      if (error || !data.user)
        return reply({ message: "Sessie ongeldig. Meld opnieuw aan." }, 401);
      const claims = JSON.parse(
        atob(
          authorization
            .slice(7)
            .split(".")[1]
            .replaceAll("-", "+")
            .replaceAll("_", "/"),
        ),
      );
      if (claims.sub !== data.user.id || !claims.session_id)
        return reply({ message: "Sessie ongeldig." }, 401);
      if (Number(request.headers.get("Content-Length") || 0) > 2048)
        return reply({ message: "Verzoek te groot." }, 413);
      const raw = await request.text();
      if (raw.length > 2048)
        return reply({ message: "Verzoek te groot." }, 413);
      const body = JSON.parse(raw);
      if (
        !["list", "block", "reactivate", "invite", "set_role"].includes(
          body.action,
        )
      )
        return reply({ message: "Onbekende beheeractie." }, 400);
      if (body.action !== "invite") {
        if (body.action === "set_role" && body.confirmed !== true)
          return reply(
            { message: "Bevestig eerst de wijziging van de gebruikersrol." },
            400,
          );
        const result =
          body.action === "set_role"
            ? await userClient.rpc("material_set_member_role", {
                target: body.target || null,
                new_role: body.role,
                expected_role: body.expected_role,
              })
            : await userClient.rpc("material_manage_users", {
                action: body.action,
                target: body.target || null,
              });
        if (result.error)
          return reply(
            {
              message:
                result.error.code === "42501"
                  ? "Geen toegang tot gebruikersbeheer."
                  : result.error.message,
            },
            result.error.code === "42501" ? 403 : 400,
          );
        return reply(result.data);
      }
      if (body.role && body.role !== "volunteer")
        return reply(
          {
            message:
              "Via dit scherm kunnen alleen vrijwilligers worden uitgenodigd.",
          },
          400,
        );
      const requestId = body.request_id;
      const reservation = await userClient.rpc("material_prepare_invite", {
        email_input: body.email,
        request: requestId,
      });
      if (reservation.error)
        return reply(
          {
            message:
              reservation.error.code === "42501"
                ? "Geen toegang tot gebruikersbeheer."
                : reservation.error.message,
          },
          reservation.error.code === "42501" ? 403 : 400,
        );
      if (reservation.data.already_sent)
        return reply({ saved: true, message: "Uitnodiging is al verzonden." });
      const inv = reservation.data;
      const server = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const redirect = new URL("/", appOrigin);
      redirect.searchParams.set("invitation", inv.id);
      let result;
      try {
        result =
          inv.delivery === "recovery"
            ? await server.auth.resetPasswordForEmail(inv.email, {
                redirectTo: redirect.href,
              })
            : await server.auth.admin.inviteUserByEmail(inv.email, {
                data: { material_invitation_id: inv.id },
                redirectTo: redirect.href,
              });
      } catch {
        result = { error: true };
      }
      const finish = await server.rpc("material_finish_invite", {
        invitation: inv.id,
        request: requestId,
        actor: data.user.id,
        actor_session: claims.session_id,
        new_user: result.error ? null : inv.user_id || result.data?.user?.id,
        delivered: !result.error,
      });
      if (result.error || finish.error)
        return reply(
          {
            message:
              "Verzending niet bevestigd. Wacht een minuut en kies opnieuw verzenden. Er wordt geen tweede account aangemaakt.",
          },
          503,
        );
      return reply({
        saved: true,
        message: "Uitnodiging verzonden. De link is één uur geldig.",
      });
    } catch {
      return reply(
        {
          message:
            "Gebruikersbeheer kon niet worden uitgevoerd. Controleer de verbinding en probeer opnieuw.",
        },
        400,
      );
    }
  };
}
