//! `usage`: the weekly limit left per account, read from files only (the status line wrapper's saved input for Claude
//! Code, the rollouts under CODEX_HOME for Codex). Temp folders; no network.
#![cfg(unix)]

use chrono::NaiveDate;
use modfeedkit::usage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

const BIN: &str = env!("CARGO_BIN_EXE_flockbook-modfeed");

fn set_mtime(path: &Path, secs: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}

/// A saved status line input: `config`'s session `sid` with the given `rate_limits`, written at `mtime` (seconds).
fn session(dir: &Path, sid: &str, config: &str, rate_limits: Option<Value>, mtime: u64) {
    std::fs::create_dir_all(dir).unwrap();
    let mut v = json!({"session_id": sid, "transcript_path": format!("{config}/projects/-Users-x/{sid}.jsonl"), "model": {"id": "m"}});
    if let Some(r) = rate_limits {
        v["rate_limits"] = r;
    }
    let p = dir.join(format!("{sid}.json"));
    std::fs::write(&p, v.to_string()).unwrap();
    set_mtime(&p, mtime);
}

fn weekly(used: f64, resets: i64) -> Value {
    json!({"seven_day": {"used_percentage": used, "resets_at": resets}})
}

fn find<'a>(lines: &'a [Value], config: &str) -> &'a Value {
    lines.iter().find(|l| l["kind"] == "claude" && l["config"] == config).unwrap_or_else(|| panic!("no line for {config}: {lines:?}"))
}

#[test]
fn claude_newest_file_per_config_wins() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    let (a, b) = (format!("{}/.claude", home.display()), format!("{}/.claude-eaglewatch", home.display()));
    session(&dir, "a-old", &a, Some(weekly(10.0, 1_795_000_000)), 1_000);
    session(&dir, "a-new", &a, Some(weekly(64.0, 1_795_208_400)), 2_000);
    session(&dir, "b-only", &b, Some(weekly(30.0, 1_795_300_000)), 1_500);
    let lines = usage::claude_lines(&dir, &home);
    assert_eq!(lines.len(), 2, "{lines:?}");
    let l = find(&lines, &a);
    assert_eq!(l["type"], "usage");
    assert_eq!(l["weekly"], json!({"left": 36, "used": 64, "resets_at": 1_795_208_400}));
    assert_eq!(l["at"], 2_000_000, "at is the file's mtime in ms");
    let l = find(&lines, &b);
    assert_eq!(l["weekly"], json!({"left": 70, "used": 30, "resets_at": 1_795_300_000}));
    assert_eq!(l["at"], 1_500_000);
}

#[test]
fn claude_transcript_path_names_the_config_folder() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    // A config folder that itself has "/projects/" in its path: the last one is the split.
    let cfg = format!("{}/projects/work/.claude-x", home.display());
    session(&dir, "s1", &cfg, Some(weekly(5.0, 1_795_000_000)), 100);
    let lines = usage::claude_lines(&dir, &home);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["config"], cfg.as_str());
}

#[test]
fn claude_email_from_the_config_folders_own_file_and_the_default_from_home() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(home.join(".claude-eaglewatch")).unwrap();
    std::fs::create_dir_all(home.join(".claude-none")).unwrap();
    // The default folder's file is $HOME/.claude.json, not .claude/.claude.json (which says another account).
    std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.test"}}"#).unwrap();
    std::fs::write(home.join(".claude/.claude.json"), r#"{"oauthAccount":{"emailAddress":"wrong@example.test"}}"#).unwrap();
    std::fs::write(home.join(".claude-eaglewatch/.claude.json"), r#"{"oauthAccount":{"emailAddress":"work@example.test"}}"#).unwrap();
    for (i, d) in [".claude", ".claude-eaglewatch", ".claude-none"].iter().enumerate() {
        session(&dir, &format!("s{i}"), &format!("{}/{d}", home.display()), Some(weekly(1.0, 1_795_000_000)), 100 + i as u64);
    }
    let lines = usage::claude_lines(&dir, &home);
    assert_eq!(find(&lines, &format!("{}/.claude", home.display()))["email"], "me@example.test");
    assert_eq!(find(&lines, &format!("{}/.claude-eaglewatch", home.display()))["email"], "work@example.test");
    assert_eq!(find(&lines, &format!("{}/.claude-none", home.display()))["email"], Value::Null);
}

#[test]
fn claude_files_without_rate_limits_or_a_weekly_window_are_skipped() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    let a = format!("{}/.claude", home.display());
    session(&dir, "old-good", &a, Some(weekly(40.0, 1_795_000_000)), 1_000);
    session(&dir, "new-none", &a, None, 3_000);
    // Only a five_hour window (Claude removed it, but it can still arrive alone): not a weekly reading.
    session(&dir, "new-five", &a, Some(json!({"five_hour": {"used_percentage": 99, "resets_at": 1_795_000_000}})), 2_000);
    std::fs::write(dir.join("junk.json"), "{ not json").unwrap();
    std::fs::write(dir.join("old-good.out"), "text").unwrap();
    let lines = usage::claude_lines(&dir, &home);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["weekly"]["used"], 40);
    assert_eq!(lines[0]["at"], 1_000_000);
    assert!(lines[0].get("five_hour").is_none() && lines[0]["weekly"].get("five_hour").is_none(), "five_hour is read but never shown");
    // Nothing at all: no line, and a folder that is not there is no line either.
    assert!(usage::claude_lines(&t.path().join("empty"), &home).is_empty());
}

#[test]
fn claude_the_five_hour_window_is_ignored_when_both_are_there() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    let a = format!("{}/.claude", home.display());
    session(&dir, "s", &a, Some(json!({"five_hour": {"used_percentage": 99, "resets_at": 1}, "seven_day": {"used_percentage": 20, "resets_at": 1_795_000_000}})), 10);
    let l = &usage::claude_lines(&dir, &home)[0];
    assert_eq!(l["weekly"], json!({"left": 80, "used": 20, "resets_at": 1_795_000_000}));
    assert!(l.get("five_hour").is_none());
}

#[test]
fn claude_a_past_reset_is_passed_through_and_the_numbers_are_clamped() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    let (a, b) = (format!("{}/.claude", home.display()), format!("{}/.claude-b", home.display()));
    // resets_at long ago: the mod decides what that means; the helper says what it read.
    session(&dir, "s1", &a, Some(weekly(63.6, 1_000)), 10);
    session(&dir, "s2", &b, Some(weekly(130.0, 1_795_000_000)), 10);
    let lines = usage::claude_lines(&dir, &home);
    let l = find(&lines, &a);
    assert_eq!(l["weekly"]["resets_at"], 1_000);
    assert_eq!(l["weekly"]["used"], 63.6);
    assert_eq!(l["weekly"]["left"], 36, "100 - 63.6, rounded");
    let l = find(&lines, &b);
    assert_eq!(l["weekly"]["left"], 0, "never below 0");
    assert_eq!(l["weekly"]["used"], 100, "nor above 100");
}

#[test]
fn claude_reads_at_most_the_300_newest_files() {
    let t = tempfile::tempdir().unwrap();
    let (dir, home) = (t.path().join("statusline"), t.path().join("home"));
    let (a, old) = (format!("{}/.claude", home.display()), format!("{}/.claude-old", home.display()));
    // The oldest file is the only one of its config: it is past the 300.
    session(&dir, "ancient", &old, Some(weekly(9.0, 1_795_000_000)), 5);
    for i in 0..300 {
        session(&dir, &format!("n{i:03}"), &a, Some(weekly(1.0, 1_795_000_000)), 1_000 + i);
    }
    let lines = usage::claude_lines(&dir, &home);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["config"], a.as_str());
}

// ---- Codex ----

fn day(codex: &Path, d: NaiveDate) -> PathBuf {
    let p = codex.join("sessions").join(d.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn rollout(dir: &Path, name: &str, lines: &[String], mtime: u64) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    set_mtime(&p, mtime);
    p
}

fn limits_line(ts: &str, used: f64, resets: i64) -> String {
    json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count", "info": null, "rate_limits": {"limit_id": "codex",
        "primary": {"used_percent": used, "window_minutes": 10080, "resets_at": resets}, "secondary": null, "plan_type": "prolite"}}})
    .to_string()
}

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 15).unwrap()
}

#[test]
fn codex_nested_rate_limits_and_the_weekly_window_wherever_it_is() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    let line = json!({"timestamp": "2026-11-15T10:00:00.000Z", "payload": {"deeper": {"x": [{"rate_limits": {"plan_type": "plus",
        "primary": {"used_percent": 3.0, "window_minutes": 300, "resets_at": 1_795_000_001},
        "secondary": {"used_percent": 20.0, "window_minutes": 10080, "resets_at": 1_795_252_974}}}]}}})
    .to_string();
    rollout(&d, "rollout-a.jsonl", &[line], 5_000);
    let l = usage::codex_line(&codex, today()).unwrap();
    assert_eq!(l["type"], "usage");
    assert_eq!(l["kind"], "codex");
    assert_eq!(l["plan"], "plus");
    assert_eq!(l["weekly"], json!({"left": 80, "used": 20, "resets_at": 1_795_252_974}), "the 10080-minute window, not the 300-minute one");
    assert_eq!(l["at"], 1_794_736_800_000_i64, "the line's own timestamp, in ms");
    assert!(l.get("config").is_none());
}

#[test]
fn codex_takes_the_last_reading_of_the_newest_file_that_has_one() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    rollout(&d, "rollout-old.jsonl", &[limits_line("2026-11-15T01:00:00.000Z", 70.0, 1_795_000_000)], 1_000);
    rollout(
        &d,
        "rollout-mid.jsonl",
        &[
            limits_line("2026-11-15T02:00:00.000Z", 40.0, 1_795_000_000),
            limits_line("2026-11-15T03:00:00.000Z", 45.0, 1_795_000_000),
            r#"{"timestamp":"2026-11-15T03:00:01.000Z","payload":{"rate_limits":null}}"#.to_string(),
            r#"{"timestamp":"2026-11-15T03:00:02.000Z","payload":{"type":"message"}}"#.to_string(),
        ],
        2_000,
    );
    // Newest by mtime, but no rate_limits at all: skipped.
    rollout(&d, "rollout-new.jsonl", &[r#"{"timestamp":"2026-11-15T04:00:00.000Z","payload":{"type":"message"}}"#.to_string()], 3_000);
    let l = usage::codex_line(&codex, today()).unwrap();
    assert_eq!(l["weekly"]["used"], 45, "the last reading of rollout-mid, not its first or the older file's");
}

#[test]
fn codex_walks_back_from_today_for_14_days_and_no_further() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    day(&codex, today()); // today: an empty folder
    let (near, far) = (today() - chrono::Days::new(14), today() - chrono::Days::new(15));
    rollout(&day(&codex, far), "rollout-far.jsonl", &[limits_line("2026-10-31T01:00:00.000Z", 99.0, 1_795_000_000)], 9_000);
    assert!(usage::codex_line(&codex, today()).is_none(), "15 days back is not looked at");
    rollout(&day(&codex, near), "rollout-near.jsonl", &[limits_line("2026-11-01T01:00:00.000Z", 12.0, 1_795_000_000)], 1_000);
    assert_eq!(usage::codex_line(&codex, today()).unwrap()["weekly"]["used"], 12, "the newest day that has one wins");
    let yesterday = today() - chrono::Days::new(1);
    rollout(&day(&codex, yesterday), "rollout-y.jsonl", &[limits_line("2026-11-14T01:00:00.000Z", 33.0, 1_795_000_000)], 500);
    assert_eq!(usage::codex_line(&codex, today()).unwrap()["weekly"]["used"], 33, "a newer day beats an older file with a newer mtime");
}

#[test]
fn codex_looks_at_20_files_at_most() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    rollout(&d, "rollout-reading.jsonl", &[limits_line("2026-11-15T01:00:00.000Z", 50.0, 1_795_000_000)], 10);
    for i in 0..20 {
        rollout(&d, &format!("rollout-empty{i:02}.jsonl"), &[r#"{"payload":{}}"#.to_string()], 1_000 + i);
    }
    assert!(usage::codex_line(&codex, today()).is_none(), "the reading is the 21st file");
}

#[test]
fn codex_reads_only_the_tail_of_a_big_file() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    // 600 KB of one huge line first (cut in the middle by the tail read), then the reading at the end.
    let big = json!({"timestamp": "2026-11-15T01:00:00.000Z", "payload": {"text": "x".repeat(600 * 1024), "rate_limits": {"note": "inside the cut part"}}}).to_string();
    rollout(&d, "rollout-big.jsonl", &[big, limits_line("2026-11-15T05:00:00.000Z", 61.0, 1_795_000_000)], 100);
    let l = usage::codex_line(&codex, today()).unwrap();
    assert_eq!(l["weekly"]["used"], 61);
    // A file with a line cut at the start of the tail does not break the reading.
    let d2 = day(&codex, today() - chrono::Days::new(1));
    let filler = format!("{}\n", "y".repeat(300 * 1024));
    let p = d2.join("rollout-tail.jsonl");
    std::fs::write(&p, format!("{filler}{}\n", limits_line("2026-11-14T05:00:00.000Z", 7.0, 1_795_000_000))).unwrap();
    let only_old = tempfile::tempdir().unwrap();
    let d3 = day(only_old.path(), today());
    std::fs::copy(&p, d3.join("rollout-tail.jsonl")).unwrap();
    assert_eq!(usage::codex_line(only_old.path(), today()).unwrap()["weekly"]["used"], 7);
}

#[test]
fn codex_without_a_timestamp_uses_the_files_mtime() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    let line = json!({"payload": {"rate_limits": {"secondary": {"used_percent": 100.0, "window_minutes": 10080, "resets_at": 1_795_000_000}}}}).to_string();
    rollout(&d, "rollout-a.jsonl", &[line], 7_000);
    let l = usage::codex_line(&codex, today()).unwrap();
    assert_eq!(l["at"], 7_000_000);
    assert_eq!(l["weekly"]["left"], 0);
    assert_eq!(l["plan"], Value::Null);
}

#[test]
fn codex_a_window_that_is_not_weekly_is_no_reading() {
    let t = tempfile::tempdir().unwrap();
    let codex = t.path().join("codex");
    let d = day(&codex, today());
    let line = json!({"timestamp": "2026-11-15T01:00:00.000Z", "payload": {"rate_limits": {"primary": {"used_percent": 3.0, "window_minutes": 300, "resets_at": 1}}}}).to_string();
    rollout(&d, "rollout-a.jsonl", &[line], 7_000);
    assert!(usage::codex_line(&codex, today()).is_none());
    assert!(usage::codex_line(&t.path().join("nothing"), today()).is_none());
}

// ---- the command ----

fn run(args: &[&str], env: &[(&str, &Path)]) -> Vec<Value> {
    let mut c = Command::new(BIN);
    c.args(args).env_clear().env("HC_SOCKET", "/nonexistent.sock");
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.output().unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn version_lists_usage() {
    let v = run(&["version"], &[]);
    assert!(v[1]["commands"].as_array().unwrap().iter().any(|c| c == "usage"), "{v:?}");
}

#[test]
fn the_command_prints_one_line_per_account_found_and_nothing_for_the_rest() {
    let t = tempfile::tempdir().unwrap();
    let (home, shared) = (t.path().join("home"), t.path().join("statusline"));
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(
        home.join(".claude/settings.json"),
        json!({"statusLine": {"type": "command", "command": format!("node /x/flockbook-statusline --dir {} -- bash s.sh", shared.display())}}).to_string(),
    )
    .unwrap();
    std::fs::write(home.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.test"}}"#).unwrap();
    session(&shared, "s1", &format!("{}/.claude", home.display()), Some(weekly(64.0, 1_795_208_400)), 2_000);
    // CODEX_HOME names the Codex folder; today's real date names the day folder.
    let codex = t.path().join("codex");
    let d = day(&codex, chrono::Local::now().date_naive());
    rollout(&d, "rollout-a.jsonl", &[limits_line("2026-11-15T01:00:00.000Z", 20.0, 1_795_252_974)], 3_000);
    let v = run(&["usage"], &[("HOME", &home), ("CODEX_HOME", &codex)]);
    assert_eq!(v[0]["type"], "header");
    assert_eq!(v[0]["cmd"], "usage");
    assert_eq!(v.last().unwrap(), &json!({"type": "end", "ok": true, "ms": v.last().unwrap()["ms"]}));
    let usage_lines: Vec<&Value> = v.iter().filter(|l| l["type"] == "usage").collect();
    assert_eq!(usage_lines.len(), 2, "{v:?}");
    let c = usage_lines.iter().find(|l| l["kind"] == "claude").unwrap();
    assert_eq!(c["email"], "me@example.test");
    assert_eq!(c["weekly"]["left"], 36);
    let x = usage_lines.iter().find(|l| l["kind"] == "codex").unwrap();
    assert_eq!(x["weekly"]["left"], 80);
    assert_eq!(x["plan"], "prolite");
    // Neither found: only the header and the end.
    let none = run(&["usage"], &[("HOME", &t.path().join("empty")), ("CODEX_HOME", &t.path().join("nocodex"))]);
    assert_eq!(none.len(), 2, "{none:?}");
}

#[test]
fn another_machine_with_never_chosen_runs_nothing() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("app");
    std::fs::create_dir_all(home.join("flockbook")).unwrap();
    std::fs::write(home.join("flockbook/config.json"), r#"{"remote_helper":"never"}"#).unwrap();
    let v = run(&["usage", "--machine", "box", "--home", home.to_str().unwrap()], &[]);
    assert_eq!(v[1]["code"], "remote-off", "{v:?}");
    assert_eq!(v.last().unwrap()["ok"], false);
    let v = run(&["usage", "--machine", "box"], &[]);
    assert_eq!(v[1]["code"], "no-core", "{v:?}");
}
