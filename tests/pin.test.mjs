import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePassword,
  validPin,
} from "../supabase/functions/pin-auth/password.mjs";
import { pinAuthHandler } from "../supabase/functions/pin-auth/handler.mjs";
import { publicPinRequest, validPin as browserPin } from "../src/pin-client.js";
const actor = "11111111-1111-4111-8111-111111111111",
  sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token =
  "e30." +
  Buffer.from(
    JSON.stringify({
      sub: actor,
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url") +
  ".eA";
const pepper = "a".repeat(64);
function fixture({
  verified = true,
  allowed = true,
  known = true,
  blocked = false,
  prepareFail = false,
  updateFail = false,
  finishFail = false,
  authFail = false,
  throwUpdate = false,
  alreadySaved = false,
  samePassword = false,
} = {}) {
  const calls = [];
  const session = {
    access_token: token,
    refresh_token: "fictitious-refresh",
    user: { id: actor, email: "member@example.invalid" },
    expires_in: 3600,
  };
  const createClient = (url, key) => ({
    auth: {
      getUser: async () => ({
        data: { user: verified ? session.user : null },
        error: verified ? null : true,
      }),
      admin: {
        updateUserById: async (id, body) => {
          calls.push({ type: "update", id, body });
          if (throwUpdate) throw Error("service-secret");
          return updateFail
            ? { error: { status: 400 } }
            : { data: { user: session.user } };
        },
      },
      signInWithPassword: async (body) => {
        calls.push({ type: "nativeLogin", body });
        return authFail || (updateFail && !samePassword)
          ? { error: true }
          : { data: { user: session.user, session } };
      },
      resetPasswordForEmail: async (email, options) => {
        calls.push({ type: "mail", email, options });
        return { data: {} };
      },
    },
    rpc: async (name, args) => {
      calls.push({ name, args, server: key === "service-secret" });
      if (name === "material_pin_prepare_enrol")
        return prepareFail
          ? { error: { code: "42501", message: "Geen toegang" } }
          : { data: { user_id: actor, pepper, already_saved: alreadySaved } };
      if (name === "material_pin_finish_enrol")
        return finishFail
          ? { error: true }
          : { data: { saved: args.succeeded } };
      if (name === "material_pin_prepare_login")
        return {
          data: { allowed, ...(known ? { user_id: actor, pepper } : {}) },
        };
      if (name === "material_pin_finish_login")
        return { data: { allowed: !blocked } };
      if (name === "material_pin_prepare_reset")
        return { data: { allowed: known && allowed } };
    },
  });
  const handler = pinAuthHandler({
    createClient,
    url: "https://db.example.invalid",
    publishableKey: "public",
    serviceKey: "service-secret",
    appOrigin: "https://app.example.invalid",
  });
  const request = (body, headers = {}) =>
    handler(
      new Request("https://db.example.invalid/functions/v1/pin-auth", {
        method: "POST",
        headers: { Origin: "https://app.example.invalid", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { calls, request, handler, session };
}
test("PINs are 4–8 ASCII digits, preserve leading zeroes and derive strong account-specific credentials", async () => {
  for (const p of ["0042", "12345678"]) {
    assert.equal(validPin(p), true);
    assert.equal(browserPin(p), true);
  }
  for (const p of [
    "123",
    "123456789",
    "12a4",
    " 1234",
    "１２３４",
    1234,
    null,
  ]) {
    assert.equal(validPin(p), false);
    assert.equal(browserPin(p), false);
  }
  const pwd = await derivePassword(actor, pepper, "0042");
  assert.equal(pwd.length, 72);
  assert.match(pwd, /^[A-Za-z0-9!]+$/);
  assert.equal(pwd.includes("0042"), false);
  assert.equal(pwd, await derivePassword(actor, pepper, "0042"));
  assert.notEqual(pwd, await derivePassword(actor, pepper, "1042"));
  assert.notEqual(pwd, await derivePassword("other", pepper, "0042"));
  assert.notEqual(pwd, await derivePassword(actor, "b".repeat(64), "0042"));
});
test("PIN login consumes the persistent server budget before native Auth; raw PIN and pepper are not returned", async () => {
  const h = fixture(),
    r = await h.request({
      action: "login",
      email: " Member@example.invalid ",
      pin: "0042",
    });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).session, h.session);
  assert.equal(h.calls[0].name, "material_pin_prepare_login");
  assert.equal(h.calls[0].args.email_input, "member@example.invalid");
  const login = h.calls.find((x) => x.type === "nativeLogin");
  assert.notEqual(login.body.password, "0042");
  assert.equal(login.body.password.length, 72);
  assert.ok(h.calls.filter((x) => x.name).every((x) => x.server));
  assert.ok(!JSON.stringify(h.session).includes(pepper));
});
test("unknown, incorrect, blocked and throttled PIN logins cannot issue a session or touch accounts", async () => {
  for (const opts of [
    { known: false },
    { authFail: true },
    { blocked: true },
    { allowed: false },
  ]) {
    const h = fixture(opts),
      r = await h.request({
        action: "login",
        email: "member@example.invalid",
        pin: "0042",
      });
    assert.ok([401, 429].includes(r.status));
    const body = await r.json();
    assert.equal(body.session, undefined);
    assert.ok(!h.calls.some((x) => x.type === "update" || x.type === "mail"));
    if (opts.known === false || opts.allowed === false)
      assert.ok(!h.calls.some((x) => x.type === "nativeLogin"));
  }
});
test("enrolment verifies the JWT, targets only its owner and confirms with a fresh matching session", async () => {
  const h = fixture(),
    r = await h.request(
      {
        action: "enrol",
        pin: "0042",
        request_id: "request-id",
        actor: "attacker-target",
      },
      { Authorization: "Bearer " + token },
    );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.saved, true);
  assert.equal(body.session.access_token, token);
  const updated = h.calls.find((x) => x.type === "update");
  assert.equal(updated.id, actor);
  assert.equal(updated.body.password.length, 72);
  assert.notEqual(updated.body.password, "0042");
  const complete = h.calls.find((x) => x.name === "material_pin_finish_enrol");
  assert.equal(complete.args.actor, actor);
  assert.equal(complete.args.actor_session, sessionId);
  assert.equal(body.pepper, undefined);
  assert.equal(body.password, undefined);
  assert.ok(!JSON.stringify(h.calls.filter((x) => x.name)).includes("0042"));
});
test("invalid JWT/nonmember enrolment and uncertain native/SQL failures never claim a saved PIN", async () => {
  for (const opts of [
    { verified: false },
    { prepareFail: true },
    { updateFail: true },
    { finishFail: true },
    { throwUpdate: true },
    { authFail: true },
  ]) {
    const h = fixture(opts),
      r = await h.request(
        { action: "enrol", pin: "0042", request_id: "request-id" },
        { Authorization: "Bearer " + token },
      );
    assert.ok([401, 403, 503].includes(r.status));
    const body = await r.json();
    assert.equal(body.saved, undefined);
    assert.ok(!JSON.stringify(body).includes("service-secret"));
    if (opts.verified === false || opts.prepareFail)
      assert.ok(!h.calls.some((x) => x.type === "update"));
    if (opts.throwUpdate)
      assert.ok(!h.calls.some((x) => x.name === "material_pin_finish_enrol"));
  }
});
test("a confirmed enrolment replay verifies the PIN through Auth without replacing the password again", async () => {
  const h = fixture({ alreadySaved: true });
  const r = await h.request(
    { action: "enrol", pin: "0042", request_id: "request-id" },
    { Authorization: "Bearer " + token },
  );
  assert.equal(r.status, 200);
  assert.equal(
    h.calls.some((x) => x.type === "update"),
    false,
  );
  assert.ok(h.calls.some((x) => x.type === "nativeLogin"));
});
test("an uncertain previous update can finish when Auth confirms the exact same credential", async () => {
  const h = fixture({ updateFail: true, samePassword: true });
  const r = await h.request(
    { action: "enrol", pin: "0042", request_id: "request-id" },
    { Authorization: "Bearer " + token },
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).saved, true);
});
test("PIN reset gives the same response for unknown accounts and only sends after membership/budget approval", async () => {
  const known = fixture(),
    unknown = fixture({ known: false });
  const a = await known.request({
      action: "reset",
      email: "member@example.invalid",
    }),
    b = await unknown.request({
      action: "reset",
      email: "member@example.invalid",
    });
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(
    unknown.calls.some((x) => x.type === "mail"),
    false,
  );
  assert.equal(
    known.calls.find((x) => x.type === "mail").options.redirectTo,
    "https://app.example.invalid/?pin_reset=1",
  );
});
test("invalid PINs/origins are refused before private RPCs; anonymous transport never persists credentials", async () => {
  const h = fixture();
  assert.equal(
    (
      await h.request({
        action: "login",
        pin: "abc4",
        email: "member@example.invalid",
      })
    ).status,
    400,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(
    (
      await h.request(
        { action: "login", pin: "0042", email: "member@example.invalid" },
        { Origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  let sent;
  await publicPinRequest(
    "https://db.example.invalid",
    "public",
    { action: "login", email: "member@example.invalid", pin: "0042" },
    {
      fetchImpl: async (url, options) => {
        sent = { url, options };
        return { ok: true, json: async () => ({ session: {} }) };
      },
    },
  );
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.url.includes("0042"), false);
});
