// Resume after a restart (owner 11-12 s13: "remember which conversation each tab had and offer to resume them all
// with one click"). Every RESUME_TICK_MS it remembers each local Claude Code tab's conversation — its session id and
// account (from the log the Flockbook helper found for that terminal: flockbook/cache.json), the folder it started in,
// its workspace and tab name, its process ids. When the remembered sessions vanish together (Herdr Core or the Mac
// restarted; the window alone restarting keeps them) or while the app was not running, the Overview offers them
// back: Resume (one), Resume all, Dismiss. A resume opens a tab in the same workspace and folder, as the same
// account, running `claude --resume <id>`. A tab closed on purpose (alone, while the rest go on) or a /clear (same
// process, new conversation) is just forgotten. Nothing runs without a click.
import { agents, terminals, spaces, shared, setShared, readTextFile, appHome, home, run, notify } from "herdr";
import { accounts, claudeCommand, sessionOfLog } from "./accounts.js";

export const KEY_RESUME = "flockbook.resume.v1";   // { at, tabs: { [sid]: rec } }
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
const TICK_LOCK_MS = 20_000, HANDLED_KEEP_MS = 24 * 3600_000, UNSURE_WAIT_MS = 30_000, CLAIM_MS = 60_000;
// Whether a click claimed this offer row and is still opening it (s14 follow-up: the Overview shows "Opening…" in
// place of its Resume for those CLAIM_MS, so a second click has nothing to press).
export const opening = (rec, now = Date.now()) => Boolean(rec?.claimAt && now - rec.claimAt < CLAIM_MS);
const handled = () => shared(KEY_HANDLED) ?? {};
const markHandled = (sids) => setShared(KEY_HANDLED, { ...handled(), ...Object.fromEntries(sids.map((s) => [s, Date.now()])) });
const dropFromOffer = (sid) => { const o = offer(); if (!o) return; const rest = o.tabs.filter((x) => x.sid !== sid); setShared(KEY_OFFER, rest.length ? { ...o, tabs: rest } : null); };
const patchOffer = (sid, patch) => { const o = offer(); if (!o?.tabs.some((x) => x.sid === sid)) return; setShared(KEY_OFFER, { ...o, tabs: o.tabs.map((x) => (x.sid === sid ? { ...x, ...patch } : x)) }); };

async function helperCache() {
  try { const t = await readTextFile(`${appHome()}/flockbook/cache.json`); return t ? JSON.parse(t) : null; } catch { return null; }
}

// The local Claude tabs now: { tabs (by session), sids, pids, unknown (a live Claude tab the helper hasn't identified
// yet), unknownTitles (their titles) }.
async function liveNow(now) {
  const subs = new Set(terminals().filter((t) => t.parent).map((t) => t.address));
  const claudes = agents().filter((a) => a.app === "claude-code" && a.address && !a.address.includes("/") && !subs.has(a.address));
  const entries = (await helperCache())?.entries ?? {};
  const tabs = {}, sids = new Set(), pids = new Set(), unknownTitles = new Set();
  let unknown = false;
  for (const a of claudes) {
    const e = entries[a.address], s = sessionOf(e?.path);
    if (!s) { unknown = true; if (plainTitle(a.title)) unknownTitles.add(plainTitle(a.title)); continue; }
    sids.add(s.sid);
    for (const p of e.pids ?? []) pids.add(p);
    tabs[s.sid] = { sid: s.sid, account: s.account, cwd: e.cwd ?? home(), pids: e.pids ?? [], terminal: a.address, space: a.space, spaceName: a.space_name,
      name: ownName(a), title: plainTitle(a.title) || null, at: now };
  }
  return { tabs, sids, pids, unknown, unknownTitles };
}
const running = (rec, live) => live.sids.has(rec.sid) || (rec.pids ?? []).some((p) => live.pids.has(p));

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
  // Downtime = the longest wait between two polls since the last complete look (`gapMax`), so polls that went on
  // while a tab was unidentified are not downtime (R2 P2), and a real gap before them still counts (R1 P2).
  const prev = was.polledAt ?? was.at;
  const gapMax = Math.max(was.gapMax ?? 0, prev ? now - prev : 0);
  // A live Claude tab whose session the helper has not found yet: no decision now (it would look gone).
  if (live.unknown) { setShared(KEY_RESUME, { at: was.at ?? now, polledAt: now, gapMax, tabs: { ...was.tabs, ...tabs } }); return; }
  const lost = lostSessions(was.tabs, { sids, pids }, gapMax).offer.filter((x) => !keep[x.sid]);
  if (lost.length) {
    const cur = offer()?.tabs ?? [];
    const add = lost.filter((x) => !cur.some((y) => y.sid === x.sid));
    setShared(KEY_OFFER, { at: now, tabs: [...cur, ...add] });
    if (add.length) notify?.(`${add.length} Claude ${add.length === 1 ? "session was" : "sessions were"} open before the restart. Resume ${add.length === 1 ? "it" : "them"} from the Overview.`);
  }
  // What is live now is what is remembered; the offered ones live on in the offer.
  setShared(KEY_RESUME, { at: now, polledAt: now, gapMax: 0, tabs });
}

// Opens a tab that resumes the offered session `sid`; then it leaves the offer. Its row is claimed before anything is
// awaited, so a double click or a second view opens nothing more. Never opens a session that runs now (resumed by
// hand since the last poll: s13 Codex R1 P1). While a Claude tab is not identified yet it waits: for good when that
// tab carries this session's title (it is likely this session, R2 P1); otherwise a click UNSURE_WAIT_MS after the
// first opens it (a brand-new Claude tab has no conversation log to identify it by until its first message).
export async function resumeOne(sid, { quiet = false } = {}) {
  const now = Date.now(), first = offer()?.tabs.find((x) => x.sid === sid);
  if (!first || (first.claimAt && now - first.claimAt < CLAIM_MS)) return false;
  patchOffer(sid, { claimAt: now });
  const live = await liveNow(now);
  const rec = offer()?.tabs.find((x) => x.sid === sid);
  if (!rec || rec.claimAt !== now) return false;   // dismissed meanwhile, or another click took it over
  if (running(rec, live)) { markHandled([sid]); dropFromOffer(sid); return false; }
  const sameTitle = Boolean(rec.title) && live.unknownTitles.has(rec.title);
  if (live.unknown && (sameTitle || !(rec.unsureAt && now - rec.unsureAt >= UNSURE_WAIT_MS))) {
    patchOffer(sid, { claimAt: null, unsureAt: rec.unsureAt ?? now });
    if (!quiet) notify?.(sameTitle
      ? `A Claude tab named “${rec.title}” isn't identified yet — it is probably that session, already open. Not resumed.`
      : "A Claude tab isn't identified yet — it could be that session. Click Resume again in half a minute.");
    return "wait";
  }
  const argv = resumeArgv(rec);
  if (argv) {
    const space = spaces().some((s) => s.id === rec.space) ? rec.space : undefined;
    run("tab.new", { ...(space ? { space } : {}), folder: rec.cwd, argv, ...(rec.name ? { name: rec.name } : {}) });
  }
  markHandled([sid]); dropFromOffer(sid);
  return Boolean(argv);
}
export async function resumeAll() {
  let wait = 0;
  for (const x of offer()?.tabs ?? []) if (await resumeOne(x.sid, { quiet: true }) === "wait") wait++;
  if (wait) notify?.(`A Claude tab isn't identified yet — it could be one of the ${wait === 1 ? "sessions" : `${wait} sessions`} still offered. Click Resume all again in half a minute.`);
}
export function dismissOffer() { const o = offer(); if (o) markHandled(o.tabs.map((x) => x.sid)); setShared(KEY_OFFER, null); }
