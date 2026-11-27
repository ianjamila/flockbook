import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { SideView, tabMarks, monogram } from "../mods/flockbook/side.js";
import { NeedsView } from "../mods/flockbook/needs.js";
import { FinishedView, RETRY_MS } from "../mods/flockbook/finished.js";
import { KEY_AGENT, reentering, reenterRuns } from "../mods/flockbook/state.js";
import { replyHandoff } from "../mods/flockbook/blocks.js";

const tab = (id, status) => ({ id, status });

beforeEach(() => {
  reset();
  reentering?.clear(); reenterRuns?.clear();
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

// Review (11-27): a failed read must not stick. A read that gave no prompt is tried again after RETRY_MS; a Copy whose
// re-read fails keeps the prompt already shown (and only says why it could not copy).
test("finished screen: a failed read is retried; a failed Copy keeps the prompt on screen", async () => {
  finishedSetup(["t4"]);
  const v = new FinishedView(fakeCx());
  let fail = true;
  v.reader = async () => (fail ? { prompt: null, file: null, problem: "helper restarting" } : { prompt: "P4 now.", file: null, problem: null });
  let el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /helper restarting/);
  fail = false;
  el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /helper restarting/, "not re-read on every tick");
  v.read.get("t4").at -= RETRY_MS;
  el = (await load(v), paint(v));
  assert.match(textOf(byId(el, "finished-detail")), /P4 now\./, "re-read once the retry time passed");
  fail = true;
  const cx = fakeCx(); let clip = null; cx.write_to_clipboard = (t) => { clip = t; };
  byId(el, "fin-copy")._h.on_click({}, cx);
  await Promise.all(cx.tasks);
  assert.equal(clip, null);
  assert.match(textOf(byId(paint(v), "finished-detail")), /P4 now\./, "the shown prompt stays");
});

// Clear & re-enter (finished.js): the button, the run, its notes and the clipboard. No key goes anywhere: the run is a
// fake `reenterer` that returns the helper's answer (reenter.rs: one `done` or `error` line, with `keys`).
const SEEN = { agent: "claude", path: "/logs/t4.jsonl" };
const doneLine = (result, o = {}) => ({ lines: [{ type: "done", result, message: `msg ${result}`, cleared: false, keys: "yes", ...o }], error: null });
const errorLine = (code, o = {}) => ({ lines: [], error: { type: "error", code, message: `msg ${code}`, ...o } });
// A cx that can write to the clipboard (the button needs one at render time).
const clipCx = () => { const cx = fakeCx(); cx.clip = []; cx.write_to_clipboard = (t) => { cx.clip.push(t); }; return cx; };
// A view with the button available: a Claude tab t4 with prompt "P4.", `answer` the helper's reply (or a function).
async function reenterView(answer, { prompt = "P4.", seen = SEEN, addrs = ["t4"] } = {}) {
  finishedSetup(addrs);
  const boot = fakeCx();
  const v = new FinishedView(boot);
  await boot.settle();
  v.canReenter = true;
  v.reader = async () => ({ prompt, file: null, seen, problem: null });
  v.calls = [];
  v.reenterer = async (addr, text, s) => { v.calls.push([addr, text, s]); return typeof answer === "function" ? answer() : answer; };
  await load(v);
  return v;
}
const paintWith = (v, cx) => { fake.shared["flockbook.handoff"] = marks; return v.render(cx); };
const press = async (v, cx, id = "fin-reenter") => { byId(paintWith(v, cx), id)._h.on_click({}, cx); await Promise.all(cx.tasks); };
const detail = (v, cx) => textOf(byId(paintWith(v, cx), "finished-detail"));

test("finished screen: reenter_button_needs_prompt_claude_path_helper_and_clipboard", async () => {
  const cx = clipCx();
  let v = await reenterView(doneLine("sent"));
  assert.ok(byId(paintWith(v, cx), "fin-reenter"), "all there: the button shows");
  assert.match(textOf(byId(paintWith(v, cx), "fin-reenter")), /Clear & re-enter/);
  assert.match(detail(v, cx), /Types \/clear in this tab, then the prompt above\. If the tab's box has text in it, nothing is typed\./);
  assert.doesNotMatch(detail(v, cx), /Then type \/clear in the tab and paste\./);
  assert.ok(byId(paintWith(v, cx), "fin-copy"), "Copy prompt stays beside it");
  // each condition off in turn: a missing one hides the button and keeps the step-1 line
  const off = async (name, v2, cx2 = cx, hasPrompt = true) => {
    const el = paintWith(v2, cx2);
    assert.equal(byId(el, "fin-reenter"), null, `${name}: no button`);
    if (hasPrompt) assert.match(textOf(byId(el, "finished-detail")), /Then type \/clear in the tab and paste\./, `${name}: the step-1 line stays`);
  };
  // the clipboard is checked at the click, as Copy does: the button shows, a click without one types nothing
  const bare = fakeCx();
  byId(paintWith(v, bare), "fin-reenter")._h.on_click({}, bare); await Promise.all(bare.tasks);
  assert.equal(v.calls.length, 0, "no clipboard: nothing typed");
  assert.match(log.notify.at(-1).title, /no clipboard here/);
  assert.equal(reentering.has("t4"), false);
  assert.equal(reenterRuns.has("t4"), false);
  v = await reenterView(doneLine("sent"), { prompt: null });
  await off("no prompt", v, cx, false);
  v = await reenterView(doneLine("sent"), { seen: { agent: "codex", path: "/logs/t4.jsonl" } });
  await off("another agent", v);
  v = await reenterView(doneLine("sent"), { seen: { agent: "claude", path: null } });
  await off("no log path", v);
  v = await reenterView(doneLine("sent"));
  v.hasCommand = async () => false;
  await v.askHelper(fakeCx());
  assert.equal(v.canReenter, false);
  await off("helper without reenter", v);
  v.hasCommand = async () => true;
  await v.askHelper(fakeCx());
  assert.ok(byId(paintWith(v, cx), "fin-reenter"), "a helper with it: on again");
  v.canReenter = null;
  await off("not asked yet", v);
});

test("finished screen: a failed ask for the helper's commands is asked again after RETRY_MS", async () => {
  finishedSetup(["t4"]);
  const boot = fakeCx(); const v = new FinishedView(boot); await boot.settle();
  let asks = 0; v.hasCommand = async () => { asks++; return asks > 1; };
  v.reader = async () => ({ prompt: "P4.", file: null, seen: SEEN, problem: null });
  await load(v); assert.equal(asks, 0, "not asked again at once");
  v.askedAt -= RETRY_MS;
  await load(v); await load(v);
  assert.equal(asks, 1);
  assert.equal(v.canReenter, false);
  v.askedAt -= RETRY_MS;
  await load(v);
  assert.equal(v.canReenter, true, "the second ask got it");
  v.askedAt -= RETRY_MS; await load(v);
  assert.equal(asks, 2, "a helper that has it is not asked again");
});

test("finished screen: click_with_a_changed_prompt_types_nothing", async () => {
  const cx = clipCx();
  const v = await reenterView(doneLine("sent"));
  paintWith(v, cx);
  // the reply changed between the render and the click: a new prompt (or, below, another log)
  v.reader = async () => ({ prompt: "P4 NEWER.", file: null, seen: SEEN, problem: null });
  await press(v, cx);
  assert.equal(v.calls.length, 0, "nothing typed");
  assert.match(log.notify.at(-1).title, /^The re-entry prompt changed\. Check it, then press again\.$/);
  assert.match(detail(v, cx), /P4 NEWER\./, "the screen shows the new read");
  assert.equal(reentering.has("t4"), false);
  assert.equal(reenterRuns.has("t4"), false, "no run left behind: the button works again");
  v.reader = async () => ({ prompt: "P4 NEWER.", file: null, seen: { agent: "claude", path: "/logs/other.jsonl" }, problem: null });
  await press(v, cx);
  assert.equal(v.calls.length, 0, "the same prompt in another conversation: nothing typed");
  v.reader = async () => ({ prompt: null, file: null, seen: { agent: null, path: null }, problem: "helper restarting" });
  await press(v, cx);
  assert.equal(v.calls.length, 0, "a read problem: nothing typed");
  // the screen now shows that other log's read; unchanged since the click → it goes, with that prompt and log
  const other = { agent: "claude", path: "/logs/other.jsonl" };
  v.reader = async () => ({ prompt: "P4 NEWER.", file: null, seen: other, problem: null });
  await press(v, cx);
  assert.equal(v.calls.length, 1, "unchanged: it goes (to the same prompt and log)");
  assert.deepEqual(v.calls[0], ["t4", "P4 NEWER.", other]);
});

test("finished screen: double_click_runs_once (the loser leaves the winner's run and lock alone)", async () => {
  const cx = clipCx();
  const v = await reenterView(doneLine("sent"));
  let release; const gate = new Promise((r) => { release = r; });
  const real = v.reader; v.reader = async (a) => { await gate; return real(a); };
  const el = paintWith(v, cx);
  const btn = byId(el, "fin-reenter");
  btn._h.on_click({}, cx);
  assert.equal(reentering.has("t4"), true, "the lock is set at the click, before any await");
  const id = reenterRuns.get("t4").id;
  btn._h.on_click({}, cx);
  assert.equal(reenterRuns.get("t4").id, id, "the second click changed nothing");
  assert.match(textOf(byId(paintWith(v, cx), "fin-reenter")), /Re-entering…/);
  release(); await Promise.all(cx.tasks);
  assert.equal(v.calls.length, 1, "one run");
  assert.equal(reentering.has("t4"), false, "the lock is released at the end");
  assert.equal(reenterRuns.get("t4").state, "done");
});

const TAIL = "The prompt is on your clipboard: open the tab and paste.";
const CHECK = "Check the tab shows a new conversation before pasting; if it does not, type /clear first.";
const NOANS = "No answer from the helper: the tab may have been cleared and the prompt may or may not have gone. Check the tab.";
test("finished screen: each_result_maps_to_its_note", async () => {
  const rows = [
    // [answer, expected note, prompt copied?]
    [doneLine("sent", { cleared: true }), "Re-entered: the new conversation has its prompt.", false],
    [doneLine("prompt_unconfirmed", { cleared: true }), "msg prompt_unconfirmed The prompt may already be in the tab. Check it before pasting.", true],
    [doneLine("cleared_not_sent", { cleared: true }), `msg cleared_not_sent ${TAIL}`, true],
    [doneLine("failed", { cleared: "maybe", keys: "maybe" }), `msg failed ${TAIL}`, true],
    [doneLine("clear_unknown", { cleared: "maybe", keys: "maybe" }), `msg clear_unknown ${CHECK}`, true],
    [doneLine("clear_unconfirmed", { cleared: "maybe", keys: "maybe" }), `msg clear_unconfirmed ${CHECK}`, true],
    [doneLine("changed", { keys: "none" }), "msg changed Nothing was typed.", false],
    [doneLine("tab_busy", { keys: "none" }), "msg tab_busy Nothing was typed.", false],
    [doneLine("no_time", { keys: "none", message: "Not enough time. Nothing was sent." }), "Not enough time. Nothing was sent.", false],
    [doneLine("busy", { keys: "none", message: "Another run holds this tab; nothing was typed." }), "Another run holds this tab; nothing was typed.", false],
    [errorLine("remote_helper_outdated", { keys: "none" }), "msg remote_helper_outdated Nothing was typed.", false],
    [errorLine("send_failed", { keys: "maybe" }), `msg send_failed ${TAIL}`, true],
    [doneLine("cleared_not_sent", { cleared: true, keys: undefined }), `msg cleared_not_sent ${TAIL}`, true],
  ];
  for (const [answer, note, copied] of rows) {
    reenterRuns.clear(); reentering.clear();
    const cx = clipCx();
    const v = await reenterView(answer);
    await press(v, cx);
    const label = JSON.stringify(answer.lines[0] ?? answer.error);
    assert.equal(textOf(byId(paintWith(v, cx), "fin-note")), note, label);
    assert.deepEqual(cx.clip, copied ? ["P4."] : [], `${label}: clipboard`);
    assert.equal(log.notify.at(-1).title, note, `${label}: toast says the same`);
    assert.equal(byId(paintWith(v, cx), "fin-copy-again"), null, `${label}: nothing to copy again`);
    assert.equal(reentering.has("t4"), false);
    assert.equal(reenterRuns.get("t4").state, "done");
    assert.match(detail(v, cx), /P4\./, `${label}: the prompt stays beside the result`);
  }
});

test("finished screen: no_answer_is_maybe_cleared (a throw, no line, an error without keys, a timeout)", async () => {
  const cases = [
    ["the call throws", () => { throw new Error("boom"); }],
    ["no done or error line", () => ({ lines: [{ type: "log" }], error: null })],
    ["error without keys", () => errorLine("bad_thing")],
    ["a helper killed by the 30 s timeout", () => ({ lines: [], error: { code: "sidecar", message: "The Flockbook sidecar did not answer: exit 137" } })],
    ["the end line missing but a done line came", () => ({ lines: [{ type: "done", result: "cleared_not_sent", message: "msg cleared_not_sent", cleared: true, keys: "yes" }], error: { code: "sidecar", message: "no end" } })],
  ];
  for (const [name, answer] of cases) {
    reenterRuns.clear(); reentering.clear();
    const cx = clipCx();
    const v = await reenterView(answer);
    await press(v, cx);
    const want = name.startsWith("the end line") ? `msg cleared_not_sent ${TAIL}` : `${NOANS} ${TAIL}`;
    assert.equal(textOf(byId(paintWith(v, cx), "fin-note")), want, name);
    assert.deepEqual(cx.clip, ["P4."], `${name}: the prompt is on the clipboard`);
    assert.equal(reentering.has("t4"), false, `${name}: the lock is released`);
  }
});

test("finished screen: none_errors_say_nothing_typed (an older helper on another machine)", async () => {
  const cx = clipCx();
  const v = await reenterView(errorLine("remote_helper_outdated", { keys: "none", message: "The Flockbook helper on box is older." }));
  await press(v, cx);
  assert.equal(textOf(byId(paintWith(v, cx), "fin-note")), "The Flockbook helper on box is older. Nothing was typed.");
  assert.deepEqual(cx.clip, [], "nothing was typed, so nothing to paste");
  assert.ok(byId(paintWith(v, cx), "fin-copy"), "Copy prompt stays for the owner");
});

test("finished screen: clipboard_throw_is_reported (Copy again copies the run's own prompt, not a re-read)", async () => {
  const cx = clipCx();
  let fail = true; cx.write_to_clipboard = (t) => { if (fail) throw new Error("no clipboard"); cx.clip.push(t); };
  const v = await reenterView(doneLine("cleared_not_sent", { cleared: true }));
  await press(v, cx);
  assert.equal(textOf(byId(paintWith(v, cx), "fin-note")), "msg cleared_not_sent Couldn't put the prompt on your clipboard: use Copy again.");
  assert.doesNotMatch(detail(v, cx), /open the tab and paste/);
  assert.equal(byId(paintWith(v, cx), "fin-reenter"), null, "no second Clear & re-enter on the stale pre-clear read");
  assert.ok(byId(paintWith(v, cx), "fin-copy"), "Copy prompt stays");
  // after /clear the chat shows the new conversation: a re-read would give another (or no) prompt
  v.reader = async () => { throw new Error("must not re-read"); };
  fail = false;
  const again = byId(paintWith(v, cx), "fin-copy-again");
  assert.ok(again, "a Copy again button");
  again._h.on_click({}, cx); await Promise.all(cx.tasks);
  assert.deepEqual(cx.clip, ["P4."], "the run's own prompt");
});

test("finished screen: after sent the run drops 5 s later and the pick moves to the next tab", async () => {
  const cx = clipCx();
  const v = await reenterView(doneLine("sent", { cleared: true }), { addrs: ["t4", "t6"] });
  v.read.set("t6", { prompt: "P6.", file: null, seen: { agent: "claude", path: "/logs/t6.jsonl" }, problem: null, at: Date.now() });
  paintWith(v, cx);
  await press(v, cx);
  const t = cx.timers.find((x) => x.once && x.ms === 5000);
  assert.ok(t, "a 5 s timer");
  assert.ok(reenterRuns.has("t4"));
  t.f(cx);
  assert.equal(reenterRuns.has("t4"), false, "its run is dropped");
  assert.equal(v.picked, "t6", "the next tab is picked");
  // a timer of a run that is no longer the tab's own does nothing
  reenterRuns.set("t4", { id: 999, state: "running", prompt: "P4." });
  t.f(cx);
  assert.equal(reenterRuns.get("t4").id, 999);
});

test("finished screen: running_tab_stays_listed_and_picked (A16: the tab leaves finished() mid-run)", async () => {
  const cx = clipCx();
  const v = await reenterView(doneLine("sent"), { addrs: ["t4", "t6"] });
  let release; const gate = new Promise((r) => { release = r; });
  v.reenterer = async () => { await gate; return doneLine("sent", { cleared: true }); };
  // t4 is the first row by default: the owner never clicked a row
  assert.equal(v.picked, null);
  byId(paintWith(v, cx), "fin-reenter")._h.on_click({}, cx);
  await new Promise((r) => setTimeout(r, 0));
  marks = { t6: true };   // the /clear took t4 off the list
  const reads = [];
  const real = v.reader; v.reader = async (a) => { reads.push(a); return real(a); };
  v.read.delete("t4");    // would be purged for a tab that left the list
  fake.shared["flockbook.handoff"] = marks;
  const tcx = fakeCx(); v.tick(tcx); await Promise.all(tcx.tasks);
  assert.equal(v.shown, "t4", "still the shown tab");
  assert.deepEqual(reads, [], "its read is not reloaded while the run is on");
  const el = paintWith(v, cx);
  assert.ok(byId(el, "fin-t4") && byId(el, "fin-t6"), "listed beside the others");
  assert.match(textOf(byId(el, "finished-list")), /Finished · 2/);
  assert.match(textOf(byId(el, "finished-detail")), /P4\./);
  assert.match(textOf(byId(el, "fin-reenter")), /Re-entering…/);
  release(); await Promise.all(cx.tasks);
  // done but not sent: stays listed until the owner picks another tab, which drops its result
  reenterRuns.get("t4").state = "done";
  assert.ok(byId(paintWith(v, cx), "fin-t4"));
  byId(paintWith(v, cx), "fin-t6")._h.on_click({}, cx);
  assert.equal(reenterRuns.has("t4"), false, "another pick drops the finished run");
  assert.equal(byId(paintWith(v, cx), "fin-t4"), null);
});

test("finished screen: pinned_tab_keeps_its_prompt_beside_its_result (A16: the view is rebuilt)", async () => {
  const cx = clipCx();
  const v = await reenterView(doneLine("cleared_not_sent", { cleared: true }), { addrs: ["t4", "t6"] });
  await press(v, cx);
  assert.ok(reenterRuns.get("t4"));
  marks = { t6: true };   // t4 left finished(); the screen is rebuilt (the layout re-created the view)
  const boot = fakeCx(); const v2 = new FinishedView(boot); await boot.settle();
  v2.canReenter = true;
  v2.reader = async (a) => (a === "t6" ? { prompt: "P6.", file: null, seen: SEEN, problem: null } : { prompt: null, file: null, seen: { agent: null, path: null }, problem: null });
  fake.shared["flockbook.handoff"] = marks;
  assert.equal(v2.picked, null, "the rebuilt view's owner has picked nothing");
  const tcx = fakeCx(); v2.tick(tcx); await Promise.all(tcx.tasks);
  const el = paintWith(v2, cx);
  assert.ok(byId(el, "fin-t4") && byId(el, "fin-t6"), "still listed");
  assert.match(textOf(byId(el, "finished-detail")), /P4\./, "its prompt (from the run record)");
  assert.equal(textOf(byId(el, "fin-note")), `msg cleared_not_sent ${TAIL}`, "its result");
  assert.equal(v2.shown, "t4");
  // a run that started in another view finishes: this view repaints at its next tick (and not when nothing changed)
  const run = reenterRuns.get("t4"); run.state = "running";
  const c1 = fakeCx(); v2.tick(c1);
  Object.assign(run, { state: "done", result: "failed" });
  const c2 = fakeCx(); v2.tick(c2);
  assert.ok(c2.notified > 0, "repainted when the run ended");
  const c3 = fakeCx(); v2.tick(c3);
  assert.equal(c3.notified, 0, "not repainted every tick");
});

test("sidecar.reenter: the helper gets the terminal, the log the screen showed, the cache and the exact prompt", async () => {
  const { reenter } = await import("../mods/flockbook/sidecar.js");
  let args = null;
  fake.exec = (_c, a) => { args = a; return { code: 0, stdout: "", stderr: "" }; };
  await reenter("t4", "Continue --home x.", { agent: "claude", path: "/logs/t4.jsonl" });
  assert.deepEqual(args, ["reenter", "--terminal", "t4", "--expect-path", "/logs/t4.jsonl", "--cache", "/home/test/.config/herdr-app/flockbook/cache.json", "--text", "Continue --home x.", "--home", "/home/test/.config/herdr-app"]);
});
