//! `reenter::run` (Clear & re-enter): `/clear` typed into a finished Claude tab, the new conversation awaited, then the
//! prompt. On a fake herdr-core and a throwaway config folder holding the agent's pid record: no key ever goes to a
//! real terminal. Every test names the failure it catches; each asserts `result`, `cleared`, `keys` as they are
//! serialised (the mod reads the wire form) and the exact `terminal.send` texts.
#![cfg(unix)]

mod common;
use common::{claude, FakeHc, State};
use herdr_core::hc::{HcClient, HcSession};
use herdr_core::resolver::{parse_ps, Proc, ProcessSource, SessionResolver};
use herdr_core::*;
use modfeedkit::locate::{self, Found};
use modfeedkit::queue;
use modfeedkit::reenter::{self, Answer, Wait};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROMPT: &str = "Continue the work on PR 12. Read the notes first.";
const EMPTY: &[u8] = include_bytes!("fixtures/claude-empty-box.paint");
const DIM: &[u8] = include_bytes!("fixtures/claude-dim-suggestion.paint");
const CLEAR_02: &[u8] = include_bytes!("fixtures/claude-after-clear-0s2.paint");
const CLEAR_3S: &[u8] = include_bytes!("fixtures/claude-after-clear-3s.paint");
const DIM_ROW: &str = "Try \"how does flockbook-helper-fixes.patch work?\"";
const WAIT: Wait = Wait { limit: Duration::from_millis(300), every: Duration::from_millis(10) };

fn rule() -> String {
    "─".repeat(40)
}

/// Claude Code's screen: the box rows (the first starts "❯ ") between two rules, a footer under it.
fn screen(rows: &[&str]) -> String {
    format!("● Done.\n\n{r}\n{}\n{r}\n  ~/proj\n", rows.join("\n"), r = rule())
}

fn empty_screen() -> String {
    screen(&["❯\u{a0}"])
}

/// What stays after `/clear`: the `❯ /clear` echo row above the box (white on grey in the paint), an empty box.
fn after_clear_screen() -> String {
    format!("❯\u{a0}/clear\n\n{r}\n❯\u{a0}\n{r}\n  ~/proj\n", r = rule())
}

/// A paint with typed (coloured, not dim) text in the box and the cursor after it (`cursor_col`, 1-based).
fn typed_paint(text: &str, cursor_col: usize) -> Vec<u8> {
    format!("\x1b[2J\x1b[1;1H● Done.\x1b[3;1H{r}\x1b[4;1H❯\u{a0}\x1b[0m\x1b[38;2;177;185;249m{text}\x1b[0m\x1b[5;1H{r}\x1b[6;3H~/proj\x1b[4;{cursor_col}H", r = rule()).into_bytes()
}

fn typed_at_end(text: &str) -> Vec<u8> {
    typed_paint(text, 3 + text.chars().count())
}

/// The serialised answer's `result`, `cleared` and `keys`.
fn check(a: &Answer, result: &str, cleared: Value, keys: &str) {
    let v = serde_json::to_value(a).unwrap();
    assert_eq!(v["type"], "done", "{v}");
    assert_eq!((v["result"].as_str(), &v["cleared"], v["keys"].as_str()), (Some(result), &cleared, Some(keys)), "{v}");
}

/// A refusal before the `/clear` send: nothing typed.
fn refused(a: &Answer, result: &str) {
    check(a, result, json!(false), "none");
}

struct Procs(Vec<Proc>);
impl ProcessSource for Procs {
    fn processes(&self) -> Vec<Proc> {
        self.0.clone()
    }
    fn open_files(&self, _: &[i32]) -> Vec<String> {
        vec![]
    }
}

fn write_record(dir: &Path, start: &str, session: &str, status: &str) {
    write_record_for(dir, 4242, start, session, status);
}

fn write_record_for(dir: &Path, pid: u32, start: &str, session: &str, status: &str) {
    let o = json!({"pid": pid, "sessionId": session, "procStart": start, "cwd": "/tmp/proj", "status": status, "kind": "interactive"});
    std::fs::write(dir.join(format!("{pid}.json")), serde_json::to_vec(&o).unwrap()).unwrap();
}

/// What a real `/clear` does, as measured: the pid record names a new session and says idle, the core's status for the
/// tab is idle, the box is empty with the `❯ /clear` echo above it.
fn standard_clear(dir: &Path, start: &str, st: &mut State) {
    write_record(dir, start, "new", "idle");
    st.terminals = vec![claude("t1", "idle", "idle")];
    st.screens.insert("t1".into(), after_clear_screen());
    st.paints.insert("t1".into(), CLEAR_02.to_vec());
}

/// An idle finished Claude tab `t1` on a fake core, its pid record `old` in a throwaway config folder.
struct Rig {
    fake: FakeHc,
    cfg: tempfile::TempDir,
    procs: Vec<Proc>,
    start: String,
    client: HcClient,
    cache: PathBuf,
}

impl Rig {
    fn new() -> Rig {
        let fake = FakeHc::start();
        let cfg = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cfg.path().join("sessions")).unwrap();
        std::fs::create_dir_all(cfg.path().join("projects/-tmp-proj")).unwrap();
        std::fs::write(cfg.path().join("projects/-tmp-proj/old.jsonl"), "{}\n").unwrap();
        let procs = parse_ps(&format!("  4242     1 Sat Oct 31 10:01:00 2026     claude CLAUDE_CONFIG_DIR={} HC_TERMINAL_ID=t1\n", cfg.path().display()));
        let start = procs[0].start.format("%a %b %-d %H:%M:%S %Y").to_string();
        let client = HcClient::new(HcSession::new(&fake.path), 8, reenter::SEND_S);
        let cache = cfg.path().join("cache/cache.json");
        let rig = Rig { fake, cfg, procs, start, client, cache };
        rig.record("old", "idle");
        rig.fake.set_terminals(vec![claude("t1", "done", "done")]);
        rig.fake.set_screen("t1", &empty_screen());
        rig.fake.set_paint("t1", EMPTY);
        rig.on_clear(|_| {});
        rig
    }

    fn sessions(&self) -> PathBuf {
        self.cfg.path().join("sessions")
    }
    fn log(&self, id: &str) -> PathBuf {
        self.cfg.path().join(format!("projects/-tmp-proj/{id}.jsonl"))
    }
    fn record(&self, session: &str, status: &str) {
        write_record(&self.sessions(), &self.start, session, status);
    }

    /// `/clear` takes effect (`standard_clear`), then `extra` changes what a variant needs.
    fn on_clear(&self, extra: impl Fn(&mut State) + Send + Sync + 'static) {
        let (dir, start) = (self.sessions(), self.start.clone());
        self.fake.on_send(Some(Arc::new(move |_a, text, st| {
            if text == "/clear" {
                standard_clear(&dir, &start, st);
                extra(st);
            }
        })));
    }
    /// `/clear` changes nothing but what `extra` does.
    fn on_clear_only(&self, extra: impl Fn(&mut State) + Send + Sync + 'static) {
        self.fake.on_send(Some(Arc::new(move |_a, text, st| {
            if text == "/clear" {
                extra(st);
            }
        })));
    }

    /// The tab as the caller found it: a hand-built `Found` naming the old log and the old record's pid.
    fn found(&self) -> Found {
        let ws = self.client.snapshot().unwrap();
        let log = self.log("old").to_string_lossy().into_owned();
        Found { pane: locate::pane(&ws, "t1").unwrap().clone(), path: Some(log.clone()), cached: false, raw: Some(log), pid_record: Some((4242, self.sessions().to_string_lossy().into_owned())) }
    }
    fn expect(&self) -> String {
        self.log("old").to_string_lossy().into_owned()
    }
    fn run_found(&self, found: &Found, text: &str, expect: &str, deadline: Instant) -> Answer {
        reenter::run("t1", found, &self.procs, &self.client, text, expect, Some(&self.cache), WAIT, deadline)
    }
    fn go(&self, text: &str) -> Answer {
        self.run_found(&self.found(), text, &self.expect(), Instant::now() + Duration::from_secs(30))
    }
    /// The real resolver and locate on this tab, as the helper's command finds it.
    fn real_found(&self) -> Found {
        let ws = self.client.snapshot().unwrap();
        let mut res = SessionResolver::new("/nonexistent.sock").with_source(Box::new(Procs(self.procs.clone())));
        locate::recheck("t1", &ws, &mut res, None, 1.0).unwrap().0
    }
    fn sent(&self) -> Vec<String> {
        self.fake.sent_texts()
    }
    fn nothing_sent(&self) {
        assert!(self.sent().is_empty(), "nothing typed ({:?})", self.sent());
        assert!(self.fake.keys().is_empty(), "no keys");
    }
    fn cache_entry(&self) -> locate::Entry {
        locate::read_cache(Some(&self.cache)).entries.get("t1").cloned().expect("t1 in the cache")
    }
}

/// Catches: the two sends in the wrong order or form: the prompt before the new conversation, `/clear` guarded by
/// `if: "idle"` (a finished tab's status is `done`: the core would refuse every `/clear`), the prompt NOT guarded
/// (a person's own message meanwhile would be pasted onto), a key pressed through a path that skips the checks, or an
/// attach that is more than a watcher.
#[test]
fn happy_path_sends_clear_then_the_prompt() {
    let rig = Rig::new();
    let a = rig.go(PROMPT);
    check(&a, "sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear", PROMPT]);
    let sends = rig.fake.calls("terminal.send");
    assert!(sends[0].get("if").is_none(), "the /clear send carries no `if` ({})", sends[0]);
    assert_eq!(sends[1]["if"], "idle", "the prompt send is guarded");
    assert!(rig.fake.keys().is_empty(), "no key but the two sends");
    assert!(rig.fake.calls("terminal.attach").iter().all(|a| a["observe"] == true), "watch-only looks");
    assert!(rig.fake.calls("frame").iter().all(|f| f["kind"] == 2), "only CLOSE frames");
}

/// Catches: the cache left on the old conversation after a re-entry (the chat and the Finished list would keep
/// reading the dead one): the new session before its log exists, and the new log once it does.
#[test]
fn cache_points_at_the_new_session() {
    // Without the new log on disk: the bare session id and the config folder, so the tab is identified at once.
    let rig = Rig::new();
    locate::write_cache(
        &locate::Cache { entries: [("t1".to_string(), locate::Entry { kind: "claude".into(), cwd: "/tmp/proj".into(), pids: vec![4242], path: Some(rig.expect()), checked: 1.0, sid: None, config: None })].into(), ..Default::default() },
        Some(&rig.cache),
    );
    check(&rig.go(PROMPT), "sent", json!(true), "yes");
    let e = rig.cache_entry();
    assert_eq!((e.path.clone(), e.sid.as_deref(), e.config.clone()), (None, Some("new"), Some(rig.cfg.path().to_string_lossy().into_owned())), "{e:?}");

    // With it: the entry names the new log, and a lookup with that cache reads it (no scan).
    let rig = Rig::new();
    std::fs::write(rig.log("new"), "{}\n").unwrap();
    check(&rig.go(PROMPT), "sent", json!(true), "yes");
    let e = rig.cache_entry();
    assert_eq!((e.path.clone(), e.sid.clone()), (Some(rig.log("new").to_string_lossy().into_owned()), None), "{e:?}");
    let ws = rig.client.snapshot().unwrap();
    let mut res = SessionResolver::new("/nonexistent.sock").with_source(Box::new(Procs(vec![])));
    let f = locate::find("t1", &ws, &mut res, Some(&rig.cache), e.checked + 1.0).unwrap();
    assert!(f.cached && f.path.as_deref() == Some(rig.log("new").to_string_lossy().as_ref()), "the very next read follows the new conversation");
}

/// Catches: a multi-line prompt split, trimmed or reflowed into several sends (the second line would be a message of
/// its own, or the first would be submitted alone).
#[test]
fn multi_line_prompt_goes_whole() {
    let rig = Rig::new();
    let text = "Resume the review.\n\n  - first, read notes.md\n  - then run the tests\n-x then y";
    check(&rig.go(text), "sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear".to_string(), text.to_string()], "one send, byte for byte");
}

/// Catches: `/clear` glued onto a person's draft (the 11-27 finding): a typed draft, or typed text that merely reads
/// like Claude's placeholders, must stop everything before the first key.
#[test]
fn typed_draft_sends_nothing() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&["❯\u{a0}fix the typo in the readme"]));
    rig.fake.set_paint("t1", &typed_at_end("fix the typo in the readme"));
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();
}

#[test]
fn typed_placeholder_lookalike_sends_nothing() {
    for row in ["Try \"fix typecheck errors\"", "Press up to edit queued messages"] {
        let rig = Rig::new();
        rig.fake.set_screen("t1", &screen(&[&format!("❯\u{a0}{row}")]));
        rig.fake.set_paint("t1", &typed_at_end(row));
        refused(&rig.go(PROMPT), "box_not_empty");
        rig.nothing_sent();
    }
}

/// Catches: a dim suggestion refused (the button would never work on a finished tab) and, the other way, anything but
/// a dim, single-row, cursor-at-start box passing for one.
#[test]
fn dim_one_row_suggestion_goes() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&[&format!("❯\u{a0}{DIM_ROW}")]));
    rig.fake.set_paint("t1", DIM);
    check(&rig.go(PROMPT), "sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear", PROMPT]);
}

#[test]
fn same_text_not_dim_is_refused() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&[&format!("❯\u{a0}{DIM_ROW}")]));
    let not_dim = String::from_utf8_lossy(DIM).replace("\x1b[2mTry", "Try").into_bytes();
    assert_ne!(not_dim, DIM, "the fixture changed");
    rig.fake.set_paint("t1", &not_dim);
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();
}

#[test]
fn cursor_after_text_is_refused() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&[&format!("❯\u{a0}{DIM_ROW}")]));
    let at_end = String::from_utf8_lossy(DIM).replace("\x1b[116;3H", "\x1b[116;52H").into_bytes();
    assert_ne!(at_end, DIM, "the fixture changed");
    rig.fake.set_paint("t1", &at_end);
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();
}

#[test]
fn two_row_box_is_refused() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&[&format!("❯\u{a0}{DIM_ROW}"), "  and a second row"]));
    rig.fake.set_paint("t1", DIM);
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();
}

/// Catches: the `❯ /clear` echo row that stays above the box after `/clear` taken for the box (the box would read
/// "has text", or the paint's cursor would be judged against the wrong row), in the text and in the paint.
#[test]
fn echo_row_above_the_box_is_ignored() {
    for paint in [CLEAR_02, CLEAR_3S] {
        let rig = Rig::new();
        rig.fake.set_screen("t1", &after_clear_screen());
        rig.fake.set_paint("t1", paint);
        check(&rig.go(PROMPT), "sent", json!(true), "yes");
        assert_eq!(rig.sent(), ["/clear", PROMPT]);
    }
}

/// Catches: a tab with no Claude box on screen (a dialog, a menu, a failed read) treated as an empty box.
#[test]
fn no_box_sends_nothing() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", "● Done.\n  some output, no box\n");
    refused(&rig.go(PROMPT), "no_box");
    rig.fake.set_screen("t1", &format!("● Done.\n{r}\n  Do you want to continue?\n  ❯ 1. Yes\n{r}\n", r = rule()));
    refused(&rig.go(PROMPT), "no_box");
    rig.fake.clear_screen("t1");
    refused(&rig.go(PROMPT), "no_box");
    rig.nothing_sent();
}

/// Catches: the box's text read as empty after `queue`'s placeholder clean-up (one blank row and two look alike
/// there), and a typed `Try "…"` read as the placeholder.
#[test]
fn box_reads_raw_rows() {
    assert_eq!(queue::claude_box_raw(&empty_screen()), Some(vec![String::new()]));
    assert_eq!(queue::claude_box_raw(&screen(&["❯\u{a0}", "  "])).map(|r| r.len()), Some(2), "a blank second row is kept");
    assert_eq!(queue::claude_box_raw(&screen(&["❯\u{a0}Try \"x\""])), Some(vec!["Try \"x\"".to_string()]));
    assert_eq!(queue::claude_box_raw(&after_clear_screen()), Some(vec![String::new()]), "the echo row above is not the box");
    assert_eq!(queue::claude_box_raw("no box here"), None);
    assert_eq!(queue::claude_box_raw(&format!("{r}\n  Pick one\n  ❯ 1. Yes\n{r}\n", r = rule())), None, "a dialog between rules is no box");
}

/// Catches: identity read from the wrong place: a record that names another session, an unresolved pane (only the
/// fallback pid) passing for identified, a `continued-in` log taken for the one the record names. Real resolver and
/// locate; 0 sends where refused.
#[test]
fn identity_real_path() {
    // The record names the displayed log: goes.
    let rig = Rig::new();
    let f = rig.real_found();
    assert_eq!((f.raw.clone(), f.path.clone()), (Some(rig.expect()), Some(rig.expect())));
    assert_eq!(f.pid_record, Some((4242, rig.sessions().to_string_lossy().into_owned())));
    check(&rig.run_found(&f, PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(30)), "sent", json!(true), "yes");

    // The record turned to another session after the tab was found.
    let rig = Rig::new();
    let f = rig.real_found();
    rig.record("other", "idle");
    refused(&rig.run_found(&f, PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(30)), "changed");
    rig.nothing_sent();

    // An unresolved pane: its pid record is invalid, so only the fallback pid is left: no identity.
    let rig = Rig::new();
    rig.record("a/b", "idle");
    let f = rig.real_found();
    assert_eq!((f.path.clone(), f.pid_record.clone()), (None, None));
    refused(&rig.run_found(&f, PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(30)), "no-identity");
    rig.nothing_sent();

    // A conversation that went on in a `continued-in` log: the record names the predecessor, the resolver gives the
    // successor. Never goes. The successor named by the record is another story: it goes.
    let rig = Rig::new();
    std::fs::write(rig.log("old"), "{\"type\":\"continued-in\",\"continuedInSessionId\":\"newer\"}\n").unwrap();
    std::fs::write(rig.log("newer"), "{}\n").unwrap();
    let f = rig.real_found();
    let newer = rig.log("newer").to_string_lossy().into_owned();
    assert_eq!(f.path.as_deref(), Some(newer.as_str()), "found the successor");
    refused(&rig.run_found(&f, PROMPT, &newer, Instant::now() + Duration::from_secs(30)), "changed");
    rig.nothing_sent();
    rig.record("newer", "idle");
    let f = rig.real_found();
    check(&rig.run_found(&f, PROMPT, &newer, Instant::now() + Duration::from_secs(30)), "sent", json!(true), "yes");
}

/// Catches: the prompt typed into another log's tab (the page was read from a conversation the tab left), another
/// agent kind, a log that reached its `path` through `continued-in` (CONTINUED_ID is not known: never trusted).
#[test]
fn other_log_or_kind_is_changed() {
    let rig = Rig::new();
    refused(&rig.run_found(&rig.found(), PROMPT, "/elsewhere/other.jsonl", Instant::now() + Duration::from_secs(30)), "changed");
    let mut f = rig.found();
    f.pane.agent.as_mut().unwrap().kind = "codex".into();
    refused(&rig.run_found(&f, PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(30)), "changed");
    let mut f = rig.found();
    f.path = Some(rig.log("newer").to_string_lossy().into_owned()); // raw is still the old log
    refused(&rig.run_found(&f, PROMPT, &rig.log("newer").to_string_lossy(), Instant::now() + Duration::from_secs(30)), "changed");
    let mut f = rig.found();
    f.path = None;
    f.raw = None;
    refused(&rig.run_found(&f, PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(30)), "changed");
    // A `bg` record: a /clear in this pane cannot change it.
    let o = json!({"pid": 4242, "sessionId": "old", "procStart": rig.start, "status": "idle", "kind": "bg"});
    std::fs::write(rig.sessions().join("4242.json"), serde_json::to_vec(&o).unwrap()).unwrap();
    refused(&rig.go(PROMPT), "no-identity");
    rig.nothing_sent();
}

/// Catches: a `/clear` typed while Claude works, waits for an approval or a question, or whose pid record says busy;
/// and a turn that starts between the box check and the send (A10).
#[test]
fn working_blocked_or_card_is_tab_busy() {
    for (status, kind) in [("working", "working"), ("blocked", "permission"), ("blocked", "question")] {
        let rig = Rig::new();
        rig.fake.set_terminals(vec![claude("t1", status, kind)]);
        rig.fake.set_screen("t1", "✻ Working… 3s\n────────────────────\nBash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No");
        refused(&rig.go(PROMPT), "tab_busy");
        rig.nothing_sent();
    }
    let rig = Rig::new();
    rig.record("old", "busy");
    refused(&rig.go(PROMPT), "tab_busy");
    rig.nothing_sent();
}

#[test]
fn turn_started_during_checks_is_tab_busy() {
    let rig = Rig::new();
    // The tab starts a turn as the box check's paint is taken.
    rig.fake.state.lock().unwrap().after_attach = Some(vec![claude("t1", "working", "working")]);
    refused(&rig.go(PROMPT), "tab_busy");
    assert_eq!(rig.fake.calls("terminal.attach").len(), 1, "the paint was taken first");
    rig.nothing_sent();
}

/// Catches: an empty or command-like prompt typed (a `/` line runs a command, `!` a shell line, `#` a memory note),
/// and a prompt that merely starts with `-` refused.
#[test]
fn bad_text_refused() {
    let rig = Rig::new();
    for text in ["", "  ", "/clear", "  !ls", "#note", "\n\t/compact"] {
        refused(&rig.go(text), "bad_text");
    }
    rig.nothing_sent();
    check(&rig.go("-x then y"), "sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear", "-x then y"]);
}

/// Catches: a run started with too little time left to finish its steps (the caller's exec would be cut mid-run).
#[test]
fn too_little_time_is_no_time() {
    let rig = Rig::new();
    let a = rig.run_found(&rig.found(), PROMPT, &rig.expect(), Instant::now() + Duration::from_secs(17));
    refused(&a, "no_time");
    rig.nothing_sent();
}

/// Catches: the time left measured before the checks instead of right before the send (the box paint can take
/// 400 ms): 18.2 s was enough at the start, 17.8 s is not at the send. The control run with enough time goes.
#[test]
fn slow_last_check_is_no_time() {
    let rig = Rig::new();
    rig.fake.paint_delay(0.4);
    refused(&rig.run_found(&rig.found(), PROMPT, &rig.expect(), Instant::now() + Duration::from_millis(18_200)), "no_time");
    rig.nothing_sent();
    check(&rig.run_found(&rig.found(), PROMPT, &rig.expect(), Instant::now() + Duration::from_millis(19_500)), "sent", json!(true), "yes");
}

/// Catches: a `/clear` whose reply was lost reported as "nothing typed" (it may still arrive), or followed by the
/// prompt (into the old conversation); a connect error (provably nothing written) reported as maybe; an undocumented
/// error reply reported as nothing typed; a documented refusal reported as maybe.
#[test]
fn clear_lost_reply_is_maybe() {
    let rig = Rig::new();
    rig.fake.send_close(vec![true]);
    let a = rig.go(PROMPT);
    check(&a, "clear_unconfirmed", json!("maybe"), "maybe");
    assert_eq!(rig.sent(), ["/clear"], "the prompt is never sent after a /clear that may still arrive");
}

#[test]
fn clear_connect_error_is_none() {
    let rig = Rig::new();
    // The core's socket goes away right after the last check's snapshot (the fourth: the caller's find, the gate, the
    // gate after the paint, A10).
    let sock = rig.fake.path.clone();
    rig.fake.on_call(Some(Arc::new(move |m, st| {
        if m == "terminal.list" && st.calls.iter().filter(|(c, _)| c == "terminal.list").count() >= 4 {
            let _ = std::fs::remove_file(&sock);
        }
    })));
    let a = rig.go(PROMPT);
    check(&a, "failed", json!(false), "none");
    assert_eq!(rig.fake.calls("terminal.list").len(), 4, "the socket went at the last check");
    assert!(rig.sent().is_empty(), "nothing was written");
}

#[test]
fn clear_unknown_error_reply_is_maybe() {
    let rig = Rig::new();
    rig.fake.send_refuse(vec![Some("something_new")]);
    check(&rig.go(PROMPT), "clear_unconfirmed", json!("maybe"), "maybe");
    assert_eq!(rig.sent(), ["/clear"]);
}

#[test]
fn clear_documented_refusal_is_none() {
    let rig = Rig::new();
    rig.fake.send_refuse(vec![Some("blocked")]);
    check(&rig.go(PROMPT), "failed", json!(false), "none");
    assert_eq!(rig.sent(), ["/clear"], "attempted once, taken never");
}

/// Catches: the core's refusal at paste time (a person sent their own message meanwhile: `status_mismatch`) reported
/// as a sent prompt, or as "nothing typed" (the `/clear` did go).
#[test]
fn draft_after_final_check_is_refused_by_core() {
    let rig = Rig::new();
    rig.fake.send_refuse(vec![None, Some("status_mismatch")]);
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear", PROMPT], "both attempted, nothing more");
}

/// Catches: a draft the text read cannot see: spaces typed in the box (text read as empty, the cursor moved), and a
/// blank second line (two box rows, both blank). Before `/clear`: nothing typed. Left in the box after `/clear`:
/// exactly the one send.
#[test]
fn whitespace_draft_sends_nothing() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&["❯\u{a0}   "]));
    rig.fake.set_paint("t1", &typed_paint("   ", 6));
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();

    let rig = Rig::new();
    rig.on_clear(|st| {
        st.screens.insert("t1".into(), screen(&["❯\u{a0}   "]));
        st.paints.insert("t1".into(), typed_paint("   ", 6));
    });
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

#[test]
fn blank_line_draft_sends_nothing() {
    let rig = Rig::new();
    rig.fake.set_screen("t1", &screen(&["❯\u{a0}", "  "]));
    refused(&rig.go(PROMPT), "box_not_empty");
    rig.nothing_sent();

    let rig = Rig::new();
    rig.on_clear(|st| {
        st.screens.insert("t1".into(), screen(&["❯\u{a0}", "  "]));
    });
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: the prompt typed after the deadline went by during the wait (A11). The `/clear` takes effect only after
/// the deadline: the first look at the record sees nothing, the wait ends at the deadline, the last look sees the new
/// conversation, and the time is gone.
#[test]
fn deadline_after_clear_is_cleared_not_sent() {
    let rig = Rig::new();
    rig.on_clear_only(|_| {});
    let (dir, start) = (rig.sessions(), rig.start.clone());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        write_record(&dir, &start, "new", "idle");
    });
    let wait = Wait { limit: Duration::from_secs(5), every: Duration::from_secs(2) };
    let deadline = Instant::now() + Duration::from_millis(700);
    let a = reenter::run_with_need("t1", &rig.found(), &rig.procs, &rig.client, PROMPT, &rig.expect(), Some(&rig.cache), wait, deadline, Duration::from_millis(300));
    check(&a, "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: the three results whose `cleared` / `keys` are easy to get wrong on the wire (the mod reads these words).
#[test]
fn answer_fields_per_result() {
    // clear_unknown: the /clear went, no new conversation showed.
    let rig = Rig::new();
    rig.on_clear_only(|_| {});
    let a = rig.go(PROMPT);
    check(&a, "clear_unknown", json!(true), "yes");
    assert!(a.message.is_some());
    // clear_unconfirmed: it may still arrive.
    let rig = Rig::new();
    rig.fake.send_close(vec![true]);
    let v = serde_json::to_value(rig.go(PROMPT)).unwrap();
    assert_eq!((&v["cleared"], &v["keys"]), (&json!("maybe"), &json!("maybe")), "{v}");
    // prompt_unconfirmed: typed, not confirmed.
    let rig = Rig::new();
    rig.fake.send_close(vec![false, true]);
    let v = serde_json::to_value(rig.go(PROMPT)).unwrap();
    assert_eq!((&v["result"], &v["cleared"], &v["keys"]), (&json!("prompt_unconfirmed"), &json!(true), &json!("yes")), "{v}");
    // sent: no message at all, and the key names are lower case words.
    let rig = Rig::new();
    let v = serde_json::to_value(rig.go(PROMPT)).unwrap();
    assert!(v.get("message").is_none(), "{v}");
}

/// Catches: waiting for a new conversation that never came, then typing anyway (into the old one).
#[test]
fn pid_record_unchanged_is_clear_unknown() {
    let rig = Rig::new();
    rig.on_clear_only(|_| {});
    check(&rig.go(PROMPT), "clear_unknown", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"], "the prompt is never typed");
    // The record changes but the agent never says idle: still unknown.
    let rig = Rig::new();
    rig.on_clear_only({
        let (dir, start) = (rig.sessions(), rig.start.clone());
        move |_| write_record(&dir, &start, "new", "busy")
    });
    check(&rig.go(PROMPT), "clear_unknown", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: a prompt typed into a pane another process took over between `/clear` and the prompt.
#[test]
fn process_changed_is_cleared_not_sent() {
    let rig = Rig::new();
    rig.on_clear(|st| st.terminals = vec![common::terminal("t1", &["claude"], Some(9999), Some("idle"), Some("idle"))]);
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: a second conversation change (another /clear, a resume) between the first and the prompt: the prompt
/// would land in a conversation nobody asked for.
#[test]
fn second_session_change_is_cleared_not_sent() {
    let rig = Rig::new();
    let (dir, start) = (rig.sessions(), rig.start.clone());
    // The first snapshot after the /clear is the last check's: the record moves on just then.
    rig.fake.on_call(Some(Arc::new(move |m, st| {
        if m == "terminal.list" && st.calls.iter().any(|(c, _)| c == "terminal.send") {
            write_record(&dir, &start, "newer", "idle");
        }
    })));
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: text typed into the new conversation's box by a person right after `/clear` taken for an empty box.
#[test]
fn typed_after_clear_is_not_sent() {
    let rig = Rig::new();
    rig.on_clear(|st| {
        st.screens.insert("t1".into(), screen(&["❯\u{a0}hello"]));
        st.paints.insert("t1".into(), typed_at_end("hello"));
    });
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    assert_eq!(rig.sent(), ["/clear"]);
}

/// Catches: a lost reply to the prompt reported as "nothing typed" or as sent: the prompt may be in the tab.
#[test]
fn prompt_lost_reply_is_prompt_unconfirmed() {
    let rig = Rig::new();
    rig.fake.send_close(vec![false, true]);
    let a = rig.go(PROMPT);
    check(&a, "prompt_unconfirmed", json!(true), "yes");
    assert!(a.message.as_deref().unwrap().contains("may already be in the tab"), "{a:?}");
    assert_eq!(rig.sent(), ["/clear", PROMPT]);
}

/// Catches: the cache left behind on any exit after the `/clear` went (A9): unknown, not sent, sent.
#[test]
fn cache_moves_on_every_exit_after_clear() {
    let on_new = |rig: &Rig| {
        let e = rig.cache_entry();
        assert_eq!(e.sid.as_deref(), Some("new"), "{e:?}");
    };
    // clear_unknown: the record names the new session but is not idle yet.
    let rig = Rig::new();
    rig.on_clear_only({
        let (dir, start) = (rig.sessions(), rig.start.clone());
        move |_| write_record(&dir, &start, "new", "busy")
    });
    check(&rig.go(PROMPT), "clear_unknown", json!(true), "yes");
    on_new(&rig);
    // cleared_not_sent: a draft in the new conversation's box.
    let rig = Rig::new();
    rig.on_clear(|st| {
        st.screens.insert("t1".into(), screen(&["❯\u{a0}hello"]));
        st.paints.insert("t1".into(), typed_at_end("hello"));
    });
    check(&rig.go(PROMPT), "cleared_not_sent", json!(true), "yes");
    on_new(&rig);
    // sent.
    let rig = Rig::new();
    check(&rig.go(PROMPT), "sent", json!(true), "yes");
    on_new(&rig);
    // No cache asked for: none written.
    let rig = Rig::new();
    let a = reenter::run("t1", &rig.found(), &rig.procs, &rig.client, PROMPT, &rig.expect(), None, WAIT, Instant::now() + Duration::from_secs(30));
    check(&a, "sent", json!(true), "yes");
    assert!(!rig.cache.exists());
}

/// Catches (Task 3 review): the cache refresh after the prompt waiting its fixed 3 s when the deadline is nearly spent,
/// so a run answered after the mod's 30 s exec had given up and the answer was lost although keys went.
#[test]
fn cache_refresh_stays_inside_the_deadline() {
    let rig = Rig::new();
    let slow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let on_clear = {
        let (dir, start) = (rig.sessions(), rig.start.clone());
        move |st: &mut State| standard_clear(&dir, &start, st)
    };
    let flag = slow.clone();
    rig.fake.on_send(Some(Arc::new(move |_a, text, st| {
        if text == "/clear" {
            on_clear(st);
        } else {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    })));
    let flag = slow.clone();
    rig.fake.on_call(Some(Arc::new(move |m, _st| {
        if m == "terminal.list" && flag.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(5));
        }
    })));
    let t0 = Instant::now();
    let a = reenter::run_with_need("t1", &rig.found(), &rig.procs, &rig.client, PROMPT, &rig.expect(), Some(&rig.cache), WAIT, t0 + Duration::from_millis(1500), Duration::ZERO);
    check(&a, "sent", json!(true), "yes");
    assert!(t0.elapsed() < Duration::from_millis(2300), "answered {:?} after the start: the refresh must stop at the deadline (+0.3 s floor)", t0.elapsed());
}

/// Catches (Task 3 review): a prompt that could not be typed explained as "no longer idle" when the cause was a refusal
/// the core made for another reason or a connect error. The message is true for every cause; result, cleared, keys stay.
#[test]
fn prompt_not_sent_message_is_neutral() {
    for kind in ["status_mismatch", "blocked"] {
        let rig = Rig::new();
        rig.fake.send_refuse(vec![None, Some(kind)]);
        let a = rig.go(PROMPT);
        check(&a, "cleared_not_sent", json!(true), "yes");
        assert_eq!(a.message.as_deref(), Some("The tab was cleared, but the prompt could not be typed."), "{kind}");
        assert_eq!(rig.sent(), ["/clear", PROMPT], "{kind}: the refused prompt send is still recorded, nothing else");
    }
}

/// The built binary's local arm on a real process standing in for Claude Code (the arm scans the real process table:
/// the pid record only counts for a live process that started when it says). No key goes anywhere but the fake core.
struct Live {
    fake: FakeHc,
    cfg: tempfile::TempDir,
    locks: tempfile::TempDir,
    child: std::process::Child,
    start: String,
}

impl Live {
    fn new() -> Live {
        let fake = FakeHc::start();
        let cfg = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cfg.path().join("sessions")).unwrap();
        std::fs::create_dir_all(cfg.path().join("projects/-tmp-proj")).unwrap();
        std::fs::write(cfg.path().join("projects/-tmp-proj/old.jsonl"), "{}\n").unwrap();
        // A process named claude with the config folder in its environment, as `ps -E` shows it. Not a system binary:
        // macOS hides the environment of those (and kills a copy of one), so this test binary runs its own sleeper.
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg0("claude")
            .args(["--ignored", "--exact", "stand_in_sleeper"])
            .env_clear()
            .env("CLAUDE_CONFIG_DIR", cfg.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let start = {
            let mut found = None;
            for _ in 0..50 {
                // `ps -E` can show the process before its environment (the config folder the pid files are read from).
                found = herdr_core::resolver::processes().into_iter().find(|p| p.pid == pid && p.line.contains("CLAUDE_CONFIG_DIR="));
                if found.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            found.expect("the stand-in process shows in the process table").start.format("%a %b %-d %H:%M:%S %Y").to_string()
        };
        let live = Live { fake, cfg, locks: tempfile::tempdir().unwrap(), child, start };
        live.record("old", "idle");
        live.fake.set_terminals(vec![live.tab("done")]);
        live.fake.set_screen("t1", &empty_screen());
        live.fake.set_paint("t1", EMPTY);
        let (dir, start, pid) = (live.cfg.path().join("sessions"), live.start.clone(), live.child.id());
        live.fake.on_send(Some(Arc::new(move |_a, text, st| {
            if text == "/clear" {
                write_record_for(&dir, pid, &start, "new", "idle");
                st.terminals = vec![common::terminal("t1", &["claude"], Some(pid as i64), Some("idle"), Some("idle"))];
                st.screens.insert("t1".into(), after_clear_screen());
                st.paints.insert("t1".into(), CLEAR_02.to_vec());
            }
        })));
        live
    }
    fn tab(&self, status: &str) -> Value {
        common::terminal("t1", &["claude"], Some(self.child.id() as i64), Some(status), Some(status))
    }
    fn record(&self, session: &str, status: &str) {
        write_record_for(&self.cfg.path().join("sessions"), self.child.id(), &self.start, session, status);
    }
    fn log(&self) -> String {
        self.cfg.path().join("projects/-tmp-proj/old.jsonl").to_string_lossy().into_owned()
    }
    /// The mod's own argv for a `reenter` (`sidecar.call` appends `--home` last), then `extra` before `--text`.
    fn run(&self, extra: &[&str], text: &str) -> Vec<Value> {
        let cache = self.cfg.path().join("cache/cache.json");
        let (log, cache) = (self.log(), cache.to_string_lossy().into_owned());
        let mut args = vec!["reenter", "--terminal", "t1", "--expect-path", &log, "--cache", &cache];
        args.extend(extra);
        args.extend(["--text", text, "--home", "/nonexistent-app"]);
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_flockbook-modfeed"))
            .args(&args)
            .env_clear()
            .env("HC_SOCKET", &self.fake.path)
            .env("HOME", "/nonexistent-home")
            .env("FLOCKBOOK_KEYLOCK_DIR", self.locks.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "exit code 0 always");
        String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn done(v: &[Value]) -> Value {
    v.iter().find(|l| l["type"] == "done").cloned().unwrap_or_else(|| panic!("a done line: {v:?}"))
}

/// Catches: the local arm reading the tab from the cache (a cached find has no pid record, so every run answers
/// `no-identity` and nothing ever clears), the argv the mod really builds (`--home` last, a text that is itself
/// `--home`) misread, or a key typed on the wrong terms. The whole path: header, one `done`, end.
#[test]
fn local_arm_reaches_clear_and_the_prompt_with_the_mods_argv() {
    let live = Live::new();
    let v = live.run(&[], "--home");
    assert_eq!((v[0]["type"].as_str(), v.last().unwrap()["type"].as_str()), (Some("header"), Some("end")), "{v:?}");
    let d = done(&v);
    assert_eq!((d["result"].as_str(), d["cleared"].clone(), d["keys"].as_str()), (Some("sent"), json!(true), Some("yes")), "{v:?}");
    assert_eq!(live.fake.sent_texts(), ["/clear", "--home"], "the text is the value after --text, whatever it says");
    assert!(live.fake.keys().is_empty());
}

/// Catches: `--budget-ms` ignored (the run needs 18 s: 17 s left must refuse, after every check, with nothing typed),
/// and a run with no `--budget-ms` having no time at all (it has enough for a whole run: the 27 s default).
#[test]
fn budget_ms_sets_the_deadline() {
    let live = Live::new();
    let d = done(&live.run(&["--budget-ms", "17000"], PROMPT));
    assert_eq!((d["result"].as_str(), d["cleared"].clone(), d["keys"].as_str()), (Some("no_time"), json!(false), Some("none")), "{d}");
    assert!(live.fake.sent_texts().is_empty(), "nothing typed");
    let d = done(&live.run(&[], PROMPT));
    assert_eq!(d["result"], "sent", "no --budget-ms: 27 s, enough: {d}");
}

/// Not a test: the stand-in process `Live` starts (this test binary, named `claude`), so `ps -E` shows its environment.
#[test]
#[ignore]
fn stand_in_sleeper() {
    // Only the rig sets this: a general `--include-ignored` run returns at once.
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
        return;
    }
    std::thread::sleep(Duration::from_secs(120));
}
