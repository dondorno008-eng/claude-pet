// HorsePet: a transparent always-on-top window with a horse that walks along
// the bottom of the screen in short episodes. Clicks pass through everything
// except the visible elements (the cursor is polled and hit-tested here, and
// ignore-cursor-events is toggled per element). Talks to the Claude Code mod
// through files only, see docs/protocol.md:
//   reads  ~/.claude-pet/sessions/*.json, acks/*.json
//   writes ~/.claude-pet/inbox/<sessionId>.json (atomic), overlay.json (pulse)
//   drops  inbox files once acked, and session files dead for over a day
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const W: f64 = 192.0;
const H: f64 = 208.0;
const EXP_W: f64 = 460.0;
const EXP_H: f64 = 300.0;
const DAY_MS: u64 = 24 * 3600 * 1000;
const PULSE_MS: u64 = 15_000;
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
struct Shared {
    paused: AtomicBool,
    dragging: AtomicBool,
    ignoring: AtomicBool,
    /// pid of the app that was frontmost before we took focus (macOS)
    prev_app: AtomicI32,
    /// (cursor x, cursor y, window x, window y) in physical px at drag start
    drag_anchor: Mutex<Option<(f64, f64, i32, i32)>>,
    /// hit rects of visible elements, logical px relative to the window
    rects: Mutex<Vec<[f64; 4]>>,
}
type St<'a> = tauri::State<'a, Arc<Shared>>;

fn base() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".claude-pet")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn ensure_dirs(base: &Path) {
    for d in ["", "sessions", "inbox", "acks"] {
        let _ = DirBuilder::new().recursive(true).mode(0o700).create(base.join(d));
    }
}

/// write `text` to `dst` via a tmp file + rename, mode 0600
fn write_atomic(dst: &Path, text: &str) -> Result<(), String> {
    let name = dst.file_name().and_then(|n| n.to_str()).unwrap_or("f");
    let tmp = dst.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), now_ms()));
    {
        let mut f = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&tmp).map_err(e2s)?;
        f.write_all(text.as_bytes()).map_err(e2s)?;
    }
    fs::rename(&tmp, dst).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e2s(e)
    })
}

/// session ids become file names: allow only what Claude Code ids are made of
pub fn safe_sid(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_f64).map(|f| f.max(0.0) as u64).unwrap_or(0)
}

/// a session file nobody has written for over a day
pub fn is_dead(s: &Value, now: u64) -> bool {
    now.saturating_sub(num(s, "updatedAt").max(num(s, "pulseAt"))) > DAY_MS
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

/// the inbox message of session `sid` has been taken by the mod: its ack (or,
/// after a new chat, the new session's ack naming `from: sid`) carries its id
pub fn inbox_taken(sid: &str, inbox: &Value, acks: &Map<String, Value>) -> bool {
    let Some(id) = id_of(inbox) else { return true }; // junk: drop it
    acks.iter().any(|(k, a)| id_of(a) == Some(id) && (k == sid || a.get("from").and_then(Value::as_str) == Some(sid)))
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// `<sid>.json` files of a folder (tmp files start with a dot and are skipped)
fn json_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let sid = name.strip_suffix(".json")?;
            safe_sid(sid).then(|| (sid.to_string(), e.path()))
        })
        .collect()
}

/// one look at the shared folder: sessions + acks for the window, plus housekeeping
pub fn scan(base: &Path, now: u64) -> Value {
    let mut acks = Map::new();
    for (sid, p) in json_files(&base.join("acks")) {
        if let Some(a) = read_json(&p) {
            acks.insert(sid, a);
        }
    }
    let mut sessions = vec![];
    for (sid, p) in json_files(&base.join("sessions")) {
        let Some(s) = read_json(&p) else { continue }; // half-written: next time
        if is_dead(&s, now) {
            let _ = fs::remove_file(&p);
            let _ = fs::remove_file(base.join("acks").join(format!("{sid}.json")));
            let _ = fs::remove_file(base.join("inbox").join(format!("{sid}.json")));
            acks.remove(&sid);
            continue;
        }
        sessions.push(s);
    }
    for (sid, p) in json_files(&base.join("inbox")) {
        if let Some(m) = read_json(&p) {
            if inbox_taken(&sid, &m, &acks) {
                let _ = fs::remove_file(&p);
            }
        }
    }
    json!({ "sessions": sessions, "acks": acks })
}

#[tauri::command]
fn read_state() -> Value {
    scan(&base(), now_ms())
}

#[tauri::command]
fn submit(session_id: String, body: Value) -> Result<(), String> {
    if !safe_sid(&session_id) {
        return Err("bad session id".into());
    }
    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    if id_of(&body).is_none() || text.trim().is_empty() || text.chars().count() > 8000 {
        return Err("bad message".into());
    }
    let b = base();
    ensure_dirs(&b);
    write_atomic(&b.join("inbox").join(format!("{session_id}.json")), &body.to_string())
}

#[tauri::command]
fn set_hit_rects(st: St, rects: Vec<[f64; 4]>) {
    *st.rects.lock().unwrap() = rects;
}

#[tauri::command]
fn set_dragging(window: WebviewWindow, st: St, dragging: bool) {
    if dragging {
        // keep receiving mouse events for the whole drag
        let _ = window.set_ignore_cursor_events(false);
        st.ignoring.store(false, Ordering::SeqCst);
        if let (Ok(c), Ok(p)) = (window.cursor_position(), window.outer_position()) {
            *st.drag_anchor.lock().unwrap() = Some((c.x, c.y, p.x, p.y));
        }
    } else {
        *st.drag_anchor.lock().unwrap() = None;
    }
    st.dragging.store(dragging, Ordering::SeqCst);
}

/// compact = 192×208 (pet only), expanded = 460×300 (pet + pill + card/input).
/// Keeps the top edge and the horizontal centre, so the pet does not move on screen.
#[tauri::command]
fn set_mode(window: WebviewWindow, st: St, expanded: bool) -> Result<(), String> {
    st.paused.store(expanded, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(40)); // let the walker finish its tick
    let (w, h) = if expanded { (EXP_W, EXP_H) } else { (W, H) };
    let scale = window.scale_factor().map_err(e2s)?;
    let pos = window.outer_position().map_err(e2s)?;
    let cur = window.outer_size().map_err(e2s)?;
    let (nw, nh) = ((w * scale) as i32, (h * scale) as i32);
    let mut nx = pos.x + (cur.width as i32 - nw) / 2;
    let mut ny = pos.y;
    if let Ok(Some(m)) = window.current_monitor() {
        let a = m.work_area();
        let (l, t) = (a.position.x, a.position.y);
        let (r, b) = (l + a.size.width as i32, t + a.size.height as i32);
        nx = nx.clamp(l, (r - nw).max(l));
        ny = ny.clamp(t, (b - nh).max(t));
    }
    window.set_size(LogicalSize::new(w, h)).map_err(e2s)?;
    window.set_position(PhysicalPosition::new(nx, ny)).map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn focus_input(window: WebviewWindow, st: St) -> Result<(), String> {
    remember_front(&st);
    window.set_focus().map_err(e2s)
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// remember which app owns the keyboard right now (if it is not us)
fn remember_front(sh: &Shared) {
    #[cfg(target_os = "macos")]
    if let Some(app) = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication() {
        let pid = app.processIdentifier();
        if pid != std::process::id() as i32 {
            sh.prev_app.store(pid, Ordering::SeqCst);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = sh;
}

/// hand keyboard focus back to the app the user was in before
#[tauri::command]
fn blur_app(window: WebviewWindow, st: St) {
    let pid = st.prev_app.load(Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        if let Some(a) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            a.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (window, pid);
}

#[cfg(target_os = "macos")]
fn mac_window_tweaks(win: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = win.ns_window() else { return };
    // SAFETY: setup() runs on the main thread; pointer is the live NSWindow.
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    // NSStatusWindowLevel = 25: above normal and floating windows.
    ns.setLevel(25);
}

/// tiny xorshift: walk lengths and pauses need no crypto
struct Rng(u64);
impl Rng {
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        lo + self.0 % (hi - lo).max(1)
    }
}

/// Walk episodes: rest 6–20 s, gallop 2.5–6 s. Resting, the loop wakes at 10 Hz
/// only to hit-test the cursor; galloping it moves the window at 30 Hz.
fn spawn_ticker(win: WebviewWindow, sh: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut rng = Rng(now_ms() | 1);
        let mut dir: i32 = 1;
        let mut walking = false;
        let mut until = now_ms() + rng.range(3000, 8000);
        let mut drag_last_x: Option<i32> = None;
        let emit_walk = |walking: bool, dir: i32| {
            let _ = win.emit("walk", json!({ "walking": walking, "dir": dir }));
        };
        loop {
            let busy = sh.dragging.load(Ordering::SeqCst) || (walking && !sh.paused.load(Ordering::SeqCst));
            std::thread::sleep(Duration::from_millis(if busy { 33 } else { 100 }));
            // read again after the sleep: a drag may have started meanwhile
            if sh.dragging.load(Ordering::SeqCst) {
                // window follows the global cursor; pet faces the direction of travel
                let anchor = *sh.drag_anchor.lock().unwrap();
                if let (Some((cx, cy, wx, wy)), Ok(c)) = (anchor, win.cursor_position()) {
                    let nx = wx + (c.x - cx) as i32;
                    let ny = wy + (c.y - cy) as i32;
                    let d = drag_last_x.map(|l| (nx - l).signum()).unwrap_or(0);
                    if d != 0 && d != dir {
                        dir = d;
                        emit_walk(walking, dir);
                    }
                    drag_last_x = Some(nx);
                    let _ = win.set_position(PhysicalPosition::new(nx, ny));
                }
                continue;
            }
            drag_last_x = None;
            if let (Ok(c), Ok(p), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) {
                let lx = (c.x - p.x as f64) / scale;
                let ly = (c.y - p.y as f64) / scale;
                let inside = sh
                    .rects
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| lx >= r[0] && lx < r[0] + r[2] && ly >= r[1] && ly < r[1] + r[3]);
                if inside == sh.ignoring.load(Ordering::SeqCst) {
                    if inside {
                        remember_front(&sh);
                    }
                    let _ = win.set_ignore_cursor_events(!inside);
                    sh.ignoring.store(!inside, Ordering::SeqCst);
                    let _ = win.emit("hover", inside);
                }
            }
            let t = now_ms();
            if sh.paused.load(Ordering::SeqCst) {
                if walking {
                    walking = false;
                    emit_walk(walking, dir);
                }
                until = t + rng.range(6000, 20000);
                continue;
            }
            if t >= until {
                walking = !walking;
                until = t + if walking { rng.range(2500, 6000) } else { rng.range(6000, 20000) };
                if walking && rng.range(0, 3) == 0 {
                    dir = -dir;
                }
                emit_walk(walking, dir);
            }
            if !walking {
                continue;
            }
            let Ok(Some(mon)) = win.current_monitor() else { continue };
            let Ok(p) = win.outer_position() else { continue };
            let Ok(sz) = win.outer_size() else { continue };
            let area = mon.work_area();
            let step = (2.0 * mon.scale_factor()) as i32;
            let left = area.position.x;
            let right = area.position.x + area.size.width as i32 - sz.width as i32;
            let mut nx = p.x + dir * step.max(1);
            if nx >= right || nx <= left {
                nx = nx.clamp(left, right.max(left));
                dir = -dir;
                emit_walk(walking, dir);
            }
            let _ = win.set_position(PhysicalPosition::new(nx, p.y));
        }
    });
}

/// overlay.json: the mod starts the app when this pulse is older than 60 s
fn spawn_pulse() {
    std::thread::spawn(|| {
        let b = base();
        loop {
            ensure_dirs(&b);
            let body = json!({ "v": 1, "pid": std::process::id(), "version": VERSION, "pulseAt": now_ms() });
            let _ = write_atomic(&b.join("overlay.json"), &body.to_string());
            std::thread::sleep(Duration::from_millis(PULSE_MS));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Arc::new(Shared::default());
    let ticker_state = shared.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // the mod launched us again: say hello instead of opening a second horse
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("second-instance", ());
            }
        }))
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            read_state, submit, set_hit_rects, set_dragging, set_mode, focus_input, blur_app, quit
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let win = app.get_webview_window("main").expect("main window");
            #[cfg(target_os = "macos")]
            mac_window_tweaks(&win);
            // start click-through; the ticker turns it off over visible elements
            win.set_ignore_cursor_events(true)?;
            ticker_state.ignoring.store(true, Ordering::SeqCst);
            // walking lane: low enough to look "on the floor", high enough that
            // the expanded 460×300 frame still fits without moving the pet
            if let Ok(Some(m)) = win.primary_monitor() {
                let a = m.work_area();
                let s = m.scale_factor();
                let y = a.position.y + a.size.height as i32 - (EXP_H * s) as i32;
                let x = a.position.x + (a.size.width as i32 - (W * s) as i32) / 2;
                win.set_position(PhysicalPosition::new(x, y))?;
            }
            spawn_pulse();
            spawn_ticker(win, ticker_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(name: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("horsepet-{name}-{}-{}", std::process::id(), now_ms()));
        ensure_dirs(&b);
        b
    }

    #[test]
    fn session_ids_cannot_escape_the_folder() {
        assert!(safe_sid("2f6c1a9e-0b1d-4c55-9a51-1f8d2c3b4a5e"));
        assert!(!safe_sid("../overlay"));
        assert!(!safe_sid("a/b"));
        assert!(!safe_sid(""));
        assert!(submit("../x".into(), json!({"id":"m","text":"hi"})).is_err());
    }

    #[test]
    fn a_session_is_dead_after_a_day_without_writes() {
        let now = 10 * DAY_MS;
        assert!(!is_dead(&json!({ "updatedAt": now - 1000, "pulseAt": 0 }), now));
        assert!(!is_dead(&json!({ "updatedAt": 0, "pulseAt": now - DAY_MS + 1 }), now));
        assert!(is_dead(&json!({ "updatedAt": now - DAY_MS - 1 }), now));
    }

    #[test]
    fn inbox_is_taken_by_its_own_ack_or_a_new_chat_ack() {
        let mut acks = Map::new();
        acks.insert("A".into(), json!({ "id": "m1" }));
        acks.insert("B".into(), json!({ "id": "m2", "from": "OLD" }));
        assert!(inbox_taken("A", &json!({ "id": "m1" }), &acks));
        assert!(!inbox_taken("A", &json!({ "id": "m9" }), &acks));
        assert!(inbox_taken("OLD", &json!({ "id": "m2" }), &acks));
        assert!(!inbox_taken("C", &json!({ "id": "m2" }), &acks)); // someone else's id
    }

    #[test]
    fn scan_reports_live_sessions_and_cleans_up() {
        let b = tmp_base("scan");
        let now = 10 * DAY_MS;
        let put = |rel: &str, v: Value| fs::write(b.join(rel), v.to_string()).unwrap();
        put("sessions/live.json", json!({ "sessionId": "live", "updatedAt": now - 5000 }));
        put("sessions/old.json", json!({ "sessionId": "old", "updatedAt": now - 2 * DAY_MS }));
        put("acks/old.json", json!({ "id": "x" }));
        put("acks/live.json", json!({ "id": "m1", "status": "started" }));
        put("inbox/live.json", json!({ "id": "m1", "text": "hi" }));
        fs::write(b.join("sessions/half.json"), "{\"sessionId\":").unwrap();

        let st = scan(&b, now);
        let ids: Vec<_> = st["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].clone()).collect();
        assert_eq!(ids, vec![json!("live")]);
        assert_eq!(st["acks"]["live"]["id"], "m1");
        assert!(st["acks"].get("old").is_none());
        assert!(!b.join("sessions/old.json").exists());
        assert!(!b.join("acks/old.json").exists());
        assert!(!b.join("inbox/live.json").exists(), "acked inbox is dropped");
        assert!(b.join("sessions/half.json").exists(), "half-written file is left alone");
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn inbox_write_is_atomic_and_private() {
        let b = tmp_base("write");
        let p = b.join("inbox/S1.json");
        write_atomic(&p, "{\"id\":\"m1\"}").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let left: Vec<_> = fs::read_dir(b.join("inbox")).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "no tmp file left behind");
        let _ = fs::remove_dir_all(&b);
    }
}
