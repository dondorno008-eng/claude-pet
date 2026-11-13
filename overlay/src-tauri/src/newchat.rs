// A request from the horse's bar becomes a NEW Claude Code chat that runs in the
// background: `claude --bg -- <text>` in the project folder. No window opens. The
// horse-pet mod loads in that session like in any other, so its status reaches
// the card through sessions/<id>.json, and ↩ / ■ go through inbox/ as usual.
use std::path::{Path, PathBuf};
use std::process::Command;

/// where the `claude` CLI is: a GUI app does not get the shell's PATH. Last resort — the copy
/// inside the Claude desktop app (the newest version), as install.sh does
pub fn claude_bin(home: &Path) -> Option<PathBuf> {
    [
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .or_else(|| desktop_cli(home))
}

/// ~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude
fn desktop_cli(home: &Path) -> Option<PathBuf> {
    let root = home.join("Library/Application Support/Claude/claude-code");
    let ver = |p: &Path| -> Vec<u32> {
        p.file_name().and_then(|n| n.to_str()).unwrap_or("").split('.').map(|x| x.parse().unwrap_or(0)).collect()
    };
    let mut found: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .flat_map(|v| std::fs::read_dir(v.path()).into_iter().flatten().flatten())
        .map(|b| b.path().join("claude.app/Contents/MacOS/claude"))
        .filter(|p| p.is_file())
        .collect();
    found.sort_by_key(|p| p.ancestors().nth(5).map(ver));
    found.pop()
}

const SIGN_IN: &str = "Claude Code в Терминале не вошёл в аккаунт. Откройте «Терминал» и выполните: claude auth login";

/// the CLI keeps its own sign-in, apart from the Claude app; true only when it says so for sure
fn logged_out(bin: &Path) -> bool {
    Command::new(bin)
        .args(["auth", "status"])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .and_then(|v| v.get("loggedIn").and_then(|b| b.as_bool()))
        == Some(false)
}

/// the terminal screen without colours and cursor moves, whitespace collapsed, lower case
fn plain(screen: &str) -> String {
    let mut out = String::with_capacity(screen.len());
    let mut it = screen.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.next() {
                Some('[') => while let Some(x) = it.next() { if ('@'..='~').contains(&x) { break; } },
                Some(']') => while let Some(x) = it.next() { if x == '\x07' || x == '\\' { break; } },
                _ => {}
            }
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// what a silent background chat's screen is stuck on, in plain words
pub fn hint_for(screen: &str) -> Option<String> {
    let s = plain(screen);
    let has = |ws: &[&str]| ws.iter().any(|w| s.contains(w));
    if has(&["not logged in", "please run /login", "invalid api key", "oauth token has expired", "select login method"]) {
        return Some(SIGN_IN.into());
    }
    if has(&["choose the text style", "welcome to claude code"]) {
        return Some("Claude Code в Терминале ещё не настроен. Откройте «Терминал», выполните claude и пройдите первый запуск".into());
    }
    if has(&["do you trust", "trust the files"]) {
        return Some("Claude Code не доверяет этой папке. Откройте её в Терминале, выполните claude и согласитесь".into());
    }
    if has(&["usage limit", "hit your limit", "credit balance"]) {
        return Some("Лимит Claude закончился — новый чат подождёт, пока он обновится".into());
    }
    None
}

/// why a new background chat has not reported yet: `claude logs <id>` shows its screen
pub fn why_silent(home: &Path, short: &str) -> Option<String> {
    let bin = claude_bin(home)?;
    let out = Command::new(bin).args(["logs", short]).output().ok()?;
    hint_for(&format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// the short session id from `claude --bg` output: "backgrounded · 3f35592d"
pub fn short_id(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("backgrounded"))
        .and_then(|rest| rest.split_whitespace().last())
        .filter(|id| id.len() >= 6 && id.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
}

/// starts the chat; Ok(short id) or Err(what the CLI said, first line)
pub fn start(home: &Path, folder: &Path, text: &str) -> Result<String, String> {
    let bin = claude_bin(home).ok_or("не найден claude (Claude Code в терминале)")?;
    if logged_out(&bin) {
        return Err(SIGN_IN.into());
    }
    let out = Command::new(bin)
        .args(["--bg", "--", text])
        .current_dir(folder)
        .output()
        .map_err(|e| e.to_string())?;
    let all = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    match short_id(&all) {
        Some(id) if out.status.success() => Ok(id),
        _ => Err(all.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("claude не запустился").to_string()),
    }
}

/// the card's ↗: the chat opens in the Claude app, where the whole answer is. A background
/// chat is stopped first (one writer per session); the app imports it by its id and shows it.
pub fn open_in_app(home: &Path, sid: &str, background: bool) -> Result<(), String> {
    if background {
        if let Some(bin) = claude_bin(home) {
            let _ = Command::new(bin).args(["stop", &sid[..8.min(sid.len())]]).output();
        }
    }
    let ok = Command::new("/usr/bin/open")
        .arg(format!("claude://resume?session={sid}"))
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if ok { Ok(()) } else { Err("Claude не открылся".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_short_id_comes_from_the_backgrounded_line() {
        let out = "Starting background service…\nbackgrounded · 3f35592d\n  claude agents   list sessions\n";
        assert_eq!(short_id(out).as_deref(), Some("3f35592d"));
        assert_eq!(short_id("Workspace not trusted. Run `claude` …"), None);
        assert_eq!(short_id("backgrounded · ../etc"), None);
    }

    #[test]
    fn a_silent_chat_stuck_on_sign_in_says_so() {
        let screen = "\x1b[2J\x1b[H\x1b[38;2;1;2;3mNot\x1b[1Clogged in\x1b[39m · Please run /login";
        assert_eq!(hint_for(screen).as_deref(), Some(SIGN_IN));
        assert_eq!(hint_for("\x1b[1m⏺\x1b[22m ок · Cogitated for 5s"), None);
    }
}
