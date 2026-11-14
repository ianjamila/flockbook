// Claude Code tabs whose conversation went on in Claude Code's background service ("parked", owner 11-13: "flockbook
// is not working for this terminal"). The client in the terminal stops reporting its status and the background
// session has no terminal to report to, so Herdr lists no agent there: the chat says "No agent to show", the tab
// drops out of the Overview, Needs you and the sidebar marks. The helper's `parked` command finds such tabs and their
// job's status (and the helper's other commands read the job's conversation); this module puts them back.
//
// Every module reads `agents()` and `spaces()` from here instead of from "herdr": Herdr's lists plus the parked tabs
// as agents, with their tab's and space's status rolled up. A parked tab whose job finished shows "done" until you
// look at it, then "idle", as Herdr does for its own agents.
import { agents as herdrAgents, spaces as herdrSpaces, panes, focused, shared, setShared } from "herdr";
import { call, hasCommand } from "./sidecar.js";

export const KEY_PARKED = "flockbook.parked";       // terminal → { job, session, status, kind, name, changed, finished, seen }
const KEY_AT = "flockbook.parked.at";
const KEY_BUSY = "flockbook.parked.busy";
export const TICK_MS = 3000;
const BUSY_MS = 60_000;

// Most urgent first, as Herdr rolls a tab's and a space's status up (blocked > done > working > idle).
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const worst = (list) => list.reduce((w, s) => ((RANK[s] ?? 0) > (RANK[w] ?? 0) ? s : w), null);

// A pane that may hold a parked Claude: a local terminal running Claude that reports no status and that Herdr does
// not list as an agent. Only while one exists does the tick ask the helper (a process listing).
export function candidates(list = panes(), known = herdrAgents()) {
  const have = new Set((known ?? []).map((a) => a.address));
  return (list ?? []).filter((p) => p.terminal && !p.terminal.includes("/") && p.status == null && !have.has(p.terminal)
    && (p.app === "claude-code" || p.program?.key === "claude"));
}

// The terminal is on screen for the owner now: its tab is the shown tab of the shown space.
function lookedAt(terminal, list = panes()) {
  const f = focused(), p = (list ?? []).find((x) => x.terminal === terminal);
  return Boolean(f && p && f.tab === p.tab && herdrSpaces().some((s) => s.active && s.id === f.space));
}

// The helper's answer (`terminals`) merged into what was kept: when the status last changed, when the job last
// finished (working or blocked → idle) and when the owner last looked, so "done" turns "idle" once seen.
export function merge(was, terminals, now, looked = lookedAt) {
  const out = {};
  for (const t of terminals ?? []) {
    if (!t?.terminal) continue;
    const w = was?.[t.terminal];
    const same = w && w.job === t.job;
    const changed = same && w.status === t.status ? w.changed : now;
    const finished = t.status === "idle" && same && w.status !== "idle" ? now : (same ? w.finished ?? null : null);
    const seen = looked(t.terminal) ? now : (same ? w.seen ?? null : null);
    out[t.terminal] = { job: t.job, session: t.session, status: t.status, kind: t.kind ?? null, name: t.name ?? null, changed, finished, seen };
  }
  return out;
}

// One tick at a time across every copy of the mod (as asks.js): ask the helper while a candidate pane exists; drop
// what was kept when none does.
export async function parkedTick() {
  const now = Date.now(), at = shared(KEY_AT), busy = shared(KEY_BUSY);
  if (at && now - at < TICK_MS - 500) return;
  if (busy && now - busy < BUSY_MS) return;
  if (!candidates().length) {
    if (Object.keys(shared(KEY_PARKED) ?? {}).length) setShared(KEY_PARKED, {});
    return;
  }
  // An older helper has no `parked` command: nothing to show.
  if (!(await hasCommand("parked"))) return;
  setShared(KEY_AT, now);
  setShared(KEY_BUSY, now);
  try {
    const r = await call("parked");
    if (r.error) return;
    const line = r.lines.find((l) => l.type === "parked");
    if (line) setShared(KEY_PARKED, merge(shared(KEY_PARKED) ?? {}, line.terminals, now));
  } finally { setShared(KEY_BUSY, null); }
}

// What a parked tab shows: the job's status, "done" while it finished after the owner last looked.
export function shownStatus(rec) {
  if (rec.status !== "idle") return rec.status;
  return rec.finished && !(rec.seen && rec.seen >= rec.finished) ? "done" : "idle";
}

// The parked tabs as Herdr's AgentInfo, plus `parked` ({ job, session, name }). `list`: Herdr's agents.
export function parkedAgents(list = herdrAgents(), all = herdrSpaces(), paneList = panes(), kept = shared(KEY_PARKED)) {
  if (!kept || !Object.keys(kept).length) return [];
  const have = new Set((list ?? []).map((a) => a.address));
  const out = [];
  for (const p of paneList ?? []) {
    const rec = kept[p.terminal];
    if (!rec || have.has(p.terminal) || p.status != null) continue;
    const s = (all ?? []).find((x) => (x.tabs ?? []).some((t) => t.id === p.tab));
    const t = s?.tabs.find((x) => x.id === p.tab);
    if (!s || !t) continue;
    out.push({ address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: t.id, tab_index: t.index, tab_name: t.name,
      status: shownStatus(rec), app: "claude-code", program: p.program, title: p.title ?? "", seq: rec.changed ?? 0, pinned: false,
      focused: Boolean(p.focused), parked: { job: rec.job, session: rec.session, name: rec.name } });
  }
  return out;
}

// One render's view of Herdr's lists (11-14 s33, "overview is not working": Herdr cut the Overview's render off with
// "interrupted" — it asked Herdr for every agent dozens of times per card, each a fresh copy of the whole list). Inside
// `withSnapshot(fn)` agents() and spaces() are read from Herdr once and reused; nothing changes mid-render, and the
// snapshot ends with the render. Callers get their own array (a copy), so an in-place sort can't leak to the next.
let snap = null;
export function withSnapshot(fn) {
  if (snap) return fn();
  snap = {};
  try { return fn(); } finally { snap = null; }
}

// One of Flockbook's own shared maps (asks, background work, hand-offs, Now and About lines), read once per snapshot
// (11-15: the Overview read them 337 times per redraw for 8 tabs, again per card). Only for read-only look-ups: a
// caller must not change the value, and anything that writes the map reads it with shared() itself.
export function snapShared(key) {
  if (!snap) return shared(key);
  const m = (snap.shared ??= new Map());
  if (!m.has(key)) m.set(key, shared(key));
  return m.get(key);
}

// Herdr's agents with the parked ones, in space, tab, pane order.
export function agents() {
  if (snap) return (snap.agents ??= readAgents()).slice();
  return readAgents();
}
function readAgents() {
  const base = herdrAgents();
  const extra = parkedAgents(base);
  if (!extra.length) return base;
  const all = herdrSpaces(), order = new Map();
  all.forEach((s, i) => (s.tabs ?? []).forEach((t, j) => order.set(t.id, i * 10_000 + j)));
  const paneAt = new Map((panes() ?? []).map((p, i) => [p.pane, i]));
  const key = (a) => [order.get(a.tab) ?? Infinity, paneAt.get(a.pane) ?? Infinity];
  return [...base, ...extra].map((a, i) => ({ a, i, k: key(a) }))
    .sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.i - y.i).map((x) => x.a);
}

// Herdr's spaces with each parked tab's status rolled into its tab and space (and when it changed / works since).
export function spaces() {
  if (snap) return (snap.spaces ??= readSpaces()).slice();
  return readSpaces();
}
function readSpaces() {
  const all = herdrSpaces();
  const extra = parkedAgents(herdrAgents(), all);
  if (!extra.length) return all;
  const kept = shared(KEY_PARKED) ?? {};
  return all.map((s) => {
    const mine = extra.filter((a) => a.space === s.id);
    if (!mine.length) return s;
    const tabs = s.tabs.map((t) => {
      const m = mine.filter((a) => a.tab === t.id);
      if (!m.length) return t;
      const status = worst([t.status, ...m.map((a) => a.status)]);
      const changed = Math.max(t.changed_at ?? 0, ...m.map((a) => kept[a.address]?.changed ?? 0)) || null;
      const since = status === "working" ? (t.working_since ?? Math.min(...m.filter((a) => a.status === "working").map((a) => kept[a.address]?.changed ?? Date.now()))) : t.working_since;
      return { ...t, status, changed_at: changed, working_since: Number.isFinite(since) ? since : null };
    });
    return { ...s, tabs, status: worst([s.status, ...tabs.map((t) => t.status)]) };
  });
}

// Whether a terminal is a parked Claude (for labels that name it).
export const parkedOf = (address) => (address ? shared(KEY_PARKED)?.[address] ?? null : null);
