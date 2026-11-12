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
