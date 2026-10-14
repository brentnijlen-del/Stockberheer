import { test } from "node:test";
import assert from "node:assert/strict";
import {
  materialMailHandler,
  mailText,
} from "../supabase/functions/material-mail/handler.mjs";
const token = "x".repeat(40);
const job = {
  id: "test-job",
  lease: "lease",
  email: "admin@example.invalid",
  payload: {
    kind: "help",
    title: "Hulpvraag",
    email: "volunteer@example.invalid",
    message: "<script>test</script>",
  },
};
const request = (secret = token) =>
  new Request("https://example.invalid", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
test("missing mail configuration and invalid job credentials never claim jobs", async () => {
  let calls = 0;
  const server = {
    rpc: async () => {
      calls++;
    },
  };
  assert.equal((await materialMailHandler({ server })(request())).status, 503);
  assert.equal(
    (
      await materialMailHandler({
        server,
        jobToken: token,
        resendKey: "secret",
        from: "alerts@example.invalid",
      })(request("bad"))
    ).status,
    401,
  );
  assert.equal(calls, 0);
});
test("plain-text delivery uses stable provider idempotency and confirms only provider success", async () => {
  const calls = [],
    deliveries = [];
  const handler = materialMailHandler({
    server: {
      rpc: async (name, args) => {
        calls.push([name, args]);
        return name === "material_mail_claim"
          ? { data: [job] }
          : { data: true };
      },
    },
    jobToken: token,
    resendKey: "server-only",
    from: "alerts@example.invalid",
    appOrigin: "https://website.invalid",
    fetchImpl: async (url, init) => {
      deliveries.push(init);
      return Response.json({ id: "provider-success" });
    },
  });
  assert.equal((await handler(request())).status, 200);
  assert.equal(deliveries[0].headers["Idempotency-Key"], "material-test-job");
  const body = JSON.parse(deliveries[0].body);
  assert.equal(body.html, undefined);
  assert.match(body.text, /<script>test<\/script>/);
  assert.deepEqual(calls[1][1], {
    job: job.id,
    job_lease: job.lease,
    delivered: true,
    provider: "provider-success",
  });
});
test("provider/network failures and lost database confirmation remain retryable without success claims", async () => {
  for (const mode of ["provider", "network", "database"]) {
    let completion;
    const handler = materialMailHandler({
      jobToken: token,
      resendKey: "server-only",
      from: "alerts@example.invalid",
      appOrigin: "https://website.invalid",
      server: {
        rpc: async (name, args) => {
          if (name === "material_mail_claim") return { data: [job] };
          completion = args;
          return mode === "database" ? { error: "offline" } : { data: true };
        },
      },
      fetchImpl: async () => {
        if (mode === "network") throw Error("offline");
        return mode === "provider"
          ? new Response("no", { status: 429 })
          : Response.json({ id: "delivered" });
      },
    });
    assert.equal((await handler(request())).status, 503);
    assert.equal(completion.delivered, mode === "database");
  }
  assert.match(
    mailText(
      { kind: "empty", title: "Leeg", product: "Verband", location: "Tas" },
      "https://website.invalid",
    ),
    /geen niet-vervallen voorraad/,
  );
});
