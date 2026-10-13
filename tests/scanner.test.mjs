import { test } from "node:test";
import assert from "node:assert/strict";
import { hardwareListener, CameraScanner } from "../src/scanner.js";
const target = {
  tagName: "INPUT",
  closest: () => false,
  matches: (s) => s === "input,select" || s === "[data-scan]",
};
const key = (key, target) => ({
  key,
  target,
  preventDefault() {
    this.prevented = true;
  },
});
test("USB scan accepts fast Enter but excludes password fields and stale manual typing", () => {
  let now = 0,
    found = [];
  const listener = hardwareListener({
    active: () => true,
    clock: () => now,
    onCode: (x) => found.push(x),
  });
  for (const c of "PROD-1") {
    now += 5;
    listener(key(c, target));
  }
  const enter = key("Enter", target);
  listener(enter);
  assert.deepEqual(found, ["PROD-1"]);
  assert.equal(enter.prevented, true);
  for (const c of "abc") {
    now += 5;
    listener(key(c, target));
  }
  now += 1000;
  const stale = key("Enter", target);
  listener(stale);
  assert.equal(stale.prevented, undefined);
  const password = { ...target, closest: () => true };
  for (const c of "password") {
    listener(key(c, password));
  }
  const e = key("Enter", password);
  listener(e);
  assert.equal(e.prevented, undefined);
});
test("scanner inactive during login prevents interception", () => {
  const listener = hardwareListener({
    active: () => false,
    onCode: () => assert.fail(),
  });
  for (const c of "ABC") listener(key(c, target));
  const e = key("Enter", target);
  listener(e);
  assert.equal(e.prevented, undefined);
});
test("camera retries rear-camera selection and always releases tracks through library stop", async () => {
  let starts = 0,
    stops = 0,
    clears = 0;
  const scanner = new CameraScanner({
    factory: () => ({
      start: async () => {
        if (++starts === 1) throw new Error("no exact");
      },
      stop: async () => stops++,
      clear: async () => clears++,
    }),
    media: { getUserMedia() {} },
    secure: true,
  });
  await scanner.start("reader", () => {});
  assert.equal(starts, 2);
  await scanner.stop();
  assert.equal(stops, 1);
  assert.equal(clears, 1);
});
test("leaving during camera startup waits then releases the old scanner", async () => {
  let release,
    stops = 0;
  const gate = new Promise((r) => (release = r));
  const scanner = new CameraScanner({
    factory: () => ({
      start: () => gate,
      stop: async () => stops++,
      clear: async () => {},
    }),
    media: { getUserMedia() {} },
    secure: true,
  });
  const p = scanner.start("reader", () => assert.fail());
  await new Promise((r) => setImmediate(r));
  const stop = scanner.stop();
  release();
  await Promise.all([p, stop]);
  assert.ok(stops >= 1);
  assert.equal(scanner.instance, null);
});
test("insecure or unavailable cameras fail explicitly", async () => {
  const scanner = new CameraScanner({
    factory: () => assert.fail(),
    media: null,
    secure: false,
  });
  await assert.rejects(
    scanner.start("reader", () => {}),
    /HTTPS/,
  );
});
test("closing an unanswered camera permission prompt does not block navigation", async () => {
  let finish,
    stops = 0;
  const gate = new Promise((r) => (finish = r));
  const scanner = new CameraScanner({
    factory: () => ({
      start: () => gate,
      stop: async () => stops++,
      clear: async () => {},
    }),
    media: { getUserMedia() {} },
    secure: true,
  });
  const starting = scanner.start("reader", () => assert.fail());
  await new Promise((r) => setImmediate(r));
  await scanner.stop();
  assert.equal(scanner.instance, null);
  assert.equal(stops, 0);
  finish();
  await starting;
  assert.equal(stops, 1);
});
