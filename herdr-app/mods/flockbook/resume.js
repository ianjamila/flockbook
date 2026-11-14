// Resume after a restart (owner 11-12 s13: "remember which conversation each tab had and offer to resume them all
// with one click"). Every RESUME_TICK_MS it remembers each local Claude Code tab's conversation — its session id and
// account (from the log the Flockbook helper found for that terminal: flockbook/cache.json), the folder it started in,
// its workspace and tab name, its process ids. When the remembered sessions vanish together (Herdr Core or the Mac
// restarted; the window alone restarting keeps them) or while the app was not running, the Overview offers them
// back: Resume (one), Resume all, Dismiss. A resume opens a tab in the same workspace and folder, as the same
// account, running `claude --resume <id>`. A tab closed on purpose (alone, while the rest go on) or a /clear (same
// process, new conversation) is just forgotten. Nothing runs without a click.
import { terminals, panes, shared, setShared, readTextFile, appHome, home, run, notify } from "herdr";
import { agents, spaces } from "./parked.js";
import { accounts, claudeCommand, claudeRun, sessionOfLog } from "./accounts.js";
import { claudeMachine, localWindows, connected, machineOf, terminalOf, remoteEntries, knownHome, sameMachine } from "./where.js";
import * as sidecar from "./sidecar.js";

export const KEY_RESUME = "flockbook.resume.v1";   // { at, polledAt, gapMax, gaps?, away, awayFor?, tabs: { [sid]: rec } }
export const KEY_OFFER = "flockbook.resume.offer";   // { at, tabs: [rec] } or null
export const RESUME_TICK_MS = 30_000;

// <resume-pure>
const GAP_MS = 2 * 60_000;
// The session id and account of a conversation log: …/<config folder>/projects/<project>/<id>.jsonl, the account
// being the one whose config folder that is (accounts.js; the default ~/.claude without the "accounts" setting).
export function sessionOf(p, list = accounts(), homeDir = home()) {
  return sessionOfLog(p, list, homeDir);
}
// The command that resumes `rec` as its account (like ai.js: /usr/bin/env sets or clears the config folder), or null
// for an account no longer set.
export function resumeArgv(rec) {
  const c = rec?.sid ? claudeCommand(rec.account, ["--resume", rec.sid]) : null;
  return c ? [c[0], ...c[1]] : null;
}
// Which remembered sessions are gone, and whether to offer them back. `live`: { sids, pids } now; `gap`: ms since the
// last look. Still here = its session or one of its processes is live (a /clear keeps the process). Gone after a gap,
// or most of them at once (two or more, at least half) = a restart → offered; else closed on purpose → forgotten.
export function lostSessions(saved, live, gap) {
  const all = Object.values(saved ?? {});
  const gone = all.filter((x) => !live.sids.has(x.sid) && !(x.pids ?? []).some((p) => live.pids.has(p)));
  const cleared = all.filter((x) => !live.sids.has(x.sid) && (x.pids ?? []).some((p) => live.pids.has(p)));
  const restart = gone.length > 0 && (gap > GAP_MS || (gone.length >= 2 && gone.length * 2 >= all.length));
  return { offer: restart ? gone : [], forget: [...(restart ? [] : gone), ...cleared].map((x) => x.sid) };
}
// The tab's own name, or null for a default one (its number, or the program's name) — a resumed tab without one
// names itself from its session.
export function ownName(a) {
  const n = String(a?.tab_name ?? "").trim();
  if (!n || n === a?.program?.name || n === String((a?.tab_index ?? -2) + 1)) return null;
  return n;
}
// A title without the marks in front (✳, spinners, 🔀 …).
export const plainTitle = (s) => String(s ?? "").replace(/^[^\p{L}\p{N}#~/]+/u, "").trim();
// s31 (owner 11-14): the session a helper cache entry names: its log, else — a Claude tab before its first message, or
// right after /clear — the id Claude Code's pid file names (`sid`) under its config folder (`config`, which account).
export function sessionOfEntry(e, list = accounts(), homeDir = home()) {
  if (!e) return null;
  if (e.path) return sessionOf(e.path, list, homeDir);
  if (e.sid && e.config) return sessionOf(`${String(e.config).replace(/\/+$/, "")}/projects/-/${e.sid}.jsonl`, list, homeDir);
  return null;
}
// s31 (owner 11-14: "precise identity, no timer"): which sessions a Claude tab the helper has not identified can be,
// read from its live command line (Herdr core's foreground argv) and folder. { none } a new conversation (plain
// `claude`, a prompt, a --fork-session); { sid } `--resume <id>` / `--session-id <id>`; { cwd } `--continue` (the
// newest session of that folder); { any } anything else: the picker (`--resume` with no id or with search words),
// `--from-pr`, `attach`, combined short flags, a command line that isn't Claude's, or none at all.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const baseName = (p) => String(p ?? "").split(/[\\/]/).pop().toLowerCase();
function claudeArgs(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  if (/^claude(\.exe)?$/.test(baseName(argv[0]))) return argv.slice(1);
  if (/^(node|bun)(\.exe)?$/.test(baseName(argv[0])) && /claude-code[\\/]cli\.m?js$|[\\/]claude(\.exe)?$/i.test(String(argv[1] ?? ""))) return argv.slice(2);
  return null;
}
export function couldBe(argv, cwd) {
  const a = claudeArgs(argv);
  if (!a) return { any: true };
  let resume = false, value = null, cont = false, fork = false, given = null;
  for (let i = 0; i < a.length; i++) {
    const x = String(a[i]);
    if (x === "--") break;
    if (x === "-r" || x === "--resume") { resume = true; const v = a[i + 1]; if (v != null && !String(v).startsWith("-")) { value = String(v); i++; } else value = null; continue; }
    if (x.startsWith("--resume=")) { resume = true; value = x.slice(9) || null; continue; }
    if (x === "-c" || x === "--continue") { cont = true; continue; }
    if (x === "--fork-session") { fork = true; continue; }
    if (x === "--session-id") { given = a[i + 1] == null ? "" : String(a[i + 1]); i++; continue; }
    if (x.startsWith("--session-id=")) { given = x.slice(13); continue; }
    if (x === "--from-pr" || x.startsWith("--from-pr=") || x === "--bg" || /^-[A-Za-z]{2,}$/.test(x) || x === "attach" || x === "agents" || x === "respawn") return { any: true };
  }
  if ((resume || cont) && fork) return { none: true };
  if (resume) return value && UUID.test(value) ? { sid: value } : { any: true };
  if (cont) return cwd ? { cwd: String(cwd) } : { any: true };
  if (given != null) return SID.test(given) ? { sid: given } : { any: true };
  return { none: true };
}
const sameDir = (a, b) => String(a ?? "").replace(/\/+$/, "") === String(b ?? "").replace(/\/+$/, "");
// Whether an unidentified tab that `could` be these sessions may hold `rec` ({ sid, cwd }).
export function mayBe(rec, could) {
  if (!could || could.any) return true;
  if (could.none) return false;
  if (could.sid) return rec?.sid === could.sid;
  if (could.cwd) return !rec?.cwd || sameDir(rec.cwd, could.cwd);
  return true;
}
// s31 (from herdr-sessions, owner 11-14): the workspace and tab shown now, and the commands that show them again after
// a batch of resumes opened tabs elsewhere (each new tab is shown as it opens). A workspace that is gone: nothing; a
// tab that is gone: its workspace only.
export function placeNow(list) {
  const s = (list ?? []).find((x) => x.active);
  return s ? { space: s.id, tab: (s.tabs ?? []).find((t) => t.active)?.id ?? null } : null;
}
export function backTo(was, list) {
  const s = was ? (list ?? []).find((x) => x.id === was.space) : null;
  if (!s) return [];
  return [["space.select", { id: s.id }], ...(was.tab && (s.tabs ?? []).some((t) => t.id === was.tab) ? [["tab.select", { id: was.tab }]] : [])];
}
// </resume-pure>

export const remembered = () => shared(KEY_RESUME) ?? { at: null, tabs: {} };
export const offer = () => { const o = shared(KEY_OFFER); return o?.tabs?.length ? o : null; };
// Sessions resumed or dismissed from the offer: { [sid]: at }. A poll that read the remembered state before the click
// can't offer them again (s13 Codex R1 P2). A poll that STARTED after the mark and sees the session running clears
// it, so a second restart soon after offers it again (R2 P2).
const KEY_HANDLED = "flockbook.resume.handled";
// One poll at a time across the mod's views (each window's top bar runs the timer). A poll cut short by a mod reload
// leaves its lock; it holds for TICK_LOCK_MS at most, and a poll that outlived its lock writes nothing (R2 P2).
const KEY_TICK = "flockbook.resume.busy";
// A Resume click claims its offer row for CLAIM_MS (`claimAt` on the row) instead of removing it before it knows the
// result: a mod reload in between leaves the row, clickable again once the claim is old (R2 P2).
const TICK_LOCK_MS = 20_000, HANDLED_KEEP_MS = 24 * 3600_000, CLAIM_MS = 60_000;
// Whether a click claimed this offer row and is still opening it (s14 follow-up: the Overview shows "Opening…" in
// place of its Resume for those CLAIM_MS, so a second click has nothing to press).
export const opening = (rec, now = Date.now()) => Boolean(rec?.claimAt && now - rec.claimAt < CLAIM_MS);
const handled = () => shared(KEY_HANDLED) ?? {};
const markHandled = (sids) => setShared(KEY_HANDLED, { ...handled(), ...Object.fromEntries(sids.map((s) => [s, Date.now()])) });
const dropFromOffer = (sid) => { const o = offer(); if (!o) return; const rest = o.tabs.filter((x) => x.sid !== sid); setShared(KEY_OFFER, rest.length ? { ...o, tabs: rest } : null); };
// s28 (Codex R1 P2): sessions just opened by either way in (the offer's Resume, the Resume sessions dialog), by
// "machine\tsid" → at. Its new tab is not identified at once, so for CLAIM_MS neither way opens it again.
const KEY_OPENED = "flockbook.resume.opened";
const openedKey = (m, sid) => `${m ?? ""}\t${sid}`;
const justOpened = (m, sid, now = Date.now()) => { const at = (shared(KEY_OPENED) ?? {})[openedKey(m, sid)]; return Boolean(at && now - at < CLAIM_MS); };
// Whether `sid` on `machine` is being opened now: an offer row a Resume click claimed, or one either way just opened.
export function openingNow(machine, sid, now = Date.now()) {
  const row = offer()?.tabs.find((x) => x.sid === sid && sameMachine(x.machine, machine || null));
  return Boolean((row && opening(row, now)) || justOpened(machine || null, sid, now));
}
// Claims `sid` on `machine` before anything is awaited (s28 Codex R2: the check and the claim in one synchronous step,
// so two resumes at once can't both pass): a token, or null when it is being opened already.
export function claimOpening(machine, sid, now = Date.now()) {
  if (openingNow(machine, sid, now)) return null;
  const keep = Object.fromEntries(Object.entries(shared(KEY_OPENED) ?? {}).filter(([, at]) => now - at < CLAIM_MS));
  setShared(KEY_OPENED, { ...keep, [openedKey(machine || null, sid)]: now });
  return now;
}
// Gives a claim up (its pick could not open), unless a newer one took its place.
export function releaseOpening(machine, sid, token) {
  const all = { ...(shared(KEY_OPENED) ?? {}) }, k = openedKey(machine || null, sid);
  if (all[k] !== token) return;
  delete all[k];
  setShared(KEY_OPENED, all);
}
// After a tab was opened for `sid`: noted for both ways in, and it leaves the offer (handled, as a Resume click does).
export function noteOpened(machine, sid, now = Date.now()) {
  const keep = Object.fromEntries(Object.entries(shared(KEY_OPENED) ?? {}).filter(([, at]) => now - at < CLAIM_MS));
  setShared(KEY_OPENED, { ...keep, [openedKey(machine || null, sid)]: now });
  if (offer()?.tabs.some((x) => x.sid === sid)) { markHandled([sid]); dropFromOffer(sid); }
}
const patchOffer = (sid, patch) => { const o = offer(); if (!o?.tabs.some((x) => x.sid === sid)) return; setShared(KEY_OFFER, { ...o, tabs: o.tabs.map((x) => (x.sid === sid ? { ...x, ...patch } : x)) }); };

async function helperCache() {
  try { const t = await readTextFile(`${appHome()}/flockbook/cache.json`); return t ? JSON.parse(t) : null; } catch { return null; }
}

// The Claude tabs looked at now: this computer's own (not on Windows: no /usr/bin/env to resume them with) and those on
// the "claude_machine" while it is connected (s26: the PC resumes its WSL tabs; a computer that doesn't name that
// machine never does, so two computers never both resume one session). { tabs (by session), sids, pids, looked
// (machine names looked at, "" = this computer), unknown (a live Claude tab the helper hasn't identified yet that may
// hold a session that isn't new), unknownTitles (their titles), unknownTabs ([{ machine ("" = this computer), title,
// cwd (its pane's folder, or null), could (couldBe: which sessions it may hold) }]) }. Process ids are per machine
// ("wsl:30"), so two machines' never mix. s31: a tab before its first message is identified by its pid file's id
// (sessionOfEntry); one still unidentified is read by its command line.
const statusAsked = new Map(), STATUS_EVERY_MS = 60_000;
async function liveNow(now) {
  const terms = terminals(), byAddr = new Map(terms.map((t) => [t.address, t]));
  const subs = new Set(terms.filter((t) => t.parent).map((t) => t.address));
  const cm = claudeMachine(), looked = new Set();
  if (!localWindows()) looked.add("");
  const remote = cm && connected(cm) ? await remoteEntries(cm) : null;
  if (remote) looked.add(cm);
  const claudes = agents().filter((a) => a.app === "claude-code" && a.address && looked.has(machineOf(a.address) ?? ""));
  const entries = looked.has("") ? (await helperCache())?.entries ?? {} : {};
  const tabs = {}, sids = new Set(), pids = new Set(), unknownTitles = new Set(), unknownTabs = [];
  let unknown = false;
  const subLive = [];   // s28 (Fable): sessions in sub-agent tabs, open but never offered (liveSids only)
  for (const a of claudes) {
    const m = machineOf(a.address);
    const e = m ? remote[terminalOf(a.address)] : entries[a.address], s = sessionOfEntry(e, accounts(), m ? knownHome(m) : home());
    if (subs.has(a.address)) { if (s) subLive.push({ machine: m ?? "", sid: s.sid }); continue; }
    if (!s) {
      const fg = byAddr.get(a.address)?.foreground, cwd = paneCwd(a.address);
      const could = couldBe(fg?.argv, fg?.cwd || cwd);
      if (!could.none) { unknown = true; if (plainTitle(a.title)) unknownTitles.add(plainTitle(a.title)); }
      unknownTabs.push({ machine: m ?? "", title: plainTitle(a.title), cwd, could });
      // The helper has no entry for it yet: a status call through this computer's helper makes one (once a minute at
      // most per tab, s28 Fable: every poll and the dialog's 10 s refresh used to send one). s31: this computer's tabs
      // too (the helper names a new tab's session from its pid file), not only another machine's.
      if (!(now - (statusAsked.get(a.address) ?? -Infinity) < STATUS_EVERY_MS)) { statusAsked.set(a.address, now); sidecar.status(a.address); }
      continue;
    }
    sids.add(s.sid);
    const own = (e.pids ?? []).map((p) => pidKey(m, p));
    for (const p of own) pids.add(p);
    tabs[s.sid] = { sid: s.sid, account: s.account, cwd: e.cwd ?? (m ? knownHome(m) : home()), pids: own, terminal: a.address, space: a.space, spaceName: a.space_name,
      name: ownName(a), title: plainTitle(a.title) || null, at: now, ...(m ? { machine: m } : {}) };
  }
  return { tabs, sids, pids, looked, unknown, unknownTitles, unknownTabs, subLive };
}
// The folder Herdr shows for a tab's pane, or null.
const paneCwd = (address) => { try { return panes().find((x) => x.terminal === address)?.cwd || null; } catch { return null; } };
// The sessions running in a Claude tab now, by machine ("" = this computer), for the Resume sessions dialog (sessions.js):
// { by: { [machine]: Set of session ids }, looked (machines looked at: a machine missing there can't be told),
// unknown (a live Claude tab the helper hasn't identified yet), unknownTitles, unknownTabs }.
export async function liveSids(now = Date.now()) {
  const live = await liveNow(now), by = {};
  for (const t of Object.values(live.tabs)) (by[t.machine ?? ""] ??= new Set()).add(t.sid);
  for (const t of live.subLive) (by[t.machine] ??= new Set()).add(t.sid);
  return { by, looked: live.looked, unknown: live.unknown, unknownTitles: live.unknownTitles, unknownTabs: live.unknownTabs };
}
// A process id as remembered: a bare number on this computer (as before), "machine:pid" on another.
const pidKey = (m, p) => (m ? `${m}:${p}` : p);
const running = (rec, live) => live.sids.has(rec.sid) || (rec.pids ?? []).some((p) => live.pids.has(p));
// Whether a remembered session's machine was looked at in `live` (this computer: "").
const lookedAt = (rec, live) => live.looked.has(rec.machine ?? "");

export async function resumeTick() {
  const start = Date.now(), busy = shared(KEY_TICK);
  if (busy && start - busy.at < TICK_LOCK_MS) return;
  const token = `${start}-${Math.random().toString(36).slice(2, 10)}`;
  setShared(KEY_TICK, { at: start, token });
  const mine = () => shared(KEY_TICK)?.token === token && Date.now() - start < TICK_LOCK_MS;
  try { await tick(mine); } finally { if (shared(KEY_TICK)?.token === token) setShared(KEY_TICK, null); }
}
async function tick(mine) {
  const now = Date.now();
  const live = await liveNow(now);
  // Outlived its lock (another poll may have written newer facts since): this poll's older view is dropped. Nothing
  // below awaits, so this one check covers every write.
  if (!mine()) return;
  const was = remembered();
  const { tabs, sids, pids } = live;
  // Handled marks: cleared by a poll that started after the mark and sees the session running; old marks go.
  const h = handled(), keep = Object.fromEntries(Object.entries(h).filter(([sid, at]) => now - at < HANDLED_KEEP_MS && !(sids.has(sid) && at < now)));
  if (Object.keys(keep).length !== Object.keys(h).length) setShared(KEY_HANDLED, keep);
  // Sessions resumed by hand leave the offer.
  const o = offer();
  if (o && o.tabs.some((x) => sids.has(x.sid))) setShared(KEY_OFFER, { ...o, tabs: o.tabs.filter((x) => !sids.has(x.sid)) });
  // Downtime = the longest wait between two polls since the machine's last complete look, so polls that went on
  // while a tab was unidentified are not downtime (R2 P2), and a real gap before them still counts (R1 P2). Kept per
  // machine (`gaps`, s29 Fable P3) for a machine held back below; `gapMax` is an older poll's (one for all).
  const prev = was.polledAt ?? was.at, step = prev ? now - prev : 0;
  const gapOf = (m) => Math.max(was.gapMax ?? 0, was.gaps?.[m] ?? 0, step);
  // Remembered sessions by where they run (s26): a machine no longer the "claude_machine" (or this computer, when it
  // can't resume here) → forgotten; one not looked at now (disconnected) → set aside as it is, neither live nor lost;
  // the rest are judged. How long a machine was away counts as downtime for its sessions when it is back (a WSL
  // restart takes its core down with it).
  const cm = claudeMachine(), aside = {}, judged = {}, away = { ...(was.away ?? {}) }, awayFor = {};
  for (const m of Object.keys(away)) if (m !== cm) delete away[m];
  if (cm && !live.looked.has(cm)) away[cm] ??= now;
  else if (cm && away[cm]) { awayFor[cm] = now - away[cm]; delete away[cm]; }
  for (const [sid, x] of Object.entries(was.tabs ?? {})) {
    if (x.machine ? x.machine !== cm : !live.looked.has("")) continue;
    if (lookedAt(x, live)) judged[sid] = x; else aside[sid] = x;
  }
  // Away time noted by a poll that had to wait for an unidentified tab still counts (s28 Codex R1 P2: merged before
  // the early return below too, so two such polls in a row keep it).
  for (const [m, ms] of Object.entries(was.awayFor ?? {})) if (m === cm) awayFor[m] = Math.max(awayFor[m] ?? 0, ms);
  // A live Claude tab whose session the helper has not found yet: no decision now for ITS machine (that session would
  // look gone); its records, downtime and away time wait for a later poll. Other machines are judged (s29 Fable P3).
  // s31: only a tab that may hold one of that machine's remembered sessions (a new conversation holds none of them).
  const mayHold = (u) => Object.values(judged).some((x) => (x.machine ?? "") === u.machine && mayBe(x, u.could));
  const hold = new Set(live.unknownTabs.filter(mayHold).map((u) => u.machine)), byMachine = {}, held = {}, gaps = {}, heldAway = {};
  for (const [sid, x] of Object.entries(judged)) { const m = x.machine ?? ""; if (hold.has(m)) held[sid] = x; else (byMachine[m] ??= {})[sid] = x; }
  for (const m of hold) { gaps[m] = gapOf(m); if (awayFor[m]) heldAway[m] = awayFor[m]; }
  const lost = Object.entries(byMachine).flatMap(([m, group]) => lostSessions(group, { sids, pids }, Math.max(gapOf(m), awayFor[m] ?? 0)).offer).filter((x) => !keep[x.sid]);
  if (lost.length) {
    const cur = offer()?.tabs ?? [];
    const add = lost.filter((x) => !cur.some((y) => y.sid === x.sid));
    setShared(KEY_OFFER, { at: now, tabs: [...cur, ...add] });
    if (add.length) notify?.(`${add.length} Claude ${add.length === 1 ? "session was" : "sessions were"} open before the restart. Resume ${add.length === 1 ? "it" : "them"} from the Overview.`);
  }
  // What is live now (and what waits for its machine) is what is remembered; the offered ones live on in the offer.
  const more = { ...(Object.keys(gaps).length ? { gaps } : {}), ...(Object.keys(heldAway).length ? { awayFor: heldAway } : {}) };
  setShared(KEY_RESUME, { at: now, polledAt: now, gapMax: 0, away, ...more, tabs: { ...aside, ...held, ...tabs } });
}

// Opens a tab that resumes the offered session `sid`; then it leaves the offer. Its row is claimed before anything is
// awaited, so a double click or a second view opens nothing more. Never opens a session that runs now (resumed by
// hand since the last poll: s13 Codex R1 P1). While a Claude tab on its machine is not identified yet and may hold this
// session (s31: by its command line, mayBe), it waits — no timer opens it anyway (owner 11-14: it could reopen a session
// resumed by hand). A brand-new tab is identified at once by its pid file's id (sessionOfEntry), or can only be new.
// `made`: a Set the caller (resumeAll) keeps; the machine gets added when this call made a new workspace there.
export async function resumeOne(sid, { quiet = false, made = null } = {}) {
  const now = Date.now(), first = offer()?.tabs.find((x) => x.sid === sid);
  if (!first || (first.claimAt && now - first.claimAt < CLAIM_MS)) return false;
  patchOffer(sid, { claimAt: now });
  const live = await liveNow(now);
  const rec = offer()?.tabs.find((x) => x.sid === sid);
  if (!rec || rec.claimAt !== now) return false;   // dismissed meanwhile, or another click took it over
  // Its machine is not connected now: whether it runs there can't be told, so nothing opens (s26).
  if (!lookedAt(rec, live)) {
    patchOffer(sid, { claimAt: null });
    if (!quiet) notify?.(`${rec.machine ?? "This computer"} isn't connected now, so “${rec.title ?? "that session"}” can't be checked or resumed yet. Try again when it is back.`);
    return false;
  }
  if (running(rec, live) || justOpened(rec.machine ?? null, sid, now)) { markHandled([sid]); dropFromOffer(sid); return false; }
  // Only an unidentified tab on its own machine can be this session (s28 Fable), and only one that may hold it (s31).
  const unsure = live.unknownTabs.filter((u) => u.machine === (rec.machine ?? "") && mayBe(rec, u.could));
  if (unsure.length) {
    patchOffer(sid, { claimAt: null });
    const named = unsure.find((u) => u.title)?.title;
    if (!quiet) notify?.(`A Claude tab${named ? ` (“${named}”)` : ""} isn't identified yet and could be “${rec.title ?? "that session"}”, already open. Not resumed — try again in a moment, once it is identified.`);
    return "wait";
  }
  // On another machine (s26): resumed there, in its workspace if that is still there, else in that machine's "~"
  // workspace, else in a new one there named "~" (s27: so several resumes share it, and the auto-mover files them) —
  // never on this computer. Its machine away or unreachable: the row stays, for a later click.
  const c = await resumeCommand(rec);
  if (c?.unreachable) {
    patchOffer(sid, { claimAt: null });
    if (!quiet) notify?.(`Couldn't reach ${c.unreachable} to resume “${rec.title ?? "that session"}”. Try again when it is back.`);
    return false;
  }
  const argv = c;
  if (argv) {
    const all = spaces();
    // s28 (Codex R1 P2): a session of this computer opens in its own workspace, its "~", or the shown workspace when
    // that is this computer's — never a bare tab.new, which lands in the shown workspace even on another machine.
    const space = all.find((s) => s.id === rec.space && sameMachine(s.machine, rec.machine))
      ?? all.find((s) => s.name === "~" && sameMachine(s.machine, rec.machine))
      ?? (rec.machine ? null : all.find((s) => s.active && !s.machine));
    if (space) run("tab.new", { space: space.id, folder: rec.cwd, argv, ...(rec.name ? { name: rec.name } : {}) });
    else { run("space.new", { machine: rec.machine ?? "", name: "~", folder: rec.cwd, argv, ...(rec.name ? { tab: rec.name } : {}) }); made?.add(rec.machine ?? ""); }
    noteOpened(rec.machine ?? null, sid);
  }
  markHandled([sid]); dropFromOffer(sid);
  return Boolean(argv);
}
// The argv that resumes `rec` where it ran: this computer (resumeArgv), or its machine (claudeRun there); null for an
// account no longer set; { unreachable } when that machine can't be reached.
export async function resumeCommand(rec) {
  if (!rec?.sid) return null;
  if (!rec.machine) return resumeArgv(rec);
  const c = await claudeRun(rec.account, ["--resume", rec.sid], rec.machine);
  if (c?.unreachable) return c;
  return c?.cmd ? [c.cmd, ...c.args] : null;
}
// s27: a new "~" workspace made for one session is waited for (WAIT_STEP_MS steps, at most NEW_SPACE_WAIT_MS) before the
// next session on that machine, so they share it instead of making one each. `pause(ms)`: a pause.
const WAIT_STEP_MS = 150, NEW_SPACE_WAIT_MS = 3000;
const sleep = (ms) => new Promise((res) => (typeof setTimeout === "function" ? setTimeout(res, ms) : res()));
// s31 (from herdr-sessions, owner 11-14): once the tabs it opened show (TAB_WAIT_MS at most), the workspace and tab
// shown before are shown again (placeNow / backTo), not the last tab it opened.
const TAB_WAIT_MS = 3000;
const tabCount = () => spaces().reduce((n, s) => n + (s.tabs?.length ?? 0), 0);
export async function returnTo(was, before, opened, pause = sleep) {
  if (!was || !opened) return;
  for (let t = 0; tabCount() < before + opened && t < TAB_WAIT_MS; t += WAIT_STEP_MS) await pause(WAIT_STEP_MS);
  for (const [name, args] of backTo(was, spaces())) run(name, args);
}
export async function resumeAll({ wait: pause = sleep } = {}) {
  let wait = 0, opened = 0;
  const made = new Set(), was = placeNow(spaces()), before = tabCount();
  for (const x of offer()?.tabs ?? []) {
    const m = x.machine ?? null;
    if (made.has(m ?? "")) {
      const there = () => spaces().some((s) => s.name === "~" && sameMachine(s.machine, m));
      for (let t = 0; !there() && t < NEW_SPACE_WAIT_MS; t += WAIT_STEP_MS) await pause(WAIT_STEP_MS);
      made.delete(m ?? "");
    }
    const r = await resumeOne(x.sid, { quiet: true, made });
    if (r === "wait") wait++; else if (r === true) opened++;
  }
  await returnTo(was, before, opened, pause);
  if (wait) notify?.(`A Claude tab isn't identified yet — it could be ${wait === 1 ? "the session" : `one of the ${wait} sessions`} still offered, already open. Try Resume all again in a moment, once it is identified.`);
}
export function dismissOffer() { const o = offer(); if (o) markHandled(o.tabs.map((x) => x.sid)); setShared(KEY_OFFER, null); }
