// A request from the horse's bar becomes a NEW chat in Claude's desktop app:
// `claude://code/new?q=<text>&folder=<dir>` opens the new-session page with the
// text in its prompt field. Pressing Enter there is the person's, unless HorsePet
// holds the Accessibility permission: then it checks through AX that Claude is in
// front and its focused field holds exactly our text, and only then sends Return.

/// percent-encode everything but RFC 3986 unreserved characters
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn new_chat_url(text: &str, folder: Option<&str>) -> String {
    let mut u = format!("claude://code/new?q={}", encode(text));
    if let Some(f) = folder.filter(|f| f.starts_with('/')) {
        u.push_str("&folder=");
        u.push_str(&encode(f));
    }
    u
}

/// whitespace-insensitive equality: the field may render line breaks its own way
pub fn same_text(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

pub const CLAUDE_BUNDLE: &str = "com.anthropic.claudefordesktop";

#[cfg(target_os = "macos")]
pub mod mac {
    use std::ffi::{CString, c_void};
    use std::time::{Duration, Instant};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(el: AXUIElementRef, attr: CFStringRef, out: *mut CFTypeRef) -> i32;
        fn AXUIElementSetAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: CFTypeRef) -> i32;
        fn CGEventCreateKeyboardEvent(src: *const c_void, key: u16, down: bool) -> *const c_void;
        fn CGEventPostToPid(pid: i32, ev: *const c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const i8, enc: u32) -> CFStringRef;
        fn CFGetTypeID(v: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetLength(s: CFStringRef) -> isize;
        fn CFStringGetCString(s: CFStringRef, buf: *mut i8, size: isize, enc: u32) -> bool;
        fn CFRelease(v: CFTypeRef);
    }
    const UTF8: u32 = 0x0800_0100;
    const RETURN_KEY: u16 = 36;

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    fn cfstr(s: &str) -> CFStringRef {
        let c = CString::new(s).unwrap_or_default();
        unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) }
    }

    fn to_string(v: CFTypeRef) -> Option<String> {
        unsafe {
            if v.is_null() || CFGetTypeID(v) != CFStringGetTypeID() {
                return None;
            }
            let size = CFStringGetLength(v) * 4 + 1;
            let mut buf = vec![0i8; size as usize];
            if !CFStringGetCString(v, buf.as_mut_ptr(), size, UTF8) {
                return None;
            }
            let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
            String::from_utf8(bytes).ok()
        }
    }

    /// owned CF attribute value; caller releases
    fn attr(el: AXUIElementRef, name: &str) -> CFTypeRef {
        let key = cfstr(name);
        let mut out: CFTypeRef = std::ptr::null();
        unsafe {
            AXUIElementCopyAttributeValue(el, key, &mut out);
            CFRelease(key);
        }
        out
    }

    /// value of the focused text element of app `pid`, if any
    fn focused_value(app: AXUIElementRef) -> Option<String> {
        let el = attr(app, "AXFocusedUIElement");
        if el.is_null() {
            return None;
        }
        let v = attr(el, "AXValue");
        let s = to_string(v);
        unsafe {
            if !v.is_null() {
                CFRelease(v);
            }
            CFRelease(el);
        }
        s
    }

    fn claude_pid() -> Option<i32> {
        use objc2_app_kit::NSRunningApplication;
        use objc2_foundation::NSString;
        let id = NSString::from_str(super::CLAUDE_BUNDLE);
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&id);
        apps.iter().next().map(|a| a.processIdentifier())
    }

    fn front_pid() -> i32 {
        objc2_app_kit::NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier())
            .unwrap_or(-1)
    }

    /// wait until Claude is in front with exactly `text` in its focused field, then press Return.
    /// true = pressed. Never presses on a guess.
    pub fn press_enter_when_ready(text: &str, timeout: Duration) -> bool {
        if !trusted() {
            return false;
        }
        let Some(pid) = claude_pid() else { return false };
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return false;
        }
        // Chromium builds its AX tree only for assistive clients that ask for it
        let k = cfstr("AXManualAccessibility");
        unsafe {
            AXUIElementSetAttributeValue(app, k, kCFBooleanTrue);
            CFRelease(k);
        }
        let start = Instant::now();
        let mut pressed = false;
        while start.elapsed() < timeout {
            if front_pid() == pid && focused_value(app).is_some_and(|v| super::same_text(&v, text)) {
                // the field may still be settling: confirm once more a moment later
                std::thread::sleep(Duration::from_millis(150));
                if front_pid() == pid && focused_value(app).is_some_and(|v| super::same_text(&v, text)) {
                    unsafe {
                        for down in [true, false] {
                            let ev = CGEventCreateKeyboardEvent(std::ptr::null(), RETURN_KEY, down);
                            if !ev.is_null() {
                                CGEventPostToPid(pid, ev);
                                CFRelease(ev);
                            }
                        }
                    }
                    pressed = true;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        unsafe { CFRelease(app) };
        pressed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_carries_the_whole_text_and_folder() {
        let u = new_chat_url("Найди новости\nи «итоги» & 100%", Some("/Users/n/my proj"));
        assert!(u.starts_with("claude://code/new?q="));
        let q = u.split("&folder=").next().unwrap().trim_start_matches("claude://code/new?q=");
        assert!(!q.contains('&') && !q.contains(' ') && !q.contains('\n'));
        assert!(q.contains("%0A"), "line breaks survive");
        assert!(u.ends_with("&folder=%2FUsers%2Fn%2Fmy%20proj"));
        assert_eq!(new_chat_url("x", Some("relative")), "claude://code/new?q=x");
        assert_eq!(new_chat_url("x", None), "claude://code/new?q=x");
    }

    #[test]
    fn field_text_matches_regardless_of_line_breaks() {
        assert!(same_text("a\nb  c", "a b\nc"));
        assert!(!same_text("a b", "a b c"));
        assert!(!same_text("", "a"));
    }
}
