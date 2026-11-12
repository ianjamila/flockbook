// Files sessions started in a "~" workspace into the project workspace they work on (owner, 2026-11-11): the
// workspaces of the "projects" setting (see projectList below). A session moves when its title names exactly one
// project, or its Claude Code log shows most of the work happening in one project's folder (the log's own "cwd"
// and "file_path" fields; quoted text in commands is escaped there, so a command that only mentions the folder
// doesn't count; that folder must hold more than half of all such lines, see logProject). Each session moves at most once: one that was ever seen outside "~", or that moved already,
// stays wherever the owner puts it. The owner's view never changes: the terminal is parked (it keeps running)
// and relabelled for a new tab in the target space, which Herdr adopts in place (tested 2026-11-11; space.select
// + terminal.keep would switch the view). Never the tab the owner is looking at, never a split tab or a sub-agent,
// never in its first minute. Off unless the "Move sessions to their project" setting is on.
// Also: the tab menu's "Move to <workspace>" (a "flockbook.move-to:<t>:<space>" command → requestMove → serveMoveRequest
// in the top bar, which has a timer; the menu popup closes at once), and the "moved here" badge a tab gets for BADGE_MS after an automatic move (movedBadge).
import { spaces, agents, terminals, panes, run, hc, exec, home, appHome, readTextFile, writeTextFile, shared, setShared, notify } from "herdr";
import * as sidecar from "./sidecar.js";
import { setting, expandHome } from "./config.js";
import { sessionTopic } from "./state.js";

// The project workspaces, from the "projects" setting (config.json), e.g.
//   "projects": [{ "workspace": "webshop", "folder": "~/code/webshop", "title": "web\\s*shop" },
//                { "workspace": "tools", "folder": "~/code/tools", "suggest_only": true }]
// `title`: a pattern (any case) a session's title matches when it is about that project (none: only its folder
// counts); `suggest_only`: never moved automatically, only offered (suggestTick). None set: nothing moves.
// <projects-pure>
export function projectList(v, homeDir) {
  if (!Array.isArray(v)) return [];
  return v.map((p) => ({ name: p.workspace, folder: expandHome(String(p.folder), homeDir).replace(/\/+$/, ""),
    title: p.title ? new RegExp(p.title, "i") : null, suggestOnly: p.suggest_only === true }));
}
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// </projects-pure>
export const projects = () => projectList(setting("projects"), home());
export const TICK_MS = 20_000;
const MIN_AGE_MS = 60_000;          // a new session settles first (the owner may still be typing its first message)
const RECHECK_MS = 120_000;         // a session with no clear project is looked at again this often
const MIN_HITS = 5;                 // log lines in the project's folder before a move…
const MAJORITY = 0.5;               // …more than this share of ALL the log's folder lines (a quick `cd` there to check
                                    // one thing left ~30 of 618 lines there and moved a "~" session, 2026-11-11)…
const RATIO = 4;                    // …and this many times the other project's
const KEY_AT = "flockbook.automove.at";
const KEY_DONE = "flockbook.automove.done";   // { "<address>@<created_ms>": { to?, from?, why?, manual?, stay?, at } }, as in the file
export const KEY_REQUEST = "flockbook.move.request"; // { address, space, at }: a move the tab menu asked for
const KEY_MOVING = "flockbook.move.moving";   // { address: since }: moves under way, so two never touch one terminal
export const BADGE_MS = 5 * 60_000;
const file = () => `${appHome()}/flockbook/automove.json`;
const looked = new Map();           // key → when its log was last scored (this copy only; a rescore is cheap)
const firstSeen = new Map();        // address → when this copy first saw it (when the core gives no start time)

const isHome = (s) => !s.machine && s.name === "~";
const keyOf = (t) => `${t.address}@${t.created_ms ?? 0}`;
export const projectSpace = (p, list = spaces()) => list.find((s) => !s.machine && s.name.toLowerCase() === p.name.toLowerCase()) ?? null;

// The one project a title names, else null (none, or both).
export function titleProject(title, list = projects()) {
  const hits = list.filter((p) => p.title?.test(title ?? ""));
  return hits.length === 1 ? hits[0] : null;
}
// The project the log scores point to, else null. `scores`: { name: lines, [ALL]: lines with any folder }.
// The project's folder must hold most of the log's folder lines: work mostly elsewhere ("~", notes) stays put.
export const ALL = "*";
export function logProject(scores, list = projects()) {
  const ranked = list.map((p) => ({ p, n: scores[p.name] ?? 0 })).sort((a, b) => b.n - a.n);
  const [best, next] = ranked;
  if (!best) return null;
  if (!(scores[ALL] > 0)) return null;               // total unknown (grep failed): no move on half a picture
  const all = Math.max(scores[ALL], best.n);
  return best.n >= MIN_HITS && best.n > all * MAJORITY && (next?.n ?? 0) * RATIO <= best.n ? best.p : null;
}

async function loadDone() {
  if (shared(KEY_DONE)) return shared(KEY_DONE);
  let text = null, v = {};
  try { text = await readTextFile(file()); v = text ? JSON.parse(text) : {}; } catch { v = {}; }
  const done = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  setShared(KEY_DONE, done);
  return done;
}
// Keeps only live terminals' entries, so the file stays small.
async function saveDone(done) {
  const live = new Set(terminals().map(keyOf));
  const kept = Object.fromEntries(Object.entries(done).filter(([k]) => live.has(k)));
  setShared(KEY_DONE, kept);
  let was = null;
  try { was = await readTextFile(file()); } catch { was = null; }
  try { await writeTextFile(file(), JSON.stringify(kept, null, 2) + "\n", was); } catch { /* next tick writes again */ }
}

const pause = (cx, ms) => new Promise((r) => cx.timer.after(ms, () => r()));
async function until(cx, test, ms) {
  for (let waited = 0; waited <= ms; waited += 200) { if (test()) return true; await pause(cx, 200); }
  return false;
}
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

// Lines of the log in each project's folder, and (ALL) lines naming any folder.
async function scores(address) {
  let path = null;
  const read = async () => { try { return JSON.parse(await readTextFile(sidecar.cachePath()) ?? "{}")?.entries?.[address]?.path ?? null; } catch { return null; } };
  path = await read();
  if (!path) { await sidecar.status(address); path = await read(); }
  if (!path) return null;
  const out = {};
  for (const p of projects()) {
    try {
      const r = await exec("/usr/bin/grep", ["-c", "-E", `"(cwd|file_path)":"${escapeRe(p.folder)}(/|")`, path]);
      out[p.name] = parseInt(String(r.stdout).trim(), 10) || 0;
    } catch { out[p.name] = 0; }
  }
  try {
    const r = await exec("/usr/bin/grep", ["-c", "-E", `"(cwd|file_path)":"/`, path]);
    out[ALL] = parseInt(String(r.stdout).trim(), 10) || 0;
  } catch { out[ALL] = 0; }
  return out;
}

// Parks the terminal and gives it a new tab in `target`, at the end. False (and the terminal back in a pane
// somewhere) when a step failed.
export async function moveTerminal(cx, address, target) {
  const moving = shared(KEY_MOVING) ?? {};
  if (moving[address] && Date.now() - moving[address] < 30_000) return null;   // already moving: not a failure
  setShared(KEY_MOVING, { ...moving, [address]: Date.now() });
  try { return await parkAndAdopt(cx, address, target); }
  finally { const m = { ...(shared(KEY_MOVING) ?? {}) }; delete m[address]; setShared(KEY_MOVING, m); }
}
async function parkAndAdopt(cx, address, target) {
  run("terminal.park", { terminal: address });
  if (!(await until(cx, () => !panes().some((p) => p.terminal === address), 8000))) return false;
  const r = await hc(["label", address, `herdr.space=${target.id}`, `herdr.tab=tb${hex(32)}`]);
  const there = () => panes().find((p) => p.terminal === address && spaces().find((s) => s.id === target.id)?.tabs.some((t) => t.id === p.tab));
  if (r.code !== 0 || !(await until(cx, () => Boolean(there()), 8000))) {
    // Not adopted: never leave it without a pane (it would vanish from every screen).
    if (!panes().some((p) => p.terminal === address)) run("terminal.keep", { terminal: address });
    return false;
  }
  const sp = spaces().find((s) => s.id === target.id);
  if (sp) run("tab.move", { id: there().tab, index: sp.tabs.length });
  return true;
}

// One look at every session in a "~" space. Runs in one copy of the mod at a time.
export async function autoMoveTick(cx) {
  if (setting("auto_move") !== "on" || !projects().length) return;
  const now = Date.now(), at = shared(KEY_AT);
  if (at && now - at < TICK_MS - 2000) return;
  setShared(KEY_AT, now);
  const done = { ...(await loadDone()) };
  let changed = false;
  const all = spaces(), byAddr = new Map(terminals().map((t) => [t.address, t]));
  const homeIds = new Set(all.filter(isHome).map((s) => s.id));
  for (const a of agents()) {
    const t = byAddr.get(a.address);
    if (!t || t.parent) continue;
    const k = keyOf(t);
    if (done[k] || shared(KEY_MOVING)?.[a.address]) continue;
    // Seen outside "~": the owner's choice from now on (also when they later drag it into "~").
    if (!homeIds.has(a.space)) { done[k] = { stay: true, at: now }; changed = true; continue; }
    const space = all.find((s) => s.id === a.space), tab = space?.tabs.find((x) => x.id === a.tab);
    if (!tab || tab.panes !== 1 || (space.active && tab.active)) continue;
    if (!firstSeen.has(a.address)) firstSeen.set(a.address, now);
    if (now - (t.created_ms ?? firstSeen.get(a.address)) < MIN_AGE_MS) continue;
    let p = titleProject(sessionTopic(a)), why = p ? "its title names it" : null;
    if (!p) {
      if (now - (looked.get(k) ?? 0) < RECHECK_MS) continue;
      looked.set(k, now);
      const s = await scores(a.address);
      p = s ? logProject(s) : null;
      why = p ? "its work is in that folder" : null;
    }
    const target = p && !p.suggestOnly && projectSpace(p);
    if (!target) continue;
    const ok = await moveTerminal(cx, a.address, target);
    if (ok === null) continue;
    done[k] = ok ? { to: target.name, from: space.name, why, at: Date.now() } : { stay: true, failed: true, at: now };
    changed = true;
    notify({ title: ok ? `Moved “${sessionTopic(a) ?? a.address}” to ${target.name}` : `Couldn't move “${sessionTopic(a) ?? a.address}” to ${target.name}`,
      level: ok ? "info" : "warning", timeout: 4000 });
  }
  if (changed) await saveDone(done);
}

// <suggest>
// A tab in the wrong workspace (owner OK'd 11-12, "⑤"): a session whose work is in another project's folder gets a
// suggestion: a badge ("→ webshop?") and a first tab-menu row "Move to webshop?" — never a move by itself. From the log's
// folder lines (logProject, as the auto-mover; any space), or, for a tab outside a project workspace, its title. Not
// for a tab the owner moved by hand, nor towards a workspace the owner said "Keep it here" to for that session.
// The suggestion for one tab: { space, name, why } or null. `s`: its log scores (or null); `here`: its space;
// `entry`: its automove record; `list`: spaces.
export function suggestion(s, topic, here, entry, list, projs = projects()) {
  if (!here || here.machine || entry?.manual) return null;
  const inProject = projs.some((p) => p.name.toLowerCase() === here.name.toLowerCase());
  let p = s ? logProject(s, projs) : null, why = p ? `its work is in the ${p.name} folder` : null;
  if (!p && !inProject) { p = titleProject(topic, projs); why = p ? "its title names it" : null; }
  const target = p ? projectSpace(p, list) : null;
  if (!target || target.id === here.id || (entry?.noSuggest ?? []).includes(target.name)) return null;
  return { space: target.id, name: target.name, why };
}
// </suggest>
export const KEY_SUGGEST = "flockbook.move.suggest";   // { [address]: { space, name, why } }
export const suggestOf = (address) => (address ? shared(KEY_SUGGEST)?.[address] ?? null : null);
const scored = new Map();   // key → { at, s }: log scores, at most every RECHECK_MS per session (this copy)
export async function suggestTick() {
  const now = Date.now(), at = shared("flockbook.move.suggest.at");
  if (at && now - at < TICK_MS - 2000) return;
  setShared("flockbook.move.suggest.at", now);
  // No project workspaces set (the "projects" setting): nothing to suggest, and no log is read.
  if (!projects().length) { if (Object.keys(shared(KEY_SUGGEST) ?? {}).length) setShared(KEY_SUGGEST, {}); return; }
  const done = await loadDone(), all = spaces(), byAddr = new Map(terminals().map((t) => [t.address, t]));
  const out = {};
  for (const a of agents()) {
    const t = byAddr.get(a.address);
    if (!t || t.parent || a.address.includes("/")) continue;
    const here = all.find((x) => x.id === a.space), tab = here?.tabs.find((x) => x.id === a.tab);
    if (!tab || (tab.panes ?? 1) !== 1) continue;
    const k = keyOf(t);
    let c = scored.get(k);
    if (!c || now - c.at >= RECHECK_MS) { c = { at: now, s: await scores(a.address) }; scored.set(k, c); }
    const sg = suggestion(c.s, sessionTopic(a), here, done[k], all);
    if (sg) out[a.address] = sg;
  }
  if (JSON.stringify(out) !== JSON.stringify(shared(KEY_SUGGEST) ?? {})) setShared(KEY_SUGGEST, out);
}
// The tab menu's "Keep it in <here>": no more suggestions towards `name` for this session.
export async function keepHere(address, name) {
  const t = terminals().find((x) => x.address === address);
  if (!t || !name) return;
  const done = { ...(await loadDone()) }, k = keyOf(t);
  done[k] = { ...(done[k] ?? { stay: true, at: Date.now() }), noSuggest: [...new Set([...(done[k]?.noSuggest ?? []), name])] };
  await saveDone(done);
  const sg = { ...(shared(KEY_SUGGEST) ?? {}) }; delete sg[address]; setShared(KEY_SUGGEST, sg);
}
export const suggestTip = (sg) => `This tab may belong in ${sg.name}: ${sg.why}. Right-click it to move it, or to keep it here.`;

// Where the tab menu may move a tab: every other workspace on this computer (projects first). Only a tab with one
// pane and an agent in it, and not a sub-agent: a park ends a plain shell (tested 2026-11-11).
export function moveTargets(tab, agent) {
  if (!tab || !agent || (tab.panes ?? 1) !== 1) return [];
  if (terminals().find((t) => t.address === agent.address)?.parent) return [];
  const projs = projects();
  const proj = (s) => (projs.some((p) => p.name.toLowerCase() === s.name.toLowerCase()) ? 0 : 1);
  return spaces().filter((s) => !s.machine && s.id !== agent.space).sort((a, b) => proj(a) - proj(b) || a.index - b.index);
}
// The tab menu asks; the top bar moves (serveMoveRequest).
export function requestMove(address, space) { setShared(KEY_REQUEST, { address, space, at: Date.now() }); }
export async function serveMoveRequest(cx) {
  const r = shared(KEY_REQUEST);
  if (!r) return;
  setShared(KEY_REQUEST, null);   // the first copy of the bar takes it (before any await, so only one does)
  if (Date.now() - r.at > 10_000) return notify({ title: "Move skipped: it waited too long. Try again.", level: "warning", timeout: 3000 });
  const target = spaces().find((s) => s.id === r.space), a = agents().find((x) => x.address === r.address);
  if (!target || !a) return notify({ title: !a ? "Move skipped: that tab has no agent now." : "Move skipped: that workspace is gone.", level: "warning", timeout: 3000 });
  const name = sessionTopic(a) ?? a.address;
  const ok = await moveTerminal(cx, a.address, target);
  if (ok === null) return;
  const t = terminals().find((x) => x.address === a.address);
  if (t) {
    // A hand move is the owner's choice: the auto-mover leaves this session alone from now on.
    const done = { ...(await loadDone()), [keyOf(t)]: ok ? { to: target.name, manual: true, at: Date.now() } : { stay: true, at: Date.now() } };
    await saveDone(done);
  }
  notify({ title: ok ? `Moved “${name}” to ${target.name}` : `Couldn't move “${name}” to ${target.name}`, level: ok ? "info" : "warning", timeout: 3000 });
}
// The "moved here" badge: { to, from, why } for BADGE_MS after an automatic move, else null.
export function movedBadge(address, now = Date.now()) {
  const done = shared(KEY_DONE);
  if (!done || !address) return null;
  const t = terminals().find((x) => x.address === address);
  const d = t ? done[keyOf(t)] : null;
  return d?.to && !d.manual && now - d.at < BADGE_MS ? d : null;
}
export const badgeTip = (d) => `Moved here automatically${d.from ? ` from ${d.from}` : ""}${d.why ? `: ${d.why}` : ""}`;
