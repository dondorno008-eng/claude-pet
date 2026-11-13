import { HINT_MS, MAX_CARDS, folderOf, inboxMessage, isLive, labelOf, liveSessions, matchNewChat, resolveId, stopMessage, taskView } from "./state.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const pet = $("pet");
const sprite = $("sprite");
const pill = $("pill");
const form = $("ask");
const input = $("prompt");
const send = $("send");
const micIn = $("mic-in");
const micPill = $("btn-mic");
const wave = $("wave");
const cards = $("cards");
const collapseBtn = $("btn-collapse");

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sprite: the pack's atlas + pet.json (packs/horse, built by tools/build_atlas.py)
// an animation is a list of [row, col, ms] steps; "loop" = step to go back to, "once" = play over the pose once
const SCALE = 0.6375; // 0.75 × 0.85: the horse 15% smaller

let pack = null;
let anim = null;
let stepNo = 0;
let timer = null;
let oneShot = null; // an animation that plays once over the pose (hello on a second launch)

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
// the card whose ↩ field is open: its key
let contKey = null;

// four poses, set by the person alone (other sessions never move the horse):
// rest → lies down and stays lying ("done": stand → kneel → lie); dragged → gallops;
// clicked (input open) → stands ("idle" is the pack's standing pose)
// input open: the horse hops to the right of the window and looks down-left at the text;
// mic on: holds a corded phone whose cord runs into the bar and listens
function refreshAnim() {
  if (dragging) return play(walk.dir < 0 ? "running-left" : "running-right");
  if (hop) return play(hop > 0 ? "running-right" : "running-left");
  if (oneShot) return play(oneShot);
  if (ui !== "input") return play("done");
  const pose = rec ? "listening" : "reading";
  play(!pack || pack.animations[pose] ? pose : "idle"); // an older pack has no such pose
}

// the hop between the horse's spot and the right of the input bar
const stage = $("stage");
const HOP_MS = 420;
let hop = 0; // 1 → to the bar, -1 ← back, 0 standing

async function hopTo(aside) {
  if (aside === stage.classList.contains("aside")) return;
  hop = aside ? 1 : -1;
  if (oneShot === "hangup") oneShot = null;
  refreshAnim();
  stage.classList.toggle("aside", aside);
  pet.classList.add("hopping");
  await sleep(HOP_MS);
  pet.classList.remove("hopping");
  hop = 0;
  refreshAnim();
  sendRects();
}

// what the stack under the horse shows: the last few requests the person sent from the horse
function cardItems() {
  return tasks.slice(-MAX_CARDS).reverse().map((t) => ({ key: t.id || t.sid, task: t }));
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
      <button class="c-open" type="button" title="Открыть чат в Claude">↗</button>
      <button class="c-cont" type="button" title="Продолжить этот чат">↩</button>
      <button class="c-stop" type="button" title="Остановить">■</button>
      <button class="c-close" type="button" title="Закрыть карточку">×</button>
    </div>
    <div class="card-step"></div>
    <div class="card-answer" hidden></div>
    <form class="cont" hidden>
      <input type="text" placeholder="Продолжить…" autocomplete="off" maxlength="8000" />
      <button type="submit" title="Отправить в этот чат">↑</button>
    </form>`;
  el.querySelector(".c-open").addEventListener("click", () => openChat(key));
  el.querySelector(".card-name").addEventListener("click", () => openChat(key));
  el.querySelector(".card-answer").addEventListener("dblclick", () => openChat(key));
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

// an answer as plain text: the card draws no markdown
const plain = (t) => String(t || "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").trim();

// a card that shows an answer stays until the person folds or closes it
const hasAnswer = () => [...cards.querySelectorAll(".card-answer")].some((el) => !el.hidden);

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
    // the whole chat opens in Claude once the turn is over (a running one would be cut short)
    const canOpen = !!v.sid && !!s && s.status !== "running";
    el.querySelector(".c-open").hidden = !canOpen;
    el.querySelector(".card-name").classList.toggle("link", canOpen);
    // the chat's answer: in the newest card, and in the one being continued
    const ans = el.querySelector(".card-answer");
    const text = (i === 0 || contKey === it.key) && s && s.status !== "running" ? plain(s.answer) : "";
    if (ans.textContent !== text) ans.textContent = text;
    ans.hidden = !text;
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
  const t = { sid, fresh: it.task.fresh, id: msg.id, text: it.task.text || msg.text, at: msg.createdAt, started: false, stopId: null };
  tasks = tasks.filter((x) => x !== it.task).concat(t);
  saveTasks();
  contKey = null;
  await setUi("card");
  invoke("blur_app");
}

// the chat moves to the Claude app: its card has nothing left to do here
async function openChat(key) {
  const it = itemByKey(key);
  if (!it) return;
  const sid = resolveId(it.task.sid, byId);
  const s = byId[sid];
  if (!sid || !s || s.status === "running") return;
  try {
    await invoke("open_chat", { sessionId: sid, background: !!it.task.fresh });
  } catch (err) {
    cards.querySelector(`[data-key="${CSS.escape(key)}"] .card-step`).textContent = String(err.message || err);
    return;
  }
  closeCard(key);
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
  it.task.stopId = msg.id;
  saveTasks();
  renderCards(Date.now());
}

async function closeCard(key) {
  const it = itemByKey(key);
  if (!it) return;
  tasks = tasks.filter((x) => x !== it.task);
  saveTasks();
  if (contKey === key) contKey = null;
  if (cardItems(Date.now()).length === 0) return collapse();
  renderCards(Date.now());
  await frame();
  sendRects();
}

function updateSend() {
  const ok = input.value.trim().length > 0;
  send.disabled = !ok;
  send.classList.toggle("ready", !!ok);
}

// ---------- UI states: idle (pet only) | pill (hover) | input | card
let ui = "idle";
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
  const now = Date.now();
  // the buttons show only under the mouse
  pill.hidden = !hovered || next === "idle" || next === "input";
  collapseBtn.hidden = next !== "card";
  form.hidden = next !== "input";
  if (next !== "card") contKey = null;
  if (next !== "input") stopRec();
  hopTo(next === "input");
  refreshAnim();
  // the open bar is one line: no cards under it
  cards.hidden = !(next === "card" || next === "pill") || renderCards(now).length === 0;
  if (next === "card") cardSince = now;
  await frame();
  sendRects();
}

async function openInput() {
  await setUi("input");
  updateSend();
  await invoke("focus_input");
  input.focus();
}

async function collapse() {
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

// ---------- voice: macOS dictation through WebKit's SpeechRecognition; the bars follow the mic level
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const PLACEHOLDER = input.placeholder;
const BARS = [0.55, 0.8, 1, 0.8, 0.55];
let rec = null; // the running recognizer
let meter = null; // { stream, ctx, an, buf } when the page may read the mic level itself
let level = 0; // 0..1: the ring and the bars
let bump = 0; // no meter: a heard word kicks the bars

const MIC_ERRORS = {
  "not-allowed": "Нет доступа к микрофону: Системные настройки → Конфиденциальность",
  "service-not-allowed": "Включите диктовку: Системные настройки → Клавиатура → Диктовка",
  "audio-capture": "Микрофон не найден",
  network: "Нет сети для распознавания речи",
};

function setRecUi(on) {
  micIn.classList.toggle("rec", on);
  micPill.classList.toggle("rec", on);
  micIn.title = on ? "Стоп" : "Голосом (ещё раз — стоп)";
  wave.hidden = !on;
  // the phone comes out with the mic and goes away after it
  if (!on && ui === "input" && pack?.animations.hangup) oneShot = "hangup";
  refreshAnim();
}

function drawLevel(t) {
  if (!rec) return;
  let target;
  if (meter) {
    meter.an.getByteTimeDomainData(meter.buf);
    let sum = 0;
    for (const v of meter.buf) sum += ((v - 128) / 128) ** 2;
    target = Math.min(1, Math.sqrt(sum / meter.buf.length) * 5);
  } else {
    bump *= 0.93;
    target = 0.12 + bump * 0.8;
  }
  level += (target - level) * 0.35;
  micIn.style.setProperty("--lvl", level.toFixed(3));
  [...wave.children].forEach((bar, i) => {
    const wob = 0.7 + 0.3 * Math.sin(t / 110 + i * 1.7);
    bar.style.height = `${4 + 14 * level * BARS[i] * wob}px`;
  });
  requestAnimationFrame(drawLevel);
}

async function openMeter(r) {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (rec !== r) return stream.getTracks().forEach((x) => x.stop());
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    meter = { stream, ctx, an, buf: new Uint8Array(an.fftSize) };
  } catch {
    // no level for the page: the bars move on recognized words
  }
}

function closeMeter() {
  if (!meter) return;
  meter.stream.getTracks().forEach((x) => x.stop());
  meter.ctx.close();
  meter = null;
}

function startRec() {
  if (rec) return;
  input.placeholder = PLACEHOLDER;
  if (!Speech) {
    input.placeholder = "Голосовой ввод недоступен на этом Mac";
    return;
  }
  const r = new Speech();
  r.lang = "ru-RU";
  r.continuous = true;
  r.interimResults = true;
  const before = input.value.trim();
  r.onresult = (e) => {
    let said = "";
    for (const res of e.results) said += res[0].transcript;
    input.value = [before, said.trim()].filter(Boolean).join(" ");
    bump = 1;
    updateSend();
  };
  r.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;
    input.placeholder = MIC_ERRORS[e.error] || `Голос: ${e.error}`;
  };
  r.onend = () => {
    if (rec === r) stopRec();
  };
  rec = r;
  level = 0;
  setRecUi(true);
  try {
    r.start();
  } catch (err) {
    stopRec();
    input.placeholder = `Голос: ${err.message || err}`;
    return;
  }
  openMeter(r);
  requestAnimationFrame(drawLevel);
}

function stopRec() {
  if (!rec) return;
  const r = rec;
  rec = null;
  try {
    r.stop();
  } catch {
    // already over
  }
  closeMeter();
  setRecUi(false);
  if (ui === "input") input.focus();
}

// ---------- the 1 s loop: read the shared folder, update the cards
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
      } else if (t.short && !t.hint && now - t.at > HINT_MS && now - (t.hintAt || 0) > HINT_MS / 2) {
        // still silent: ask its screen why (not signed in, first run, trust…)
        t.hintAt = now;
        invoke("bg_chat_hint", { short: t.short }).then((h) => { if (h) { t.hint = h; saveTasks(); } }, () => {});
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
  const open = tasks.filter((t) => {
    const s = t.started && t.sid ? byId[resolveId(t.sid, byId)] : null;
    return !(t.started && t.sid) || isLive(s, now) || (s && s.answer); // an answer stays readable
  });
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

  const busy = cardItems(now).some((it) => {
    if (!it.task) return false;
    const m = taskView(it.task, byId, acks, now).mood;
    return m === "working" || m === "waiting";
  });
  if (!busy) folded = false;
  else if (ui === "idle" && !folded) await setUi("card");
  if (ui === "card" && !hovered && contKey === null) {
    if (!busy && !hasAnswer() && now - cardSince > 12_000) {
      await setUi("idle");
    }
  }
  if (!cards.hidden) {
    const n = cards.getBoundingClientRect().height;
    renderCards(now);
    await frame();
    if (cards.getBoundingClientRect().height !== n) {
      await frame();
      sendRects();
    }
  }
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
  } else if (ui === "card") {
    if (!hovered) await sleep(600);
    pill.hidden = !hovered;
    await frame();
    sendRects();
  }
});

// the window is not key while the cursor just passes, so CSS :hover never fires;
// Rust sends the cursor position and the button under it gets .hot
let hot = null;
listen("cursor", (e) => {
  const p = e.payload;
  const el = p ? document.elementFromPoint(p.x, p.y)?.closest("button, .card-name.link") ?? null : null;
  if (el === hot) return;
  hot?.classList.remove("hot");
  hot = el;
  hot?.classList.add("hot");
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
// the pill's mic: the input opens already listening
micPill.addEventListener("click", async () => {
  await openInput();
  startRec();
});
micIn.addEventListener("click", () => (rec ? stopRec() : startRec()));
input.addEventListener("input", updateSend);
input.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (rec) stopRec();
  else collapse();
});
window.addEventListener("blur", () => {
  // clicked somewhere else: an empty input folds away by itself
  // (not while the mic listens: macOS's microphone question takes the focus too)
  if (ui === "input" && !rec && !input.value.trim()) setUi("idle");
  if (contKey !== null) {
    const v = cards.querySelector(`[data-key="${CSS.escape(contKey)}"] .cont input`);
    if (!v || !v.value.trim()) closeCont();
  }
});

// every request is a new Claude Code chat in the background, in the project of the freshest
// live session (the folder Claude itself would most likely pick), else in the home folder
async function sendNewChat(text) {
  const t = { sid: null, fresh: true, id: crypto.randomUUID(), text, at: Date.now(), started: false, stopId: null, short: null };
  const folder = folderOf(liveSessions(sessions, t.at)[0]?.cwd);
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
  stopRec();
  const text = input.value.trim();
  if (text) await sendNewChat(text);
});

window.addEventListener("resize", sendRects);
refreshAnim();
sendRects();
