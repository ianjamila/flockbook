// Stay awake while agents work (owner 11-15 s36): which tabs count as work, when the hold is renewed and let go (a fake
// clock), the switch, the back-off after a failure, and a render that calls nothing. The helper is a fake exec.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset, theme } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space } from "./fixtures.mjs";
import { SideView } from "../mods/flockbook/side.js";
import { allTabs } from "../mods/flockbook/overview.js";
import { KEY_CONFIG } from "../mods/flockbook/config.js";
import { forgetCommands } from "../mods/flockbook/sidecar.js";
import { SETTINGS, SECTIONS } from "../mods/flockbook/settings.js";
import { classify, phrase, lineOf, isLocal, awakeTick, awakeBlock, setStayAwake, startAwake, KEY_AWAKE,
  AWAKE_MS, RENEW_MS, HOLD_SECS, GRACE_MS, BLOCKED_MAX_MS, BACKOFF_MS } from "../mods/flockbook/awake.js";

const NOW = new Date(2026, 10, 15, 14, 0).getTime();
const MIN = 60_000;
const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });
const answer = (cmd, lines) => ({ code: 0, stdout: [{ type: "header", protocol: 1, sidecar: "0.1.0", cmd }, ...lines, { type: "end", ok: true, ms: 1 }].map((l) => JSON.stringify(l)).join("\n"), stderr: "" });
const holding = (until = 0) => answer("awake", [{ type: "awake", state: "holding", for: HOLD_SECS, pid: 4242, until, replaced: false }]);
const fail = (code, message) => answer("awake", [{ type: "error", code, message }]);

// What the helper was asked, as "awake --for 180" / "awake --release" (the version question is "version").
const asked = () => log.exec.map(([, argv]) => argv.slice(0, argv.indexOf("--home")).join(" "));
const awakeCalls = () => asked().filter((a) => a.startsWith("awake"));

let helper;   // what `awake` answers; the version answer lists `commands`
let commands;
beforeEach(() => {
  reset();
  forgetCommands();
  fake.props = undefined;
  fake.machines = [{ name: null, layout: "ready" }];
  fake.shared[KEY_CONFIG] = { file: {} };
  commands = ["version", "usage", "awake"];
  helper = () => holding();
  fake.exec = (_p, argv) => (argv[0] === "version" ? answer("version", [{ type: "version", commands }]) : argv[0] === "awake" ? helper(argv) : { code: 127, stdout: "", stderr: "" });
  // One Mac tab working.
  setTabs([["a1", { status: "working" }]]);
});

// tabs: [[agentId, tab extra, agent extra?]] in one local space; the agent has the same status as its tab.
function setTabs(list, extraSpaces = []) {
  fake.spaces = [space("sp1", { name: "app", tabs: list.map(([id, t], i) => tab(`tb-${id}`, i + 1, t)) }), ...extraSpaces];
  fake.agents = list.map(([id, t, a]) => agent(id, t.status ?? "idle", { tab: `tb-${id}`, ...a }));
}

test("work: working, a finished turn with CI or a review behind it, and blocked under 3 h; idle and done are not", () => {
  setTabs([
    ["w", { status: "working" }],
    ["ci", { status: "done" }, { title: "⏳ PR #9" }],
    ["rv", { status: "done" }, { title: "🔍 round 2" }],
    ["bg", { status: "done" }, { title: "🛠 build" }],
    ["bl", { status: "blocked", changed_at: NOW - 10 * MIN }],
    ["old", { status: "blocked", changed_at: NOW - BLOCKED_MAX_MS - MIN }],
    ["id", { status: "idle" }],
    ["dn", { status: "done" }],
  ]);
  const w = classify(allTabs(), NOW);
  assert.deepEqual({ working: w.working, ci: w.ci, review: w.review, other: w.other, waiting: w.waiting, total: w.total }, { working: 1, ci: 1, review: 1, other: 0, waiting: 1, total: 4 });
  // The 🛠 on a finished turn with no build agent running is only a leftover mark: not work (the Overview says the same).
  assert.equal(classify(allTabs().filter((i) => i.tab.id === "tb-bg"), NOW).total, 0);
});

test("blocked: the 3 hours count from the tab's changed_at, else from when it was first seen", () => {
  setTabs([["b", { status: "blocked" }]]);
  const first = classify(allTabs(), NOW);
  assert.equal(first.waiting, 1);
  assert.deepEqual(first.seen, { "tb-b": NOW });
  assert.equal(classify(allTabs(), NOW + BLOCKED_MAX_MS - MIN, { seen: first.seen }).waiting, 1);
  assert.equal(classify(allTabs(), NOW + BLOCKED_MAX_MS + MIN, { seen: first.seen }).waiting, 0, "past 3 h it may sleep");
  setTabs([["b", { status: "blocked", changed_at: NOW - 2 * 60 * MIN }]]);
  assert.equal(classify(allTabs(), NOW).waiting, 1);
  assert.equal(classify(allTabs(), NOW + 61 * MIN).waiting, 0);
});

test("only this computer's agents count; on Windows the WSL machine of claude_machine is this computer", () => {
  const far = space("sp2", { name: "far", machine: "build-box", tabs: [tab("tb-r1", 1, { status: "working" })] });
  const wsl = space("sp3", { name: "wsl", machine: "wsl", tabs: [tab("tb-s1", 1, { status: "working" })] });
  setTabs([["a1", { status: "working" }]], [far, wsl]);
  assert.equal(classify(allTabs(), NOW).working, 1, "a remote agent is ignored");
  assert.equal(classify(allTabs(), NOW, { windows: false, wsl: "wsl" }).working, 1, "off Windows a machine is another computer");
  assert.equal(classify(allTabs(), NOW, { windows: true, wsl: "wsl" }).working, 2, "the PC's own WSL terminals count");
  assert.equal(classify(allTabs(), NOW, { windows: true, wsl: null }).working, 1);
  assert.ok(isLocal({ machine: null }) && !isLocal({ machine: "wsl" }) && isLocal({ machine: "wsl" }, { windows: true, wsl: "wsl" }));
});

test("the words: counts merged, grace minutes, nothing to say, and the switch off", () => {
  assert.equal(phrase({ working: 3 }), "3 agents working");
  assert.equal(phrase({ working: 1, waiting: 1 }), "1 agent working · 1 waiting for you");
  assert.equal(phrase({ ci: 1, review: 1, other: 1 }), "CI running · review running · background work");
  assert.equal(lineOf({ work: { working: 3, total: 3 } }, true, NOW).text, "☕ Awake — 3 agents working");
  assert.equal(lineOf({ work: { waiting: 1, total: 1 } }, true, NOW).text, "☕ Awake — 1 waiting for you");
  assert.equal(lineOf({ work: { ci: 1, total: 1 } }, true, NOW).text, "☕ Awake — CI running");
  assert.equal(lineOf({ work: { total: 0 }, holding: true, lastWork: NOW - 3 * MIN - 1000 }, true, NOW).text, "☕ Awake — 12 min more");
  assert.deepEqual(lineOf({ work: { total: 0 }, holding: false }, true, NOW), { text: "Sleep allowed", kind: "idle" });
  assert.equal(lineOf({ phase: "unsupported" }, true, NOW), null);
  assert.equal(lineOf({ phase: "older" }, true, NOW), null);
  assert.equal(lineOf({ phase: "error", error: "no caffeinate" }, true, NOW).text, "Can't keep awake: no caffeinate");
  assert.equal(lineOf({ holding: true }, false, NOW).kind, "off");
});

test("renew every minute for 3 minutes while there is work; 15 minutes of grace; then released", async () => {
  await awakeTick(NOW);
  assert.deepEqual(awakeCalls(), [`awake --for ${HOLD_SECS}`]);
  assert.equal(HOLD_SECS, 180);
  assert.equal(RENEW_MS, 60_000);
  assert.equal(fake.shared[KEY_AWAKE].holding, true);
  // Ticks every 15 s: no call until a minute has passed.
  for (const s of [15, 30, 45]) await awakeTick(NOW + s * 1000);
  assert.equal(awakeCalls().length, 1, "no renewal inside the minute");
  await awakeTick(NOW + MIN);
  assert.equal(awakeCalls().length, 2, "renewed after a minute");
  // The work ends at +75 s: the hold goes on, renewed each minute, for 15 minutes after the last tick that saw work (+60 s).
  setTabs([["a1", { status: "done" }]]);
  await awakeTick(NOW + 75_000);
  assert.equal(awakeCalls().length, 2);
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW + 75_000).text, "☕ Awake — 15 min more");
  await awakeTick(NOW + 125_000);
  assert.equal(awakeCalls().length, 3, "still renewed in the grace");
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW + 125_000).text, "☕ Awake — 14 min more");
  await awakeTick(NOW + MIN + GRACE_MS - 15_000);
  assert.ok(!awakeCalls().includes("awake --release"), "not yet released");
  await awakeTick(NOW + MIN + GRACE_MS);
  assert.equal(awakeCalls().at(-1), "awake --release");
  assert.equal(fake.shared[KEY_AWAKE].holding, false);
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW + MIN + GRACE_MS).text, "Sleep allowed");
  // Nothing to do after that: no more calls.
  const n = awakeCalls().length;
  await awakeTick(NOW + MIN + GRACE_MS + AWAKE_MS);
  assert.equal(awakeCalls().length, n);
});

test("work coming back during the grace goes on holding; an idle computer never asks the helper", async () => {
  setTabs([["a1", { status: "idle" }]]);
  await awakeTick(NOW);
  assert.deepEqual(asked(), [], "no work: not even the version question");
  setTabs([["a1", { status: "working" }]]);
  await awakeTick(NOW + 15_000);
  assert.equal(awakeCalls().length, 1);
});

test("turning the switch off releases at once and stops asking; on again holds again", async () => {
  await awakeTick(NOW);
  assert.equal(fake.shared[KEY_AWAKE].holding, true);
  assert.equal(await setStayAwake("off"), true);
  assert.equal(fake.shared[KEY_CONFIG].file.stay_awake, "off");
  assert.equal(awakeCalls().at(-1), "awake --release");
  assert.equal(fake.shared[KEY_AWAKE].holding, false);
  const n = awakeCalls().length;
  await awakeTick(NOW + 5 * MIN);
  assert.equal(awakeCalls().length, n, "off: the helper is not asked");
  assert.equal(lineOf(fake.shared[KEY_AWAKE], false, NOW).text, "Stay awake: off");
  assert.equal(await setStayAwake("on"), true);
  assert.equal(awakeCalls().at(-1), `awake --for ${HOLD_SECS}`);
});

test("a failed call says why once and is not retried for 5 minutes", async () => {
  helper = () => fail("awake", "cannot start caffeinate: not allowed");
  await awakeTick(NOW);
  assert.equal(awakeCalls().length, 1);
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW).text, "Can't keep awake: cannot start caffeinate: not allowed");
  for (let s = 15; s < BACKOFF_MS / 1000; s += 15) await awakeTick(NOW + s * 1000);
  assert.equal(awakeCalls().length, 1, "no retry storm");
  await awakeTick(NOW + BACKOFF_MS);
  assert.equal(awakeCalls().length, 2, "asked again after the back-off");
  helper = () => holding();
  await awakeTick(NOW + 2 * BACKOFF_MS);
  assert.equal(fake.shared[KEY_AWAKE].phase, "ok");
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW + 2 * BACKOFF_MS).text, "☕ Awake — 1 agent working");
});

test("an older helper without awake, and a computer that cannot, are quiet", async () => {
  commands = ["version", "usage"];
  await awakeTick(NOW);
  assert.deepEqual(awakeCalls(), [], "no `awake` call to a helper that lacks it");
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW), null);
  // Asked about again after the back-off (the helper may have been updated).
  commands = ["version", "usage", "awake"];
  await awakeTick(NOW + BACKOFF_MS);
  assert.equal(awakeCalls().length, 1);
  // Unsupported: the helper answers, the mod shows nothing and does not ask again for the back-off.
  helper = () => answer("awake", [{ type: "awake", state: "unsupported", reason: "x" }]);
  await awakeTick(NOW + 2 * BACKOFF_MS);
  assert.equal(awakeCalls().length, 2);
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW + 2 * BACKOFF_MS), null);
  await awakeTick(NOW + 2 * BACKOFF_MS + MIN);
  assert.equal(awakeCalls().length, 2);
});

test("a missing helper is quiet too", async () => {
  fake.exec = () => ({ code: 127, stdout: "", stderr: "" });
  await awakeTick(NOW);
  assert.equal(lineOf(fake.shared[KEY_AWAKE], true, NOW), null);
});

test("render makes no host calls: it reads the one shared key", () => {
  fake.shared[KEY_AWAKE] = { work: { working: 2, total: 2 }, holding: true, lastWork: NOW };
  const hostExec = log.exec.length;
  // Reading Herdr's lists would throw here: the line must not.
  Object.defineProperty(fake, "spaces", { get() { throw new Error("render asked Herdr for the spaces"); }, configurable: true });
  Object.defineProperty(fake, "agents", { get() { throw new Error("render asked Herdr for the agents"); }, configurable: true });
  try {
    const el = awakeBlock(theme(), NOW);
    assert.match(textOf(byId(el, "awake-text")), /^☕ Awake — 2 agents working$/);
  } finally {
    delete fake.spaces; delete fake.agents;
    fake.spaces = []; fake.agents = [];
  }
  assert.equal(log.exec.length, hostExec);
});

test("the line sits in the side bar above the bottom rows and a click turns the switch", async () => {
  fake.shared[KEY_AWAKE] = { work: { working: 1, total: 1 }, holding: true, lastWork: Date.now() };
  const cx = fakeCx();
  const el = new SideView(cx).render(cx);
  const root = byId(el, "side-root");
  const ids = root.kids.map((k) => k?._a?.id);
  assert.ok(ids.indexOf("side-sessions") > 0 && ids.indexOf("side-sessions") - 1 >= 0);
  const line = byId(el, "awake");
  assert.ok(line, ids.join(","));
  assert.match(textOf(line), /Awake — 1 agent working/);
  assert.match(line._a.tooltip, /lid/);
  assert.equal(ids.at(-1), "usage", "the usage block is still the last thing");
  const c2 = fakeCx();
  line._h.on_click({}, c2);
  await c2.settle();
  assert.equal(fake.shared[KEY_CONFIG].file.stay_awake, "off");
  // Now off: the line says so and a click turns it on.
  const cx3 = fakeCx();
  const off = byId(new SideView(cx3).render(cx3), "awake");
  assert.match(textOf(off), /Stay awake: off/);
  const c4 = fakeCx();
  off._h.on_click({}, c4);
  await c4.settle();
  assert.equal(fake.shared[KEY_CONFIG].file.stay_awake, "on");
});

test("an older helper or an unsupported computer: no line in the side bar", () => {
  fake.shared[KEY_AWAKE] = { phase: "older" };
  const cx = fakeCx();
  assert.equal(byId(new SideView(cx).render(cx), "awake"), null);
});

test("the side bar redraws when the line's words change; the top bar ticks on a timer", () => {
  const cx = fakeCx();
  new SideView(cx);
  const t = cx.timers.find((x) => x.ms === AWAKE_MS);
  assert.ok(t, "a 15 s timer in the side bar");
  const top = fakeCx();
  startAwake(top);
  assert.ok(top.timers.some((x) => x.ms === AWAKE_MS) && top.timers.some((x) => x.once), "the tick runs on a timer");
});

test("a second copy's tick is skipped while one is under way", async () => {
  fake.shared["flockbook.awake.busy"] = NOW - 5_000;
  await awakeTick(NOW);
  assert.deepEqual(asked(), []);
  assert.equal(await awakeTick(NOW, { force: true }) !== undefined, true);
  assert.equal(awakeCalls().length, 1);
});

test("the setting is a switch in the settings dialog, default on, in one section", () => {
  const s = SETTINGS.find((x) => x.key === "stay_awake");
  assert.ok(s && s.title === "Keep this computer awake while agents work");
  assert.deepEqual(s.choices.map((c) => c[0]), ["on", "off"]);
  assert.equal(SECTIONS.filter((sec) => (sec.parts ?? []).some(([, keys]) => keys.includes("stay_awake"))).length, 1);
});
