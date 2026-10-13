import { test } from "node:test";
import assert from "node:assert/strict";
import { userManagementHandler } from "../supabase/functions/user-management/handler.mjs";
const token =
  "e30." +
  btoa(JSON.stringify({ sub: "admin-id", session_id: "session-id" })) +
  ".signature";
function fixture({
  valid = true,
  role = "admin",
  delivery = "invite",
  sendFail = false,
  finishFail = false,
  already = false,
} = {}) {
  const calls = [];
  const createClient = (url, key, options) => {
    const server = key === "server-secret";
    return {
      auth: {
        getUser: async () => ({
          data: {
            user: valid
              ? { id: "admin-id", user_metadata: { role: "admin" } }
              : null,
          },
          error: valid ? null : true,
        }),
        admin: {
          inviteUserByEmail: async (email, opts) => {
            calls.push({ type: "invite", email, opts });
            return sendFail
              ? { error: true }
              : { data: { user: { id: "new-id" } } };
          },
        },
        resetPasswordForEmail: async (email, opts) => {
          calls.push({ type: "recovery", email, opts });
          return { data: {} };
        },
      },
      rpc: async (name, args) => {
        calls.push({ name, args, server, key });
        if (!server && role !== "admin")
          return { error: { code: "42501", message: "denied" } };
        if (name === "material_prepare_invite")
          return {
            data: already
              ? { already_sent: true }
              : {
                  id: "inv-id",
                  email: "new@example.invalid",
                  user_id: delivery === "recovery" ? "new-id" : null,
                  delivery,
                },
          };
        if (name === "material_finish_invite")
          return finishFail ? { error: true } : { data: { saved: true } };
        return {
          data:
            args.action === "list"
              ? [{ email: "volunteer@example.invalid" }]
              : { saved: true },
        };
      },
    };
  };
  const handler = userManagementHandler({
    createClient,
    url: "https://db.example.invalid",
    publishableKey: "public-key",
    serviceKey: "server-secret",
    appOrigin: "https://app.example.invalid",
  });
  const request = (body, headers = {}) =>
    handler(
      new Request("https://db.example.invalid/functions/v1/user-management", {
        method: "POST",
        headers: {
          Origin: "https://app.example.invalid",
          Authorization: "Bearer " + token,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  return { calls, request, handler };
}
test("handler rejects invalid JWT, anonymous and volunteer before sending or exposing account information", async () => {
  for (const settings of [{ valid: false }, { role: "volunteer" }]) {
    const h = fixture(settings);
    const r = await h.request({
      action: "invite",
      email: "new@example.invalid",
      request_id: "req",
    });
    assert.ok([401, 403].includes(r.status));
    assert.ok(!h.calls.some((x) => x.type === "invite" || x.server));
  }
  const h = fixture();
  assert.equal(
    (await h.request({ action: "list" }, { Authorization: "" })).status,
    401,
  );
  assert.equal(
    (await h.request({ action: "list" }, { Origin: "https://evil.invalid" }))
      .status,
    403,
  );
});
test("server-key stays server-side; invite reservation is authorized by user JWT and completion binds actor/session", async () => {
  const h = fixture(),
    r = await h.request({
      action: "invite",
      email: "new@example.invalid",
      request_id: "req",
    });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(await r.json()).includes("server-secret"));
  const prepare = h.calls.find((x) => x.name === "material_prepare_invite"),
    finish = h.calls.find((x) => x.name === "material_finish_invite");
  assert.equal(prepare.server, false);
  assert.equal(finish.server, true);
  assert.equal(finish.args.actor, "admin-id");
  assert.equal(finish.args.actor_session, "session-id");
  assert.equal(finish.args.new_user, "new-id");
  assert.equal(
    h.calls.find((x) => x.type === "invite").opts.redirectTo,
    "https://app.example.invalid/?invitation=inv-id",
  );
});
test("request replay does not resend, admin invite is rejected, and confirmed pending invite uses recovery safely", async () => {
  const h = fixture({ already: true });
  assert.equal(
    (
      await h.request({
        action: "invite",
        email: "new@example.invalid",
        request_id: "req",
      })
    ).status,
    200,
  );
  assert.ok(!h.calls.some((x) => x.server || x.type));
  assert.equal(
    (
      await fixture().request({
        action: "invite",
        role: "admin",
        email: "new@example.invalid",
      })
    ).status,
    400,
  );
  const recovery = fixture({ delivery: "recovery" });
  assert.equal(
    (
      await recovery.request({
        action: "invite",
        email: "new@example.invalid",
        request_id: "req",
      })
    ).status,
    200,
  );
  assert.ok(recovery.calls.some((x) => x.type === "recovery"));
  assert.ok(!recovery.calls.some((x) => x.type === "invite"));
});
test("delivery or completion failures are explicit and never leak service credentials or claim success", async () => {
  for (const settings of [{ sendFail: true }, { finishFail: true }]) {
    const h = fixture(settings);
    const r = await h.request({
      action: "invite",
      email: "new@example.invalid",
      request_id: "req",
    });
    assert.equal(r.status, 503);
    const b = await r.json();
    assert.ok(!b.saved);
    assert.ok(!JSON.stringify(b).includes("server-secret"));
  }
});
