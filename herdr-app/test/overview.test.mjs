import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { OverviewView, groups, allTabs, ago, greeting, KEY_GROUP } from "../mods/flockbook/overview.js";

// The "Since you last looked" tests place events minutes ago; just after midnight those fall on yesterday, before the
// strip's baseline (local midnight), and the tests failed from 00:00 to ~00:10. They run on a clock fixed at today's noon.
const realNow = Date.now;
const atNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); const t = d.getTime(); Date.now = () => t; };
afterEach(() => { Date.now = realNow; });

const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });

beforeEach(() => {
  reset();
  fake.spaces = [
    space("sp1", { name: "app", tabs: [tab("tb-t1", 1, { status: "working", name: "api", named: true }), tab("tb-t2", 2, { status: "done" }), tab("tb-x", 3, { settled: true })] }),
    space("sp2", { name: "docs", active: false, tabs: [tab("tb-t3", 1, { status: "blocked" }), tab("tb-sh", 2)] }),
  ];
  fake.agents = [agent("t1", "working"), agent("t2", "done"), agent("t3", "blocked", { space: "sp2" })];
  fake.shared["flockbook.screen"] = "overview";   // the hand-off prefetch reads only while the Overview shows
  passBlockGrace();   // plus build: blocked counts as Needs you only once it has lasted the grace (state.js BLOCK_GRACE_MS)
});

test("every tab of every space, except settled ones", () => {
  assert.deepEqual(allTabs().map((it) => it.tab.id), ["tb-t1", "tb-t2", "tb-t3", "tb-sh"]);
});

test("grouped by status: working, done, then resting (a tab that needs you is left to the Needs you page); or by space", () => {
  // plus build: the blocked tab has no section here (the Needs you page lists it); a tab at the end of a piece of work gets "CI / Final Review / Merging" (below).
  assert.deepEqual(groups(allTabs(), "status").map((g) => [g.title, g.items.length]), [["Working", 1], ["Done", 1], ["Resting", 1]]);
  assert.deepEqual(groups(allTabs(), "space").map((g) => [g.title, g.items.length]), [["app", 2], ["docs", 2]]);
});

test("header counts, cards, and a click opens that tab in its space", () => {
  const v = new OverviewView(fakeCx());
  const el = v.render(fakeCx());
  assert.match(textOf(el), /4 tabs · 1 working ·\s+1 need you/);
  assert.match(textOf(byId(el, "ov-tb-t1")), /api/);
  // plus build: the blocked tab (tb-t3) is not an Overview card; "1 need you" opens the Needs you page instead.
  assert.equal(byId(el, "ov-tb-t3"), null);
  byId(el, "ov-need-you")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.at(-1), ["layout.select", { stack: "screen", child: "needs" }]);
  log.run = [];
  byId(el, "ov-tb-sh")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.slice(0, 2), [["space.select", { id: "sp2" }], ["tab.select", { id: "tb-sh" }]]);
  byId(el, "group-space")._h.on_click({}, fakeCx());
  assert.equal(fake.shared[KEY_GROUP], "space");
});

test("ago and greeting", () => {
  const now = 10 * 86400000;
  assert.equal(ago(now - 20000, now), "now");
  assert.equal(ago(now - 13 * 60000, now), "13m");
  assert.equal(ago(now - 5 * 3600000, now), "5h");
  assert.equal(ago(now - 2 * 86400000, now), "2d");
  assert.equal(ago(null, now), "");
  assert.equal(greeting(9), "Good morning"); assert.equal(greeting(15), "Good afternoon"); assert.equal(greeting(21), "Good evening");
});

// Owner 11-13 ("hard to read … should be organized better"): the strip groups tabs by what they do now, a card per tab;
// a click opens an open tab; every group starts folded (Expand all / Collapse all); Copy copies the grouped text and says so.
test("Since you last looked: groups, cards, click to open, folded at first, Expand/Collapse all, Copy with a notice", async () => {
  atNoon();
  const { KEY_HIST } = await import("../mods/flockbook/history.js");
  const now = Date.now(), m = 60_000;
  const ev = (addr, label, min, kind, text) => ({ at: now - min * m, addr, label, account: "WORK", kind, text });
  fake.shared[KEY_HIST] = { from: now - 600 * m, at: now, last: {
    t1: { label: "api", account: "WORK", state: "working", about: "Keeps the API fast.", pr: null, handoff: false },
    t2: { label: "docs", account: "WORK", state: "needs", ask: "ready to merge · #5", about: null, pr: null, handoff: false },
  }, events: [ev("t1", "api", 9, "finished", "finished"), ev("t1", "api", 8, "about", "About: Keeps the API fast. (auto-written)"),
    ev("t2", "docs", 5, "needs", "ready to merge · #5"), ev("gone", "Webshop", 4, "closed", "closed")] };
  const v = new OverviewView(fakeCx());
  const el0 = v.render(fakeCx());
  // Every group starts folded: headings with counts, no cards.
  for (const g of ["needs", "working", "closed"]) assert.ok(byId(el0, `ov-since-h-${g}`), g);
  for (const id of ["ov-since-needs-0", "ov-since-working-0", "ov-since-closed-0"]) assert.equal(byId(el0, id), null, id);
  // A heading opens its own group only.
  byId(el0, "ov-since-h-working")._h.on_click({}, fakeCx());
  const el1 = v.render(fakeCx());
  assert.ok(byId(el1, "ov-since-working-0"));
  assert.equal(byId(el1, "ov-since-needs-0"), null);
  byId(el1, "ov-since-expand")._h.on_click({}, fakeCx());
  const el = v.render(fakeCx());
  const strip = byId(el, "ov-since");
  const text = textOf(strip);
  // Waiting on you comes first, then Working, then Closed.
  assert.ok(text.indexOf("WAITING ON YOU") < text.indexOf("WORKING") && text.indexOf("WORKING") < text.indexOf("CLOSED"), text);
  assert.match(text, /3 tabs changed/);
  assert.match(textOf(byId(el, "ov-since-needs-0")), /docs.*WORK.*ready to merge, #5/);
  assert.match(textOf(byId(el, "ov-since-working-0")), /api.*Keeps the API fast\./);
  assert.doesNotMatch(textOf(byId(el, "ov-since-working-0")), /auto-written/);
  const el2 = el;
  assert.match(textOf(byId(el2, "ov-since-closed-0")), /Webshop/, "Expand all opened Closed too");
  assert.equal(byId(el2, "ov-since-closed-0")._h?.on_click, undefined, "a closed tab's card opens nothing");
  log.run = [];
  byId(el2, "ov-since-needs-0")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.slice(0, 2), [["space.select", { id: "sp1" }], ["tab.select", { id: "tb-t2" }]]);
  let copied = null;
  byId(el2, "ov-since-copy")._h.on_click({}, { ...fakeCx(), write_to_clipboard: (s) => { copied = s; } });
  assert.match(copied, /^Since you last looked/);
  assert.match(copied, /\nWaiting on you \(1\)\n- docs \[WORK\]: ready to merge, #5\n/);
  assert.match(log.notify.at(-1).title, /Copied/);
  assert.match(textOf(byId(v.render(fakeCx()), "ov-since-copy")), /Copied/);
  // Collapse all folds every group again; a heading click still folds one.
  byId(el2, "ov-since-collapse")._h.on_click({}, fakeCx());
  const el3 = v.render(fakeCx());
  for (const id of ["ov-since-needs-0", "ov-since-working-0", "ov-since-closed-0"]) assert.equal(byId(el3, id), null, id);
});

// s19 (owner yes): a tab under "Hand-off given" gets "Copy prompt" on its Overview card (and its "Since you last
// looked" card): the prompt of its newest reply, read through the helper as the chat reads it, without opening the tab.
test("Hand-off given: Copy prompt copies the newest reply's re-entry prompt without opening the tab", async () => {
  const jl = (...lines) => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" });
  const head = { type: "header", protocol: 1, sidecar: "0.1.0", command: "feed" }, end = { type: "end", ok: true };
  const logLine = { type: "log", agent: "claude", path: "/logs/s.jsonl", start: 0, size: 10, cursor: "c1", model: "m" };
  const row = (id, k, text) => ({ type: "row", id, k, text, ts: 1 });
  const reply = "Done.\n\nRe-entry prompt:\n\n> Continue the work.\n> (1) PR 2a.";
  let feed = [row("u0", "user", "start"), row("a0", "assistant", "Re-entry prompt:\n\n> An OLDER prompt."), row("f0", "footer", "9:00"),
    row("u1", "user", "go"), row("a1", "assistant", reply), row("f1", "footer", "10:04 · Worked 14m")];
  fake.exec = (_c, args) => { if (args[0] !== "feed") return { code: 127, stdout: "", stderr: "" }; return jl(head, logLine, { type: "splice", at: 0, count: feed.length }, ...feed, end); };
  // The asks tick (started by a render) rewrites the marks from the screens, which these fakes do not give: set again.
  const mark = (on = true) => { fake.shared["flockbook.handoff"] = on ? { t2: true } : {}; };
  const render = () => { mark(); return v.render(fakeCx()); };
  const v = new OverviewView(fakeCx());
  let el = render();
  assert.ok(byId(el, "ov-copy-tb-t2"), "the hand-off card has the button");
  assert.equal(byId(el, "ov-copy-tb-t1"), null, "a working tab has none");
  let copied = null;
  const ccx = Object.assign(fakeCx(), { write_to_clipboard: (s) => { copied = s; } });
  log.run = []; let stopped = 0;
  const btn = byId(el, "ov-copy-tb-t2");
  ccx.stop_propagation = () => { stopped++; };
  btn._h.on_click({}, ccx);
  await Promise.all(ccx.tasks);
  assert.equal(copied, "Continue the work.\n(1) PR 2a.", "the newest reply's prompt, not the older one");
  assert.ok(log.exec.some(([, a]) => a[0] === "feed" && a.includes("t2")), "read t2's chat through the helper");
  assert.match(log.notify.at(-1).title, /Re-entry prompt copied/);
  assert.equal(stopped, 1, "the click stops at the button");
  assert.deepEqual(log.run, [], "the tab is not opened");
  assert.match(textOf(byId(render(), "ov-copy-tb-t2")), /Copied/);
  // A newest reply without a prompt: nothing copied, a notice says so.
  feed = [...feed, row("u2", "user", "thanks"), row("a2", "assistant", "You're welcome."), row("f2", "footer", "10:30")];
  copied = null; v.copiedHandoff = null;
  const ccx2 = Object.assign(fakeCx(), { write_to_clipboard: (s) => { copied = s; } });
  byId(render(), "ov-copy-tb-t2")._h.on_click({}, ccx2); await Promise.all(ccx2.tasks);
  assert.equal(copied, null);
  assert.match(log.notify.at(-1).title, /No re-entry prompt in its last reply/);
  // The helper fails: its message, nothing copied.
  fake.exec = () => jl(head, { type: "error", code: "read", message: "log not found" }, end);
  const ccx3 = Object.assign(fakeCx(), { write_to_clipboard: (s) => { copied = s; } });
  byId(render(), "ov-copy-tb-t2")._h.on_click({}, ccx3); await Promise.all(ccx3.tasks);
  assert.equal(copied, null);
  assert.match(log.notify.at(-1).title, /Couldn't read its chat: log not found/);
  // No clipboard: a warning, no helper call.
  const n = log.exec.length;
  const ccx4 = fakeCx();
  byId(render(), "ov-copy-tb-t2")._h.on_click({}, ccx4); await Promise.all(ccx4.tasks);
  assert.equal(log.exec.length, n);
  assert.match(log.notify.at(-1).title, /no clipboard/);
  // The mark gone: no button.
  mark(false);
  assert.equal(byId(v.render(fakeCx()), "ov-copy-tb-t2"), null);
});

test("Hand-off given: the Since you last looked card of a hand-off tab has Copy prompt too; others don't", async () => {
  atNoon();
  const { KEY_HIST } = await import("../mods/flockbook/history.js");
  const now = Date.now(), m = 60_000;
  fake.shared[KEY_HIST] = { from: now - 600 * m, at: now, last: {
    t1: { label: "api", account: "WORK", state: "working", about: null, pr: null, handoff: false },
    t2: { label: "docs", account: "WORK", state: "finished", about: null, pr: null, handoff: true },
  }, events: [{ at: now - 9 * m, addr: "t1", label: "api", account: "WORK", kind: "working", text: "working" },
    { at: now - 5 * m, addr: "t2", label: "docs", account: "WORK", kind: "handoff", text: "gave a hand-off" }] };
  const v = new OverviewView(fakeCx());
  fake.shared["flockbook.handoff"] = { t2: true };
  byId(v.render(fakeCx()), "ov-since-expand")._h.on_click({}, fakeCx());
  fake.shared["flockbook.handoff"] = { t2: true };
  const el = v.render(fakeCx());
  assert.ok(byId(el, "ov-since-finished-0-copy"), "the hand-off tab's card");
  assert.equal(byId(el, "ov-since-working-0-copy"), null);
});

// s27: a hand-off card also gets "Copy full", the file its newest reply's prompt names (~/claude-notes/handoffs/…),
// read without opening the tab. A prompt naming no file: a notice says so and nothing is copied.
test("Hand-off given: Copy full copies the hand-off file the newest prompt names", async () => {
  const jl = (...lines) => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" });
  const head = { type: "header", protocol: 1, sidecar: "0.1.0", command: "feed" }, end = { type: "end", ok: true };
  const logLine = { type: "log", agent: "claude", path: "/logs/s.jsonl", start: 0, size: 10, cursor: "c1", model: "m" };
  const row = (id, k, text) => ({ type: "row", id, k, text, ts: 1 });
  let reply = "Done.\n\nRe-entry prompt:\n\n> Continue.\n> Full prompt: ~/claude-notes/handoffs/ov.md — read it first.";
  const feed = () => [row("u1", "user", "go"), row("a1", "assistant", reply), row("f1", "footer", "10:04")];
  fake.exec = (_c, args) => (args[0] === "feed" ? jl(head, logLine, { type: "splice", at: 0, count: 3 }, ...feed(), end) : { code: 127, stdout: "", stderr: "" });
  fake.readText = (p) => (p === "/home/test/claude-notes/handoffs/ov.md" ? "FULL PROMPT\n" : null);
  const render = () => { fake.shared["flockbook.handoff"] = { t2: true }; return v.render(fakeCx()); };
  const v = new OverviewView(fakeCx());
  const el = render();
  assert.ok(byId(el, "ov-full-tb-t2"), "the hand-off card has Copy full");
  assert.equal(byId(el, "ov-full-tb-t1"), null);
  let copied = null, stopped = 0;
  const ccx = Object.assign(fakeCx(), { write_to_clipboard: (s) => { copied = s; }, stop_propagation: () => { stopped++; } });
  log.run = [];
  byId(el, "ov-full-tb-t2")._h.on_click({}, ccx); await Promise.all(ccx.tasks);
  assert.equal(copied, "FULL PROMPT");
  assert.match(log.notify.at(-1).title, /Full re-entry prompt copied/);
  assert.equal(stopped, 1); assert.deepEqual(log.run, [], "the tab is not opened");
  assert.match(textOf(byId(render(), "ov-full-tb-t2")), /Copied/);
  // No file named: nothing copied, a notice.
  reply = "Re-entry prompt:\n\n> Continue.";
  copied = null; v.copiedFull = null;
  const ccx2 = Object.assign(fakeCx(), { write_to_clipboard: (s) => { copied = s; } });
  byId(render(), "ov-full-tb-t2")._h.on_click({}, ccx2); await Promise.all(ccx2.tasks);
  assert.equal(copied, null);
  assert.match(log.notify.at(-1).title, /names no full-prompt file/);
});

// Finished (owner 11-27): Overview and the Finished screen read a tab's re-entry prompt with one shared helper.
test("readHandoff: the newest prompt, the hand-off file it names, or the problem", async () => {
  const { readHandoff } = await import("../mods/flockbook/handoff-read.js");
  const jl = (...lines) => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" });
  const head = { type: "header", protocol: 1, sidecar: "0.1.0", command: "feed" }, end = { type: "end", ok: true };
  const logLine = { type: "log", agent: "claude", path: "/logs/s.jsonl", start: 0, size: 10, cursor: "c1", model: "m" };
  const row = (id, k, text) => ({ type: "row", id, k, text, ts: 1 });
  let reply = "Done.\n\nRe-entry prompt:\n\n> Continue.\n> Full prompt: ~/claude-notes/handoffs/ov.md — read it first.";
  fake.exec = (_c, args) => (args[0] === "feed" ? jl(head, logLine, { type: "splice", at: 0, count: 3 }, row("u1", "user", "go"), row("a1", "assistant", reply), row("f1", "footer", "10:04"), end) : { code: 127, stdout: "", stderr: "" });
  const a = await readHandoff("t2");
  assert.match(a.prompt, /Continue\./);
  assert.match(a.file, /handoffs\/ov\.md$/);
  assert.equal(a.problem, null);
  reply = "Done.\n\nRe-entry prompt:\n\n> Continue, no file.";
  const b = await readHandoff("t2");
  assert.match(b.prompt, /no file/);
  assert.equal(b.file, null);
  reply = "Done, nothing to hand over.";
  assert.equal((await readHandoff("t2")).prompt, null);
  fake.exec = () => ({ code: 0, stdout: JSON.stringify({ type: "error", message: "no such terminal" }) + "\n" + JSON.stringify(end) + "\n", stderr: "" });
  const c = await readHandoff("t2");
  assert.equal(c.prompt, null);
  assert.ok(c.problem, "a helper error is reported, not swallowed");
});

// Clear & re-enter: the Finished screen sends only into the log it showed, so readHandoff also gives the agent and log.
test("readHandoff: seen has the feed's agent and log; empty when the chat could not be read", async () => {
  const { readHandoff } = await import("../mods/flockbook/handoff-read.js");
  const jl = (...lines) => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" });
  const head = { type: "header", protocol: 1, sidecar: "0.1.0", command: "feed" }, end = { type: "end", ok: true };
  const logLine = { type: "log", agent: "claude", path: "/logs/seen.jsonl", start: 0, size: 10, cursor: "c1", model: "m" };
  fake.exec = () => jl(head, logLine, { type: "splice", at: 0, count: 1 }, { type: "row", id: "a1", k: "assistant", text: "Re-entry prompt:\n\n> Go.", ts: 1 }, end);
  assert.deepEqual((await readHandoff("t2")).seen, { agent: "claude", path: "/logs/seen.jsonl" });
  fake.exec = () => ({ code: 0, stdout: JSON.stringify({ type: "error", message: "no such terminal" }) + "\n" + JSON.stringify(end) + "\n", stderr: "" });
  assert.deepEqual((await readHandoff("t2")).seen, { agent: null, path: null });
});

// Clear & re-enter on a hand-off card (reenter-run.js). No key goes anywhere: the helper call is a fake `reenterer`.
// Fails if the card types into a tab it should not (another agent, no log, an older helper), types twice for two clicks,
// or does not share its run with the other screens (a second run started from the Finished screen or a chat).
test("Hand-off given: Clear & re-enter shows only when allowed, runs once with (address, prompt, seen), and shares its run", async () => {
  const { reentering, reenterRuns } = await import("../mods/flockbook/state.js");
  reentering.clear(); reenterRuns.clear();
  const seen = { agent: "claude", path: "/logs/t2.jsonl" };
  let read = { prompt: "Continue.", file: null, seen, problem: null };
  fake.shared["flockbook.handoff"] = { t2: true };
  const boot = fakeCx();
  const v = new OverviewView(boot);
  const calls = []; let release;
  v.reader = async () => read;
  v.reenterer = async (a, text, s) => { calls.push([a, text, s]); await new Promise((r) => { release = r; }); return { lines: [{ type: "done", result: "sent", message: "m", keys: "yes" }], error: null }; };
  let canHelper = false;
  v.helper.has = async () => canHelper;
  const paint = () => { fake.shared["flockbook.handoff"] = { t2: true }; return v.render(fakeCx()); };
  const tick = async () => { fake.shared["flockbook.handoff"] = { t2: true }; const cx = fakeCx(); v.tick(cx); await Promise.all(cx.tasks); };
  const ccx = Object.assign(fakeCx(), { write_to_clipboard: () => {}, stop_propagation: () => {} });
  // an older helper (no `reenter`): no button
  await tick();
  assert.equal(byId(paint(), "ov-reenter-tb-t2"), null, "the helper has no reenter");
  // the helper has it (asked again after its first "no")
  canHelper = true; v.helper.at = 0; await tick();
  assert.match(textOf(byId(paint(), "ov-reenter-tb-t2")), /Clear & re-enter/);
  assert.equal(byId(paint(), "ov-reenter-tb-t1"), null, "a working tab has none");
  // another agent, or no log path: no button
  read = { prompt: "Continue.", file: null, seen: { agent: "codex", path: "/logs/t2.jsonl" }, problem: null }; v.reads.clear(); await tick();
  assert.equal(byId(paint(), "ov-reenter-tb-t2"), null, "not a Claude tab");
  read = { prompt: "Continue.", file: null, seen: { agent: "claude", path: null }, problem: null }; v.reads.clear(); await tick();
  assert.equal(byId(paint(), "ov-reenter-tb-t2"), null, "no log path");
  read = { prompt: "Continue.", file: null, seen, problem: null }; v.reads.clear(); await tick();
  // a click: the helper gets (address, prompt, seen); the label says Re-entering…; a second click does nothing
  byId(paint(), "ov-reenter-tb-t2")._h.on_click({}, ccx);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [["t2", "Continue.", seen]]);
  assert.equal(reenterRuns.get("t2")?.state, "running", "the run is shared state: the Finished screen and chats see it");
  assert.equal(reentering.has("t2"), true, "the chat's Send waits");
  assert.match(textOf(byId(paint(), "ov-reenter-tb-t2")), /Re-entering…/);
  byId(paint(), "ov-reenter-tb-t2")._h.on_click({}, ccx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, "no second run");
  release(); await Promise.all(ccx.tasks);
  assert.match(log.notify.at(-1).title, /Re-entered/);
  assert.equal(reentering.has("t2"), false);
  // sent: no button again for the tab (its row stays only 5 s)
  assert.equal(byId(paint(), "ov-reenter-tb-t2"), null);
  // a run another screen started shows here as Re-entering…, with nothing to press, even before this view read the tab
  reenterRuns.clear(); v.reads.clear();
  reenterRuns.set("t2", { id: 99, state: "running", prompt: "Continue.", seen, at: Date.now() });
  const other = byId(paint(), "ov-reenter-tb-t2");
  assert.match(textOf(other), /Re-entering…/);
  other._h.on_click({}, ccx); await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, "a run on elsewhere is not started again");
  reentering.clear(); reenterRuns.clear();
});

// Clear & re-enter, review round 1. Each test names what it would catch in real use.
const KEY_SCREEN = "flockbook.screen";
const seenT2 = { agent: "claude", path: "/logs/t2.jsonl" };
const doneRun = (prompt, extra = {}) => ({ id: 5, state: "done", result: "prompt_unconfirmed", keys: "yes", prompt, seen: seenT2, at: Date.now(), message: null, lead: "x", tail: "y", note: "The prompt may already be in the tab.", bad: true, copyFailed: false, ...extra });

// A done run that typed (keys "yes") but did not send kept the button off until the Finished screen picked another tab:
// the owner's NEXT hand-off in that tab (a different prompt) never got its button.
test("Hand-off given: a run that typed hides the button only for the prompt it typed; a new hand-off drops the record and shows the button", async () => {
  const { reentering, reenterRuns } = await import("../mods/flockbook/state.js");
  reentering.clear(); reenterRuns.clear();
  fake.shared[KEY_SCREEN] = "overview";
  let read = { prompt: "Old.", file: null, seen: seenT2, problem: null };
  const v = new OverviewView(fakeCx());
  v.reader = async () => read; v.helper.has = async () => true;
  const paint = () => { fake.shared["flockbook.handoff"] = { t2: true }; return v.render(fakeCx()); };
  const tick = async () => { fake.shared["flockbook.handoff"] = { t2: true }; const cx = fakeCx(); v.tick(cx); await Promise.all(cx.tasks); };
  await tick(); await tick();
  assert.match(textOf(byId(paint(), "ov-reenter-tb-t2")), /Clear & re-enter/);
  reenterRuns.set("t2", doneRun("Old."));
  assert.equal(byId(paint(), "ov-reenter-tb-t2"), null, "the prompt it typed: not again");
  // the tab worked again and ended with a new hand-off
  read = { prompt: "New.", file: null, seen: seenT2, problem: null };
  fake.spaces[0].tabs[1].changed_at = Date.now() + 1000;
  await tick();
  assert.match(textOf(byId(paint(), "ov-reenter-tb-t2")), /Clear & re-enter/, "a new hand-off has its button");
  assert.equal(reenterRuns.has("t2"), false, "the old run's record is dropped");
  reenterRuns.clear(); reentering.clear();
});

// The prefetch used to run while another screen showed, all tabs at once, and a tab with no prompt every 5 s for ever.
test("Hand-off given: reads only while the Overview shows, two at a time, a tab with no prompt is asked after 5 s, 30 s, 5 min", async () => {
  const { reenterRuns } = await import("../mods/flockbook/state.js");
  reenterRuns.clear();
  const v = new OverviewView(fakeCx());
  const marks = { t1: true, t2: true, t3: true };
  const gates = []; let calls = 0;
  v.reader = (a) => { calls++; return new Promise((r) => gates.push(() => r({ prompt: "P " + a, file: null, seen: seenT2, problem: null }))); };
  const tick = async () => { fake.shared["flockbook.handoff"] = { ...marks }; const cx = fakeCx(); v.tick(cx); await Promise.resolve(); return cx; };
  fake.shared[KEY_SCREEN] = "chat";
  await tick();
  assert.equal(calls, 0, "another screen shows: nothing is read");
  fake.shared[KEY_SCREEN] = "overview";
  await tick(); await tick();
  assert.equal(calls, 2, "at most two reads at once");
  gates.splice(0).forEach((g) => g());
  await new Promise((r) => setTimeout(r, 5));
  await tick();
  assert.equal(calls, 3, "the third tab is read when one is free");
  gates.splice(0).forEach((g) => g());
  await new Promise((r) => setTimeout(r, 5));

  // no prompt: backoff
  const w = new OverviewView(fakeCx()); let n = 0; let now = 1_000_000;
  Date.now = () => now;
  w.reader = async () => { n++; return { prompt: null, file: null, seen: seenT2, problem: null }; };
  const wtick = async () => { fake.shared["flockbook.handoff"] = { t2: true }; const cx = fakeCx(); w.tick(cx); await Promise.all(cx.tasks); };
  await wtick(); assert.equal(n, 1);
  now += 4000; await wtick(); assert.equal(n, 1, "not before 5 s");
  now += 1000; await wtick(); assert.equal(n, 2, "5 s after the first miss");
  now += 29000; await wtick(); assert.equal(n, 2, "not before 30 s");
  now += 1000; await wtick(); assert.equal(n, 3, "30 s after the second");
  now += 299000; await wtick(); assert.equal(n, 3, "not before 5 min");
  now += 1000; await wtick(); assert.equal(n, 4, "5 min after the third");
  now += 299000; await wtick(); assert.equal(n, 4);
});

// A card kept the prompt of a reply the tab had since replaced (its mark stayed on across a new turn).
test("Hand-off given: a card's read is taken again when the tab's turn ends again", async () => {
  fake.shared[KEY_SCREEN] = "overview";
  let read = { prompt: "First.", file: null, seen: seenT2, problem: null }, n = 0;
  const v = new OverviewView(fakeCx());
  v.reader = async () => { n++; return read; };
  const tick = async () => { fake.shared["flockbook.handoff"] = { t2: true }; const cx = fakeCx(); v.tick(cx); await Promise.all(cx.tasks); };
  await tick(); await tick();
  assert.equal(n, 1); assert.equal(v.reads.get("t2").prompt, "First.");
  read = { prompt: "Second.", file: null, seen: seenT2, problem: null };
  fake.spaces[0].tabs[1].changed_at = Date.now() + 5000;
  await tick();
  assert.equal(n, 2); assert.equal(v.reads.get("t2").prompt, "Second.");
});

// The click took the lock and the run record, then cx.spawn threw: the tab showed "Re-entering…" for ever.
test("Hand-off given: a click whose task could not start leaves no run and no lock", async () => {
  const { reentering, reenterRuns } = await import("../mods/flockbook/state.js");
  reentering.clear(); reenterRuns.clear();
  fake.shared[KEY_SCREEN] = "overview";
  const v = new OverviewView(fakeCx());
  v.reader = async () => ({ prompt: "Go.", file: null, seen: seenT2, problem: null }); v.helper.has = async () => true;
  const tick = async () => { fake.shared["flockbook.handoff"] = { t2: true }; const cx = fakeCx(); v.tick(cx); await Promise.all(cx.tasks); };
  await tick(); await tick();
  const boom = Object.assign(fakeCx(), { write_to_clipboard: () => {}, spawn() { throw new Error("no spawn"); } });
  v.startReenter(boom, "t2");
  assert.equal(reenterRuns.has("t2"), false); assert.equal(reentering.has("t2"), false);
});

// The changed callback threw: the record stayed "running", the button said Re-entering… for ever.
test("reenter(): a callback that throws still ends the run", async () => {
  const { reentering, reenterRuns } = await import("../mods/flockbook/state.js");
  const { begin, reenter } = await import("../mods/flockbook/reenter-run.js");
  reentering.clear(); reenterRuns.clear();
  const started = begin("t2", { prompt: "A.", seen: seenT2 });
  await reenter(fakeCx(), "t2", started, { write_to_clipboard() {} }, {
    reader: async () => ({ prompt: "B.", seen: seenT2, problem: null }),
    reenterer: async () => { throw new Error("must not be called"); },
    changed: () => { throw new Error("view gone"); },
  });
  assert.equal(reenterRuns.has("t2"), false); assert.equal(reentering.has("t2"), false);
});
