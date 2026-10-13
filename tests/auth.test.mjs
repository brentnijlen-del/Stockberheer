import { test } from "node:test";
import assert from "node:assert/strict";
import { MaterialService } from "../src/service.js";
const auth = (id = "admin") => ({
  getSession: async () => ({
    data: { session: { user: { id }, access_token: `token-${id}` } },
  }),
});
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const setup = (fetchImpl, options = {}) => {
  const s = new MaterialService(auth(), { fetchImpl, ...options });
  s.url = "https://example.invalid";
  s.key = "public";
  s.activate("admin");
  return s;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("unauthenticated calls send no private requests", async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
  });
  s.invalidate();
  await assert.rejects(s.snapshot());
  assert.equal(calls, 0);
});
test("requests use session token and operation payload, never full state or PIN", async () => {
  let req;
  const s = setup(async (url, opts) => {
    req = opts;
    return response({ saved: true, revision: 1 });
  });
  await s.command("consume", { quantity: 1 });
  assert.equal(req.headers.Authorization, "Bearer token-admin");
  const b = JSON.parse(req.body);
  assert.equal(b.command.type, "consume");
  assert.equal("new_data" in b, false);
  assert.equal("pin" in b, false);
});
test("old response cannot update a new identity; sign-out aborts in-flight requests", async () => {
  const gate = deferred();
  let signal;
  const s = setup(async (url, opts) => {
    signal = opts.signal;
    await gate.promise;
    return response({ saved: true });
  });
  const p = s.command("consume", { quantity: 1 });
  await new Promise((r) => setImmediate(r));
  s.activate("volunteer");
  gate.resolve();
  await assert.rejects(p, /Sessie gewijzigd/);
  assert.equal(signal.aborted, true);
  assert.equal(s.pending, null);
});
test("account change while refreshing prevents a request with another identity", async () => {
  const gate = deferred();
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return response({ saved: true });
  });
  s.auth = { getSession: () => gate.promise };
  const p = s.command("consume", { quantity: 1 });
  s.activate("volunteer");
  gate.resolve({
    data: { session: { user: { id: "volunteer" }, access_token: "new" } },
  });
  await assert.rejects(p, /Sessie gewijzigd/);
  assert.equal(calls, 0);
});
test("only one command executes; network retries reuse the same idempotency key", async () => {
  let first = true,
    requests = [];
  const s = setup(async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    if (first) {
      first = false;
      throw new TypeError("offline");
    }
    return response({ saved: true });
  });
  await assert.rejects(s.command("consume", { quantity: 1 }));
  await assert.rejects(s.command("consume", { quantity: 2 }), /vorige/);
  await s.command(null, null, { retry: true });
  assert.equal(requests[0].request_id, requests[1].request_id);
  assert.equal(s.pending, null);
});
test("explicit server rejection clears pending but keeps session for validation corrections", async () => {
  const s = setup(async () =>
    response({ message: "Ongeldig aantal", code: "22023" }, 400),
  );
  await assert.rejects(s.command("consume", { quantity: -1 }));
  assert.equal(s.pending, null);
  assert.equal(s.user, "admin");
});
test("RPC false is never treated as confirmed storage", async () => {
  const statuses = [];
  const s = setup(async () => response(false), {
    onStatus: (x) => statuses.push(x),
  });
  await assert.rejects(s.command("consume", { quantity: 1 }));
  assert.ok(!statuses.includes("saved"));
});
test("request timeout cancels network and preserves retryable payload", async () => {
  const s = setup(
    (url, opts) =>
      new Promise((resolve, reject) =>
        opts.signal.addEventListener("abort", () =>
          reject(new Error("timeout")),
        ),
      ),
    { timeout: 5 },
  );
  await assert.rejects(s.command("consume", { quantity: 1 }));
  assert.equal(s.pending.command.payload.quantity, 1);
});
test("new session never inherits pending operations", async () => {
  const s = setup(async () => {
    throw new Error("offline");
  });
  await assert.rejects(s.command("consume", { quantity: 1 }));
  s.activate("volunteer");
  assert.equal(s.pending, null);
  await assert.rejects(
    s.command(null, null, { retry: true }),
    /Geen handeling/,
  );
});
test("gateway errors preserve uncertain request so retry cannot double-apply a committed command", async () => {
  const s = setup(async () =>
    response({ message: "Gateway temporarily unavailable" }, 502),
  );
  await assert.rejects(s.command("consume", { quantity: 1 }));
  assert.ok(s.pending);
});
