// What changed in each tab, noticed as it happened (s13, Batch 2 items 8–9 of the 11-12 Codex + Fable review): the
// record behind the Overview's "Since you last looked" strip (Copy, Mark seen) and the Needs you page's "waiting 2 h".
// Free: built from what the mod already knows (status, asks, CI waits, hand-offs, About lines, PR states); no model
// call, no idle detection. Noticed only while the window runs: a gap (the app closed, the Mac asleep) moves "noticed
// from" and the strip says earlier changes may be missing.
//
// KEY_HIST = { from, at, last: { [address]: snap }, events: [{ at, addr, label, account, kind, text }] }, versioned
// in its key. A snap = { label, account, state: working | finished | needs | ci | review, ask, about, pr, handoff, needsAt,
// needsKnown }. Events stay HISTORY_DAYS (closed tabs' too, with the name they had), at most HISTORY_KEEP.
import { agents, terminals, shared, setShared } from "herdr";
import { agentName, needReason, overlays } from "./state.js";
import { askOf, askLine, bgOf, handoffOf, prOf } from "./asks.js";
import { aboutOf, accountFor, accountName, clockText, localOffset } from "./ai.js";

export const KEY_HIST = "flockbook.history.v1";
export const KEY_SEEN = "flockbook.history.seen";   // when the owner last pressed "Mark seen" (ms), or null
export const HISTORY_TICK_MS = 20_000;

// <history-pure>
export const HISTORY_KEEP = 400;
const HISTORY_DAYS = 3;
const GAP_MS = 5 * 60_000;
const PER_TAB = 6;
// The state that matters to the owner: asking them something, waiting on CI or on a review (a Codex / Fable review its
// turn ended on, asks.js backgroundWork), working, or finished.
export function snapOf({ label = null, account = null, status, need = null, askText = null, ci = false, review = false, merging = false, handoff = false, about = null, pr = null }) {
  const state = need ? "needs" : ci ? "ci" : merging ? "merging" : review ? "review" : status === "working" ? "working" : "finished";
  return { label, account, state, ask: need ? askText ?? "waits for your answer or approval" : null, about, pr: pr?.state ? { pr: pr.pr, state: pr.state } : null, handoff: Boolean(handoff) };
}
// The events between two snapshots of one tab: [{ kind, text }]. Going back to work is not news.
export function diffSnap(prev, next) {
  const out = [];
  if (prev.state !== next.state || (next.state === "needs" && prev.ask !== next.ask)) {
    if (next.state === "finished") out.push({ kind: "finished", text: "finished" });
    if (next.state === "needs") out.push({ kind: "needs", text: next.ask });
    if (next.state === "ci") out.push({ kind: "ci", text: "waiting on CI" });
    if (next.state === "merging") out.push({ kind: "merging", text: "merging (the PR is in the merge queue)" });
    if (next.state === "review") out.push({ kind: "review", text: "waiting on a review" });
  }
  if (next.handoff && !prev.handoff) out.push({ kind: "handoff", text: "gave a hand-off" });
  if (next.about && next.about !== prev.about) out.push({ kind: "about", text: `About: ${next.about} (auto-written)` });
  const p = next.pr;
  if (p && (p.state === "MERGED" || p.state === "CLOSED") && (prev.pr?.state !== p.state || prev.pr?.pr !== p.pr)) out.push({ kind: "pr", text: `#${p.pr} ${p.state === "MERGED" ? "merged" : "closed without merging"}` });
  return out;
}
// The kept events: newest last, none older than HISTORY_DAYS, at most HISTORY_KEEP.
export function keepEvents(old, fresh, now) {
  return [...(old ?? []), ...fresh].filter((e) => now - e.at < HISTORY_DAYS * 86_400_000).slice(-HISTORY_KEEP);
}
// Local midnight of `now`'s day (`off`: minutes ahead of UTC): the strip's baseline before any "Mark seen".
export function dayStart(now, off) {
  const w = new Date(now + off * 60_000);
  return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - off * 60_000;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayText(at, off) {
  const w = new Date(at + off * 60_000);
  return `${DAYS[w.getUTCDay()]} ${w.getUTCDate()} ${MONTHS[w.getUTCMonth()]}`;
}
// "waiting 12 min", "waiting 2 h", "waiting 1 d"; a "+" when it began before the record did.
export function waitText(since, known, now) {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  const s = m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
  return `waiting ${s}${known ? "" : "+"}`;
}
// </history-pure>

export const history = () => shared(KEY_HIST) ?? { from: null, at: null, last: {}, events: [] };
export const seenAt = () => shared(KEY_SEEN) ?? null;
export function markSeen() { setShared(KEY_SEEN, Date.now()); }

// One look at every local tab (one copy at a time is not needed: it runs without waiting, so two copies can't
// interleave; a second within HISTORY_TICK_MS does nothing).
export function historyTick() {
  const now = Date.now(), h = history();
  if (h.at && now - h.at < HISTORY_TICK_MS - 1000) return;
  const first = !h.at;
  const gap = Boolean(h.at) && now - h.at > GAP_MS;
  const subs = new Set(terminals().filter((t) => t.parent).map((t) => t.address));
  const last = {}, fresh = [];
  for (const a of agents()) {
    if (!a.address || a.address.includes("/") || subs.has(a.address)) continue;
    const ask = askOf(a.address), need = needReason(a);
    // The plain name: without the title's marks in front ("🛠✅ Webshop …").
    const snap = snapOf({ label: String(agentName(a) ?? "").replace(/^[^\p{L}\p{N}#~/]+/u, "").trim() || a.address, account: accountFor(a.address), status: a.status, need, askText: ask ? askLine(ask) : null,
      ci: Boolean(bgOf(a.address)?.ci), review: Boolean(bgOf(a.address)?.review), merging: overlays(a).some((o) => o.group === "merging" && o.wait), handoff: handoffOf(a.address), about: aboutOf(a.address), pr: prOf(a.address) });
    const prev = h.last?.[a.address] ?? null;
    // Since when it waits on the owner: kept while it keeps waiting; unknown when it already waited at the first look.
    if (snap.state === "needs") Object.assign(snap, prev?.state === "needs" ? { needsAt: prev.needsAt, needsKnown: prev.needsKnown } : { needsAt: now, needsKnown: !first && !gap && Boolean(prev) });
    last[a.address] = snap;
    if (first) continue;
    const ev = prev ? diffSnap(prev, snap) : [{ kind: "new", text: "started" }];
    for (const e of ev) fresh.push({ at: now, addr: a.address, label: snap.label, account: snap.account, ...e });
  }
  if (!first) for (const [addr, prev] of Object.entries(h.last ?? {})) {
    if (!(addr in last)) fresh.push({ at: now, addr, label: prev.label, account: prev.account, kind: "closed", text: "closed" });
  }
  setShared(KEY_HIST, { from: first || gap ? now : h.from, at: now, last, events: keepEvents(h.events, fresh, now) });
}

// "waiting 2 h" for a tab that waits on the owner now, else null (the Needs you page).
export function waitingFor(address, now = Date.now()) {
  const s = history().last?.[address];
  return s?.state === "needs" && s.needsAt ? waitText(s.needsAt, s.needsKnown, now) : null;
}

// The strip: { header, note, lines: [{ addr, text }] } for the events after `seen` (default: local midnight). One
// line per tab, the tab with the newest change first, its last PER_TAB changes in order, a repeat in a row once.
export function sinceView({ seen = seenAt(), now = Date.now(), off = localOffset() } = {}) {
  const h = history();
  const base = seen ?? dayStart(now, off);
  const clock = (at) => clockText(at, now, off);
  const by = new Map();
  for (const e of h.events ?? []) {
    if (e.at <= base) continue;
    const list = by.get(e.addr) ?? [];
    if (list.at(-1)?.text !== e.text) list.push(e);
    by.set(e.addr, list);
  }
  const lines = [...by.entries()].sort((x, y) => y[1].at(-1).at - x[1].at(-1).at).map(([addr, list]) => {
    const head = list.at(-1);
    // An ask's own " · " ("ready to merge · #1838") would read as two changes: a comma inside one.
    const items = list.slice(-PER_TAB).map((e) => `${clock(e.at)} ${String(e.text).replace(/ · /g, ", ")}`);
    return { addr, text: `${head.label ?? addr} (${accountName(head.account)}): ${list.length > PER_TAB ? "… " : ""}${items.join(" · ")}` };
  });
  const header = `Since you last looked (${seen ? clock(seen) : "today"})`;
  const note = h.from && base < h.from ? `changes noticed from ${clock(h.from)} · earlier changes may be missing` : null;
  return { header, note, lines, day: dayText(now, off) };
}
// What "Copy" puts on the clipboard: exactly the strip's lines, under its header and the local day.
export function copyText(view) {
  return [`${view.header} — ${view.day}${view.note ? ` · ${view.note}` : ""}`, ...view.lines.map((l) => `- ${l.text}`)].join("\n");
}
