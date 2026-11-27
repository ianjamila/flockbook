//! The per-terminal keys lock (Clear & re-enter, "One run per tab"): one OS-held lock per terminal, taken by every
//! keyed command before its identity read and held until after its last key, so nothing else types into a tab while
//! another action is typing. A forwarded command takes it on the machine where it runs, not on the way.
#![cfg(unix)]

mod common;
use common::{claude, FakeHc};
use modfeedkit::cli::{self, Keys};
use modfeedkit::keylock::{self, Busy};
use modfeedkit::queue::Outcome;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier, Mutex};

/// One test at a time. The ones that run `cli::keys` / `cli::pull` here share this process's environment (HC_SOCKET,
/// the lock folder); and a flock is shared with a child forked while it is held (until that child execs), so a test
/// that spawns a process must not run while another holds a lock, or a dropped lock would look still held.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn idle_box(fake: &FakeHc) {
    let rule = "─".repeat(40);
    fake.set_terminals(vec![claude("t1", "idle", "idle")]);
    fake.set_screen("t1", &format!("● Done.\n\n{rule}\n❯\u{a0}\n{rule}\n  ~/proj\n"));
}

/// The binary on `args`, the lock folder `dir`; its `done` or `error` line.
fn bin(sock: &str, dir: &std::path::Path, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_flockbook-modfeed"))
        .args(args)
        .env_clear()
        .env("HC_SOCKET", sock)
        .env("HOME", "/nonexistent-home")
        .env("FLOCKBOOK_KEYLOCK_DIR", dir)
        .output()
        .unwrap();
    let lines: Vec<Value> = String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).collect();
    lines.iter().find(|l| l["type"] == "done" || l["type"] == "error" || l["type"] == "card").cloned().unwrap_or_else(|| panic!("no answer line: {lines:?}"))
}

fn in_process(fake: &FakeHc, dir: &std::path::Path) -> std::sync::MutexGuard<'static, ()> {
    let g = serial();
    std::env::set_var("HC_SOCKET", &fake.path);
    std::env::remove_var("HC_SESSION");
    std::env::set_var("FLOCKBOOK_KEYLOCK_DIR", dir);
    g
}

fn send_keys(text: &str) -> Keys {
    Keys::Send { text: text.into(), expect_kind: Some("claude".into()), expect_path: None }
}

/// Catches: two actions typing into one tab (a second take succeeding while the first is held), or a lock that is
/// never given back (a take failing after the holder dropped it).
#[test]
fn second_take_is_busy() {
    let _s = serial();
    let dir = tempfile::tempdir().unwrap();
    let first = keylock::take(dir.path(), "t1").unwrap();
    assert_eq!(keylock::take(dir.path(), "t1").unwrap_err(), Busy::Taken, "held: busy");
    assert!(keylock::take(dir.path(), "t2").is_ok(), "another terminal is its own lock");
    drop(first);
    assert!(keylock::take(dir.path(), "t1").is_ok(), "dropped: free again");
}

/// Re-exec of this test binary as the holder (the next test): takes the lock, says so, waits to be killed.
#[test]
fn holder_child() {
    let Some(dir) = std::env::var_os("FLOCKBOOK_TEST_HOLD_DIR") else { return };
    let _held = keylock::take(std::path::Path::new(&dir), "t1").unwrap();
    println!("HELD");
    std::thread::sleep(std::time::Duration::from_secs(60));
}

/// Catches: a lock file that outlives a killed holder (a crashed helper would block its tab forever).
#[test]
fn dead_holder_frees_the_lock() {
    let _s = serial();
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["holder_child", "--exact", "--nocapture"])
        .env("FLOCKBOOK_TEST_HOLD_DIR", dir.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(out.read_line(&mut line).unwrap() > 0, "the holder died before it held the lock");
        if line.trim() == "HELD" {
            break;
        }
    }
    assert_eq!(keylock::take(dir.path(), "t1").unwrap_err(), Busy::Taken, "the child holds it");
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(keylock::take(dir.path(), "t1").is_ok(), "killed holder: the OS freed the lock at once");
}

/// Catches: a check-then-create race that lets two simultaneous takers both in.
#[test]
fn concurrent_takers_one_wins() {
    let _s = serial();
    let dir = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let (b, d) = (barrier.clone(), dir.path().to_path_buf());
            std::thread::spawn(move || {
                b.wait();
                keylock::take(&d, "t1")
            })
        })
        .collect();
    // Keep every result alive until all are in: a loser must not see the winner's lock dropped.
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "exactly one wins ({results:?})");
}

/// Catches: `t1` and `hc:t1` (one pane) taking two different locks, so two sends type into one tab.
#[test]
fn aliases_share_one_lock() {
    let _s = serial();
    let fake = FakeHc::start();
    idle_box(&fake);
    // Each send takes a second to deliver: the other, started with it, finds the lock held.
    fake.state.lock().unwrap().send_delay = 1.5;
    let dir = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = ["t1", "hc:t1"]
        .into_iter()
        .map(|addr| {
            let (b, sock, d) = (barrier.clone(), fake.path.clone(), dir.path().to_path_buf());
            std::thread::spawn(move || {
                b.wait();
                bin(&sock, &d, &["send", "--terminal", addr, "--text", "hello"])
            })
        })
        .collect();
    let mut results: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()["result"].as_str().unwrap_or("?").to_string()).collect();
    results.sort();
    assert_eq!(results[0], "busy", "one of the two was refused ({results:?})");
    assert_ne!(results[1], "busy", "the other typed ({results:?})");
    assert_eq!(fake.calls("terminal.send").len(), 1, "exactly one typed");
    // And the lock a take on the plain id holds stops the pane-id address too.
    let held = keylock::take(dir.path(), "t1").unwrap();
    let d = bin(&fake.path, dir.path(), &["send", "--terminal", "hc:t1", "--text", "hello"]);
    assert_eq!(d["result"], "busy", "{d}");
    assert_eq!(fake.calls("terminal.send").len(), 1, "still one");
    drop(held);
}

/// Catches: a lock folder that cannot be used letting the command type unprotected (it must fail closed).
#[test]
fn no_lock_dir_fails_closed() {
    let _s = serial();
    let fake = FakeHc::start();
    idle_box(&fake);
    let tmp = tempfile::tempdir().unwrap();
    let not_a_folder = tmp.path().join("file");
    std::fs::write(&not_a_folder, "x").unwrap();
    let d = bin(&fake.path, &not_a_folder, &["send", "--terminal", "t1", "--text", "hello"]);
    assert_eq!((d["type"].as_str(), d["result"].as_str()), (Some("done"), Some("no_lock")), "{d}");
    assert_eq!(d["message"], keylock::NO_LOCK);
    assert!(fake.calls("terminal.send").is_empty() && fake.keys().is_empty(), "nothing typed");
}

/// Catches: a send typing into a tab another action holds; the answer must be `busy` with the neutral message.
#[test]
fn send_refuses_while_held() {
    let fake = FakeHc::start();
    idle_box(&fake);
    let dir = tempfile::tempdir().unwrap();
    let _g = in_process(&fake, dir.path());
    let held = keylock::take(dir.path(), "t1").unwrap();
    let d = cli::keys("t1", None, None, send_keys("hello"));
    assert_eq!((d["result"].as_str(), d["message"].as_str()), (Some("busy"), Some("Another Flockbook action is typing in this tab. Wait a moment. Nothing was sent.")), "{d}");
    assert!(fake.calls("terminal.send").is_empty(), "nothing sent while held");
    drop(held);
    let d = cli::keys("t1", None, None, send_keys("hello"));
    assert_eq!(d["result"], "sent", "free again: the same send goes through ({d})");
    assert_eq!(fake.calls("terminal.send").len(), 1);
}

/// Catches: an approve (a key press on a permission prompt) going out while another action types in the tab.
#[test]
fn approve_refuses_while_held() {
    let fake = FakeHc::start();
    fake.set_terminals(vec![claude("t1", "blocked", "permission")]);
    fake.set_screen("t1", "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No");
    let dir = tempfile::tempdir().unwrap();
    let _g = in_process(&fake, dir.path());
    let _held = keylock::take(dir.path(), "t1").unwrap();
    let d = cli::keys("hc:t1", None, None, Keys::Approve { request: "x".into(), allow: true });
    assert_eq!(d["result"], "busy", "{d}");
    assert!(fake.calls("terminal.send").is_empty() && fake.keys().is_empty(), "no key went out");
}

/// Catches: a lock released before the key is delivered (the lock taken only around the identity read): another
/// action could then type into the tab mid-send. The callback runs while the fake core delivers the send.
#[test]
fn send_holds_the_lock_through_its_key() {
    let fake = FakeHc::start();
    idle_box(&fake);
    let dir = tempfile::tempdir().unwrap();
    let _g = in_process(&fake, dir.path());
    let seen: Arc<Mutex<Option<Result<(), Busy>>>> = Arc::new(Mutex::new(None));
    let (s, d) = (seen.clone(), dir.path().to_path_buf());
    fake.on_send(Some(Arc::new(move |_addr, _text, _st| {
        *s.lock().unwrap() = Some(keylock::take(&d, "t1").map(|_| ()));
    })));
    let d = cli::keys("t1", None, None, send_keys("hello"));
    assert_eq!(d["result"], "sent", "{d}");
    assert_eq!(*seen.lock().unwrap(), Some(Err(Busy::Taken)), "while its text was delivered the lock was held");
    assert!(keylock::take(dir.path(), "t1").is_ok(), "released after the send");
}

/// Catches: a queue pull (Up / Ctrl-U keys that clear the agent's box) running while another action types.
#[test]
fn pull_refuses_while_held() {
    let fake = FakeHc::start();
    fake.set_terminals(vec![claude("t1", "working", "")]);
    fake.set_screen("t1", "● Working\n");
    let dir = tempfile::tempdir().unwrap();
    let _g = in_process(&fake, dir.path());
    let _held = keylock::take(dir.path(), "t1").unwrap();
    let mut keep = |_: &str| true;
    let r = cli::pull("t1", None, &mut keep).unwrap();
    assert_eq!(r, Outcome::Refused(keylock::BUSY.to_string()), "busy: refused");
    assert!(fake.keys().is_empty(), "no key went out");
}

/// Catches: a busy `card --all` walking the picker (keys) anyway, or answering an error that blanks the card: it
/// gives the plain card and types nothing.
#[test]
fn busy_card_all_is_the_plain_card() {
    let _s = serial();
    let fake = FakeHc::start();
    fake.set_terminals(vec![claude("t1", "blocked", "question")]);
    fake.set_screen("t1", "←  ☐ Color  ☐ Size  ✔ Submit  →\nPick a color?\n❯ 1. Red\n  2. Blue\n  3. Type something.\n────────────────────\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel");
    let dir = tempfile::tempdir().unwrap();
    let held = keylock::take(dir.path(), "t1").unwrap();
    let c = bin(&fake.path, dir.path(), &["card", "--terminal", "t1", "--all"]);
    assert_eq!((c["type"].as_str(), c["kind"].as_str()), (Some("card"), Some("question")), "the plain card ({c})");
    assert!(fake.keys().is_empty(), "no picker walk while held");
    drop(held);
    let c = bin(&fake.path, dir.path(), &["card", "--terminal", "t1", "--all"]);
    assert_eq!(c["type"], "card");
    assert!(!fake.keys().is_empty(), "free: the walk starts (the test would prove nothing otherwise)");
}
