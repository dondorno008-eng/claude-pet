// A request from the horse's bar becomes a NEW Claude Code chat that runs in the
// background: `claude --bg -- <text>` in the project folder. No window opens. The
// horse-pet mod loads in that session like in any other, so its status reaches
// the card through sessions/<id>.json, and ↩ / ■ go through inbox/ as usual.
use std::path::{Path, PathBuf};
use std::process::Command;

/// where the `claude` CLI is: a GUI app does not get the shell's PATH
pub fn claude_bin(home: &Path) -> Option<PathBuf> {
    [
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]
    .into_iter()
    .find(|p| p.is_file())
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
}
