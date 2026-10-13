// Disposable local API adapter: real PostgreSQL RPCs + simulated Auth HTTP responses.
// This does not replace tests against a separate real Supabase project before production cutover.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setup, command, snapshot, fixture, pool, IDS } from "../db-helper.mjs";
import {
  accessToken,
  claims,
  authUser,
  runUser,
  handler as usersHandler,
  confirmation,
} from "./users-adapter.mjs";
let f;
async function reset() {
  await setup();
  f = await fixture();
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 4,
    batch: "A",
    expiry: "2090-01-01",
  });
  await command("admin", "receive", {
    product_id: f.product,
    location_id: f.location,
    quantity: 6,
    batch: "B",
    expiry: "2091-01-01",
  });
  return f;
}
await reset();
function token(role) {
  return {
    access_token: accessToken(
      IDS[role],
      IDS["session" + role[0].toUpperCase() + role.slice(1)],
    ),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-" + role,
    user: {
      id: IDS[role],
      aud: "authenticated",
      role: "authenticated",
      email: role + "@example.invalid",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8000");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "apikey,authorization,content-type,x-client-info,x-supabase-api-version",
  );
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,PUT,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (x, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(x));
  };
  try {
    if (req.url === "/_test/reset") {
      send(await reset());
      return;
    }
    if (req.url === "/functions/v1/user-management") {
      const r = await usersHandler(
        new Request("http://127.0.0.1:8040" + req.url, {
          method: req.method,
          headers: req.headers,
          body,
        }),
      );
      send(await r.json(), r.status);
      return;
    }
    if (req.url === "/_test/invitation") {
      send(await confirmation(JSON.parse(body).email));
      return;
    }
    if (req.url === "/auth/v1/user") {
      const u = await authUser(claims(req.headers.authorization).sub);
      if (!u) {
        send({ message: "Invalid token" }, 401);
        return;
      }
      send(req.method === "PUT" ? { user: u } : u);
      return;
    }
    if (req.url === "/rest/v1/rpc/material_invite_status") {
      send(
        (
          await runUser(
            req.headers.authorization,
            "select public.material_invite_status($1) as result",
            [JSON.parse(body).invitation],
          )
        )[0].result,
      );
      return;
    }
    if (req.url === "/rest/v1/rpc/material_accept_invite") {
      send(
        (
          await runUser(
            req.headers.authorization,
            "select public.material_accept_invite($1) as result",
            [JSON.parse(body).invitation],
          )
        )[0].result,
      );
      return;
    }
    if (req.url.startsWith("/auth/v1/token")) {
      const b = JSON.parse(body);
      const role = b.email?.split("@")[0] || b.refresh_token?.slice(8);
      if (!IDS[role] || b.password === "wrong") {
        send(
          { error: "invalid_grant", error_description: "Ongeldig account" },
          400,
        );
        return;
      }
      send(token(role));
      return;
    }
    if (req.url.startsWith("/auth/v1/logout")) {
      send({});
      return;
    }
    const role =
      req.headers.authorization?.replace("Bearer token-", "") || "anon";
    if (req.url === "/rest/v1/rpc/material_snapshot") {
      send(
        (
          await runUser(
            req.headers.authorization,
            "select public.material_snapshot() as result",
          )
        )[0].result,
      );
      return;
    }
    if (req.url === "/rest/v1/rpc/material_command") {
      const b = JSON.parse(body);
      send(
        (
          await runUser(
            req.headers.authorization,
            "select public.material_command($1::jsonb,$2::uuid) as result",
            [JSON.stringify(b.command), b.request_id],
          )
        )[0].result,
      );
      return;
    }
    send({ message: "Not found" }, 404);
  } catch (e) {
    send(
      { message: e.message, code: e.code || "error" },
      e.code === "42501" ? 403 : 400,
    );
  }
});
server.listen(8040, "127.0.0.1");
const staticServer = createServer(async (req, res) => {
  try {
    const file = resolve(
      "dist",
      new URL(req.url, "http://127.0.0.1").pathname === "/"
        ? "index.html"
        : new URL(req.url, "http://127.0.0.1").pathname.slice(1),
    );
    if (!file.startsWith(resolve("dist") + "/")) throw new Error();
    const data = await readFile(file);
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    const headers = await readFile("dist/_headers", "utf8");
    for (const line of headers.split("\n").slice(1)) {
      const m = line.match(/^  ([^:]+): (.*)$/);
      if (m) res.setHeader(m[1], m[2]);
    }
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
staticServer.listen(8000, "127.0.0.1");
const close = () => {
  server.close();
  staticServer.close();
  pool.end().then(() => process.exit());
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
