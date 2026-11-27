import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { SideView, tabMarks, monogram } from "../mods/flockbook/side.js";
import { NeedsView } from "../mods/flockbook/needs.js";
import { FinishedView } from "../mods/flockbook/finished.js";
import { KEY_AGENT } from "../mods/flockbook/state.js";
import { replyHandoff } from "../mods/flockbook/blocks.js";

const tab = (id, status) => ({ id, status });

beforeEach(() => {
  reset();
  fake.spaces = [space("sp1", { name: "flock book", tabs: [tab("a", "working"), tab("b", null)] }),
    space("sp2", { name: "api", active: false, tabs: [1, 2, 3, 4, 5, 6].map((i) => tab(`x${i}`, "done")) })];
  fake.agents = [agent("t1", "blocked", { tab_name: "fix login" }), agent("t2", "working"), agent("t3", "blocked", { space: "sp2", space_name: "api" })];
  passBlockGrace();   // plus build: blocked counts as Needs you only once it has lasted the grace (state.js BLOCK_GRACE_MS)
});

test("tab marks: up to 5 shown, else 3 and +N; monograms", () => {
  assert.equal(tabMarks([tab(1, "done"), tab(2, null)]).shown.length, 1);
  assert.deepEqual([tabMarks(Array(6).fill(tab(1, "done"))).shown.length, tabMarks(Array(6).fill(tab(1, "done"))).more], [3, 3]);
  assert.equal(monogram("flock book"), "FB");
  assert.equal(monogram("api"), "AP");
});

test("side: Needs you badge, one row per space, clicks run herdr commands", () => {
  const el = new SideView(fakeCx()).render(fakeCx());
  assert.match(textOf(byId(el, "side-needs")), /Needs you 2/);
  assert.match(textOf(byId(el, "space-sp2")), /\+3/);
  byId(el, "space-sp2")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.slice(-2), [["space.select", { id: "sp2" }], ["layout.select", { stack: "screen", child: "chat" }]],
    "a workspace click leaves Needs you for that workspace's chat");
  assert.equal(fake.shared["flockbook.agent"], null, "the chat starts at that workspace's first agent");
  byId(el, "space-new")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.at(-1), ["space.new", undefined]);
  byId(el, "side-needs")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.at(-1), ["layout.select", { stack: "screen", child: "needs" }]);
});

test("needs: blocked agents of every space; pick one; open its chat", () => {
  const v = new NeedsView(fakeCx());
  let el = v.render(fakeCx());
  assert.match(textOf(byId(el, "needs-list")), /Needs you · 2/);
  assert.ok(byId(el, "need-t1") && byId(el, "need-t3") && !byId(el, "need-t2"));
  assert.match(textOf(byId(el, "needs-detail")), /fix login/);
  const cx = fakeCx();
  byId(el, "need-t3")._h.on_click({}, cx);
  assert.equal(cx.notified, 1);
  el = v.render(fakeCx());
  byId(el, "needs-open")._h.on_click({}, fakeCx());
  assert.equal(fake.shared[KEY_AGENT], "t3");
});

test("needs: nothing waits, All clear", () => {
  fake.agents = [agent("t2", "working")];
  assert.match(textOf(new NeedsView(fakeCx()).render(fakeCx())), /All clear/);
});

// Finished (owner 11-27): the Overview's "Hand-off given" tabs, on their own screen.
test("finished: only hand-off-given tabs — never a working, blocked, asking or background-agent one", async () => {
  const { finished } = await import("../mods/flockbook/state.js");
  const { listMode } = await import("../mods/flockbook/tabs.js");
  fake.agents = [agent("t1", "blocked"), agent("t2", "working"), agent("t4", "done"), agent("t5", "done"), agent("t6", "done"), agent("t7", "idle")];
  fake.shared["flockbook.handoff"] = { t1: true, t2: true, t4: true, t5: true, t6: true };
  fake.shared["flockbook.asks"] = { t5: { kind: "merge", pr: 5 } };
  fake.shared["flockbook.background"] = { t6: { shells: 0, agents: 1 } };
  assert.deepEqual(finished().map((a) => a.address), ["t4"]);
  assert.equal(listMode("finished"), "all", "Finished spans every workspace, as Needs you does");
});

// The Finished screen: the hand-off tabs on the left, the picked one's re-entry prompt and Copy buttons on the right.
// The view reads a tab's prompt through readHandoff (tested with a real feed in overview.test.mjs); here a fake reader
// gives each tab's reply text, parsed by the same blocks.js code.
const feedOf = (v, replies) => {
  v.reader = async (addr) => { const h = replyHandoff([{ id: "a1", k: "assistant", text: replies[addr] ?? "Done.", ts: 1 }]); return { prompt: h?.prompt ?? null, file: h?.file ?? null, problem: null }; };
};
// The top bar's asks tick (started with the view) rewrites the hand-off marks from the screens, which these fakes do not
// give: `marks` is set again before each tick and render (as the Overview tests do).
let marks = {};
const finishedSetup = (addrs = ["t4", "t6"]) => {
  fake.agents = [agent("t1", "blocked"), ...addrs.map((a) => agent(a, "done", { tab_name: `job ${a}` }))];
  marks = Object.fromEntries(addrs.map((a) => [a, true]));
};
const paint = (v) => { fake.shared["flockbook.handoff"] = marks; return v.render(fakeCx()); };
// Ticks the view and waits for the prompt read. Never returns the element from an async function: a drawn element has a
// then() (the builder API), so awaiting it would wait forever.
const load = async (v) => { fake.shared["flockbook.handoff"] = marks; const cx = fakeCx(); v.tick(cx); await Promise.all(cx.tasks); };

test("finished screen: the hand-off tabs, the picked one's prompt, Copy full only with a hand-off file", async () => {
  finishedSetup();
  const replies = { t4: "Done.\n\nRe-entry prompt:\n\n> Continue t4.\n> Full prompt: ~/claude-notes/handoffs/t4.md — read it first.", t6: "Done.\n\nRe-entry prompt:\n\n> Continue t6, no file." };
  const v = new FinishedView(fakeCx());
  feedOf(v, replies);
  let el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-list")), /Finished · 2/);
  assert.ok(byId(el, "fin-t4") && byId(el, "fin-t6") && !byId(el, "fin-t1"), "only the hand-off tabs, not the blocked one");
  assert.match(textOf(byId(el, "finished-detail")), /Continue t4\./);
  assert.match(textOf(byId(el, "finished-detail")), /Then type \/clear in the tab and paste\./);
  assert.ok(byId(el, "fin-copy") && byId(el, "fin-full") && byId(el, "fin-open"));
  byId(el, "fin-t6")._h.on_click({}, fakeCx());
  el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /Continue t6, no file/);
  assert.ok(byId(el, "fin-copy") && !byId(el, "fin-full"), "no hand-off file named: no Copy full");
  replies.t6 = "Done, nothing to hand over.";
  v.read.clear();
  el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /No re-entry prompt in its last reply\./);
  assert.ok(!byId(el, "fin-copy") && !byId(el, "fin-full") && byId(el, "fin-open"), "no prompt: Open tab only");
  byId(el, "fin-open")._h.on_click({}, fakeCx());
  assert.equal(fake.shared[KEY_AGENT], "t6");
});

test("finished screen: the picked tab leaves (it re-entered) → the first one shows; none left → Nothing finished", async () => {
  finishedSetup();
  const v = new FinishedView(fakeCx());
  feedOf(v, { t4: "Re-entry prompt:\n\n> P4.", t6: "Re-entry prompt:\n\n> P6." });
  let el = (await load(v), paint(v));
  byId(el, "fin-t6")._h.on_click({}, fakeCx());
  marks = { t4: true };
  el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /P4\./);
  marks = {};
  el = paint(v);
  assert.match(textOf(el), /Nothing finished/);
  assert.match(textOf(el), /No session left a re-entry prompt\./);
});

test("finished screen: Copy prompt reads the reply again and copies (and shows) the newest prompt", async () => {
  finishedSetup(["t4"]);
  const replies = { t4: "Re-entry prompt:\n\n> OLD prompt." };
  const v = new FinishedView(fakeCx());
  feedOf(v, replies);
  let el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /OLD prompt/);
  replies.t4 = "Re-entry prompt:\n\n> NEW prompt.";
  const cx = fakeCx(); let clip = null; cx.write_to_clipboard = (t) => { clip = t; };
  byId(el, "fin-copy")._h.on_click({}, cx);
  await Promise.all(cx.tasks);
  assert.match(clip, /NEW prompt/);
  el = paint(v);
  assert.match(textOf(byId(el, "finished-detail")), /NEW prompt/);
  assert.doesNotMatch(textOf(byId(el, "finished-detail")), /OLD prompt/);
  assert.match(textOf(byId(el, "fin-copy")), /Copied/);
});

// The sidebar's Finished row (owner 11-27): right under Needs you, with a count; hidden when hand-off marks are off
// (Settings → Workflow), since nothing could ever show there.
test("side: Finished row under Needs you with its count, opens the Finished screen; none with hand-off marks off", () => {
  fake.agents = [agent("t1", "blocked"), agent("t4", "done"), agent("t6", "done")];
  const ids = (el, out = []) => { if (el?._a?.id) out.push(el._a.id); for (const k of el?.kids ?? []) ids(k, out); return out; };
  fake.shared["flockbook.config"] = { file: { handoff_marks: "on" } };
  fake.shared["flockbook.handoff"] = { t4: true, t6: true };
  let el = new SideView(fakeCx()).render(fakeCx());
  assert.match(textOf(byId(el, "side-finished")), /Finished 2/);
  const order = ids(el).filter((i) => ["side-needs", "side-finished", "side-overview"].includes(i));
  assert.deepEqual(order, ["side-needs", "side-finished", "side-overview"]);
  byId(el, "side-finished")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.at(-1), ["layout.select", { stack: "screen", child: "finished" }]);
  fake.shared["flockbook.config"] = { file: { handoff_marks: "off" } };
  el = new SideView(fakeCx()).render(fakeCx());
  assert.equal(byId(el, "side-finished"), null);
});
