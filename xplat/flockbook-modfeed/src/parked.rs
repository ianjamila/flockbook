//! Claude Code tabs whose conversation went on in Claude Code's background service ("parked", owner 11-13). The
//! client in the terminal says it is parked and stops reporting; the background session has no terminal to report
//! to. So herdr-core shows the agent as `unknown` (the app: no agent at all), and the tab drops out of the chat, the
//! lists and the cards. This gives such an agent the job's status: blocked while a permission prompt or Claude's
//! question picker is on screen (the terminal shows the job's screen), else working or idle from the job's pid file.

use herdr_core::approval;
use herdr_core::question;
use herdr_core::resolver::{self, ParkedClaude, Proc};
use herdr_core::{AgentStatus, BackendKind, Pane, PaneScreen, Workspace};
use serde_json::{json, Value};

/// One parked agent found in the workspaces, with the status it now has.
#[derive(Clone, Debug, PartialEq)]
pub struct Promoted {
    pub terminal: String,
    pub pane: String,
    pub parked: ParkedClaude,
    pub status: AgentStatus,
    /// `permission` or `question` while blocked.
    pub kind: Option<String>,
}

/// The status of a parked job: a prompt on its screen first, then its pid file's word (`idle`; `busy`, `shell` and
/// anything else Claude Code writes while it runs).
pub fn status_of(word: &str, screen: Option<&str>) -> (AgentStatus, Option<String>) {
    if let Some(s) = screen {
        if question::claude_screen(s).is_some() {
            return (AgentStatus::Blocked, Some("question".into()));
        }
        if approval::screen_shows_prompt(s) {
            return (AgentStatus::Blocked, Some("permission".into()));
        }
    }
    match word {
        "idle" => (AgentStatus::Idle, None),
        "" => (AgentStatus::Unknown, None),
        _ => (AgentStatus::Working, None),
    }
}

/// A pane that may be a parked Claude: a local hc pane running Claude that reports no status.
pub fn candidate(p: &Pane) -> bool {
    p.backend == BackendKind::Hc
        && !p.terminal_id.contains('/')
        && !p.process_ids.is_empty()
        && p.agent.as_ref().is_some_and(|a| a.kind == "claude" && a.status == AgentStatus::Unknown)
}

/// Gives every parked agent in `ws` its job's status (and its tab the status rolled up). `find`: the parked job of a
/// pane; `screen`: a pane's visible text. Nothing else changes.
pub fn promote_with(ws: &mut [Workspace], find: impl Fn(&Pane) -> Option<ParkedClaude>, screen: impl Fn(&str) -> Option<String>) -> Vec<Promoted> {
    let mut out = vec![];
    for w in ws.iter_mut() {
        for t in w.tabs.iter_mut() {
            for p in t.panes.iter_mut() {
                if !candidate(p) {
                    continue;
                }
                let Some(parked) = find(p) else { continue };
                let (status, kind) = status_of(&parked.status, screen(&p.id).as_deref());
                if status == AgentStatus::Unknown {
                    continue;
                }
                if let Some(a) = p.agent.as_mut() {
                    a.status = status;
                    a.status_kind = kind.clone();
                }
                if status.rank() > t.status.rank() {
                    t.status = status;
                }
                out.push(Promoted { terminal: p.terminal_id.clone(), pane: p.id.clone(), parked, status, kind });
            }
        }
    }
    out
}

/// `promote_with` on this machine: one process listing (only when some pane may be parked), Claude's pid files in the
/// agent's config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`), the screen read through hc.
pub fn promote<S: PaneScreen + ?Sized>(ws: &mut [Workspace], client: &S) -> Vec<Promoted> {
    let any = ws.iter().flat_map(|w| &w.tabs).flat_map(|t| &t.panes).any(candidate);
    if !any {
        return vec![];
    }
    let procs: Vec<Proc> = resolver::processes();
    let home = std::env::var("HOME").unwrap_or_default();
    promote_with(
        ws,
        |p| {
            let agent = resolver::hc_agent_process(&p.process_ids, "claude", &procs)?;
            let dir = resolver::claude_home(&agent.line).unwrap_or_else(|| format!("{home}/.claude")) + "/sessions";
            let mut pids = vec![agent.pid];
            pids.extend(&p.process_ids);
            resolver::claude_parked(&pids, &procs, &dir)
        },
        |id| client.visible_text(id).ok(),
    )
}

pub fn status_word(s: AgentStatus) -> &'static str {
    match s {
        AgentStatus::Idle => "idle",
        AgentStatus::Working => "working",
        AgentStatus::Blocked => "blocked",
        AgentStatus::Done => "done",
        AgentStatus::Unknown => "unknown",
    }
}

/// The `parked` line (docs/protocol.md): every parked agent with its job and status.
pub fn line(list: &[Promoted]) -> Value {
    json!({"type": "parked", "terminals": list.iter().map(|p| json!({
        "terminal": p.terminal, "job": p.parked.job, "session": p.parked.session, "status": status_word(p.status),
        "kind": p.kind, "name": p.parked.name,
    })).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use herdr_core::{Agent, Tab};

    fn pane(id: &str, kind: &str, status: AgentStatus) -> Pane {
        Pane {
            id: format!("hc:{id}"),
            terminal_id: id.into(),
            cwd: "/w".into(),
            agent: Some(Agent { name: kind.into(), kind: kind.into(), status, session_id: None, title: "t".into(), backend: BackendKind::Hc, status_kind: None, process: None }),
            label: None,
            backend: BackendKind::Hc,
            process_ids: vec![7],
        }
    }

    fn job(status: &str) -> ParkedClaude {
        ParkedClaude { job: "J1".into(), session: "sid".into(), pid: 9, status: status.into(), name: Some("Work".into()) }
    }

    #[test]
    fn status_from_pid_file_and_screen() {
        assert_eq!(status_of("busy", Some("⏺ Reading files")), (AgentStatus::Working, None));
        assert_eq!(status_of("shell", None), (AgentStatus::Working, None));
        assert_eq!(status_of("idle", Some("❯ ")), (AgentStatus::Idle, None));
        assert_eq!(status_of("", None), (AgentStatus::Unknown, None));
        let prompt = "Bash command\n\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n";
        assert_eq!(status_of("busy", Some(prompt)), (AgentStatus::Blocked, Some("permission".into())));
        let picker = "❯ Ask me.\n────────────────────\n ☐ Color\nPick a color?\n❯ 1. Red (Recommended)\n     warm\n  2. Blue\n     cool\n  3. Type something.\n────────────────────\n  4. Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel";
        assert_eq!(status_of("busy", Some(picker)), (AgentStatus::Blocked, Some("question".into())));
        assert_eq!(status_of("idle", Some(picker)), (AgentStatus::Blocked, Some("question".into())), "the screen wins over the pid file");
    }

    #[test]
    fn promotes_only_parked_unknown_claude_panes() {
        let mut ws = vec![Workspace {
            id: "w".into(),
            label: "w".into(),
            tabs: vec![
                Tab { id: "a".into(), label: "a".into(), number: 1, panes: vec![pane("t1", "claude", AgentStatus::Unknown)], status: AgentStatus::Unknown },
                Tab { id: "b".into(), label: "b".into(), number: 2, panes: vec![pane("t2", "claude", AgentStatus::Unknown)], status: AgentStatus::Unknown },
                Tab { id: "c".into(), label: "c".into(), number: 3, panes: vec![pane("t3", "claude", AgentStatus::Working)], status: AgentStatus::Working },
                Tab { id: "d".into(), label: "d".into(), number: 4, panes: vec![pane("t4", "codex", AgentStatus::Unknown)], status: AgentStatus::Unknown },
            ],
        }];
        let asked = std::cell::RefCell::new(vec![]);
        let got = promote_with(
            &mut ws,
            |p| {
                asked.borrow_mut().push(p.terminal_id.clone());
                (p.terminal_id == "t1").then(|| job("busy"))
            },
            |_| Some("⏺ working".into()),
        );
        assert_eq!(*asked.borrow(), vec!["t1", "t2"], "only Claude panes with no status are looked up");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].terminal.as_str(), got[0].status), ("t1", AgentStatus::Working));
        assert_eq!(ws[0].tabs[0].status, AgentStatus::Working, "its tab rolls the status up");
        assert_eq!(ws[0].tabs[0].panes[0].agent.as_ref().unwrap().status, AgentStatus::Working);
        assert_eq!(ws[0].tabs[1].status, AgentStatus::Unknown, "not parked: untouched");
        assert_eq!(
            line(&got),
            json!({"type": "parked", "terminals": [{"terminal": "t1", "job": "J1", "session": "sid", "status": "working", "kind": null, "name": "Work"}]})
        );
    }

    #[test]
    fn a_remote_pane_is_never_a_candidate() {
        let mut p = pane("m/t1", "claude", AgentStatus::Unknown);
        assert!(!candidate(&p));
        p.terminal_id = "t1".into();
        assert!(candidate(&p));
    }
}
