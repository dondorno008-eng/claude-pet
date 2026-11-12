import { MOOD_TEXT, cardSession, inboxMessage, labelOf, liveSessions, moodOf, petMood, resolveId } from "./state.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const pet = $("pet");
const sprite = $("sprite");
const pill = $("pill");
const form = $("ask");
const input = $("prompt");
const send = $("send");
const picker = $("session");
const newChatBtn = $("new-chat");
const card = $("card");
const collapseBtn = $("btn-collapse");

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sprite: the pack's atlas + pet.json (packs/horse, built by tools/build_atlas.py)
// an animation is a list of [row, col, ms] steps; "loop" = step to go back to, "once" = play over the mood once
const SCALE = 0.75;
const MOOD_ANIM = { idle: "idle", working: "working", done: "done", failed: "failed", waiting: "waiting" };

let pack = null;
let anim = null;
let stepNo = 0;
let timer = null;
let oneShot = null; // an animation that plays once over the mood (hello on a second launch)

function show() {
  const [row, col] = pack.animations[anim].steps[stepNo];
  sprite.style.backgroundPosition = `${-col * pack.cell * SCALE}px ${-row * pack.cell * SCALE}px`;
}

function next() {
  const a = pack.animations[anim];
  timer = setTimeout(() => {
    stepNo += 1;
    if (stepNo >= a.steps.length) {
      if (a.once) {
        if (oneShot === anim) oneShot = null;
        anim = null;
        refreshAnim();
        return;
      }
      stepNo = a.loop || 0;
    }
    show();
    next();
  }, a.steps[stepNo][2]);
}

function play(name) {
  if (name === anim) return;
  anim = name;
  stepNo = 0;
  clearTimeout(timer);
  timer = null;
  pet.dataset.anim = name;
  if (!pack || !pack.animations[name]) return; // the stand-in SVG animates by CSS
  show();
  next();
}

fetch("pack/pet.json")
  .then((r) => r.json())
  .then((p) => {
    const img = new Image();
    img.onload = () => {
      pack = p;
      const side = p.cell * SCALE;
      sprite.style.width = `${side}px`;
      sprite.style.height = `${side}px`;
      sprite.style.backgroundImage = `url(${img.src})`;
      sprite.style.backgroundSize = `${img.naturalWidth * SCALE}px ${img.naturalHeight * SCALE}px`;
      sprite.hidden = false;
      $("fallback").remove();
      anim = null;
      refreshAnim();
      sendRects();
    };
    img.src = `pack/${p.spritesheetPath}`;
  })
  .catch(() => {}); // no pack: keep the stand-in

// ---------- what the sessions are doing (files of docs/protocol.md, via Rust)
let sessions = [];
let acks = {};
let mood = "idle";
let walk = { walking: false, dir: 1 };
let dragging = false;

// the last prompt the person sent: { sid, id, at }
let lastSent = null;
// auto-shown cards the person closed: key -> true
const dismissed = new Set();

function refreshAnim() {
  if (oneShot) return play(oneShot);
  if (dragging || walk.walking) return play(walk.dir < 0 ? "running-left" : "running-right");
  play(MOOD_ANIM[mood]);
}

// a session that wants the person: waiting > failed > done
function attention(now) {
  for (const m of ["waiting", "failed", "done"]) {
    const s = liveSessions(sessions, now).find((x) => moodOf(x, now) === m);
    if (s) return { s, key: `${s.sessionId}:${m}:${s.doneAt || s.updatedAt}` };
  }
  return null;
}

function stepLine(s, now) {
  const byId = Object.fromEntries(sessions.map((x) => [x.sessionId, x]));
  if (lastSent && resolveId(lastSent.sid, byId) === s.sessionId) {
    const ack = acks[s.sessionId];
    if (!ack || ack.id !== lastSent.id) {
      return now - lastSent.at > 8000 ? "Claude пока не забрал промпт — сессия открыта?" : "Отправляю…";
    }
    if (ack.status === "queued") return "В очереди — Claude закончит текущий ход";
    if (ack.status === "failed") return `Не отправилось: ${ack.error || "ошибка"}`;
  }
  return s.step || MOOD_TEXT[moodOf(s, now)] || "Свободна";
}

function renderCard(now) {
  const a = attention(now);
  const s = (autoCard && a?.s) || cardSession(sessions, lastSent?.sid, now);
  if (!s) {
    $("card-name").textContent = "Нет открытых сессий";
    $("card-step").textContent = "Лошадка ждёт, пока вы откроете Claude Code";
    $("dot").className = "";
    return;
  }
  $("card-name").textContent = labelOf(s);
  $("card-step").textContent = stepLine(s, now);
  $("dot").className = moodOf(s, now);
}

function renderPicker(now) {
  const live = liveSessions(sessions, now);
  const byId = Object.fromEntries(sessions.map((x) => [x.sessionId, x]));
  const keep = picker.value || (lastSent && resolveId(lastSent.sid, byId));
  picker.replaceChildren(
    ...live.map((s) => {
      const o = document.createElement("option");
      o.value = s.sessionId;
      o.textContent = labelOf(s);
      return o;
    }),
  );
  if (live.some((s) => s.sessionId === keep)) picker.value = keep;
  picker.hidden = live.length === 0;
  $("no-session").hidden = live.length > 0;
  updateSend();
}

function updateSend() {
  const ok = input.value.trim().length > 0 && !picker.hidden && picker.value;
  send.disabled = !ok;
  send.classList.toggle("ready", !!ok);
}

// ---------- UI states: idle (pet only) | pill (hover) | input | card
let ui = "idle";
let expanded = false;
let hovered = false;
let autoCard = false; // the card was opened by a session wanting attention
let cardSince = 0;

// tell Rust where the visible, clickable things are; everything else is click-through
function sendRects() {
  const rects = [pet, pill, form, card]
    .filter((el) => !el.hidden)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
  invoke("set_hit_rects", { rects });
}

async function setUi(next) {
  ui = next;
  const wantExpanded = next !== "idle";
  if (wantExpanded !== expanded) {
    expanded = wantExpanded;
    await invoke("set_mode", { expanded });
  }
  const now = Date.now();
  pill.hidden = next === "idle" || next === "input";
  collapseBtn.hidden = next !== "card";
  form.hidden = next !== "input";
  card.hidden = !(next === "card" || (next === "pill" && liveSessions(sessions, now).length > 0));
  if (!card.hidden) renderCard(now);
  if (next === "card") cardSince = now;
  if (next !== "card") autoCard = false;
  await frame();
  sendRects();
}

async function openInput() {
  autoCard = false;
  await setUi("input");
  renderPicker(Date.now());
  await invoke("focus_input");
  input.focus();
}

async function collapse() {
  if (autoCard) dismissed.add(attention(Date.now())?.key);
  await setUi("idle");
  invoke("blur_app");
}

function setNewChat(on) {
  newChatBtn.classList.toggle("on", on);
  input.placeholder = on ? "Начать новый чат" : "Написать в сессию…";
}

// ---------- the 1 s loop: read the shared folder, update mood, card and picker
async function tick() {
  try {
    const st = await invoke("read_state");
    sessions = st.sessions;
    acks = st.acks;
  } catch {
    return;
  }
  const now = Date.now();
  mood = petMood(sessions, now);
  refreshAnim();
  const a = attention(now);
  if (ui === "idle" && a && !dismissed.has(a.key)) {
    autoCard = true;
    await setUi("card");
  }
  if (ui === "card" && !hovered) {
    const urgent = autoCard && a && (mood === "waiting" || mood === "failed") && !dismissed.has(a.key);
    const stale = now - cardSince > 12_000;
    if (autoCard && !a) await setUi("idle"); // the reason went away
    else if (!urgent && stale) {
      if (autoCard && a) dismissed.add(a.key);
      await setUi("idle");
    }
  }
  if (!card.hidden) renderCard(now);
  if (ui === "input") renderPicker(now);
}
setInterval(tick, 1000);
tick();

listen("hover", async (e) => {
  hovered = e.payload;
  if (hovered) cardSince = Date.now();
  if (hovered && ui === "idle") {
    await setUi("pill");
  } else if (!hovered && ui === "pill") {
    await sleep(600);
    if (!hovered && ui === "pill") await setUi("idle");
  }
});

listen("walk", (e) => {
  walk = e.payload;
  refreshAnim();
});

listen("second-instance", () => {
  oneShot = "hello";
  refreshAnim();
});

// ---------- drag vs click on the pet (the window itself follows the cursor in Rust)
let down = null;
pet.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pet.setPointerCapture(e.pointerId);
  down = { x: e.screenX, y: e.screenY };
  dragging = false;
});
pet.addEventListener("pointermove", (e) => {
  if (!down || dragging) return;
  if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
    dragging = true;
    pet.classList.add("dragging");
    refreshAnim();
    invoke("set_dragging", { dragging: true });
  }
});
pet.addEventListener("pointerup", async () => {
  if (!down) return;
  down = null;
  if (dragging) {
    dragging = false;
    pet.classList.remove("dragging");
    refreshAnim();
    await invoke("set_dragging", { dragging: false });
    sendRects();
  } else if (ui === "input") {
    collapse();
  } else {
    openInput();
  }
});

$("btn-write").addEventListener("click", openInput);
collapseBtn.addEventListener("click", collapse);
$("btn-quit").addEventListener("click", () => invoke("quit"));
card.addEventListener("click", openInput);
newChatBtn.addEventListener("click", () => {
  setNewChat(!newChatBtn.classList.contains("on"));
  input.focus();
});
picker.addEventListener("change", () => input.focus());
input.addEventListener("input", updateSend);
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") collapse();
});
window.addEventListener("blur", () => {
  // clicked somewhere else: an empty input folds away by itself
  if (ui === "input" && !input.value.trim()) setUi("idle");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = picker.value;
  if (!sid) return;
  let msg;
  try {
    msg = inboxMessage(input.value, newChatBtn.classList.contains("on"), crypto.randomUUID(), Date.now());
  } catch (err) {
    input.title = String(err.message || err);
    return;
  }
  try {
    await invoke("submit", { sessionId: sid, body: msg });
  } catch (err) {
    input.title = `Не записалось: ${err}`;
    return;
  }
  lastSent = { sid, id: msg.id, at: Date.now() };
  input.value = "";
  setNewChat(false);
  updateSend();
  autoCard = false;
  await setUi("card");
  invoke("blur_app");
});

window.addEventListener("resize", sendRects);
refreshAnim();
sendRects();
