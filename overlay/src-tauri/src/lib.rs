// Spike S3: throwaway overlay. Transparent always-on-top window that walks
// along the bottom of the screen. Clicks pass through everything except the
// visible elements (cursor polled + hit-tested here, ignore-cursor-events
// toggled per element). Hover shows a pill, ✎ / click turns it into an input,
// Enter drops a JSON file into ~/.claude-pet/inbox.
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const W: f64 = 192.0;
const H: f64 = 208.0;
const EXP_W: f64 = 460.0;
const EXP_H: f64 = 300.0;

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

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn log_line(msg: &str) {
    let dir = home().join(".claude-pet");
    let _ = DirBuilder::new().recursive(true).mode(0o700).create(&dir);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("overlay-spike.log")) {
        let _ = writeln!(f, "{} pid={} {}", now_ms(), std::process::id(), msg);
    }
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn log(msg: String) {
    log_line(&format!("js: {msg}"));
}

#[tauri::command]
fn submit(text: String, id: String, created_at: String) -> Result<String, String> {
    let dir = home().join(".claude-pet").join("inbox");
    DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(e2s)?;
    let body = serde_json::json!({ "id": id, "text": text, "createdAt": created_at });
    let name = format!("test-{}.json", now_ms());
    let tmp = dir.join(format!(".{name}.tmp"));
    let dst = dir.join(&name);
    {
        let mut f = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&tmp).map_err(e2s)?;
        f.write_all(body.to_string().as_bytes()).map_err(e2s)?;
    }
    fs::rename(&tmp, &dst).map_err(e2s)?;
    log_line(&format!("submit -> {}", dst.display()));
    Ok(dst.display().to_string())
}

#[tauri::command]
fn set_hit_rects(st: St, rects: Vec<[f64; 4]>) {
    *st.rects.lock().unwrap() = rects;
}

#[tauri::command]
fn set_paused(st: St, paused: bool) {
    st.paused.store(paused, Ordering::SeqCst);
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
    log_line(&format!("dragging={dragging}"));
}

/// compact = 192×208 (pet only), expanded = 460×300 (pet + pill + card).
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
    log_line(&format!("set_mode expanded={expanded}"));
    Ok(())
}

#[tauri::command]
fn focus_input(window: WebviewWindow, st: St) -> Result<(), String> {
    remember_front(&st);
    window.set_focus().map_err(e2s)?;
    log_line(&format!("focus_input focused={:?}", window.is_focused()));
    Ok(())
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
        let ok = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .map(|a| a.activateWithOptions(NSApplicationActivationOptions::empty()))
            .unwrap_or(false);
        log_line(&format!("blur_app -> pid {pid} activated={ok}"));
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
    log_line(&format!("mac tweaks: behavior={:?} level={}", ns.collectionBehavior(), ns.level()));
}

/// 30 Hz: (1) hit-test the global cursor against visible elements and toggle
/// click-through; (2) walk along x when not paused / dragged.
fn spawn_ticker(win: WebviewWindow, sh: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut dir: i32 = 1;
        let mut drag_last_x: Option<i32> = None;
        loop {
            let was_dragging = sh.dragging.load(Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(if was_dragging { 16 } else { 33 }));
            // read again after the sleep: a drag may have started meanwhile
            let dragging = sh.dragging.load(Ordering::SeqCst);
            if dragging {
                // window follows the global cursor; pet faces the direction of travel
                let anchor = *sh.drag_anchor.lock().unwrap();
                if let (Some((cx, cy, wx, wy)), Ok(c)) = (anchor, win.cursor_position()) {
                    let nx = wx + (c.x - cx) as i32;
                    let ny = wy + (c.y - cy) as i32;
                    let d = drag_last_x.map(|l| (nx - l).signum()).unwrap_or(0);
                    if d != 0 && d != dir {
                        dir = d;
                        let _ = win.emit("dir", dir);
                        log_line(&format!("drag dir={dir}"));
                    }
                    drag_last_x = Some(nx);
                    let _ = win.set_position(PhysicalPosition::new(nx, ny));
                }
                continue;
            }
            drag_last_x = None;
            if !dragging {
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
                        log_line(&format!("hover={inside} ignore_cursor={} at {lx:.0},{ly:.0}", !inside));
                    }
                }
            }
            if dragging || sh.paused.load(Ordering::SeqCst) {
                continue;
            }
            let Ok(Some(mon)) = win.current_monitor() else { continue };
            let Ok(p) = win.outer_position() else { continue };
            let Ok(sz) = win.outer_size() else { continue };
            let area = mon.work_area();
            let scale = mon.scale_factor();
            let left = area.position.x;
            let right = area.position.x + area.size.width as i32 - sz.width as i32;
            let mut nx = p.x + dir * (scale as i32).max(1);
            if nx >= right {
                nx = right;
                dir = -1;
                let _ = win.emit("dir", dir);
            } else if nx <= left {
                nx = left;
                dir = 1;
                let _ = win.emit("dir", dir);
            }
            let _ = win.set_position(PhysicalPosition::new(nx, p.y));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Arc::new(Shared::default());
    let ticker_state = shared.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log_line(&format!("second instance blocked, argv={argv:?}"));
            if let Some(w) = app.get_webview_window("main") {
                // spike-only hook: `overlay --selftest[-drag]` drives the UI paths
                let ev = if argv.iter().any(|a| a == "--selftest") {
                    "selftest"
                } else if argv.iter().any(|a| a == "--selftest-drag") {
                    "selftest-drag"
                } else {
                    "second-instance"
                };
                let _ = w.emit(ev, ());
            }
        }))
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            submit, set_hit_rects, set_paused, set_dragging, set_mode, focus_input, blur_app, log
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
                win.set_position(PhysicalPosition::new(a.position.x, y))?;
            }
            log_line("started");
            spawn_ticker(win, ticker_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
