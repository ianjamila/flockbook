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
// a click opens an open tab; Closed starts folded; Copy copies the grouped text and says so.
test("Since you last looked: groups, cards, click to open, Closed folded, Copy with a notice", async () => {
  const { KEY_HIST } = await import("../mods/flockbook/history.js");
  const now = Date.now(), m = 60_000;
  const ev = (addr, label, min, kind, text) => ({ at: now - min * m, addr, label, account: "WORK", kind, text });
  fake.shared[KEY_HIST] = { from: now - 600 * m, at: now, last: {
    t1: { label: "api", account: "WORK", state: "working", about: "Keeps the API fast.", pr: null, handoff: false },
    t2: { label: "docs", account: "WORK", state: "needs", ask: "ready to merge · #5", about: null, pr: null, handoff: false },
  }, events: [ev("t1", "api", 9, "finished", "finished"), ev("t1", "api", 8, "about", "About: Keeps the API fast. (auto-written)"),
    ev("t2", "docs", 5, "needs", "ready to merge · #5"), ev("gone", "Webshop", 4, "closed", "closed")] };
  const v = new OverviewView(fakeCx());
  const el = v.render(fakeCx());
  const strip = byId(el, "ov-since");
  const text = textOf(strip);
  // Waiting on you comes first, then Working, then Closed (folded: its tab is not listed).
  assert.ok(text.indexOf("WAITING ON YOU") < text.indexOf("WORKING") && text.indexOf("WORKING") < text.indexOf("CLOSED"), text);
  assert.match(text, /3 tabs changed/);
  assert.match(textOf(byId(el, "ov-since-needs-0")), /docs.*WORK.*ready to merge, #5/);
  assert.match(textOf(byId(el, "ov-since-working-0")), /api.*Keeps the API fast\./);
  assert.doesNotMatch(textOf(byId(el, "ov-since-working-0")), /auto-written/);
  assert.equal(byId(el, "ov-since-closed-0"), null, "Closed starts folded");
  byId(el, "ov-since-h-closed")._h.on_click({}, fakeCx());
  const el2 = v.render(fakeCx());
  assert.match(textOf(byId(el2, "ov-since-closed-0")), /Webshop/);
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
});
