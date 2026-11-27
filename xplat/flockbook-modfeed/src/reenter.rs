//! `reenter`: in a finished Claude Code tab, type `/clear`, wait for the new conversation, check again, and type exactly
//! the given prompt. Every check runs on the terminal's machine, milliseconds before the key it guards.
//!
//! Anti-goals: a key into a box that holds a person's draft; the prompt going into the old conversation or another
//! agent; a prompt other than the one given; an answer that says "nothing typed" when a key may have gone. So:
//! nothing is typed before the `/clear` send, and every answer before it says `keys: "none"`; once the `/clear` send
//! may have gone, no answer ever says nothing was typed.
//!
//! The caller holds the terminal's keys lock (`keylock`) and built `client` with send timeout `SEND_S`. `run` does not
//! take the lock.

use crate::cards::{self, Done};
use crate::{locate, queue};
use herdr_core::hc::{HcClient, SendOutcome};
use herdr_core::keygate;
use herdr_core::resolver::{read_pid_record, PidRecord, Proc, ProcessSource, SessionResolver};
use herdr_core::*;
use serde::{Serialize, Serializer};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long `run` waits for the new conversation after `/clear`, and how often it looks.
#[derive(Clone, Copy, Debug)]
pub struct Wait {
    pub limit: Duration,
    pub every: Duration,
}

pub const WAIT: Wait = Wait { limit: Duration::from_secs(6), every: Duration::from_millis(50) };
/// Seconds each `terminal.send` waits for the core's reply (the core holds a send while a person's draft is in the
/// box). `client` is built with this send timeout; `run` also bounds each send by the time left.
pub const SEND_S: u64 = 5;
/// The time `run` needs left, measured right before the `/clear` send: the `/clear` send, the wait and the prompt send
/// (5 + 6 + 5 s) and the checks between them. Less: `no_time`, nothing typed.
pub const NEED_MS: u64 = 18_000;

/// Whether the tab was cleared: `false` nothing typed, `true` the `/clear` went, `"maybe"` it may still arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cleared {
    No,
    Yes,
    Maybe,
}

impl Serialize for Cleared {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Cleared::No => s.serialize_bool(false),
            Cleared::Yes => s.serialize_bool(true),
            Cleared::Maybe => s.serialize_str("maybe"),
        }
    }
}

/// Whether any key went to the tab: none, yes, or maybe (a send whose reply was lost).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keys {
    #[serde(rename = "none")]
    None_,
    #[serde(rename = "yes")]
    Yes,
    #[serde(rename = "maybe")]
    Maybe,
}

/// The one `done` line `reenter` answers with. `result` and the (`cleared`, `keys`) pair it comes with:
/// `sent`, `prompt_unconfirmed`, `cleared_not_sent`, `clear_unknown` true/yes; `clear_unconfirmed` "maybe"/maybe;
/// `failed` (the `/clear` provably not sent) and every refusal before it false/none.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    #[serde(rename = "type")]
    pub t: &'static str,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub cleared: Cleared,
    pub keys: Keys,
}

fn answer(result: &str, message: &str, cleared: Cleared, keys: Keys) -> Answer {
    Answer { t: "done", result: result.into(), message: Some(message.into()), cleared, keys }
}

/// A refusal before the `/clear` send: nothing was typed.
fn refuse(result: &str, message: &str) -> Answer {
    answer(result, message, Cleared::No, Keys::None_)
}

/// A refusal of a keyed command (busy, no_lock, changed...) as a reenter answer: nothing typed.
pub fn from_done(d: Done) -> Answer {
    Answer { t: "done", result: d.result, message: d.message, cleared: Cleared::No, keys: Keys::None_ }
}

const NO_TIME: &str = "There is not enough time left to do it safely.";

/// Not enough time left to start (`NEED_MS`): nothing typed.
pub fn no_time() -> Answer {
    refuse("no_time", NO_TIME)
}

/// The `/clear` went: only the prompt (or its confirmation) is missing.
fn cleared_not_sent(why: &str) -> Answer {
    answer("cleared_not_sent", why, Cleared::Yes, Keys::Yes)
}

pub const NO_IDENTITY: &str = "Flockbook cannot tell when the new conversation starts.";
const CHANGED: &str = "The tab no longer shows the conversation this prompt was read from.";

/// Text the tab would not take as a message: empty, or a command (`/`), a shell line (`!`) or a memory note (`#`).
pub fn bad_text(text: &str) -> bool {
    text.trim().chars().next().is_none_or(|c| matches!(c, '/' | '!' | '#'))
}

/// The input to the later RPCs: each call waits at most `limit` (the time left to the deadline, or the client's own
/// call timeout). It reads; it never presses a key (the only key path is `send_sure`).
struct Io<'a> {
    client: &'a HcClient,
    limit: Duration,
}

impl<'a> Io<'a> {
    fn new(client: &'a HcClient, deadline: Instant) -> Io<'a> {
        let left = deadline.saturating_duration_since(Instant::now());
        // A zero timeout is no timeout to a socket: keep at least a millisecond.
        Io { client, limit: left.min(client.call_timeout).max(Duration::from_millis(1)) }
    }
}

fn no_keys() -> HerdrError {
    HerdrError::Protocol("reenter types only through send_sure".into())
}

impl PaneScreen for Io<'_> {
    fn backend(&self) -> BackendKind {
        BackendKind::Hc
    }
    fn snapshot(&self) -> Result<Vec<Workspace>, HerdrError> {
        self.client.snapshot_within(self.limit)
    }
    fn visible_text(&self, pane_id: &str) -> Result<String, HerdrError> {
        self.client.visible_text_within(pane_id, self.limit)
    }
    fn respond(&self, _: &str, _: bool) -> Result<(), HerdrError> {
        Err(no_keys())
    }
    fn send_named_keys(&self, _: &[String], _: &str) -> Result<(), HerdrError> {
        Err(no_keys())
    }
    fn send_keys(&self, _: &[u8], _: &str) -> Result<(), HerdrError> {
        Err(no_keys())
    }
    fn send_text(&self, _: &str, _: &str) -> Result<(), HerdrError> {
        Err(no_keys())
    }
}

/// The key gate: the pane still shows the agent read first (same kind, same program).
fn gate_ok(io: &Io, pane: &Pane) -> bool {
    keygate::passes(io, Some(&cards::gate(pane)), &pane.id, None, None)
}

#[derive(Debug, PartialEq)]
enum Boxed {
    Empty,
    Text,
    NoBox,
}

/// The strict box rule (both checks): `.0` the verdict, `.1` whether a paint was taken (the caller asks the key gate
/// again after it). Every "empty" needs one watch-only paint as proof, because the text read strips trailing spaces
/// and blank rows:
/// - all rows blank, exactly one box row, the cursor right after "❯ " → empty;
/// - `dim_ok` (before `/clear` only): exactly one row, one non-blank, every character dim at the box start → empty (a
///   dim suggestion or the dim placeholder).
///
/// A paint that fails or times out reads as text. Anything else: text. No box, or the read failed: no box.
fn strict_box(io: &Io, client: &HcClient, pane_id: &str, deadline: Instant, dim_ok: bool) -> (Boxed, bool) {
    let Ok(screen) = io.visible_text(pane_id) else { return (Boxed::NoBox, false) };
    let Some(rows) = queue::claude_box_raw(&screen) else { return (Boxed::NoBox, false) };
    let shown: Vec<String> = rows.iter().map(|r| r.replace('\u{a0}', " ")).collect();
    let filled: Vec<&str> = shown.iter().map(|r| r.trim()).filter(|r| !r.is_empty()).collect();
    match (filled.as_slice(), rows.len()) {
        ([], 1) => {
            let limit = cards::LOOK_LIMIT.min(deadline.saturating_duration_since(Instant::now())).max(Duration::from_millis(1));
            let empty = client.first_paint(pane_id, limit).is_ok_and(|p| queue::cursor_at_box_start(&p));
            (if empty { Boxed::Empty } else { Boxed::Text }, true)
        }
        ([row], 1) if dim_ok => (if cards::dim_row(client, pane_id, row) { Boxed::Empty } else { Boxed::Text }, true),
        _ => (Boxed::Text, false),
    }
}

fn pane_in<'a>(ws: &'a [Workspace], pane_id: &str) -> Option<&'a Pane> {
    all_panes(ws).into_iter().find(|p| p.id == pane_id)
}

/// A fixed process list (the caller's scan) as the resolver's source: after `/clear` the pane's processes are the same.
struct Fixed(Vec<Proc>);

impl ProcessSource for Fixed {
    fn processes(&self) -> Vec<Proc> {
        self.0.clone()
    }
    fn open_files(&self, _: &[i32]) -> Vec<String> {
        vec![]
    }
}

/// A9: look the tab up again so the cache names the new conversation (its log, or the bare session id until the log
/// exists), and the chat and the Finished list read it at once.
/// Best effort and bounded by the time left to `deadline` (a floor of 300 ms): a late answer is lost to the caller's own
/// timeout although keys went, and a stale cache only delays the chat catching up.
fn refresh_cache(terminal: &str, procs: &[Proc], client: &HcClient, cache: Option<&Path>, deadline: Instant) {
    let Some(cache) = cache else { return };
    let limit = Duration::from_secs(3).min(deadline.saturating_duration_since(Instant::now())).max(Duration::from_millis(300));
    let Ok(ws) = client.snapshot_within(limit) else { return };
    let mut resolver = SessionResolver::new(&client.session.socket_path).with_source(Box::new(Fixed(procs.to_vec())));
    let now_s = std::time::SystemTime::now().duration_since(std::time::SystemTime::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let _ = locate::recheck(terminal, &ws, &mut resolver, Some(cache), now_s);
}

/// `run_with_need` with the time `NEED_MS` asks for.
#[allow(clippy::too_many_arguments)]
pub fn run(terminal: &str, found: &locate::Found, procs: &[Proc], client: &HcClient, text: &str, expect_path: &str, cache: Option<&Path>, wait: Wait, deadline: Instant) -> Answer {
    run_with_need(terminal, found, procs, client, text, expect_path, cache, wait, deadline, Duration::from_millis(NEED_MS))
}

/// Re-enter the tab `found` (read afresh by the caller, under the terminal's keys lock): `/clear`, then `text`.
/// `expect_path`: the log the prompt was read from. `deadline`: a monotonic limit for the whole run; each RPC after
/// the first reads waits at most what is left. `need`: the time that must be left right before the `/clear` send
/// (`NEED_MS`; a check passes less).
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn run_with_need(
    terminal: &str,
    found: &locate::Found,
    procs: &[Proc],
    client: &HcClient,
    text: &str,
    expect_path: &str,
    cache: Option<&Path>,
    wait: Wait,
    deadline: Instant,
    need: Duration,
) -> Answer {
    let pane = &found.pane;
    // 1. The text.
    if bad_text(text) {
        return refuse("bad_text", "The prompt is empty, or starts with /, ! or #, which Claude Code would not take as a message.");
    }
    // 2. Claude, and no identity to check yet: the pid record that tells the new conversation.
    if !pane.agent.as_ref().is_some_and(|a| a.kind == "claude") {
        return refuse("changed", "Another agent is in this tab now.");
    }
    let Some((pid, dir)) = found.pid_record.as_ref() else { return refuse("no-identity", NO_IDENTITY) };
    // The conversation the prompt was read from, and no other. A log the conversation went on in is not it.
    if found.path.as_deref() != Some(expect_path) {
        return refuse("changed", CHANGED);
    }
    // 3. The old session: the pid record names exactly the log found (not its `continued-in` successor).
    let Some(old) = read_pid_record(dir, *pid, procs) else { return refuse("no-identity", NO_IDENTITY) };
    if old.kind.as_deref() == Some("bg") || old.parked.is_some() {
        return refuse("no-identity", NO_IDENTITY);
    }
    let stem = found.raw.as_deref().and_then(|r| Path::new(r).file_stem()).and_then(|s| s.to_str());
    if stem != Some(old.session.as_str()) || found.raw != found.path {
        return refuse("changed", CHANGED);
    }
    // 4. The tab is idle: not working, not waiting, no approval or question on screen.
    let io = Io::new(client, deadline);
    let busy = refuse("tab_busy", "The tab is busy: Claude is working or waiting for an answer.");
    if pane.agent.as_ref().is_some_and(|a| matches!(a.status, AgentStatus::Working | AgentStatus::Blocked)) {
        return busy;
    }
    if cards::look(pane, &io, found.path.as_deref().map(Path::new)).0.is_some() {
        return busy;
    }
    // 5. The key gate.
    if !gate_ok(&io, pane) {
        return from_done(cards::refused(pane));
    }
    // 6. The box is empty (strict); the gate again after the paint.
    let (verdict, painted) = strict_box(&Io::new(client, deadline), client, &pane.id, deadline, true);
    if painted && !gate_ok(&Io::new(client, deadline), pane) {
        return from_done(cards::refused(pane));
    }
    match verdict {
        Boxed::Empty => {}
        Boxed::Text => return refuse("box_not_empty", "The tab's box has text in it."),
        Boxed::NoBox => return refuse("no_box", "Flockbook cannot find Claude's input box on the tab's screen."),
    }
    // 7. A10: right before the send, still idle (a turn may have started during the checks), by the agent's status
    // and by its own record.
    let Some(now) = keygate::fresh_agent(&Io::new(client, deadline), pane.agent.as_ref().expect("claude, checked above"), &pane.id) else {
        return from_done(cards::refused(pane));
    };
    if matches!(now.status, AgentStatus::Working | AgentStatus::Blocked) || read_pid_record(dir, *pid, procs).is_none_or(|r| r.status.as_deref() != Some("idle")) {
        return busy;
    }
    let left = deadline.saturating_duration_since(Instant::now());
    if left < need {
        return no_time();
    }

    // 8. `/clear`. No `if`: after a finished turn the core's status is `done`, and `if: "idle"` would refuse.
    let sent = client.send_sure("/clear", &pane.id, Duration::from_secs(SEND_S).min(left), None);
    let a = match sent {
        SendOutcome::NotSent => return refuse("failed", "herdr-core did not take the /clear."),
        SendOutcome::Maybe => answer(
            "clear_unconfirmed",
            "The /clear was not confirmed: it may still arrive. The prompt was not typed.",
            Cleared::Maybe,
            Keys::Maybe,
        ),
        SendOutcome::Sent => after_clear(found, procs, client, text, wait, deadline, (*pid, dir), &old),
    };
    // 12. A9: the cache names the conversation the tab holds now.
    refresh_cache(terminal, procs, client, cache, deadline);
    a
}

/// Steps 8 (the wait) to 11, after the `/clear` send returned `Sent`.
#[allow(clippy::too_many_arguments)]
fn after_clear(found: &locate::Found, procs: &[Proc], client: &HcClient, text: &str, wait: Wait, deadline: Instant, record: (i32, &str), old: &PidRecord) -> Answer {
    let pane = &found.pane;
    let (pid, dir) = record;
    // The new conversation: another session, idle, in the same process (a changed start is another process).
    let end = (Instant::now() + wait.limit).min(deadline);
    let new = loop {
        if let Some(r) = read_pid_record(dir, pid, procs) {
            if r.session != old.session && r.status.as_deref() == Some("idle") && r.proc_start == old.proc_start {
                break r.session;
            }
        }
        let now = Instant::now();
        if now >= end {
            return answer("clear_unknown", "The /clear was typed, but no new conversation showed. The prompt was not typed.", Cleared::Yes, Keys::Yes);
        }
        std::thread::sleep(wait.every.min(end - now));
    };
    // 9. A11: out of time: the prompt is not sent.
    if Instant::now() >= deadline {
        return cleared_not_sent("The new conversation started, but time ran out before the prompt could be typed.");
    }
    // 10. Checked again right before the prompt, with no dim exception: after `/clear` the box is empty.
    let Ok(ws) = Io::new(client, deadline).snapshot() else { return cleared_not_sent("Flockbook could not check the tab before typing the prompt.") };
    let Some(now) = pane_in(&ws, &pane.id) else { return cleared_not_sent("The tab is gone.") };
    if now.process_ids != pane.process_ids || now.agent.as_ref().is_none_or(|a| a.status != AgentStatus::Idle) {
        return cleared_not_sent("The tab changed after the /clear, so the prompt was not typed.");
    }
    if read_pid_record(dir, pid, procs).is_none_or(|r| r.session != new || r.proc_start != old.proc_start) {
        return cleared_not_sent("The conversation changed again after the /clear, so the prompt was not typed.");
    }
    if !gate_ok(&Io::new(client, deadline), pane) {
        return cleared_not_sent("Another agent is in the tab now, so the prompt was not typed.");
    }
    let (verdict, painted) = strict_box(&Io::new(client, deadline), client, &pane.id, deadline, false);
    if painted && !gate_ok(&Io::new(client, deadline), pane) {
        return cleared_not_sent("Another agent is in the tab now, so the prompt was not typed.");
    }
    if verdict != Boxed::Empty {
        return cleared_not_sent("The new conversation's box has text in it, so the prompt was not typed.");
    }
    // 11. The prompt. The core re-checks `if: "idle"` when it pastes: a person who sent their own message meanwhile
    // makes it refuse, with nothing pasted.
    let left = deadline.saturating_duration_since(Instant::now());
    match client.send_sure(text, &pane.id, Duration::from_secs(SEND_S).min(left), Some("idle")) {
        SendOutcome::Sent => Answer { t: "done", result: "sent".into(), message: None, cleared: Cleared::Yes, keys: Keys::Yes },
        SendOutcome::Maybe => answer("prompt_unconfirmed", "The prompt was typed but not confirmed: it may already be in the tab.", Cleared::Yes, Keys::Yes),
        SendOutcome::NotSent => cleared_not_sent("The tab was cleared, but the prompt could not be typed."),
    }
}
