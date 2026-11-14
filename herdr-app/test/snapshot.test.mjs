// One look-up of Herdr's lists per redraw (11-14 s33: on a loaded Mac Herdr cut the Overview's render off with
// "interrupted" — every card asked Herdr for the whole agent list again, a fresh copy each time). Each view's render
// runs inside parked.js withSnapshot, so Herdr's agents() and spaces() are read at most once each by agents() and
// once each by spaces() of parked.js, however many tabs the view draws.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, reset } from "./stub/herdr.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { OverviewView } from "../mods/flockbook/overview.js";
import { SideView } from "../mods/flockbook/side.js";
import { TopView } from "../mods/flockbook/top.js";
import { NeedsView } from "../mods/flockbook/needs.js";
import { SessionsView } from "../mods/flockbook/sessions.js";
import { TabsView } from "../mods/flockbook/tabs.js";
import Flockbook from "../mods/flockbook/main.js";
import { agents as parkedAgents, spaces as parkedSpaces } from "../mods/flockbook/parked.js";

const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });
const reads = { agents: 0, spaces: 0 };
// The stub's agents()/spaces() return fake.agents / fake.spaces: count every read of them.
for (const k of ["agents", "spaces"]) {
  let v = [];
  Object.defineProperty(fake, k, { configurable: true, enumerable: true, get() { reads[k]++; return v; }, set(x) { v = x; } });
}

beforeEach(() => {
  reset();
  // Two workspaces, eight Claude tabs: some working, some done, two needing an answer.
  const st = ["working", "done", "blocked", "idle"];
  fake.spaces = [
    space("sp1", { name: "app", tabs: [1, 2, 3, 4].map((i) => tab(`tb-a${i}`, i, { status: st[i - 1] })) }),
    space("sp2", { name: "docs", active: false, tabs: [1, 2, 3, 4].map((i) => tab(`tb-b${i}`, i, { status: st[i - 1] })) }),
  ];
  fake.agents = [1, 2, 3, 4].flatMap((i) => [agent(`a${i}`, st[i - 1], { tab: `tb-a${i}`, tab_index: i }),
    agent(`b${i}`, st[i - 1], { space: "sp2", space_name: "docs", tab: `tb-b${i}`, tab_index: i })]);
  fake.focused = { space: "sp1", tab: "tb-a1", pane: "p-a1", terminal: "a1", agent: "a1", cwd: "/w/app" };
  passBlockGrace();
});

// Resume sessions reads no list while it draws today (only when opening sessions, after the render): its case is a
// guard against that changing. Reads of Herdr's lists during one render (the view is made first: its constructor may read them too).
function readsOf(View) {
  const cx = fakeCx();
  const v = new View(cx);
  reads.agents = reads.spaces = 0;
  v.render(cx);
  return { ...reads };
}

for (const [name, View] of [["Overview", OverviewView], ["side bar", SideView], ["top bar", TopView], ["Needs you", NeedsView], ["tab list", TabsView], ["Resume sessions", SessionsView]]) {
  test(`${name}: one render reads Herdr's agent and space lists at most twice each`, () => {
    const r = readsOf(View);
    assert.ok(r.agents <= 2 && r.spaces <= 2, `${name} read agents ${r.agents}×, spaces ${r.spaces}× in one render`);
  });
}

test("a second render reads Herdr again (the snapshot ends with the render)", () => {
  const cx = fakeCx();
  const v = new SideView(cx);
  v.render(cx);
  reads.agents = reads.spaces = 0;
  fake.spaces = [...fake.spaces, space("sp3", { name: "new", active: false, tabs: [tab("tb-c1", 1)] })];
  v.render(cx);
  assert.ok(reads.spaces >= 1, "the second render looked again");
});

// Needs you's half-second tick runs needing() (a reason per agent): one snapshot too.
test("Needs you: one tick reads Herdr's lists at most twice each", () => {
  const cx = fakeCx();
  const v = new NeedsView(cx);
  reads.agents = reads.spaces = 0;
  v.tick(cx);
  assert.ok(reads.agents <= 2 && reads.spaces <= 2, `tick read agents ${reads.agents}×, spaces ${reads.spaces}×`);
});

// The top bar's 15-second badge count looks at every tab's agent: one snapshot too.
test("top bar: the 15-second badge count reads Herdr's lists at most twice each", () => {
  const cx = fakeCx();
  new TopView(cx);
  const t = cx.timers.find((x) => x.ms === 15_000 && String(x.f).includes("movedBadge"));
  assert.ok(t, "the 15-second badge timer is set");
  reads.agents = reads.spaces = 0;
  t.f(cx);
  assert.ok(reads.agents >= 1, "the badge count looked at the agents");
  assert.ok(reads.agents <= 2 && reads.spaces <= 2, `badge count read agents ${reads.agents}×, spaces ${reads.spaces}×`);
});

// main.js draws every view (chat, summary, settings, menu too) inside one snapshot.
test("main.js: any view's render runs inside one snapshot", () => {
  fake.props = { view: "chat" };
  const cx = fakeCx();
  const fb = new Flockbook(cx);
  fb.view = { render: () => { for (let i = 0; i < 20; i++) { parkedAgents(); parkedSpaces(); } return null; } };
  reads.agents = reads.spaces = 0;
  fb.render(cx);
  assert.ok(reads.agents <= 2 && reads.spaces <= 2, `main render read agents ${reads.agents}×, spaces ${reads.spaces}×`);
});

// Flockbook's own maps (asks, background work, hand-offs, Now lines, About lines) were read again for every card: 337
// host reads per Overview redraw with 8 tabs (11-15). The read-only look-ups (askOf, bgOf, handoffOf, nowOf, nowWait,
// aboutEntry) read each map once per snapshot too.
const MAPS = ["flockbook.asks", "flockbook.background", "flockbook.handoff", "flockbook.now", "flockbook.about"];
function mapReadsOf(View) {
  const counts = {};
  const real = fake.shared;
  fake.shared = new Proxy(real, { get(t, k) { if (typeof k === "string") counts[k] = (counts[k] ?? 0) + 1; return t[k]; } });
  try {
    const cx = fakeCx();
    const v = new View(cx);
    for (const k of Object.keys(counts)) delete counts[k];
    v.render(cx);
  } finally { fake.shared = real; }
  return Object.fromEntries(MAPS.map((k) => [k, counts[k] ?? 0]));
}
for (const [name, View] of [["Overview", OverviewView], ["side bar", SideView], ["top bar", TopView], ["Needs you", NeedsView], ["tab list", TabsView]]) {
  test(`${name}: one render reads each of Flockbook's shared maps at most once`, () => {
    const r = mapReadsOf(View);
    assert.ok(Object.values(r).every((n) => n <= 1), `${name} read ${JSON.stringify(r)} in one render`);
  });
}

test("Needs you: one tick reads each of Flockbook's shared maps at most once", () => {
  const counts = {};
  const real = fake.shared;
  const cx = fakeCx();
  const v = new NeedsView(cx);
  fake.shared = new Proxy(real, { get(t, k) { if (typeof k === "string") counts[k] = (counts[k] ?? 0) + 1; return t[k]; } });
  try { v.tick(cx); } finally { fake.shared = real; }
  const r = Object.fromEntries(MAPS.map((k) => [k, counts[k] ?? 0]));
  assert.ok(r["flockbook.asks"] >= 1, "the tick looked at the asks");
  assert.ok(Object.values(r).every((n) => n <= 1), `tick read ${JSON.stringify(r)}`);
});
