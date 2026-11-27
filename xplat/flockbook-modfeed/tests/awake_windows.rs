//! `awake` on Windows (docs/protocol.md): the holder is this helper again as `awake-hold`, asking for
//! ES_SYSTEM_REQUIRED; it ends when its time is up or the record's token changes. Runs on the helpers.yml Windows job
//! (the only place this code is compiled and run; s37 review). The holder only keeps the CI runner from idle sleep for a
//! few seconds, and each test releases what it started.
#![cfg(windows)]

use serde_json::Value;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_flockbook-modfeed");
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run(home: &PathBuf, args: &[&str]) -> Vec<Value> {
    // output() reads the pipes to their end: it returns only when every process holding them has let go. A holder that
    // inherited them would keep this call waiting for its whole time (the s37 review's P1).
    let out = Command::new(BIN).args(args).arg("--home").arg(home).output().unwrap();
    assert!(out.status.success(), "exit code 0 always");
    String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn result(lines: &[Value]) -> &Value {
    lines.iter().find(|l| l["type"] == "awake").unwrap_or_else(|| panic!("no awake line: {lines:?}"))
}

fn alive(pid: u32) -> bool {
    Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).creation_flags(CREATE_NO_WINDOW).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("flockbook-modfeed.exe"))
        .unwrap_or(false)
}

/// Waits (up to 10 s: the holder looks at its token every 2 s) for `pid` to be gone.
fn gone(pid: u32) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

#[test]
fn for_answers_at_once_and_release_ends_the_holder() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let t0 = Instant::now();
    let lines = run(&home, &["awake", "--for", "60"]);
    assert!(t0.elapsed() < Duration::from_secs(20), "the call returns while the holder runs: {:?}", t0.elapsed());
    let r = result(&lines);
    assert_eq!(r["state"], "holding", "{lines:?}");
    let pid = r["pid"].as_u64().unwrap() as u32;
    assert!(alive(pid), "the holder runs");
    assert_eq!(result(&run(&home, &["awake", "--status"]))["state"], "holding");

    // A renewal: a new holder, and the old one ends by itself (its token is gone).
    let second = run(&home, &["awake", "--for", "60"]);
    let new = result(&second)["pid"].as_u64().unwrap() as u32;
    assert_ne!(pid, new);
    assert!(gone(pid), "the old holder ended after the renewal");

    let rel = run(&home, &["awake", "--release"]);
    assert_eq!(result(&rel)["was"], true, "{rel:?}");
    assert!(gone(new), "release ends the holder");
    assert_eq!(result(&run(&home, &["awake", "--status"]))["state"], "idle");
}
