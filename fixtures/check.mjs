// node fixtures/check.mjs — checks the example files of docs/protocol.md and the status rules.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { petMood, cardSession, resolveId, inboxMessage, isLive } from "../overlay/src/state.js";

const dir = new URL(".", import.meta.url);
const load = (n) => JSON.parse(readFileSync(new URL(n, dir), "utf8"));
const STATUS = ["ready", "running", "needs-input", "blocked", "ended"];

function session(s) {
  assert.equal(s.v, 1);
  for (const k of ["sessionId", "cwd", "project"]) assert.equal(typeof s[k], "string", k);
  assert.ok(STATUS.includes(s.status), s.status);
  for (const k of ["startedAt", "updatedAt"]) assert.equal(typeof s[k], "number", k);
  assert.ok(s.step === null || typeof s.step === "string");
}
const sessions = ["session-running.json", "session-waiting.json", "session-cleared.json"].map(load);
sessions.forEach(session);

const inbox = load("inbox.json");
assert.deepEqual(inboxMessage(inbox.text, inbox.newChat, inbox.id, inbox.createdAt), inbox);
assert.throws(() => inboxMessage("   ", false, "x", 1));
assert.throws(() => inboxMessage("я".repeat(8001), false, "x", 1));

const ack = load("ack.json");
assert.equal(ack.v, 1);
assert.equal(ack.id, inbox.id);
assert.ok(["queued", "started", "failed"].includes(ack.status));
assert.equal(typeof load("overlay.json").pid, "number");

const now = 100_000;
// priority: waiting beats working
assert.equal(petMood(sessions, now), "waiting");
assert.equal(petMood([sessions[0]], now), "working");
// a fresh finish beats working, a stale one is just idle
const done = { ...sessions[0], status: "ready", doneAt: now - 1000 };
assert.equal(petMood([done, { ...sessions[1], status: "running" }], now), "done");
assert.equal(petMood([{ ...done, doneAt: now - 10 * 60_000 }], now), "idle");
assert.equal(petMood([{ ...sessions[0], status: "blocked" }, done], now), "failed");
// no pulse for 45 s -> not live
assert.equal(isLive(sessions[0], now + 46_000), false);
// /clear chain: the card follows the old id to the new one
const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
assert.equal(resolveId("c3", byId), "a1");
assert.equal(cardSession(sessions, "c3", now).sessionId, "a1");
assert.equal(cardSession(sessions, null, now).sessionId, "a1");

console.log("fixtures ok: 6 files, status rules ok");
