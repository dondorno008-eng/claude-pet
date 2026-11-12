// Pure logic over the files of docs/protocol.md. Shared by the window and fixtures/check.mjs.

export const LIVE_MS = 45_000;
export const DONE_MS = 5 * 60_000;
export const MAX_TEXT = 8000;

export function isLive(s, now) {
  if (!s || s.status === "ended") return false;
  return now - Math.max(s.updatedAt || 0, s.pulseAt || 0) <= LIVE_MS;
}

// mood of one session: waiting | failed | done | working | idle
export function moodOf(s, now) {
  if (s.status === "needs-input") return "waiting";
  if (s.status === "blocked") return "failed";
  if (s.status === "running") return "working";
  if (s.status === "ready" && s.doneAt && now - s.doneAt <= DONE_MS) return "done";
  return "idle";
}

const RANK = { waiting: 4, failed: 3, done: 2, working: 1, idle: 0 };

// the pet's mood over every live session (priority waiting > failed > done > working)
export function petMood(sessions, now) {
  let best = "idle";
  for (const s of sessions) {
    if (!isLive(s, now)) continue;
    const m = moodOf(s, now);
    if (RANK[m] > RANK[best]) best = m;
  }
  return best;
}

// follow /clear: old id -> continuedAs -> … -> the id that is current now
export function resolveId(id, byId) {
  const seen = new Set();
  let cur = id;
  while (cur && byId[cur] && byId[cur].continuedAs && !seen.has(cur)) {
    seen.add(cur);
    cur = byId[cur].continuedAs;
  }
  return cur;
}

// live sessions, freshest first, for the picker
export function liveSessions(sessions, now) {
  return sessions
    .filter((s) => isLive(s, now))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// the session the card is about: the one the person wrote to last, else the freshest live one
export function cardSession(sessions, lastSentId, now) {
  const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
  const id = lastSentId ? resolveId(lastSentId, byId) : null;
  if (id && byId[id] && isLive(byId[id], now)) return byId[id];
  return liveSessions(sessions, now)[0] || null;
}

export function labelOf(s) {
  const title = s.title ? ` — ${s.title}` : "";
  return `${s.project || "сессия"}${title}`;
}

export const MOOD_TEXT = {
  waiting: "Ждёт вашего ответа",
  failed: "Ошибка",
  done: "Готово",
  working: "Работает",
  idle: "",
};

// one inbox message; throws on bad input
export function inboxMessage(text, newChat, id, now) {
  const t = String(text || "").trim();
  if (!t) throw new Error("пустой промпт");
  if (t.length > MAX_TEXT) throw new Error(`длиннее ${MAX_TEXT} символов`);
  return { v: 1, id, text: t, newChat: !!newChat, createdAt: now };
}

export const MAX_CARDS = 3;
export const PICKUP_MS = 8000;

// a stop for the session's running turn (the mod answers with ack status "stopped")
// a request from the bar starts a NEW chat in the background (`claude --bg`); the card waits for it
export const NEW_CHAT_MS = 120_000;
const words = (t) => String(t || "").split(/\s+/).filter(Boolean).join(" ");

// the session that this new-chat request became: the id `claude --bg` printed, else the one
// that started after it with our text as its first prompt
export function matchNewChat(task, sessions) {
  if (task.short) {
    const s = sessions.find((x) => String(x.sessionId || "").startsWith(task.short));
    if (s) return s;
  }
  const want = words(task.text).slice(0, 40);
  if (!want) return null;
  const hit = sessions
    .filter((s) => (s.startedAt || 0) >= task.at - 2000 && !s.continuedFrom)
    .filter((s) => [s.title, s.lastPrompt].some((t) => { const w = words(t); return w && (w.startsWith(want) || want.startsWith(w)); }))
    .sort((a, b) => a.startedAt - b.startedAt);
  return hit[0] || null;
}

// the project folder of a session: the repo, not the worktree or a subfolder of it
export function folderOf(cwd) {
  if (!cwd) return null;
  return cwd.replace(/\/\.claude\/worktrees\/.*$/, "");
}

export function stopMessage(id, now) {
  return { v: 1, id, stop: true, createdAt: now };
}

// one card under the horse: a request the person sent, followed through /clear.
// task = { sid, id, text, at, started, stopId }; returns { mood, text, sid, canStop }
//   mood: working | waiting | failed | done | idle (a stopped or closed chat)
export function taskView(task, byId, acks, now) {
  if (task.fresh && !task.sid) {
    const v = (mood, text) => ({ mood, text, sid: null, canStop: false });
    if (task.error) return v("failed", `Не запустилось: ${task.error}`);
    if (now - task.at > NEW_CHAT_MS) return v("idle", "Новый чат не запустился");
    return v("working", "Запускаем вашу задачу");
  }
  const sid = resolveId(task.sid, byId);
  const s = byId[sid];
  const ack = acks[sid];
  const v = (mood, text) => ({ mood, text, sid, canStop: mood === "working" || mood === "waiting" });
  if (task.stopId && ack && ack.id === task.stopId) {
    if (ack.status === "failed") return v("failed", `Не остановилось: ${ack.error || "ошибка"}`);
    if (!s || s.status !== "running") return v("idle", "Остановлено");
  }
  const seen = task.started || (ack && ack.id === task.id);
  if (!seen) {
    if (task.id && now - task.at > PICKUP_MS) return v("idle", "Claude пока не забрал промпт — сессия открыта?");
    return v("working", "Запускаю…");
  }
  if (ack && ack.id === task.id && ack.status === "queued") return v("working", "В очереди — Claude закончит текущий ход");
  if (ack && ack.id === task.id && ack.status === "failed") return v("failed", `Не отправилось: ${ack.error || "ошибка"}`);
  if (!s || !isLive(s, now)) return v("idle", "Чат закрыт");
  if (s.status === "needs-input") return v("waiting", "Ждёт вашего ответа");
  if (s.status === "blocked") return v("failed", "Ошибка");
  if (s.status === "running") return v("working", s.step || "Размышление…");
  if (s.stoppedAt && s.stoppedAt >= (task.at || 0) && !(s.doneAt > s.stoppedAt)) return v("idle", "Остановлено");
  if (s.doneAt && s.doneAt >= (task.at || 0)) return v("done", "Готово");
  return v("idle", "Свободна");
}
