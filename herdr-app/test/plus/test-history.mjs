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

// The strip: per tab, newest tab first, events after the baseline; Copy = exactly the strip's lines.
const view = h.sinceView({ seen: T0 + 5 * MIN, now, off: OFF });
eq("strip: header", view.header, "Since you last looked (3:05 pm)");
eq("strip: earlier changes may be missing (gap after the baseline)", view.note, `changes noticed from ${"3:36 pm"} · earlier changes may be missing`);
eq("strip: lines", view.lines.map((l) => l.text), [
  "Style Guide #1838 (Work account (WORK)): 3:10 pm finished · 3:15 pm ready to merge, #1838 · 3:36 pm About: Couriers read offline. (auto-written)",
  "Inventory (Personal account (HOME)): 3:16 pm closed",
]);
eq("copy: same lines under a local-day header", h.copyText(view), [
  "Since you last looked (3:05 pm) — Thu 12 Nov · changes noticed from 3:36 pm · earlier changes may be missing",
  "- Style Guide #1838 (Work account (WORK)): 3:10 pm finished · 3:15 pm ready to merge, #1838 · 3:36 pm About: Couriers read offline. (auto-written)",
  "- Inventory (Personal account (HOME)): 3:16 pm closed",
].join("\n"));
eq("strip: nothing after Mark seen", h.sinceView({ seen: now, now, off: OFF }).lines, []);
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
