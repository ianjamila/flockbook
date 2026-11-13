// Batch 2 items 8–9 (s13): history.js — the change record behind the Overview's "Since you last looked" strip and
// the Needs you page's "waiting 2 h". Pure parts + the tick against fakes. Run: node test-history.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const OFF = 480;   // Singapore
const T0 = Date.UTC(2026, 10, 12, 7, 0);   // 3:00 pm Singapore
const MIN = 60_000;
let now = T0;
Date.now = () => now;
const st = fakeShared();
let tabs = [], terms = [];
const info = {};   // per address: { ask, need, ci, handoff, about, pr, account }
const h = await loadMod("history.js", {
  herdr: { ...st, agents: () => tabs, terminals: () => terms },
  // Live names carry the title's marks in front ("🛠✅ Webshop …"); the record keeps the plain name.
  "./state.js": { agentName: (a) => `🛠✅ ${a.name}`, needReason: (a) => info[a.address]?.need ?? null, overlays: () => [] },
  "./asks.js": { askOf: (x) => info[x]?.ask ?? null, askLine: (k) => k.line, bgOf: (x) => (info[x]?.ci || info[x]?.review ? { shells: 1, agents: 0, ci: Boolean(info[x].ci), review: Boolean(info[x].review) } : null), handoffOf: (x) => Boolean(info[x]?.handoff), prOf: (x) => info[x]?.pr ?? null },
  "./ai.js": { aboutOf: (x) => info[x]?.about ?? null, accountFor: (x) => info[x]?.account ?? null, accountName: (x) => ({ WORK: "Work account (WORK)", HOME: "Personal account (HOME)" })[x] ?? "Unknown account", clockText: (at, n, off) => { const w = new Date(at + off * MIN); const hh = w.getUTCHours(); return `${hh % 12 || 12}:${String(w.getUTCMinutes()).padStart(2, "0")} ${hh < 12 ? "am" : "pm"}`; }, localOffset: () => OFF, agoText: (at, n) => `${Math.floor((n - at) / MIN)} min ago` },
});

// Pure: snapshot state and diffs.
eq("snap: needs wins", h.snapOf({ status: "done", need: "merge", askText: "ready to merge · #1", ci: true }).state, "needs");
eq("snap: ci", h.snapOf({ status: "done", ci: true }).state, "ci");
eq("snap: working", h.snapOf({ status: "working" }).state, "working");
eq("snap: finished", h.snapOf({ status: "idle" }).state, "finished");
const s = (o) => ({ label: "Courier", account: "WORK", about: null, pr: null, handoff: false, ask: null, ...o });
eq("diff: working → finished", h.diffSnap(s({ state: "working" }), s({ state: "finished" })).map((e) => e.text), ["finished"]);
eq("diff: → needs names the ask", h.diffSnap(s({ state: "working" }), s({ state: "needs", ask: "ready to merge · #1838" })).map((e) => e.text), ["ready to merge · #1838"]);
eq("diff: → ci", h.diffSnap(s({ state: "working" }), s({ state: "ci" })).map((e) => e.text), ["waiting on CI"]);
eq("diff: new About keeps (auto-written)", h.diffSnap(s({ state: "working" }), s({ state: "working", about: "Couriers read offline." })).map((e) => e.text), ["About: Couriers read offline. (auto-written)"]);
eq("diff: PR merged", h.diffSnap(s({ state: "finished", pr: null }), s({ state: "finished", pr: { pr: 1838, state: "MERGED" } })).map((e) => e.text), ["#1838 merged"]);
eq("diff: hand-off", h.diffSnap(s({ state: "finished" }), s({ state: "finished", handoff: true })).map((e) => e.text), ["gave a hand-off"]);
eq("diff: nothing changed", h.diffSnap(s({ state: "working" }), s({ state: "working" })), []);
eq("diff: finished → working is not news", h.diffSnap(s({ state: "finished" }), s({ state: "working" })), []);

// The tick: first run is a silent baseline; later changes become events.
tabs = [{ address: "t1", name: "Style Guide #1838", status: "working" }, { address: "t2", name: "Inventory", status: "working" }];
info.t1 = { account: "WORK" }; info.t2 = { account: "HOME" };
h.historyTick();
eq("tick: first run records no events", h.history().events.length, 0);
eq("tick: noticed from now", h.history().from, T0);
now += 10 * MIN; tabs[0].status = "done";
h.historyTick();
now += 5 * MIN; info.t1.need = "merge"; info.t1.ask = { line: "ready to merge · #1838" };
h.historyTick();
eq("tick: events kept with time, label, account", h.history().events.map((e) => [e.at, e.label, e.account, e.text]), [[T0 + 10 * MIN, "Style Guide #1838", "WORK", "finished"], [T0 + 15 * MIN, "Style Guide #1838", "WORK", "ready to merge · #1838"]]);
eq("waiting: since the ask came", h.waitingFor("t1", T0 + 135 * MIN), "waiting 2 h");
eq("waiting: minutes", h.waitingFor("t1", T0 + 27 * MIN), "waiting 12 min");
eq("waiting: none for a tab not waiting", h.waitingFor("t2", now), null);
// A closed tab: its events stay (with its label) and a "closed" one is added.
now += MIN; tabs = tabs.filter((x) => x.address !== "t2");
h.historyTick();
eq("tick: closed tab noted", h.history().events.at(-1).text, "closed");
eq("tick: closed tab leaves the snapshot", "t2" in h.history().last, false);
// Throttle: a second tick within 20 s does nothing.
info.t1.about = "Couriers read offline.";
h.historyTick();
eq("tick: throttled", h.history().events.length, 3);

// Gap: the mod was not running for 20 min → noticed-from moves, a needs that began before stays unknown-start.
now += 20 * MIN;
h.historyTick();
eq("gap: noticed from moves to now", h.history().from, now);
eq("gap: About change still caught", h.history().events.at(-1).text, "About: Couriers read offline. (auto-written)");

// The strip (owner 11-13 redesign): grouped by what each tab does now; a tab = name, account, now, About, change chips.
const view = h.sinceView({ seen: T0 + 5 * MIN, now, off: OFF });
eq("strip: header", view.header, "Since you last looked (3:05 pm)");
eq("strip: earlier changes may be missing (gap after the baseline)", view.note, `changes noticed from ${"3:36 pm"} · earlier changes may be missing`);
eq("strip: groups in order, empty ones left out", view.groups.map((g) => [g.key, g.title, g.items.length]), [["needs", "Waiting on you", 1], ["closed", "Closed", 1]]);
eq("strip: count of tabs", view.count, 2);
eq("strip: a tab's card", view.groups[0].items[0], { addr: "t1", label: "Style Guide #1838", account: "WORK", now: "ready to merge, #1838",
  about: "Couriers read offline.", at: T0 + 36 * MIN,
  events: [{ when: "3:10 pm", text: "finished", kind: "finished" }, { when: "3:15 pm", text: "ready to merge, #1838", kind: "needs" }], more: 0 });
eq("strip: a closed tab keeps its name and account", [view.groups[1].items[0].label, view.groups[1].items[0].account, view.groups[1].items[0].now], ["Inventory", "HOME", "closed"]);
eq("copy: the strip as text, a heading per group", h.copyText(view), [
  "Since you last looked (3:05 pm) — Thu 12 Nov · changes noticed from 3:36 pm · earlier changes may be missing",
  "",
  "Waiting on you (1)",
  "- Style Guide #1838 [WORK]: ready to merge, #1838",
  "  About: Couriers read offline.",
  "  3:10 pm finished → 3:15 pm ready to merge, #1838",
  "",
  "Closed (1)",
  "- Inventory [HOME]: closed",
  "  3:16 pm closed",
].join("\n"));
eq("strip: nothing after Mark seen", h.sinceView({ seen: now, now, off: OFF }).groups, []);
// The day is said where it matters (owner 11-13: "10:15 pm … 10:15 am" read as one evening).
{
  const clk = (at) => { const w = new Date(at + OFF * MIN); const hh = w.getUTCHours(); return `${hh % 12 || 12}:${String(w.getUTCMinutes()).padStart(2, "0")} ${hh < 12 ? "am" : "pm"}`; };
  const N = Date.UTC(2026, 10, 13, 2, 20);   // Fri 10:20 am Singapore
  const y = Date.UTC(2026, 10, 12, 14, 15);  // Thu 10:15 pm
  eq("when: today", h.whenText(N - 5 * MIN, N, OFF, clk), "10:15 am");
  eq("when: yesterday", h.whenText(y, N, OFF, clk), "yesterday 10:15 pm");
  eq("when: older → weekday", h.whenText(y - 2 * 86_400_000, N, OFF, clk), "Tue 10:15 pm");
  eq("when: same day as the event before → time only", h.whenText(y + 60 * MIN, N, OFF, clk, y), "11:15 pm");
  eq("when: a timeline crossing into today says today", h.whenText(N - 5 * MIN, N, OFF, clk, y), "today 10:15 am");
  eq("when: just after midnight, the evening before is yesterday", h.whenText(Date.UTC(2026, 10, 12, 15, 50), Date.UTC(2026, 10, 12, 16, 10), OFF, clk), "yesterday 11:50 pm");
}
// nowText: what a tab does now, in words.
eq("now: finished with a merged PR and a hand-off", h.nowText({ state: "finished", pr: { pr: 1916, state: "MERGED" }, handoff: true }), "finished · #1916 merged · gave a hand-off");
eq("now: ci", h.nowText({ state: "ci" }), "waiting on CI");
eq("now: merging", h.nowText({ state: "merging" }), "merging");
eq("now: working", h.nowText({ state: "working", handoff: true }), "working");
eq("now: needs, its ask with commas", h.nowText({ state: "needs", ask: "ready to merge · #5" }), "ready to merge, #5");
eq("now: gone", h.nowText(null), "closed");
// More than PER_TAB changes: the last 6 shown, "+N earlier"; About changes are not chips, the newest About is the line.
{
  const evs = [];
  for (let i = 0; i < 9; i++) evs.push({ at: now + (i + 1) * MIN, addr: "t1", label: "Style Guide #1838", account: "WORK", kind: i % 2 ? "finished" : "needs", text: i % 2 ? "finished" : `asks ${i}` });
  evs.push({ at: now + 20 * MIN, addr: "t1", label: "Style Guide #1838", account: "WORK", kind: "about", text: "About: Newer words. (auto-written)" });
  st.setShared(h.KEY_HIST, { ...h.history(), events: evs, last: { t1: { label: "Style Guide #1838", account: "WORK", state: "working", about: null } } });
  const v2 = h.sinceView({ seen: now, now: now + 30 * MIN, off: OFF });
  const it = v2.groups[0].items[0];
  eq("many: in Working", v2.groups.map((g) => g.key), ["working"]);
  eq("many: last 6 changes, 3 earlier", [it.events.length, it.more, it.events.at(-1).text], [6, 3, "asks 8"]);
  eq("many: the newest About when the tab has none now", it.about, "Newer words.");
}
// In a group, the tab with the newest change first (the record lists them oldest first).
{
  const e = (addr, min) => ({ at: now + min * MIN, addr, label: addr, account: null, kind: "finished", text: "finished" });
  const fin = { state: "finished", about: null };
  st.setShared(h.KEY_HIST, { ...h.history(), events: [e("old", 1), e("new", 5), e("mid", 3)], last: { old: { label: "old", ...fin }, new: { label: "new", ...fin }, mid: { label: "mid", ...fin } } });
  eq("order: newest change first", h.sinceView({ seen: now, now: now + 10 * MIN, off: OFF }).groups[0].items.map((x) => x.label), ["new", "mid", "old"]);
}
h.markSeen();
eq("markSeen stores now", h.seenAt(), now);
// Default baseline: start of the local day.
eq("baseline default: local midnight", h.dayStart(T0, OFF), Date.UTC(2026, 10, 11, 16, 0));
// Ring buffer: at most HISTORY_KEEP events, none older than 3 days.
const many = Array.from({ length: h.HISTORY_KEEP + 50 }, (_, i) => ({ at: now - i, addr: "t1", text: "x" }));
eq("keep: capped", h.keepEvents([], many, now).length, h.HISTORY_KEEP);
// s15 (b): waiting on a review (a Codex / Fable review the session waits for in the background).
eq("snap: review", h.snapOf({ status: "done", review: true }).state, "review");
eq("snap: ci wins over review", h.snapOf({ status: "done", ci: true, review: true }).state, "ci");
eq("snap: needs wins over review", h.snapOf({ status: "done", need: "merge", review: true }).state, "needs");
eq("diff: → review", h.diffSnap(s({ state: "working" }), s({ state: "review" })).map((e) => [e.kind, e.text]), [["review", "waiting on a review"]]);
eq("diff: review → review is not news", h.diffSnap(s({ state: "review" }), s({ state: "review" })), []);
eq("diff: review → finished", h.diffSnap(s({ state: "review" }), s({ state: "finished" })).map((e) => e.text), ["finished"]);
// Through the tick: the background reader's `review` flag becomes the event.
now += MIN; tabs[0].status = "working"; info.t1 = { account: "WORK" };
h.historyTick();
now += MIN; info.t1.review = true;
h.historyTick();
eq("tick: review event recorded", h.history().events.at(-1).text, "waiting on a review");
eq("keep: old dropped", h.keepEvents([{ at: now - 4 * 86_400_000, text: "old" }], [{ at: now, text: "new" }], now).map((e) => e.text), ["new"]);
process.exit(bad ? 1 : 0);
