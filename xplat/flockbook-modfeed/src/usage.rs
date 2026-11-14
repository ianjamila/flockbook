//! `usage`: how much of the weekly limit is left, per account. Read only: files this computer already has, no
//! network, no credentials.
//!
//! Claude Code: the status line wrapper (`flockbook-statusline`) saves every session's status line input as
//! `<folder>/<session id>.json` (`status::folder`); its `rate_limits` hold the account's limits, and its
//! `transcript_path` (`<config folder>/projects/<project>/<session id>.jsonl`) says which account's session it was.
//! The newest file (mtime) of each config folder is that account's reading.
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

/// The newest saved status line inputs read (the folder can hold hundreds).
const CLAUDE_FILES: usize = 300;
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
    let i = transcript.rfind("/projects/")?;
    (i > 0).then(|| &transcript[..i])
}

/// The account's email: `<config>/.claude.json`; for `$HOME/.claude` it is `$HOME/.claude.json`.
fn email_of(config: &Path, home: &Path) -> Option<String> {
    let file = if config == home.join(".claude") { home.join(".claude.json") } else { config.join(".claude.json") };
    let v: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let e = v.get("oauthAccount")?.get("emailAddress")?.as_str()?.trim();
    (!e.is_empty()).then(|| e.to_string())
}

/// One `usage` line per Claude config folder with a weekly reading in `dir` (the status line wrapper's folder).
/// `home`: where the default folder's `.claude.json` is. Sorted by config folder.
pub fn claude_lines(dir: &Path, home: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut files: Vec<(i64, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((mtime_ms(&p)?, p)))
        .collect();
    // Newest first; the name settles equal times.
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.truncate(CLAUDE_FILES);
    let mut found: BTreeMap<String, (i64, Value)> = BTreeMap::new();
    for (at, path) in files {
        if std::fs::metadata(&path).map_or(true, |m| m.len() > CLAUDE_FILE_MAX) {
            continue;
        }
        let Some(v) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        let (Some(config), Some(w)) = (v.get("transcript_path").and_then(Value::as_str).and_then(config_of), v.get("rate_limits").and_then(claude_weekly)) else {
            continue;
        };
        found.entry(config.to_string()).or_insert((at, w));
    }
    found
        .into_iter()
        .map(|(config, (at, w))| {
            let email = email_of(Path::new(&config), home);
            json!({"type": "usage", "kind": "claude", "config": config, "email": email, "weekly": w, "at": at})
        })
        .collect()
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
/// wrapper's default when the settings name none.
pub fn lines(env: &HashMap<String, String>, flockbook: Option<&Path>, today: chrono::NaiveDate) -> Vec<Value> {
    let home = PathBuf::from(herdr_core::hc::session::home_dir(env));
    let folder = status::folder(&status::default_settings(env)).or_else(|| flockbook.map(|f| f.join("statusline")));
    let mut out = folder.map(|d| claude_lines(&d, &home)).unwrap_or_default();
    let codex = env.get("CODEX_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    out.extend(codex_line(&codex, today));
    out
}

/// Today on this computer (Codex names its day folders by local date).
pub fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}
