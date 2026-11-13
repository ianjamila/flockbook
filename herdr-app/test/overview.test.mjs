import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { OverviewView, groups, allTabs, ago, greeting, KEY_GROUP } from "../mods/flockbook/overview.js";

const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });

beforeEach(() => {
  reset();
  fake.spaces = [
    space("sp1", { name: "app", tabs: [tab("tb-t1", 1, { status: "working", name: "api", named: true }), tab("tb-t2", 2, { status: "done" }), tab("tb-x", 3, { settled: true })] }),
    space("sp2", { name: "docs", active: false, tabs: [tab("tb-t3", 1, { status: "blocked" }), tab("tb-sh", 2)] }),
  ];
  fake.agents = [agent("t1", "working"), agent("t2", "done"), agent("t3", "blocked", { space: "sp2" })];
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
