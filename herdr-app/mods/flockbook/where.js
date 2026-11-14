// Where Flockbook runs Claude and reads conversation logs (owner 11-14 s26: "Full: run via Ubuntu"). A tab's address
// "wsl/t3" is terminal t3 on machine "wsl"; a bare "t3" is on this computer. On Windows this computer has no
// /usr/bin/env or grep, and the Claude accounts and projects live in WSL, so:
//   "claude_machine": "wsl"  — the About lines, Summarize and Resume run `claude` on that machine (its accounts'
//                              config folders and its PATH), through Herdr's exec `on`.
//   "projects": [{ …, "machine": "wsl" }] — that project's folder and workspace are on that machine.
// Paths with "~" on another machine are that machine's home (machineHome: asked once, remembered for the session).
import { exec, home, readTextFile, shared, setShared, window, machines } from "herdr";
import { setting } from "./config.js";
import * as sidecar from "./sidecar.js";

// <where-pure>
// The machine an address is on (null: this computer) and its terminal there.
export const machineOf = (address) => { const s = String(address ?? ""), i = s.lastIndexOf("/"); return i > 0 ? s.slice(0, i) : null; };
export const terminalOf = (address) => { const s = String(address ?? ""), i = s.lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; };
// A remote space/tab id carries "machine/"; labels on that machine leave it out (herdr.d.ts).
export const bareId = (id) => terminalOf(id);
// Same machine (null and undefined both name this computer).
export const sameMachine = (a, b) => (a ?? null) === (b ?? null);
// The helper's cache on another machine (remote.rs CACHE: under the home there).
export const remoteCachePath = (homeDir) => `${homeDir}/.cache/flockbook/cache.json`;
// The PATH searched for `claude` on another machine (its own login PATH is not ours to know; CLAUDE_DIRS come first).
export const REMOTE_PATH = "/usr/local/bin:/usr/bin:/bin";
// The words shown when Claude can't run here (Windows, no claude_machine).
export const NEEDS_MACHINE = "About lines, Summarize and Resume need Claude on Linux or a Mac. On Windows, set \"claude_machine\" in Flockbook's config.json to your WSL machine's name (e.g. \"wsl\", from Add machine).";
// </where-pure>

export const KEY_HOMES = "flockbook.homes";   // { [machine]: { home, at } | { error, at } }
const RETRY_MS = 5 * 60_000;

export const claudeMachine = () => setting("claude_machine") ?? null;
export const localWindows = () => { try { return window()?.platform === "windows"; } catch { return false; } };
// Whether Claude (and grep) can run for tabs of `machine` from here: another machine (a Unix one: Herdr's machines are
// reached over ssh or WSL), or this computer when it is not Windows.
export const unixAt = (machine) => (machine ? true : !localWindows());
// Herdr has this machine's layout (connected): only then are its terminals the whole picture.
export const connected = (machine) => {
  if (!machine) return true;
  try { return (machines() ?? []).some((m) => m.name === machine && m.layout === "ready"); } catch { return false; }
};

// The home folder of `machine` as remembered (null: not known yet). This computer: home().
export function knownHome(machine) {
  if (!machine) return home();
  const h = shared(KEY_HOMES)?.[machine];
  return h?.home ?? null;
}
// The home folder of `machine`, asked of it once (a fixed command, no value in it) and remembered; null when it
// can't be reached (asked again RETRY_MS later).
export async function machineHome(machine) {
  if (!machine) return home();
  const h = shared(KEY_HOMES)?.[machine];
  if (h?.home) return h.home;
  if (h?.error && Date.now() - h.at < RETRY_MS) return null;
  let r;
  try { r = await exec("/bin/sh", ["-c", "printf %s \"$HOME\""], { on: machine, timeout: 15_000 }); } catch (e) { r = { code: null, stdout: "", error: String(e?.message ?? e) }; }
  const out = String(r?.stdout ?? "").trim();
  const ok = r?.code === 0 && out.startsWith("/") && !out.includes("\n");
  setShared(KEY_HOMES, { ...(shared(KEY_HOMES) ?? {}), [machine]: ok ? { home: out, at: Date.now() } : { error: String(r?.stderr || r?.error || "no home").slice(0, 120), at: Date.now() } });
  return ok ? out : null;
}

// The helper's cache entry for a tab ({ kind, cwd, pids, path, checked }), or null. On another machine the helper there
// keeps it (a status call through this computer's helper fills it); `ask`: make that call when there is none yet.
export async function logEntry(address, { ask = true } = {}) {
  const m = machineOf(address);
  const readLocal = async () => { try { return JSON.parse((await readTextFile(sidecar.cachePath())) ?? "{}")?.entries?.[address] ?? null; } catch { return null; } };
  if (!m) {
    let e = await readLocal();
    if (!e?.path && ask) { await sidecar.status(address); e = await readLocal(); }
    return e?.path ? e : null;
  }
  const h = await machineHome(m);
  if (!h) return null;
  const t = terminalOf(address);
  const readRemote = async () => { try { return JSON.parse((await readTextFile(remoteCachePath(h), { on: m })) ?? "{}")?.entries?.[t] ?? null; } catch { return null; } };
  let e = await readRemote();
  if (!e?.path && ask) { await sidecar.status(address); e = await readRemote(); }
  return e?.path ? e : null;
}
// Every cache entry the helper on `machine` keeps ({ [terminal there]: entry }), or null when it can't be read.
export async function remoteEntries(machine) {
  const h = await machineHome(machine);
  if (!h) return null;
  try { return JSON.parse((await readTextFile(remoteCachePath(h), { on: machine })) ?? "{}")?.entries ?? {}; } catch { return null; }
}
// Runs `cmd args` where tabs of `machine` live (exec `on`), or rejects nothing: { code, stdout, stderr }.
export async function execAt(machine, cmd, args, opts = {}) {
  try { return await exec(cmd, args, machine ? { ...opts, on: machine } : opts); }
  catch (e) { return { code: null, stdout: "", stderr: "", error: String(e?.message ?? e) }; }
}
