// node fixtures/check.mjs — checks the example files of docs/protocol.md and the status rules.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { petMood, cardSession, resolveId, inboxMessage, isLive, taskView, stopMessage, matchNewChat, folderOf } from "../overlay/src/state.js";

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

// cards: one request followed from "sent" to "done", through /clear, and a stop
const run = { ...sessions[0], sessionId: "s1", status: "running", step: "Чтение plan.md", updatedAt: now };
const task = { sid: "s1", id: "m1", text: "x", at: now - 2000, started: false, stopId: null };
const view = (t, ss, a, at = now) => taskView(t, Object.fromEntries(ss.map((x) => [x.sessionId, x])), a, at);
assert.equal(view(task, [run], {}).text, "Запускаю…");
assert.equal(view(task, [run], {}, now + 9000).mood, "idle"); // nobody picked it up
assert.equal(view(task, [run], { s1: { id: "m1", status: "queued" } }).text, "В очереди — Claude закончит текущий ход");
assert.deepEqual(view(task, [run], { s1: { id: "m1", status: "started" } }), { mood: "working", text: "Чтение plan.md", sid: "s1", canStop: true });
const fin = { ...run, status: "ready", step: null, doneAt: now - 500 };
assert.equal(view({ ...task, started: true }, [fin], {}).mood, "done");
assert.equal(view({ ...task, started: true }, [{ ...fin, doneAt: now - 5000 }], {}).text, "Свободна"); // an older finish is not ours
const moved = [{ ...run, sessionId: "s0", status: "ended", continuedAs: "s1" }, fin];
assert.equal(view({ ...task, sid: "s0", started: true }, moved, {}).sid, "s1");
const stopped = { ...run, status: "ready", step: null, stoppedAt: now - 100 };
assert.equal(view({ ...task, started: true, stopId: "k1" }, [stopped], { s1: { id: "k1", status: "stopped" } }).text, "Остановлено");
assert.equal(view({ ...task, started: true, stopId: "k1" }, [run], { s1: { id: "k1", status: "failed", error: "e" } }).mood, "failed");
assert.deepEqual(stopMessage("k1", 5), { v: 1, id: "k1", stop: true, createdAt: 5 });

// a new background chat: working until its session shows up, by the printed short id or by its text
const ask = { sid: null, fresh: true, id: "n1", text: "Найди свежие\nновости про лошадей и собери итоги", at: now - 3000, short: null };
assert.equal(view(ask, [], {}).text, "Запускаем вашу задачу");
assert.equal(view({ ...ask, error: "Workspace not trusted" }, [], {}).mood, "failed");
assert.equal(view(ask, [], {}, now + 130_000).mood, "idle");
assert.equal(view(ask, [], {}).canStop, false);
const born = { ...run, sessionId: "n9", startedAt: now - 1000, title: "", lastPrompt: "Найди свежие новости про лошадей и собери итоги" };
const old = { ...born, sessionId: "o1", startedAt: now - 60_000 };
assert.equal(matchNewChat(ask, [old, born])?.sessionId, "n9");
assert.equal(matchNewChat(ask, [{ ...born, lastPrompt: "другое" }]), null);
assert.equal(matchNewChat({ ...ask, short: "3f35592d" }, [born, { ...old, sessionId: "3f35592d-aaaa" }])?.sessionId, "3f35592d-aaaa");
assert.equal(folderOf("/Users/n/p/.claude/worktrees/x/sub"), "/Users/n/p");
assert.equal(folderOf("/Users/n/p"), "/Users/n/p");

console.log("fixtures ok: 6 files, status, card and new-chat rules ok");
