import { validPin, derivePassword } from "./password.mjs";
function claims(token) {
  return JSON.parse(
    atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
  );
}
export function pinAuthHandler({
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
    try {
      if (Number(request.headers.get("Content-Length") || 0) > 2048)
        return reply({ message: "Verzoek te groot." }, 413);
      const raw = await request.text();
      if (raw.length > 2048)
        return reply({ message: "Verzoek te groot." }, 413);
      let b;
      try {
        b = JSON.parse(raw);
      } catch {
        return reply({ message: "Ongeldig verzoek." }, 400);
      }
      if (!b || typeof b !== "object" || Array.isArray(b))
        return reply({ message: "Ongeldig verzoek." }, 400);
      if (!["login", "enrol", "reset"].includes(b.action))
        return reply({ message: "Onbekende actie." }, 400);
      if (b.action !== "reset" && !validPin(b.pin))
        return reply(
          { message: "Gebruik een pincode van 4 tot en met 8 cijfers." },
          400,
        );
      const settings = {
        auth: { persistSession: false, autoRefreshToken: false },
      };
      const server = createClient(url, serviceKey, settings);
      const login = createClient(url, publishableKey, settings);
      if (b.action === "enrol") {
        const authorization = request.headers.get("Authorization");
        if (!authorization?.startsWith("Bearer "))
          return reply(
            { message: "Meld eerst aan of gebruik een geldige uitnodiging." },
            401,
          );
        const verified = await login.auth.getUser(authorization.slice(7));
        if (verified.error || !verified.data.user)
          return reply({ message: "Sessie ongeldig. Meld opnieuw aan." }, 401);
        const c = claims(authorization.slice(7));
        if (c.sub !== verified.data.user.id || !c.session_id)
          return reply({ message: "Sessie ongeldig." }, 401);
        const args = {
          actor: verified.data.user.id,
          actor_session: c.session_id,
          invitation: b.invitation || null,
          request: b.request_id,
        };
        const prepared = await server.rpc("material_pin_prepare_enrol", args);
        if (prepared.error)
          return reply(
            { message: prepared.error.message },
            prepared.error.code === "42501" ? 403 : 400,
          );
        if (prepared.data.user_id !== verified.data.user.id)
          throw new Error("Binding mismatch");
        const password = await derivePassword(
          prepared.data.user_id,
          prepared.data.pepper,
          b.pin,
        );
        let result;
        try {
          result = prepared.data.already_saved
            ? { data: { user: verified.data.user } }
            : await server.auth.admin.updateUserById(verified.data.user.id, {
                password,
              });
        } catch {
          return reply(
            {
              message:
                "Pincode-opslag niet bevestigd. Blijf aangemeld en probeer dezelfde handeling opnieuw.",
            },
            503,
          );
        }
        // A password change may invalidate the old session. Bind completion
        // to a new Auth session for the same account before enabling PIN login.
        if (result.data?.user && result.data.user.id !== verified.data.user.id)
          throw new Error("Auth binding mismatch");
        const fresh = await login.auth.signInWithPassword({
          email: result.data?.user?.email || verified.data.user.email,
          password,
        });
        if (
          fresh.error ||
          !fresh.data.session ||
          fresh.data.user?.id !== verified.data.user.id
        ) {
          // If Auth reports an already-identical password, a successful login
          // above still proves this exact PIN. Never enable a failed candidate.
          if (result.error?.status >= 400 && result.error.status < 500)
            await server.rpc("material_pin_finish_enrol", {
              ...args,
              succeeded: false,
            });
          throw new Error("New session unavailable");
        }
        const freshClaims = claims(fresh.data.session.access_token);
        if (
          freshClaims.sub !== verified.data.user.id ||
          !freshClaims.session_id
        )
          throw new Error("New session mismatch");
        const finished = await server.rpc("material_pin_finish_enrol", {
          ...args,
          actor_session: freshClaims.session_id,
          succeeded: true,
        });
        if (finished.error || finished.data?.saved !== true)
          return reply(
            {
              message:
                "Pincode-opslag niet bevestigd. Blijf aangemeld en probeer opnieuw.",
            },
            503,
          );
        return reply({ saved: true, session: fresh.data.session });
      }
      const email =
        typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return reply({ message: "Geef een geldig e-mailadres in." }, 400);
      if (b.action === "reset") {
        const r = await server.rpc("material_pin_prepare_reset", {
          email_input: email,
        });
        if (r.error) throw new Error("Reset unavailable");
        if (r.data.allowed) {
          const redirect = new URL("/", appOrigin);
          redirect.searchParams.set("pin_reset", "1");
          await login.auth.resetPasswordForEmail(email, {
            redirectTo: redirect.href,
          });
        }
        return reply({
          message:
            "Als dit adres toegang heeft, ontvang je een herstelmail. Controleer ook je spammap.",
        });
      }
      const prepared = await server.rpc("material_pin_prepare_login", {
        email_input: email,
      });
      if (prepared.error) throw new Error("Login unavailable");
      if (!prepared.data.allowed)
        return reply(
          {
            message:
              "Te veel aanmeldpogingen. Probeer over 15 minuten opnieuw of herstel via e-mail.",
          },
          429,
        );
      const denied = () =>
        reply(
          { message: "E-mailadres of pincode onjuist, of geen toegang." },
          401,
        );
      if (!prepared.data.user_id) return denied();
      const password = await derivePassword(
        prepared.data.user_id,
        prepared.data.pepper,
        b.pin,
      );
      const result = await login.auth.signInWithPassword({ email, password });
      if (
        result.error ||
        !result.data.session ||
        result.data.user?.id !== prepared.data.user_id
      )
        return denied();
      const c = claims(result.data.session.access_token);
      if (c.sub !== prepared.data.user_id || !c.session_id) return denied();
      const finished = await server.rpc("material_pin_finish_login", {
        actor: prepared.data.user_id,
        actor_session: c.session_id,
      });
      if (finished.error) throw new Error("Login confirmation unavailable");
      if (!finished.data.allowed) return denied();
      return reply({ session: result.data.session });
    } catch {
      return reply(
        {
          message:
            "Pincode-aanvraag niet bevestigd. Controleer de verbinding en probeer opnieuw.",
        },
        503,
      );
    }
  };
}
