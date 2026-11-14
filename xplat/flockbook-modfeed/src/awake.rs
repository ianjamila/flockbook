//! `awake`: keeps this computer from IDLE sleep while agents work (s36, owner 11-15; the mod's awake.js decides when).
//!
//!   awake --for <secs>   start a holder for <secs> (1..=3600); a holder already there is replaced: the new one starts
//!                        first, then the old one is stopped
//!   awake --release      stop our holder now
//!   awake --status       what is held
//!
//! A holder ALWAYS has a finite time, so a crashed Herdr never keeps the machine awake for longer than that.
//! The display may still sleep and lock; the lid is not covered (that needs pmset and sudo: never touched here).
//!   Mac:     a detached `caffeinate -i -t <secs>` (-i: idle sleep only; not -d, not -s).
//!   Windows: this helper again as `awake-hold <secs> <file> <token>`: it asks for ES_SYSTEM_REQUIRED, and ends when its
//!            time is up or the record's token is not its own any more (a renewal or a release changes the record).
//!   Other:   `unsupported`, and nothing is started.
//!
//! The holder is recorded in `<home>/flockbook/awake.json` ({pid, started, until, token}). A pid is stopped only when it
//! is still OUR holder: on a Mac the process has the start time that was recorded and runs caffeinate; a recycled pid, or
//! somebody else's caffeinate (Claude Code runs one too), is never touched.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The longest a holder may be asked to hold (the mod renews every minute for 3).
pub const MAX_SECS: u64 = 3600;
const FILE: &str = "awake.json";

#[derive(Debug, Clone, PartialEq)]
struct Record {
    pid: u32,
    /// The process's start time as `ps` says it (Mac): with the command, what makes a pid OUR holder.
    started: String,
    until: u64,
    /// Windows: the holder ends when the file's token is not this one.
    token: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn file(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

fn read(dir: &Path) -> Option<Record> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(file(dir)).ok()?).ok()?;
    Some(Record {
        pid: u32::try_from(v["pid"].as_u64()?).ok()?,
        started: v["started"].as_str().unwrap_or("").to_string(),
        until: v["until"].as_u64().unwrap_or(0),
        token: v["token"].as_str().unwrap_or("").to_string(),
    })
}

fn write(dir: &Path, r: &Record) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot write {}: {e}", dir.display()))?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let text = json!({"pid": r.pid, "started": r.started, "until": r.until, "token": r.token}).to_string();
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, file(dir))).map_err(|e| format!("cannot write {}: {e}", file(dir).display()))
}

pub const fn supported() -> bool {
    cfg!(any(target_os = "macos", windows))
}

/// The line when this platform cannot hold (the mod shows nothing).
pub fn unsupported() -> Value {
    json!({"type": "awake", "state": "unsupported", "reason": "this computer has no way to stay awake that Flockbook uses"})
}

/// The record's holder, when it is still ours and alive.
fn live(dir: &Path) -> Option<Record> {
    read(dir).filter(plat::ours)
}

pub fn status(dir: &Path) -> Value {
    match live(dir) {
        Some(r) => json!({"type": "awake", "state": "holding", "pid": r.pid, "until": r.until}),
        None => json!({"type": "awake", "state": "idle"}),
    }
}

/// Starts a holder for `secs` and replaces the one there. `Err`: why it could not start one.
pub fn hold(dir: &Path, secs: u64) -> Result<Value, String> {
    let old = live(dir);
    let token = format!("{:x}{:x}", std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0), std::process::id());
    let until = now() + secs;
    let (pid, started) = plat::start(dir, secs, &token, until)?;
    let rec = Record { pid, started, until, token };
    if let Err(e) = write(dir, &rec) {
        plat::stop(&rec);
        return Err(e);
    }
    // The new one is up and recorded; now the old one goes (Windows: it ends by itself, its token is gone).
    if let Some(o) = &old {
        if o.pid != rec.pid {
            plat::stop(o);
        }
    }
    Ok(json!({"type": "awake", "state": "holding", "for": secs, "pid": pid, "until": until, "replaced": old.is_some()}))
}

/// Stops our holder and forgets it. `was`: whether one was running.
pub fn release(dir: &Path) -> Value {
    let was = match live(dir) {
        Some(r) => {
            plat::stop(&r);
            true
        }
        None => false,
    };
    let _ = std::fs::remove_file(file(dir));
    json!({"type": "awake", "state": "released", "was": was})
}

/// The Windows holder's body (`awake-hold`); on other systems there is nothing to hold.
pub fn hold_here(secs: u64, record: &Path, token: &str) {
    plat::hold_here(secs, record, token)
}

#[cfg(target_os = "macos")]
mod plat {
    use super::Record;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    fn ps(field: &str, pid: u32) -> String {
        Command::new("/bin/ps").args(["-o", &format!("{field}="), "-p", &pid.to_string()]).stderr(Stdio::null()).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }

    /// A detached `caffeinate -i -t secs`; its pid and start time.
    pub fn start(_dir: &Path, secs: u64, _token: &str, _until: u64) -> Result<(u32, String), String> {
        let spawn = |program: &str| {
            Command::new(program).args(["-i", "-t", &secs.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                // Its own process group: a signal to the helper's group does not reach it.
                .process_group(0).spawn()
        };
        let mut child = match spawn("caffeinate") {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => spawn("/usr/bin/caffeinate").map_err(|e| format!("cannot start caffeinate: {e}"))?,
            Err(e) => return Err(format!("cannot start caffeinate: {e}")),
        };
        let pid = child.id();
        let started = ps("lstart", pid);
        if started.is_empty() {
            // Gone already (it refused its arguments?) or not readable: never record what could not be told apart later.
            let _ = child.kill();
            let _ = child.wait();
            return Err("caffeinate did not stay running".to_string());
        }
        Ok((pid, started))
    }

    /// Still the process that was started: the recorded start time, and caffeinate as its program (first or second word
    /// of the command: a script standing in for it has an interpreter first).
    pub fn ours(r: &Record) -> bool {
        if r.pid == 0 || r.started.is_empty() || ps("lstart", r.pid) != r.started {
            return false;
        }
        ps("command", r.pid).split_whitespace().take(2).any(|w| w.rsplit('/').next() == Some("caffeinate"))
    }

    pub fn stop(r: &Record) {
        if ours(r) {
            let _ = Command::new("/bin/kill").args(["-TERM", &r.pid.to_string()]).stderr(Stdio::null()).status();
        }
    }

    pub fn hold_here(_secs: u64, _record: &Path, _token: &str) {}
}

#[cfg(windows)]
mod plat {
    use super::Record;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    // No window, and not tied to the helper's console.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// This helper again as `awake-hold`; it ends by itself, so no handle is kept.
    pub fn start(dir: &Path, secs: u64, token: &str, until: u64) -> Result<(u32, String), String> {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find the helper: {e}"))?;
        // The record first, with this token: the holder ends when it does not find its own token there.
        let first = Record { pid: 0, started: String::new(), until, token: token.to_string() };
        super::write(dir, &first)?;
        let child = Command::new(exe).args(["awake-hold", &secs.to_string()]).arg(super::file(dir)).arg(token)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW).spawn().map_err(|e| format!("cannot start the holder: {e}"))?;
        Ok((child.id(), String::new()))
    }

    /// The holder is running (a flockbook-modfeed process with that pid) and the record still has its token.
    pub fn ours(r: &Record) -> bool {
        if r.pid == 0 {
            return false;
        }
        Command::new("tasklist").args(["/FI", &format!("PID eq {}", r.pid), "/FO", "CSV", "/NH"]).creation_flags(CREATE_NO_WINDOW).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("flockbook-modfeed.exe"))
            .unwrap_or(false)
    }

    /// Nothing to stop: the holder ends when the record's token is not its own (a renewal wrote another; release removes it).
    pub fn stop(_r: &Record) {}

    pub fn hold_here(secs: u64, record: &Path, token: &str) {
        let mine = || super::read_token(record).as_deref() == Some(token);
        // The thread that asks must stay alive: this one waits below, and the system lets go when the process ends.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end && mine() {
            std::thread::sleep(Duration::from_secs(2));
        }
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod plat {
    use super::Record;
    use std::path::Path;

    pub fn start(_dir: &Path, _secs: u64, _token: &str, _until: u64) -> Result<(u32, String), String> {
        Err("this computer cannot be kept awake by Flockbook".to_string())
    }
    pub fn ours(_r: &Record) -> bool {
        false
    }
    pub fn stop(_r: &Record) {}
    pub fn hold_here(_secs: u64, _record: &Path, _token: &str) {}
}

/// The token in a record file (the Windows holder checks it).
#[cfg(windows)]
fn read_token(record: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(record).ok()?).ok()?;
    v["token"].as_str().map(str::to_string)
}
