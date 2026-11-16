//! `usage`: how much of the weekly limit is left, per account. Read only: files this computer already has, no
//! network, no credentials.
//!
//! Claude Code: the status line wrapper (`flockbook-statusline`) saves every session's status line input as
//! `<folder>/<session id>.json` (`status::folder`); its `rate_limits` hold the account's limits, and its
//! `transcript_path` (`<config folder>/projects/<project>/<session id>.jsonl`) says which account's session it was;
//! the transcript's mtime says when that session last replied. Every session re-saves its own last figure, so the
//! account's reading is the latest window's newest REPLY (`account_reading`), not the newest file. Those records are removed after a day, so the helper keeps each
//! account's last line in `<flockbook>/usage-accounts.json` for 30 days (`claude_lines_remembering`).
//!
//! Codex: the rollouts under `$CODEX_HOME` (else `~/.codex`) `sessions/YYYY/MM/DD/`; the last `rate_limits` in the
//! newest rollout that has one.
//!
//! Only the weekly window is read out (Claude removed its 5-hour limit; Codex's plan has only a weekly one). A past
//! `resets_at` is passed on as it was read: the mod decides what that means.

use crate::status;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The newest saved status line inputs read (the folder can hold hundreds). 1000, not 300 (s36 review P3): one busy
/// account must not push the other account's newest reading out; each is a few KB and read only until a reading is found.
pub const CLAUDE_FILES: usize = 1000;
/// A Claude Code input is a few KB; one this big is not one.
const CLAUDE_FILE_MAX: u64 = 256 * 1024;
/// Codex: how many days back from today, and how many rollouts, are looked at.
const CODEX_DAYS: u64 = 14;
const CODEX_FILES: usize = 20;
/// Codex: the end of a rollout read (they can be large).
const CODEX_TAIL: u64 = 256 * 1024;
/// The weekly window's length in Codex's `rate_limits`.
const WEEK_MINUTES: i64 = 10080;

fn mtime_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// A whole number stays an integer (64, not 64.0); others keep one decimal.
fn number(v: f64) -> Value {
    if v.fract() == 0.0 {
        json!(v as i64)
    } else {
        json!((v * 10.0).round() / 10.0)
    }
}

/// `{"left", "used", "resets_at"}` from the percent used (clamped to 0..100) and the reset time in seconds.
fn weekly(used: f64, resets_at: Option<&Value>) -> Value {
    let used = used.clamp(0.0, 100.0);
    let resets = resets_at.and_then(|r| r.as_i64().or_else(|| r.as_f64().map(|f| f as i64)));
    json!({"left": (100.0 - used).round() as i64, "used": number(used), "resets_at": resets})
}

/// The weekly reading of a Claude Code `rate_limits` object (`seven_day`); `five_hour` is never read out.
fn claude_weekly(rate_limits: &Value) -> Option<Value> {
    let w = rate_limits.get("seven_day")?;
    let used = w.get("used_percentage")?.as_f64()?;
    Some(weekly(used, w.get("resets_at")))
}

/// The config folder a saved input's transcript belongs to: the path before its last `/projects/`.
fn config_of(transcript: &str) -> Option<&str> {
    // Claude Code on Windows writes it with backslashes (s36 review P2).
    let i = [transcript.rfind("/projects/"), transcript.rfind("\\projects\\")].into_iter().flatten().max()?;
    (i > 0).then(|| &transcript[..i])
}

/// The account's email: `<config>/.claude.json`; for `$HOME/.claude` it is `$HOME/.claude.json`.
fn email_of(config: &Path, home: &Path) -> Option<String> {
    let file = if config == home.join(".claude") { home.join(".claude.json") } else { config.join(".claude.json") };
    let v: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let e = v.get("oauthAccount")?.get("emailAddress")?.as_str()?.trim();
    (!e.is_empty()).then(|| e.to_string())
}

/// Two `resets_at` this close (seconds) are the same weekly window (a new window is days later).
const SAME_WINDOW_SECS: i64 = 3600;

/// One session's reading: `at` = its status line file's mtime (ms; it is re-saved every refresh), `replied` = its
/// transcript's mtime (ms), i.e. when the figure was given; None when unknown (a missing transcript, or a line an
/// older helper remembered).
#[derive(Clone, Debug)]
struct Reading {
    at: i64,
    replied: Option<i64>,
    weekly: Value,
}

/// One account's figure from all its sessions' readings (newest file first). Every session re-saves the figure from
/// its own last reply, so an idle one keeps an old, lower one (s38 live: 58/68/75 next to 80), and a limit reset by
/// hand keeps its reset date (owner 11-17: 94% before, 62% after, same Sat 05:00), so neither "newest file" nor
/// "highest figure" is right. The latest window (`resets_at`, ± `SAME_WINDOW_SECS`), and in it the reading with the
/// newest reply (equal: the higher figure). A reading with no reply time was given at or before its `at`: it wins
/// only when it is higher and its `at` is after that reply (it could be newer); with no reply times at all, the
/// highest figure, as before (equal: the newest file). Readings without a `resets_at` count only when none has one.
fn account_reading(readings: Vec<Reading>) -> Option<Reading> {
    let resets = |r: &Reading| r.weekly["resets_at"].as_i64();
    let latest = readings.iter().filter_map(resets).max();
    let used = |r: &Reading| r.weekly["used"].as_f64().unwrap_or(0.0);
    let window: Vec<Reading> = readings
        .into_iter()
        .filter(|r| match (latest, resets(r)) {
            (Some(l), Some(x)) => x >= l - SAME_WINDOW_SECS,
            (Some(_), None) => false,
            (None, _) => true,
        })
        .collect();
    let newest_reply = window.iter().filter(|r| r.replied.is_some()).fold(None, |best: Option<&Reading>, r| match best {
        Some(b) if (b.replied, used(b)) >= (r.replied, used(r)) => best,
        _ => Some(r),
    });
    let known = newest_reply.and_then(|r| r.replied);
    // Newest first, so on equal figures the first (newest) is kept.
    let unknown = window
        .iter()
        .filter(|r| r.replied.is_none() && known.map_or(true, |k| r.at > k))
        .fold(None, |best: Option<&Reading>, r| match best {
            Some(b) if used(b) >= used(r) => best,
            _ => Some(r),
        });
    match (newest_reply, unknown) {
        (Some(k), Some(u)) if used(u) > used(k) => Some(u.clone()),
        (Some(k), _) => Some(k.clone()),
        (None, u) => u.cloned(),
    }
}

/// One `usage` line per Claude config folder with a weekly reading in `dir` (the status line wrapper's folder).
/// `home`: where the default folder's `.claude.json` is. Sorted by config folder.
pub fn claude_lines(dir: &Path, home: &Path) -> Vec<Value> {
    lines_of(claude_readings(dir), home, &BTreeMap::new())
}

/// The `usage` lines of each config folder's readings; `emails`: a remembered email per folder, used when the
/// folder's own file can't be read.
fn lines_of(read: BTreeMap<String, Vec<Reading>>, home: &Path, emails: &BTreeMap<String, String>) -> Vec<Value> {
    read.into_iter()
        .filter_map(|(config, readings)| Some((config, account_reading(readings)?)))
        .map(|(config, r)| {
            let email = email_of(Path::new(&config), home).or_else(|| emails.get(&config).cloned());
            let mut line = json!({"type": "usage", "kind": "claude", "config": config, "email": email, "weekly": r.weekly, "at": r.at});
            // `replied`: when the figure was given (ms); absent when unknown, so the mod knows to fall back.
            if let Some(t) = r.replied {
                line["replied"] = json!(t);
            }
            line
        })
        .collect()
}

/// How long the helper keeps an account's last reading after its status line records are gone (as the mod's carry).
pub const REMEMBER_MS: i64 = 30 * 24 * 3600 * 1000;
/// The file the readings are kept in, beside the wrapper's default `statusline` folder (not in it: herdr-core removes
/// that folder's `.json` files after a day).
pub const MEMORY_FILE: &str = "usage-accounts.json";

/// The remembered lines in `file` (`{"lines": [usage line…]}`), as readings per config folder plus their emails; lines
/// older than `REMEMBER_MS` at `now_ms`, or not shaped like a reading, are left out. A missing or broken file is none.
fn load_memory(file: &Path, now_ms: i64) -> (BTreeMap<String, Vec<Reading>>, BTreeMap<String, String>) {
    let (mut read, mut emails) = (BTreeMap::new(), BTreeMap::new());
    let kept = std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    for l in kept.as_ref().and_then(|v| v["lines"].as_array()).into_iter().flatten() {
        let (Some(config), Some(at), Some(w)) = (l["config"].as_str(), l["at"].as_i64(), l.get("weekly").filter(|w| w["used"].is_number())) else { continue };
        if now_ms - at > REMEMBER_MS {
            continue;
        }
        read.entry(config.to_string()).or_insert_with(Vec::new).push(Reading { at, replied: l["replied"].as_i64(), weekly: w.clone() });
        if let Some(e) = l["email"].as_str() {
            emails.insert(config.to_string(), e.to_string());
        }
    }
    (read, emails)
}

/// `claude_lines`, plus the last reading of each config folder kept in `memory` (up to `REMEMBER_MS` old), so an
/// account whose status line records were removed (a day idle) still has its line. The fresh and the remembered
/// readings go through the same rule (`account_reading`: the latest window's highest). `memory` is rewritten (a temp
/// file, then a rename) when the lines differ from it; no file is made while there is nothing to keep.
pub fn claude_lines_remembering(dir: &Path, home: &Path, memory: &Path, now_ms: i64) -> Vec<Value> {
    let mut read = claude_readings(dir);
    let (kept, emails) = load_memory(memory, now_ms);
    for (config, mut readings) in kept {
        let all = read.entry(config).or_default();
        all.append(&mut readings);
        // account_reading wants the newest first (equal figures: the newest is kept).
        all.sort_by(|a, b| b.at.cmp(&a.at));
    }
    let out = lines_of(read, home, &emails);
    let text = json!({"lines": out}).to_string();
    let old = std::fs::read(memory).ok();
    if old.as_deref() != Some(text.as_bytes()) && (old.is_some() || !out.is_empty()) {
        if let Some(folder) = memory.parent() {
            let tmp = folder.join(format!(".{MEMORY_FILE}.{}.tmp", std::process::id()));
            if std::fs::write(&tmp, &text).and_then(|_| std::fs::rename(&tmp, memory)).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
    out
}

/// The weekly readings in `dir` per config folder, each folder's newest first.
fn claude_readings(dir: &Path) -> BTreeMap<String, Vec<Reading>> {
    let Ok(entries) = std::fs::read_dir(dir) else { return BTreeMap::new() };
    let mut files: Vec<(i64, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((mtime_ms(&p)?, p)))
        .collect();
    // Newest first; the name settles equal times.
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.truncate(CLAUDE_FILES);
    let mut read: BTreeMap<String, Vec<Reading>> = BTreeMap::new();
    for (at, path) in files {
        if std::fs::metadata(&path).map_or(true, |m| m.len() > CLAUDE_FILE_MAX) {
            continue;
        }
        let Some(v) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        let transcript = v.get("transcript_path").and_then(Value::as_str);
        let (Some(config), Some(w)) = (transcript.and_then(config_of), v.get("rate_limits").and_then(claude_weekly)) else {
            continue;
        };
        let replied = transcript.and_then(|t| mtime_ms(Path::new(t)));
        read.entry(config.to_string()).or_default().push(Reading { at, replied, weekly: w });
    }
    read
}

/// The first `rate_limits` object in `v`, however deep it is nested (null does not count).
fn find_rate_limits(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(m) => {
            if let Some(r) = m.get("rate_limits").filter(|r| r.is_object()) {
                return Some(r);
            }
            m.values().find_map(find_rate_limits)
        }
        Value::Array(a) => a.iter().find_map(find_rate_limits),
        _ => None,
    }
}

/// The weekly window (10080 minutes) of a Codex `rate_limits`: its `primary` or `secondary`.
fn codex_weekly(r: &Value) -> Option<Value> {
    ["primary", "secondary"].iter().filter_map(|k| r.get(k)).find(|w| w.get("window_minutes").and_then(Value::as_i64) == Some(WEEK_MINUTES)).and_then(|w| {
        let used = w.get("used_percent")?.as_f64()?;
        Some(weekly(used, w.get("resets_at")))
    })
}

/// The last end of `path` (`CODEX_TAIL` bytes), as lines; the first is dropped when the read starts inside one.
fn tail_lines(path: &Path) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(CODEX_TAIL);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Some(lines)
}

/// The last weekly reading in one rollout: (the `rate_limits`' weekly, its plan, its time in ms).
fn codex_reading(path: &Path) -> Option<(Value, Option<String>, i64)> {
    for line in tail_lines(path)?.iter().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(r) = find_rate_limits(&v) else { continue };
        let Some(w) = codex_weekly(r) else { continue };
        let at = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
            .or_else(|| mtime_ms(path))?;
        return Some((w, r.get("plan_type").and_then(Value::as_str).map(String::from), at));
    }
    None
}

/// The `usage` line for Codex under `codex_home`: the newest day folders from `today` back 14 days, newest files
/// first, up to 20 files. None: no weekly reading found.
pub fn codex_line(codex_home: &Path, today: chrono::NaiveDate) -> Option<Value> {
    let mut seen = 0;
    for back in 0..=CODEX_DAYS {
        let day = today.checked_sub_days(chrono::Days::new(back))?;
        let dir = codex_home.join("sessions").join(day.format("%Y/%m/%d").to_string());
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<(i64, PathBuf)> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl") && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rollout-")))
            .filter_map(|p| Some((mtime_ms(&p)?, p)))
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        for (_, path) in files {
            if seen == CODEX_FILES {
                return None;
            }
            seen += 1;
            if let Some((w, plan, at)) = codex_reading(&path) {
                return Some(json!({"type": "usage", "kind": "codex", "plan": plan, "weekly": w, "at": at}));
            }
        }
    }
    None
}

/// Every `usage` line for this computer: Claude's accounts, then Codex. `env`: the process environment (HOME,
/// CLAUDE_CONFIG_DIR, CODEX_HOME). `flockbook`: `<herdr-app home>/flockbook`, whose `statusline` folder is the
/// wrapper's default when the settings name none. Claude's readings are remembered in `flockbook`'s `MEMORY_FILE`
/// (without one: beside the wrapper's folder; neither: not remembered).
pub fn lines(env: &HashMap<String, String>, flockbook: Option<&Path>, today: chrono::NaiveDate) -> Vec<Value> {
    let home = PathBuf::from(herdr_core::hc::session::home_dir(env));
    let folder = status::folder(&status::default_settings(env)).or_else(|| flockbook.map(|f| f.join("statusline")));
    let memory = flockbook.map(Path::to_path_buf).or_else(|| folder.as_deref().and_then(Path::parent).map(Path::to_path_buf)).map(|d| d.join(MEMORY_FILE));
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut out = match (folder, memory) {
        (folder, Some(m)) => claude_lines_remembering(&folder.unwrap_or_default(), &home, &m, now_ms),
        (Some(d), None) => claude_lines(&d, &home),
        (None, None) => vec![],
    };
    let codex = env.get("CODEX_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    out.extend(codex_line(&codex, today));
    out
}

/// Today on this computer (Codex names its day folders by local date).
pub fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::config_of;

    // s36 review P2: Claude Code on Windows writes transcript_path with backslashes; the PC helper found no account.
    #[test]
    fn config_of_reads_unix_and_windows_transcript_paths() {
        assert_eq!(config_of("/Users/x/.claude/projects/-Users-x/abc.jsonl"), Some("/Users/x/.claude"));
        assert_eq!(config_of(r"C:\Users\x\.claude\projects\C--Users-x\abc.jsonl"), Some(r"C:\Users\x\.claude"));
        assert_eq!(config_of(r"C:\Users\x\.claude-ew\projects\p\abc.jsonl"), Some(r"C:\Users\x\.claude-ew"));
        // The last one wins (a project folder itself named projects).
        assert_eq!(config_of("/h/.claude/projects/-h-projects-/a.jsonl"), Some("/h/.claude"));
        assert_eq!(config_of("/projects/a.jsonl"), None);
        assert_eq!(config_of("no folder"), None);
    }
}
