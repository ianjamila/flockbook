//! s31 (owner 11-14, Resume sessions): a Claude tab is identified before its first message. Claude Code's pid file
//! names the session at start (and after `/clear`), before the conversation has a log; the helper's cache now carries
//! that bare id and its config folder (`sid`, `config`), so the mod knows which session the tab holds at once instead
//! of treating it as "not identified yet" (which blocked every Resume on its machine).
#![cfg(unix)]

mod common;
use common::{terminal, FakeHc};
use herdr_core::hc::{HcClient, HcSession};
use herdr_core::resolver::{parse_ps, Proc, ProcessSource, SessionResolver};
use herdr_core::*;
use modfeedkit::locate;
use std::time::SystemTime;

struct Procs(Vec<Proc>);
impl ProcessSource for Procs {
    fn processes(&self) -> Vec<Proc> {
        self.0.clone()
    }
    fn open_files(&self, _: &[i32]) -> Vec<String> {
        vec![]
    }
}

fn pid_file(dir: &std::path::Path, pid: i32, sid: &str, start: &Proc) {
    std::fs::create_dir_all(dir).unwrap();
    let o = serde_json::json!({"pid": pid, "sessionId": sid, "procStart": start.start.format("%a %b %-d %H:%M:%S %Y").to_string(), "cwd": "/tmp/proj"});
    std::fs::write(dir.join(format!("{pid}.json")), serde_json::to_vec(&o).unwrap()).unwrap();
}

#[test]
fn a_new_claude_tab_is_identified_before_its_first_message() {
    let fake = FakeHc::start();
    let hc = HcClient::new(HcSession::new(&fake.path), 10, 60);
    let tmp = tempfile::tempdir().unwrap();
    let home_cfg = tmp.path().join("home-cfg");
    let work_cfg = tmp.path().join("work-cfg");
    let procs = parse_ps(&format!(
        "  4242     1 Sat Oct 31 10:01:00 2026     claude HC_TERMINAL_ID=t1\n  4343     1 Sat Oct 31 10:02:00 2026     claude CLAUDE_CONFIG_DIR={} HC_TERMINAL_ID=t2\n",
        work_cfg.display()
    ));
    pid_file(&home_cfg.join("sessions"), 4242, "sid-fresh", &procs[0]);
    pid_file(&work_cfg.join("sessions"), 4343, "sid-work", &procs[1]);
    fake.set_terminals(vec![
        terminal("t1", &["claude"], Some(4242), Some("idle"), None),
        terminal("t2", &["claude"], Some(4343), Some("idle"), None),
    ]);
    let ws = hc.snapshot().unwrap();
    let mut res = SessionResolver::new("/nonexistent.sock").with_source(Box::new(Procs(procs.clone())));
    res.claude_dir = home_cfg.join("sessions").to_string_lossy().into_owned();
    res.retry = 0.0;
    let cache = tmp.path().join("cache.json");
    let now_s = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs_f64();

    let found = locate::find("t1", &ws, &mut res, Some(&cache), now_s).unwrap();
    assert_eq!(found.path, None, "no log yet: nothing for the chat to read");
    let c = locate::read_cache(Some(&cache));
    let e1 = c.entries.get("t1").expect("t1 cached");
    assert_eq!((e1.sid.as_deref(), e1.config.clone()), (Some("sid-fresh"), Some(home_cfg.to_string_lossy().into_owned())), "the default account's new tab: its id and config folder ({e1:?})");
    let e2 = c.entries.get("t2").expect("t2 cached in the same pass");
    assert_eq!((e2.sid.as_deref(), e2.config.clone()), (Some("sid-work"), Some(work_cfg.to_string_lossy().into_owned())), "an account with its own config folder ({e2:?})");
    assert!(e2.path.is_none());

    // Its first message writes the log: the entry holds the path and no longer the bare id.
    let log = work_cfg.join("projects").join("-tmp-proj").join("sid-work.jsonl");
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, "{}\n").unwrap();
    let found = locate::find("t2", &ws, &mut res, Some(&cache), now_s + 1.0).unwrap();
    assert_eq!(found.path.as_deref(), Some(log.to_string_lossy().as_ref()), "the log once it exists");
    let e2 = locate::read_cache(Some(&cache)).entries.get("t2").cloned().unwrap();
    assert_eq!((e2.sid, e2.config), (None, None), "a found log needs no bare id");

    // An older cache file (no sid/config) still reads, and an entry without them writes no such keys.
    let old = r#"{"entries":{"t9":{"kind":"claude","cwd":"/w","pids":[1],"checked":1.0}}}"#;
    std::fs::write(&cache, old).unwrap();
    let back = locate::read_cache(Some(&cache));
    let e9 = back.entries.get("t9").unwrap();
    assert_eq!((e9.sid.as_deref(), e9.config.as_deref()), (None, None));
    locate::write_cache(&back, Some(&cache));
    let text = std::fs::read_to_string(&cache).unwrap();
    assert!(!text.contains("\"sid\"") && !text.contains("\"config\""), "no empty keys written: {text}");
}
