//! One lock per terminal for everything that types into it (approve, answer, send, a card's picker walk, a queue
//! pull). Held by the OS (`File::try_lock`) on `<dir>/<terminal id>.lock`: the OS frees it when the holder exits, is
//! killed, or drops it, so a crash never leaves a tab locked. The file itself is never deleted (no unlink race).
//! Spec: the Clear & re-enter design, "One run per tab".

use crate::cards::Done;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

/// The folder of the lock files: `$HOME/.local/state/flockbook/keylocks` (Windows `%USERPROFILE%`); the env
/// `FLOCKBOOK_KEYLOCK_DIR` overrides it (tests). None: no home to put them in.
pub fn lock_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("FLOCKBOOK_KEYLOCK_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(".local/state/flockbook/keylocks"))
}

/// A held lock; dropping it (or the process ending) frees it.
#[derive(Debug)]
pub struct Held(#[allow(dead_code)] File);

/// Why no lock was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    /// Another holder has it: something else is typing in this tab.
    Taken,
    /// The folder or the file cannot be made or opened, or the OS cannot lock: nothing can promise exclusivity.
    Unavailable,
}

fn file_name(terminal_id: &str) -> String {
    let id: String = terminal_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    format!("{}.lock", if id.is_empty() { "_" } else { &id })
}

/// Takes the lock of `terminal_id` without waiting.
pub fn take(dir: &Path, terminal_id: &str) -> Result<Held, Busy> {
    std::fs::create_dir_all(dir).map_err(|_| Busy::Unavailable)?;
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join(file_name(terminal_id))).map_err(|_| Busy::Unavailable)?;
    match file.try_lock() {
        Ok(()) => Ok(Held(file)),
        Err(TryLockError::WouldBlock) => Err(Busy::Taken),
        Err(TryLockError::Error(_)) => Err(Busy::Unavailable),
    }
}

/// `take` in `lock_dir()`; no folder known: `Unavailable` (fail closed).
pub fn take_default(terminal_id: &str) -> Result<Held, Busy> {
    take(&lock_dir().ok_or(Busy::Unavailable)?, terminal_id)
}

pub const BUSY: &str = "Another Flockbook action is typing in this tab. Wait a moment. Nothing was sent.";
pub const BUSY_REENTER: &str = "Another Flockbook action is typing in this tab. Nothing was typed.";
pub const NO_LOCK: &str = "Flockbook cannot make sure nothing else types into this tab. Nothing was sent.";

/// The answer of a keyed command that found the tab busy. `reenter`: the wording of Clear & re-enter.
pub fn busy_done(reenter: bool) -> Done {
    Done::new("busy", Some(if reenter { BUSY_REENTER } else { BUSY }))
}

/// The answer of a keyed command that could not take the lock at all.
pub fn no_lock_done() -> Done {
    Done::new("no_lock", Some(NO_LOCK))
}

/// The refusal for a failed take.
pub fn refusal(why: Busy, reenter: bool) -> Done {
    match why {
        Busy::Taken => busy_done(reenter),
        Busy::Unavailable => no_lock_done(),
    }
}
