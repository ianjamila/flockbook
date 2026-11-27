// Parked Claude tabs (owner 11-13: "flockbook is not working for this terminal"): a tab whose conversation went on
// in Claude Code's background service reports no status, so Herdr lists no agent there. parked.js puts it back from
// the helper's `parked` command. Pure parts + the tick against fakes. Run: node test-parked.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
let now = 1_800_000_000_000;
Date.now = () => now;

const program = (key, name) => ({ key, name, icon: null, tint: false, tile: null, color: null, shell: key === "shell", agent: key === "claude" });
const tab = (id, index, extra = {}) => ({ id, index, name: String(index), named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });
const space = (id, index, tabs, extra = {}) => ({ id, index, name: id, named: false, folder: "/w", machine: null, branch: null, active: false, status: null, tabs, ...extra });
const pane = (terminal, tabId, extra = {}) => ({ pane: `p-${terminal}`, terminal, tab: tabId, title: `title ${terminal}`, cwd: "/w", branch: null, status: null, app: null, program: program("claude", "Claude Code"), focused: false, zoomed: false, movable: false, ...extra });
const agent = (address, tabId, spaceId, status) => ({ address, pane: `p-${address}`, space: spaceId, space_name: spaceId, tab: tabId, tab_index: 1, tab_name: "1", status, app: "claude-code", program: program("claude", "Claude Code"), title: "", seq: 1, pinned: false, focused: false });

// Two spaces: sp1 has a working agent (t1, tab a) and a parked Claude (t2, tab b); sp2 a shell (t3) and a parked one (t4).
const world = () => ({
  spaces: [space("sp1", 1, [tab("a", 1, { status: "working" }), tab("b", 2)], { active: true, status: "working" }), space("sp2", 2, [tab("c", 1), tab("d", 2)])],
  agents: [agent("t1", "a", "sp1", "working")],
  panes: [pane("t1", "a", { status: "working", app: "claude-code" }), pane("t2", "b", { app: "claude-code" }), pane("t3", "c", { program: program("shell", "zsh") }), pane("t4", "d"), pane("box/t9", "d")],
  focused: { space: "sp1", tab: "a", pane: "p-t1", terminal: "t1", shown: null, agent: "t1", cwd: "/w" },
});
let w = world();
const st = fakeShared();
const calls = [];
let answer = { lines: [{ type: "parked", terminals: [{ terminal: "t2", job: "J2", session: "s2", status: "working", kind: null, name: "Parked work" }] }] };
let has = true;
const herdr = { ...st, agents: () => w.agents, spaces: () => w.spaces, panes: () => w.panes, focused: () => w.focused };
const sidecar = { call: async (cmd, args) => { calls.push([cmd, args]); return answer; }, hasCommand: async (n) => has && n === "parked" };
const p = await loadMod("parked.js", { herdr, "./sidecar.js": sidecar });

// candidates: Claude terminals reporting no status that Herdr doesn't list; never a shell, a listed agent or a remote one.
eq("candidates", p.candidates(w.panes, w.agents).map((x) => x.terminal), ["t2", "t4"]);
eq("a Claude pane that reports a status is no candidate", p.candidates([pane("t7", "a", { status: "idle" })], []), []);

// The tick asks the helper and keeps the answer.
await p.parkedTick();
eq("tick asked the helper once", calls.map((c) => c[0]), ["parked"]);
eq("kept", st.data["flockbook.parked"], { t2: { job: "J2", session: "s2", status: "working", kind: null, name: "Parked work", changed: now, finished: null, seen: null } });
eq("busy lock released", st.data["flockbook.parked.busy"], undefined);

// agents(): Herdr's plus the parked one, in space/tab/pane order, as an AgentInfo with `parked`.
const list = p.agents();
eq("agents in order", list.map((a) => [a.address, a.status]), [["t1", "working"], ["t2", "working"]]);
eq("parked agent fields", (({ space, space_name, tab, tab_index, app, title, parked }) => ({ space, space_name, tab, tab_index, app, title, parked }))(list[1]),
  { space: "sp1", space_name: "sp1", tab: "b", tab_index: 2, app: "claude-code", title: "title t2", parked: { job: "J2", session: "s2", name: "Parked work" } });

// spaces(): the parked tab gets its status, working since the status changed; the space rolls up (working).
const sp = p.spaces();
eq("tab b working", [sp[0].tabs[1].status, sp[0].tabs[1].working_since, sp[0].tabs[1].changed_at], ["working", now, now]);
eq("tab a untouched (same object)", sp[0].tabs[0] === w.spaces[0].tabs[0], true);
eq("sp2 untouched (same object)", sp[1] === w.spaces[1], true);

// Within TICK_MS the tick does nothing; after it, it asks again.
now += 1000; await p.parkedTick();
eq("no second call within the tick", calls.length, 1);

// The job finishes while the owner looks elsewhere: done (blocked > done > working > idle for the space).
now += 5000;
answer = { lines: [{ type: "parked", terminals: [{ terminal: "t2", job: "J2", session: "s2", status: "idle", kind: null, name: "Parked work" }] }] };
await p.parkedTick();
const finishedAt = now;
eq("done while unseen", p.agents()[1].status, "done");
eq("space rolls up to done", p.spaces()[0].status, "done");
eq("not working any more: working_since stays Herdr's (null)", p.spaces()[0].tabs[1].working_since, null);

// The owner opens tab b: the next tick marks it seen, and it shows idle.
w.focused = { ...w.focused, tab: "b", pane: "p-t2", terminal: "t2", agent: null };
now += 5000; await p.parkedTick();
eq("idle once seen", [p.agents()[1].status, st.data["flockbook.parked"].t2.finished, st.data["flockbook.parked"].t2.seen], ["idle", finishedAt, now]);

// Blocked (a question on its screen): blocked, ahead of everything in its space.
answer = { lines: [{ type: "parked", terminals: [{ terminal: "t2", job: "J2", session: "s2", status: "blocked", kind: "question", name: null }] }] };
now += 5000; await p.parkedTick();
eq("blocked", [p.agents()[1].status, p.spaces()[0].status, st.data["flockbook.parked"].t2.kind], ["blocked", "blocked", "question"]);

// Herdr reports the terminal again (it came back from the background): Herdr's agent wins, no duplicate.
w.agents = [...w.agents, agent("t2", "b", "sp1", "idle")];
w.panes = w.panes.map((x) => (x.terminal === "t2" ? { ...x, status: "idle" } : x));
eq("Herdr's own agent wins", p.agents().map((a) => [a.address, a.status, Boolean(a.parked)]), [["t1", "working", false], ["t2", "idle", false]]);

// A new job in the same terminal starts fresh (no old finish / seen carried over).
eq("merge: another job", p.merge({ t2: { job: "J2", status: "idle", changed: 1, finished: 2, seen: 3 } }, [{ terminal: "t2", job: "J5", status: "idle" }], 9, () => false).t2,
  { job: "J5", session: undefined, status: "idle", kind: null, name: null, changed: 9, finished: null, seen: null });

// No candidate any more: the tick drops what it kept, without asking the helper.
w = world(); w.panes = w.panes.filter((x) => x.terminal !== "t2" && x.terminal !== "t4");
const before = calls.length;
now += 5000; await p.parkedTick();
eq("cleared, helper not asked", [st.data["flockbook.parked"], calls.length], [{}, before]);
eq("no parked: Herdr's lists as they are", [p.agents() === w.agents, p.spaces() === w.spaces], [true, true]);

// An older helper without `parked`: never called.
w = world(); has = false;
const p2 = await loadMod("parked.js", { herdr: { ...fakeShared(), agents: () => w.agents, spaces: () => w.spaces, panes: () => w.panes, focused: () => w.focused }, "./sidecar.js": sidecar });
const c0 = calls.length;
await p2.parkedTick();
eq("older helper: not called", calls.length, c0);

// The chat finds the parked agent: state.js currentAgent() over parked.js (owner's screenshot: "No agent to show").
has = true; w = world(); w.focused = { ...w.focused, tab: "b", pane: "p-t2", terminal: "t2", agent: null };
w.spaces[0].tabs = w.spaces[0].tabs.map((t) => ({ ...t, active: t.id === "b" }));
const st3 = fakeShared({ "flockbook.parked": { t2: { job: "J2", session: "s2", status: "working", kind: null, name: null, changed: now, finished: null, seen: null } } });
const herdr3 = { ...st3, agents: () => w.agents, spaces: () => w.spaces, panes: () => w.panes, focused: () => w.focused };
const p3 = await loadMod("parked.js", { herdr: herdr3, "./sidecar.js": sidecar });
const state = await loadMod("state.js", { herdr: herdr3, "./parked.js": p3 });
eq("chat agent = the parked one", state.currentAgent()?.address, "t2");

// Order: a parked tab sits between Herdr's agents by space and tab (sp1 a, sp1 b parked, sp2 c), not at the end.
w.agents = [agent("t1", "a", "sp1", "working"), agent("t6", "c", "sp2", "idle")];
w.panes = [...w.panes, pane("t6", "c", { status: "idle", app: "claude-code" })];
eq("parked tab in space/tab order", p3.agents().map((a) => a.address), ["t1", "t2", "t6"]);

console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
