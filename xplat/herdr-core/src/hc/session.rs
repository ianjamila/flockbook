//! Swift: `HCSession.swift`. Where herdr-core listens. Rules from upstream docs/security.md ("State and endpoints"):
//! `HC_SOCKET` overrides the endpoint; else `$XDG_RUNTIME_DIR/herdr-core/<session>.sock` when that variable is set;
//! else `/run/user/<uid>/herdr-core/` when it exists (Linux only in practice); else the session's state directory,
//! `${XDG_STATE_HOME:-~/.local/state}/herdr-core/<session>/<session>.sock`. The session name comes from
//! `HC_SESSION`, default `default`. Flockbook's overrides on top: `--hc-socket <path>` and `HERDR_DESK_HC_SOCKET`.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HcSession {
    pub socket_path: String,
}

/// The user's home directory: `HOME` on Unix, `USERPROFILE` on Windows. Empty when unset.
pub fn home_dir(env: &HashMap<String, String>) -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env.get(key).cloned().unwrap_or_default()
}

pub fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn non_empty<'a>(env: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    env.get(k).map(String::as_str).filter(|s| !s.is_empty())
}

impl HcSession {
    pub fn new(socket_path: &str) -> HcSession {
        HcSession { socket_path: socket_path.into() }
    }

    /// The session from this process's environment.
    pub fn resolve_env() -> HcSession {
        Self::resolve(&process_env(), &[], run_user_dir().as_deref())
    }

    /// `run_user`: `/run/user/<uid>` when it exists on this machine (Swift checks the file system; passed in for checks).
    pub fn resolve(env: &HashMap<String, String>, arguments: &[String], run_user: Option<&str>) -> HcSession {
        if let Some(i) = arguments.iter().position(|a| a == "--hc-socket") {
            if let Some(p) = arguments.get(i + 1) {
                return HcSession::new(p);
            }
        }
        if let Some(p) = non_empty(env, "HERDR_DESK_HC_SOCKET") {
            return HcSession::new(p);
        }
        if let Some(p) = non_empty(env, "HC_SOCKET") {
            return HcSession::new(p);
        }
        let session = non_empty(env, "HC_SESSION").unwrap_or("default");
        if cfg!(windows) {
            // Windows: herdr-core listens on a named pipe, \\.\pipe\herdr-core-… (its name is made at run time and
            // not documented upstream), so the pipe is found among this machine's pipes. None found: a path that is
            // never there, so the sidecar answers `no-core`.
            let user = non_empty(env, "USERNAME");
            return HcSession::new(&pick_core_pipe(&pipe_names(), session, user)
                .map(|n| format!("{PIPE_DIR}{n}"))
                .unwrap_or_else(|| format!("<no herdr-core pipe found: set HC_SOCKET> ({session})")));
        }
        if let Some(r) = non_empty(env, "XDG_RUNTIME_DIR") {
            return HcSession::new(&format!("{r}/herdr-core/{session}.sock"));
        }
        if let Some(run) = run_user {
            return HcSession::new(&format!("{run}/herdr-core/{session}.sock"));
        }
        let state = non_empty(env, "XDG_STATE_HOME").map(String::from).unwrap_or_else(|| home_dir(env) + "/.local/state");
        HcSession::new(&format!("{state}/herdr-core/{session}/{session}.sock"))
    }

    /// True when a socket file is there. Missing is normal (hc not installed or not running), not an error.
    pub fn is_available(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            std::fs::symlink_metadata(&self.socket_path).map(|m| m.file_type().is_socket()).unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            // Windows: a pipe that is listed now (opening it to look would take one of the core's instances).
            match self.socket_path.strip_prefix(PIPE_DIR) {
                Some(name) => pipe_names().iter().any(|n| n.eq_ignore_ascii_case(name)),
                None => std::path::Path::new(&self.socket_path).exists(),
            }
        }
    }
}

/// Where every named pipe lives (Windows).
pub const PIPE_DIR: &str = r"\\.\pipe\";

/// The pipes on this machine by name (Windows; elsewhere none).
pub fn pipe_names() -> Vec<String> {
    if !cfg!(windows) {
        return vec![];
    }
    std::fs::read_dir(PIPE_DIR)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// herdr-core's pipe among `names` (Windows): one named `herdr-core-…` that is not a holder's; with several, the
/// one that ends in `-<session>` (or is `herdr-core-<session>`), then the one that names this user (pipes are
/// machine-wide, so other users' cores show too). None: no such pipe, or no way to tell several apart.
pub fn pick_core_pipe(names: &[String], session: &str, user: Option<&str>) -> Option<String> {
    let lower = |s: &str| s.to_ascii_lowercase();
    let core: Vec<&String> = names
        .iter()
        .filter(|n| lower(n).starts_with("herdr-core-") && !lower(n).contains("holder"))
        .collect();
    let one = |v: Vec<&String>| (v.len() == 1).then(|| v[0].clone());
    if core.len() <= 1 {
        return one(core);
    }
    let tail = format!("-{}", lower(session));
    let by_session: Vec<&String> = core.iter().copied().filter(|n| lower(n).ends_with(&tail)).collect();
    let pool = if by_session.is_empty() { core } else { by_session };
    if pool.len() == 1 {
        return one(pool);
    }
    let user = lower(user?);
    one(pool.into_iter().filter(|n| !user.is_empty() && lower(n).contains(&user)).collect())
}

/// `/run/user/<uid>` when it exists.
pub fn run_user_dir() -> Option<String> {
    #[cfg(unix)]
    {
        let p = format!("/run/user/{}", unsafe { libc::getuid() });
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn env(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[cfg(unix)]
    #[test]
    fn socket_path_rules() {
        let home = "/home/someone";
        assert_eq!(HcSession::resolve(&env(&[("HOME", home)]), &[], None).socket_path, "/home/someone/.local/state/herdr-core/default/default.sock");
        assert_eq!(HcSession::resolve(&env(&[("HOME", home), ("HC_SESSION", "work")]), &[], None).socket_path, "/home/someone/.local/state/herdr-core/work/work.sock");
        assert_eq!(HcSession::resolve(&env(&[("HOME", home), ("XDG_STATE_HOME", "/s")]), &[], None).socket_path, "/s/herdr-core/default/default.sock");
        assert_eq!(HcSession::resolve(&env(&[("HOME", home)]), &[], Some("/run/user/501")).socket_path, "/run/user/501/herdr-core/default.sock");
        assert_eq!(HcSession::resolve(&env(&[("XDG_RUNTIME_DIR", "/r"), ("HC_SESSION", "x")]), &[], Some("/run/user/501")).socket_path, "/r/herdr-core/x.sock");
        assert_eq!(HcSession::resolve(&env(&[("XDG_RUNTIME_DIR", "/r"), ("HC_SOCKET", "/h.sock")]), &[], None).socket_path, "/h.sock");
        assert_eq!(HcSession::resolve(&env(&[("HC_SOCKET", "/h.sock"), ("HERDR_DESK_HC_SOCKET", "/d.sock")]), &[], None).socket_path, "/d.sock");
        assert_eq!(HcSession::resolve(&env(&[("HC_SOCKET", "")]), &["--hc-socket".into(), "/a.sock".into()], None).socket_path, "/a.sock");
        // Empty values count as unset.
        assert_eq!(HcSession::resolve(&env(&[("HOME", home), ("HC_SOCKET", ""), ("HC_SESSION", "")]), &[], None).socket_path, "/home/someone/.local/state/herdr-core/default/default.sock");
    }

    #[test]
    fn missing_socket_is_not_available() {
        assert!(!HcSession::new("/nonexistent/herdr-core/x.sock").is_available());
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // Windows: herdr-core's pipe among the machine's pipes (the rule runs everywhere; only Windows lists pipes).
    #[test]
    fn core_pipe_rules() {
        let pick = |v: &[&str], session: &str, user: Option<&str>| pick_core_pipe(&names(v), session, user);
        // One core pipe: it, whatever its middle; holders and other programs' pipes do not count.
        assert_eq!(pick(&["ProtectedPrefix", "herdr-core-jamil-default", "herdr-core-jamil-default.holder"], "default", None).as_deref(), Some("herdr-core-jamil-default"));
        assert_eq!(pick(&["herdr-core-3f2a9c"], "default", Some("jamil")).as_deref(), Some("herdr-core-3f2a9c"));
        assert_eq!(pick(&["HERDR-CORE-X"], "default", None).as_deref(), Some("HERDR-CORE-X"));
        // None: no core pipe at all, or only holders.
        assert_eq!(pick(&[], "default", None), None);
        assert_eq!(pick(&["mojo.1.2", "herdr-core-a-holder"], "default", None), None);
        // Several: the session decides, then the user (pipes are machine-wide).
        assert_eq!(pick(&["herdr-core-jamil-default", "herdr-core-jamil-work"], "work", None).as_deref(), Some("herdr-core-jamil-work"));
        assert_eq!(pick(&["herdr-core-ana-default", "herdr-core-jamil-default"], "default", Some("Jamil")).as_deref(), Some("herdr-core-jamil-default"));
        assert_eq!(pick(&["herdr-core-default", "herdr-core-work"], "default", None).as_deref(), Some("herdr-core-default"));
        // Several and nothing tells them apart: None (HC_SOCKET picks one).
        assert_eq!(pick(&["herdr-core-ana-default", "herdr-core-bo-default"], "default", None), None);
        assert_eq!(pick(&["herdr-core-ana-default", "herdr-core-bo-default"], "default", Some("cy")), None);
    }

    #[test]
    fn no_pipes_off_windows() {
        if !cfg!(windows) {
            assert!(pipe_names().is_empty());
            assert!(!HcSession::new(r"\\.\pipe\herdr-core-x").is_available());
        }
    }
}
