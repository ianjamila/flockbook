//! `awake`: keeps the computer from idle sleep while agents work (docs/protocol.md). On a Mac the holder is a detached
//! `caffeinate -i -t <secs>`; these tests put a FAKE `caffeinate` first on PATH (a perl script that only sleeps), so the real
//! machine is never held awake, and each test stops what it started.
#![cfg(unix)]

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_flockbook-modfeed");

/// A temp home, with the fake caffeinate in `bin/`. Dropping it stops whatever holder the test left.
struct Env {
    _t: tempfile::TempDir,
    home: PathBuf,
    bin: PathBuf,
}

impl Env {
    fn new() -> Env {
        let t = tempfile::tempdir().unwrap();
        let (home, bin) = (t.path().join("home"), t.path().join("bin"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("caffeinate");
        // argv: -i -t <secs>. Records nothing; exits by itself after <secs>, or at once on a TERM.
        std::fs::write(&fake, "#!/usr/bin/perl\nsleep $ARGV[2];\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Env { _t: t, home, bin }
    }

    fn run(&self, args: &[&str]) -> Vec<Value> {
        let out = Command::new(BIN)
            .args(args)
            .arg("--home")
            .arg(&self.home)
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
            .env("HOME", &self.home)
            .output()
            .unwrap();
        assert!(out.status.success(), "exit code 0 always");
        String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn state_file(&self) -> PathBuf {
        self.home.join("flockbook").join("awake.json")
    }

    fn recorded_pid(&self) -> Option<u32> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(self.state_file()).ok()?).ok()?;
        v["pid"].as_u64().map(|p| p as u32)
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(pid) = self.recorded_pid() {
            kill(pid);
        }
    }
}

fn alive(pid: u32) -> bool {
    Command::new("/bin/ps").args(["-o", "pid=", "-p", &pid.to_string()]).output().map(|o| !o.stdout.is_empty()).unwrap_or(false)
}

fn kill(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-KILL", &pid.to_string()]).stderr(Stdio::null()).status();
}

/// Waits (up to 5 s) for `pid` to be gone.
fn gone(pid: u32) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(5) {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn result(lines: &[Value]) -> &Value {
    lines.iter().find(|l| l["type"] == "awake").unwrap_or_else(|| panic!("no awake line: {lines:?}"))
}

fn lstart(pid: u32) -> String {
    let o = Command::new("/bin/ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8(o.stdout).unwrap().trim().to_string()
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;

    #[test]
    fn for_starts_one_holder_and_records_it() {
        let e = Env::new();
        let lines = e.run(&["awake", "--for", "30"]);
        assert_eq!(lines[0]["cmd"], "awake");
        assert_eq!(lines.last().unwrap()["ok"], true);
        let r = result(&lines);
        assert_eq!(r["state"], "holding", "{lines:?}");
        assert_eq!(r["for"], 30);
        let pid = r["pid"].as_u64().unwrap() as u32;
        assert_eq!(e.recorded_pid(), Some(pid), "recorded in the helper's folder");
        assert!(alive(pid));
        // The holder is the caffeinate that was asked for: idle sleep only (-i), a finite time.
        let cmd = Command::new("/bin/ps").args(["-o", "command=", "-p", &pid.to_string()]).output().unwrap();
        let cmd = String::from_utf8(cmd.stdout).unwrap();
        assert!(cmd.contains("caffeinate -i -t 30"), "{cmd}");
        // Status says so, and the second run of --status changes nothing.
        let s = e.run(&["awake", "--status"]);
        assert_eq!(result(&s)["state"], "holding");
        assert_eq!(result(&s)["pid"], pid);
        let rel = e.run(&["awake", "--release"]);
        assert_eq!(result(&rel), &json!({"type": "awake", "state": "released", "was": true}));
        assert!(gone(pid));
    }

    #[test]
    fn a_renewal_starts_the_new_holder_then_stops_the_old_one() {
        let e = Env::new();
        let first = e.run(&["awake", "--for", "30"]);
        let old = result(&first)["pid"].as_u64().unwrap() as u32;
        let second = e.run(&["awake", "--for", "40"]);
        let new = result(&second)["pid"].as_u64().unwrap() as u32;
        assert_ne!(old, new);
        assert_eq!(result(&second)["replaced"], true);
        assert!(gone(old), "the old holder is stopped");
        assert!(alive(new));
        assert_eq!(e.recorded_pid(), Some(new));
        e.run(&["awake", "--release"]);
        assert!(gone(new));
    }

    #[test]
    fn release_with_nothing_held_is_quiet() {
        let e = Env::new();
        assert_eq!(result(&e.run(&["awake", "--release"])), &json!({"type": "awake", "state": "released", "was": false}));
        assert_eq!(result(&e.run(&["awake", "--status"]))["state"], "idle");
    }

    #[test]
    fn the_holder_ends_by_itself_after_its_time() {
        let e = Env::new();
        let pid = result(&e.run(&["awake", "--for", "1"]))["pid"].as_u64().unwrap() as u32;
        assert!(gone(pid), "a holder always has a finite time");
        // The record is stale: status says idle and a release has nothing to stop.
        assert_eq!(result(&e.run(&["awake", "--status"]))["state"], "idle");
        assert_eq!(result(&e.run(&["awake", "--release"]))["was"], false);
    }

    /// A process that is not our holder (another program's pid, or a caffeinate that is not the one recorded: the
    /// pid was reused) is never stopped, by a release or by a renewal.
    #[test]
    fn a_recorded_pid_that_is_not_our_holder_is_never_stopped() {
        let e = Env::new();
        let until = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600;
        std::fs::create_dir_all(e.state_file().parent().unwrap()).unwrap();

        // 1. An unrelated program, with its real start time recorded.
        let mut other = Command::new("/bin/sleep").arg("60").stdout(Stdio::null()).spawn().unwrap();
        let rec = json!({"pid": other.id(), "started": lstart(other.id()), "until": until});
        std::fs::write(e.state_file(), rec.to_string()).unwrap();
        assert_eq!(result(&e.run(&["awake", "--release"]))["was"], false);
        assert!(alive(other.id()), "release left an unrelated pid alone");
        std::fs::write(e.state_file(), rec.to_string()).unwrap();
        let renewed = e.run(&["awake", "--for", "30"]);
        assert!(alive(other.id()), "a renewal left it alone too");
        assert_eq!(result(&renewed)["replaced"], false);
        e.run(&["awake", "--release"]);

        // 2. A caffeinate that started at another time than the recorded one (somebody else's, like Claude Code's own).
        let mut theirs = Command::new(e.bin.join("caffeinate")).args(["-i", "-t", "60"]).stdout(Stdio::null()).spawn().unwrap();
        let rec = json!({"pid": theirs.id(), "started": "Mon Jan  1 00:00:00 2001", "until": until});
        std::fs::write(e.state_file(), rec.to_string()).unwrap();
        e.run(&["awake", "--release"]);
        assert!(alive(theirs.id()), "a caffeinate that is not the recorded one is left alone");

        let _ = other.kill();
        let _ = theirs.kill();
        let _ = other.wait();
        let _ = theirs.wait();
    }

    /// A record with no start time, or pid 0 / 1, never names a process to stop (s37 review: the guard's own paths).
    #[test]
    fn a_record_without_a_start_time_or_with_pid_0_or_1_stops_nothing() {
        let e = Env::new();
        let until = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600;
        std::fs::create_dir_all(e.state_file().parent().unwrap()).unwrap();
        // A live caffeinate (the fake), recorded without its start time.
        let mut theirs = Command::new(e.bin.join("caffeinate")).args(["-i", "-t", "60"]).stdout(Stdio::null()).spawn().unwrap();
        for rec in [
            json!({"pid": theirs.id(), "started": "", "until": until}),
            json!({"pid": theirs.id(), "until": until}),
            json!({"pid": 0, "started": "", "until": until}),
            json!({"pid": 1, "started": lstart(1), "until": until}),
        ] {
            std::fs::write(e.state_file(), rec.to_string()).unwrap();
            assert_eq!(result(&e.run(&["awake", "--status"]))["state"], "idle", "{rec}");
            assert_eq!(result(&e.run(&["awake", "--release"]))["was"], false, "{rec}");
            assert!(alive(theirs.id()), "{rec}: left alone");
        }
        let _ = theirs.kill();
        let _ = theirs.wait();
    }

    /// Many renewals in a row leave exactly one holder running (each replaces the one before).
    #[test]
    fn repeated_renewals_leave_one_holder() {
        let e = Env::new();
        let mut pids = Vec::new();
        for _ in 0..4 {
            pids.push(result(&e.run(&["awake", "--for", "30"]))["pid"].as_u64().unwrap() as u32);
        }
        let last = *pids.last().unwrap();
        for p in &pids[..pids.len() - 1] {
            assert!(gone(*p), "older holder {p} stopped");
        }
        assert!(alive(last));
        e.run(&["awake", "--release"]);
        assert!(gone(last));
    }

    /// The cap: 3600 s is allowed, 3601 is not.
    #[test]
    fn the_time_is_capped_at_an_hour() {
        let e = Env::new();
        let ok = e.run(&["awake", "--for", "3600"]);
        assert_eq!(result(&ok)["for"], 3600, "{ok:?}");
        e.run(&["awake", "--release"]);
        let over = e.run(&["awake", "--for", "3601"]);
        assert_eq!(over.iter().find(|l| l["type"] == "error").map(|l| l["code"].clone()), Some(json!("usage")), "{over:?}");
    }

    #[test]
    fn a_bad_time_is_refused() {
        let e = Env::new();
        for bad in [&["awake"][..], &["awake", "--for", "0"], &["awake", "--for", "abc"], &["awake", "--for", "999999"]] {
            let lines = e.run(bad);
            let err = lines.iter().find(|l| l["type"] == "error").unwrap_or_else(|| panic!("{bad:?}: {lines:?}"));
            assert_eq!(err["code"], "usage", "{bad:?}");
            assert_eq!(lines.last().unwrap()["ok"], false);
        }
        assert!(!e.state_file().exists());
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
#[test]
fn an_unsupported_platform_says_so() {
    let e = Env::new();
    let lines = e.run(&["awake", "--for", "30"]);
    assert_eq!(result(&lines)["state"], "unsupported");
    assert_eq!(lines.last().unwrap()["ok"], true);
    assert!(!e.state_file().exists());
    assert_eq!(result(&e.run(&["awake", "--release"]))["state"], "unsupported");
}

/// The version command lists it (the mod asks `hasCommand("awake")`).
#[test]
fn version_lists_awake() {
    let out = Command::new(BIN).arg("version").env_clear().output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
    assert!(v["commands"].as_array().unwrap().iter().any(|c| c == "awake"));
}
