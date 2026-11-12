import { MAX_CARDS, folderOf, inboxMessage, isLive, labelOf, liveSessions, matchNewChat, moodOf, petMood, resolveId, stopMessage, taskView } from "./state.js";

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
const cards = $("cards");
const collapseBtn = $("btn-collapse");

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sprite: the pack's atlas + pet.json (packs/horse, built by tools/build_atlas.py)
// an animation is a list of [row, col, ms] steps; "loop" = step to go back to, "once" = play over the mood once
const SCALE = 0.6375; // 0.75 × 0.85: the horse 15% smaller
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
let byId = {};
let mood = "idle";
let walk = { walking: false, dir: 1 };
let dragging = false;

// the requests the person sent, newest last: { sid, id, text, at, started, stopId }
// a new background chat starts as { sid: null, fresh: true, short } until its session shows up
const TASKS_KEY = "horse.tasks";
let tasks = [];
try {
  tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]").filter((t) => t && (t.sid || t.fresh));
} catch {
  tasks = [];
}
const saveTasks = () => localStorage.setItem(TASKS_KEY, JSON.stringify(tasks.slice(-10)));
// auto-shown attention cards the person closed: key -> true
const dismissed = new Set();
// the card whose ↩ field is open: its key
let contKey = null;

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

// what the stack under the horse shows: the last few requests, or else the session that wants attention
function cardItems(now) {
  const items = tasks.slice(-MAX_CARDS).reverse().map((t) => ({ key: t.id || t.sid, task: t }));
  if (items.length > 0) return items;
  const a = attention(now);
  if (a && !dismissed.has(a.key)) {
    return [{ key: a.key, task: { sid: a.s.sessionId, id: null, text: null, at: 0, started: true, stopId: null }, attn: true }];
  }
  return [];
}

function cardEl(key) {
  let el = cards.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (el) return el;
  el = document.createElement("div");
  el.className = "card";
  el.dataset.key = key;
  el.innerHTML = `
    <div class="card-head">
      <span class="dot"></span><span class="card-name"></span>
      <button class="c-cont" type="button" title="Продолжить этот чат">↩</button>
      <button class="c-stop" type="button" title="Остановить">■</button>
      <button class="c-close" type="button" title="Закрыть карточку">×</button>
    </div>
    <div class="card-step"></div>
    <form class="cont" hidden>
      <input type="text" placeholder="Продолжить…" autocomplete="off" maxlength="8000" />
      <button type="submit" title="Отправить в этот чат">↑</button>
    </form>`;
  el.querySelector(".c-cont").addEventListener("click", () => openCont(key));
  el.querySelector(".c-stop").addEventListener("click", () => stopCard(key));
  el.querySelector(".c-close").addEventListener("click", () => closeCard(key));
  el.querySelector(".card-step").addEventListener("click", () => openCont(key));
  const f = el.querySelector(".cont");
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    continueCard(key, f.querySelector("input").value);
  });
  f.querySelector("input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCont();
  });
  return el;
}

function renderCards(now) {
  const items = cardItems(now);
  const keep = new Set(items.map((i) => i.key));
  for (const el of [...cards.children]) if (!keep.has(el.dataset.key)) el.remove();
  if (contKey && !keep.has(contKey)) contKey = null;
  items.forEach((it, i) => {
    const el = cardEl(it.key);
    if (cards.children[i] !== el) cards.insertBefore(el, cards.children[i] || null);
    const v = taskView(it.task, byId, acks, now);
    const s = byId[v.sid];
    el.querySelector(".card-name").textContent = it.task.text || (s ? labelOf(s) : "Чат");
    el.querySelector(".card-step").textContent = v.text;
    el.querySelector(".dot").className = `dot ${v.mood}`;
    el.querySelector(".c-stop").hidden = !v.canStop;
    el.querySelector(".c-cont").hidden = !v.sid;
    el.querySelector(".cont").hidden = contKey !== it.key;
  });
  return items;
}

function itemByKey(key) {
  return cardItems(Date.now()).find((i) => i.key === key);
}

async function openCont(key) {
  contKey = key;
  renderCards(Date.now());
  await frame();
  sendRects();
  await invoke("focus_input");
  cards.querySelector(`[data-key="${CSS.escape(key)}"] .cont input`)?.focus();
}

async function closeCont() {
  contKey = null;
  renderCards(Date.now());
  await frame();
  sendRects();
  invoke("blur_app");
}

async function continueCard(key, text) {
  const it = itemByKey(key);
  if (!it) return;
  const sid = resolveId(it.task.sid, byId);
  if (!sid) return;
  let msg;
  try {
    msg = inboxMessage(text, false, crypto.randomUUID(), Date.now());
    await invoke("submit", { sessionId: sid, body: msg });
  } catch (err) {
    cards.querySelector(`[data-key="${CSS.escape(key)}"] .cont input`).title = String(err.message || err);
    return;
  }
  const t = { sid, id: msg.id, text: it.task.text || msg.text, at: msg.createdAt, started: false, stopId: null };
  if (it.attn) dismissed.add(key);
  tasks = tasks.filter((x) => x !== it.task).concat(t);
  saveTasks();
  contKey = null;
  await setUi("card");
  invoke("blur_app");
}

async function stopCard(key) {
  const it = itemByKey(key);
  if (!it) return;
  const msg = stopMessage(crypto.randomUUID(), Date.now());
  try {
    await invoke("submit", { sessionId: resolveId(it.task.sid, byId), body: msg });
  } catch {
    return;
  }
  if (it.attn) {
    tasks = tasks.concat({ ...it.task, id: null, text: null, at: msg.createdAt, stopId: msg.id });
    dismissed.add(key);
  } else {
    it.task.stopId = msg.id;
  }
  saveTasks();
  renderCards(Date.now());
}

async function closeCard(key) {
  const it = itemByKey(key);
  if (!it) return;
  if (it.attn) dismissed.add(key);
  else tasks = tasks.filter((x) => x !== it.task);
  saveTasks();
  if (contKey === key) contKey = null;
  if (cardItems(Date.now()).length === 0) return collapse();
  renderCards(Date.now());
  await frame();
  sendRects();
}

function renderPicker(now) {
  const live = liveSessions(sessions, now);
  const last = tasks[tasks.length - 1];
  const keep = picker.value || (last && resolveId(last.sid, byId));
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
  const target = newChatBtn.classList.contains("on") || (!picker.hidden && picker.value);
  const ok = input.value.trim().length > 0 && !!target;
  send.disabled = !ok;
  send.classList.toggle("ready", !!ok);
}

// ---------- UI states: idle (pet only) | pill (hover) | input | card
let ui = "idle";
let expanded = false;
let hovered = false;
let cardSince = 0;
let folded = false; // the person folded the cards while a task works: do not pop them back

// tell Rust where the visible, clickable things are; everything else is click-through
function sendRects() {
  const rects = [pet, pill, form, ...cards.children]
    .filter((el) => !el.hidden && !(el.parentElement === cards && cards.hidden))
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
  if (next !== "card") contKey = null;
  // the open bar is one line: no cards under it
  cards.hidden = !(next === "card" || next === "pill") || renderCards(now).length === 0;
  if (next === "card") cardSince = now;
  await frame();
  sendRects();
}

async function openInput() {
  await setUi("input");
  renderPicker(Date.now());
  await invoke("focus_input");
  input.focus();
}

async function collapse() {
  const a = attention(Date.now());
  if (a && tasks.length === 0) dismissed.add(a.key);
  folded = true;
  await setUi("idle");
  invoke("blur_app");
}

async function hide() {
  await setUi("idle");
  await invoke("hide_window");
  invoke("blur_app");
}

// /horse or the hotkey: the horse is back, with the input open
async function summon() {
  await invoke("show_window");
  oneShot = "hello";
  refreshAnim();
  await openInput();
}

setNewChat(true);

function setNewChat(on) {
  newChatBtn.classList.toggle("on", on);
  // a new chat needs no session picked: the bar stays one line
  $("target").hidden = on;
  updateSend();
  input.placeholder = on ? "Начать новый чат" : "Написать в эту сессию…";
}

// ---------- the 1 s loop: read the shared folder, update mood, cards and picker
let lastShowAt = null;

async function tick() {
  let st;
  try {
    st = await invoke("read_state");
  } catch {
    return;
  }
  sessions = st.sessions;
  acks = st.acks;
  byId = Object.fromEntries(sessions.map((x) => [x.sessionId, x]));
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (t.fresh && !t.sid) {
      const s = matchNewChat(t, sessions);
      if (s) {
        t.sid = s.sessionId;
        t.started = true;
        changed = true;
      }
      continue;
    }
    const ack = acks[resolveId(t.sid, byId)];
    if (!t.started && t.id && ack && ack.id === t.id && ack.status !== "queued") {
      t.started = true;
      changed = true;
    }
  }
  // a chat that has closed leaves the stack: nothing to continue or stop there
  const open = tasks.filter((t) => !(t.started && t.sid && !isLive(byId[resolveId(t.sid, byId)], now)));
  if (open.length !== tasks.length) {
    tasks.splice(0, tasks.length, ...open);
    changed = true;
  }
  if (changed) saveTasks();
  // /horse wrote show.json: a new stamp, or a fresh one when /horse just started us
  if (st.showAt && st.showAt !== lastShowAt) {
    const fresh = lastShowAt !== null || now - st.showAt < 15_000;
    lastShowAt = st.showAt;
    if (fresh) return summon();
  } else if (lastShowAt === null) lastShowAt = st.showAt || 0;

  mood = petMood(sessions, now);
  refreshAnim();
  const a = attention(now);
  if (ui === "idle" && a && !dismissed.has(a.key)) await setUi("card");
  const busy = cardItems(now).some((it) => {
    if (!it.task) return false;
    const m = taskView(it.task, byId, acks, now).mood;
    return m === "working" || m === "waiting";
  });
  if (!busy) folded = false;
  else if (ui === "idle" && !folded) await setUi("card");
  if (ui === "card" && !hovered && contKey === null) {
    if (!busy && now - cardSince > 12_000) {
      if (a) dismissed.add(a.key);
      await setUi("idle");
    }
  }
  if (!cards.hidden) {
    const n = cards.children.length;
    renderCards(now);
    if (cards.children.length !== n) {
      await frame();
      sendRects();
    }
  }
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

// ⌃⌥Space: hidden → back with the input open; input open → fold to the pet; else → input
listen("hotkey", (e) => {
  if (e.payload) return summon();
  if (ui === "input") return collapse();
  return openInput();
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
$("btn-quit").addEventListener("click", hide);
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
  if (contKey !== null) {
    const v = cards.querySelector(`[data-key="${CSS.escape(contKey)}"] .cont input`);
    if (!v || !v.value.trim()) closeCont();
  }
});

// default: every request is a new Claude Code chat in the background, in the picked session's project
async function sendNewChat(text) {
  const t = { sid: null, fresh: true, id: crypto.randomUUID(), text, at: Date.now(), started: false, stopId: null, short: null };
  const folder = folderOf(byId[picker.value]?.cwd);
  tasks = tasks.concat(t);
  folded = false;
  saveTasks();
  input.value = "";
  updateSend();
  await setUi("card");
  try {
    // no window opens: `claude --bg` prints the new session's short id
    t.short = await invoke("start_bg_chat", { text, folder });
  } catch (err) {
    t.error = String(err).slice(0, 160);
  }
  saveTasks();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (newChatBtn.classList.contains("on")) {
    const text = input.value.trim();
    if (text) await sendNewChat(text);
    return;
  }
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
  tasks = tasks.concat({ sid, id: msg.id, text: msg.text, at: msg.createdAt, started: false, stopId: null });
  folded = false;
  saveTasks();
  input.value = "";
  setNewChat(true);
  updateSend();
  await setUi("card");
  invoke("blur_app");
});

window.addEventListener("resize", sendRects);
refreshAnim();
sendRects();
