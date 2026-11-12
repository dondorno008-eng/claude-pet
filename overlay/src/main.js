const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const pet = $("pet");
const pill = $("pill");
const form = $("ask");
const input = $("prompt");
const send = $("send");
const card = $("card");
const collapseBtn = $("btn-collapse");

const log = (msg) => invoke("log", { msg });
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// idle (pet only, 192×208) | pill | input | card  (all three: 460×300)
let state = "idle";
let expanded = false;
let hovered = false;

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

async function setState(next) {
  state = next;
  const wantExpanded = next !== "idle";
  if (wantExpanded !== expanded) {
    expanded = wantExpanded;
    await invoke("set_mode", { expanded });
  }
  pill.hidden = !(next === "pill" || next === "card");
  collapseBtn.hidden = next !== "card";
  form.hidden = next !== "input";
  card.hidden = next !== "card";
  await frame();
  sendRects();
}

async function openInput() {
  await setState("input");
  input.value = "";
  send.classList.remove("ready");
  await invoke("focus_input");
  input.focus();
  await sleep(300);
  log(`after-open hasFocus=${document.hasFocus()} active=${document.activeElement?.id || "-"}`);
}

async function collapse() {
  await setState("idle");
  invoke("blur_app");
}

listen("hover", async (e) => {
  hovered = e.payload;
  if (hovered && state === "idle") {
    await setState("pill");
  } else if (!hovered && state === "pill") {
    await sleep(600);
    if (!hovered && state === "pill") await setState("idle");
  }
});

// --- drag vs click on the pet (the window itself follows the cursor in Rust)
let down = null;
let dragging = false;
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
    invoke("set_dragging", { dragging: true });
  }
});
pet.addEventListener("pointerup", async () => {
  if (!down) return;
  down = null;
  if (dragging) {
    dragging = false;
    pet.classList.remove("dragging");
    await invoke("set_dragging", { dragging: false });
    sendRects();
  } else {
    openInput();
  }
});

$("btn-write").addEventListener("click", openInput);
$("btn-voice").addEventListener("click", () => log("voice: not in spike"));
collapseBtn.addEventListener("click", collapse);

input.addEventListener("input", () => {
  send.classList.toggle("ready", input.value.trim().length > 0);
  log(`typed len=${input.value.length}`);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") collapse();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const path = await invoke("submit", {
    text,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  log(`wrote ${path}`);
  $("card-title").textContent = text;
  $("card-step").textContent = "Отправлено в inbox";
  await setState("card");
  invoke("blur_app");
});

listen("dir", (e) => pet.classList.toggle("left", e.payload < 0));

listen("second-instance", () => {
  pet.classList.remove("jump");
  void pet.offsetWidth;
  pet.classList.add("jump");
});

// --- spike-only self-tests: the harness has no synthetic mouse/keyboard, so
// these drive the same handlers a click would, and log what the page sees.
listen("selftest", async () => {
  log("selftest: pill");
  await setState("pill");
  await sleep(2500);
  log("selftest: write button");
  $("btn-write").click();
  await sleep(1500);
  log(`selftest focus hasFocus=${document.hasFocus()} active=${document.activeElement?.id || "-"}`);
  input.value = `selftest ${new Date().toISOString()}`;
  input.dispatchEvent(new Event("input"));
  await sleep(1500);
  form.requestSubmit();
  await sleep(3000);
  log("selftest: collapse");
  await collapse();
});

listen("selftest-drag", async () => {
  log("selftest-drag: start (cursor is moved externally)");
  pet.classList.add("dragging");
  await invoke("set_dragging", { dragging: true });
  await sleep(6000);
  await invoke("set_dragging", { dragging: false });
  pet.classList.remove("dragging");
  sendRects();
  log(`selftest-drag: end left=${pet.classList.contains("left")}`);
});

window.addEventListener("resize", sendRects);
sendRects();
