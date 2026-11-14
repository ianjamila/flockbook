// parked.js withSnapshot (11-14 s33, "overview is not working"): inside one render Herdr's agent and space lists are
// read once, however often agents()/spaces() are asked; each caller gets its own copy; a nested snapshot reuses the
// outer one; the snapshot ends with the render, also after a throw. Run: node test-snapshot.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const tab = (id, index) => ({ id, index, name: String(index), status: null });
let w = {
  spaces: [{ id: "sp1", index: 1, name: "app", active: true, status: null, tabs: [tab("a", 1), tab("b", 2)] }],
  agents: [{ address: "t1", pane: "p-t1", space: "sp1", tab: "a", status: "working" }],
};
const reads = { agents: 0, spaces: 0 };
const herdr = { ...fakeShared(), agents: () => { reads.agents++; return w.agents; }, spaces: () => { reads.spaces++; return w.spaces; }, panes: () => [], focused: () => null };
const p = await loadMod("parked.js", { herdr, "./sidecar.js": { call: async () => null, hasCommand: async () => false } });
const zero = () => { reads.agents = reads.spaces = 0; };

// Outside a snapshot every call reads Herdr (as before).
zero(); p.agents(); p.agents(); p.spaces();
eq("outside: each call reads Herdr", [reads.agents, reads.spaces], [3, 3]);

// Inside: read once each, however often asked.
zero();
const got = p.withSnapshot(() => { for (let i = 0; i < 50; i++) { p.agents(); p.spaces(); } return "done"; });
eq("inside: withSnapshot returns fn's value", got, "done");
eq("inside: 100 calls, Herdr read at most twice each", [reads.agents <= 2, reads.spaces <= 2, reads.agents >= 1, reads.spaces >= 1], [true, true, true, true]);

// Each call gets its own array: an in-place sort or push by one caller can't leak to the next.
p.withSnapshot(() => {
  const one = p.agents(), two = p.agents();
  one.push({ address: "junk" });
  const s1 = p.spaces(); s1.reverse(); s1.push("junk");
  eq("copies: a caller's change doesn't reach the next caller", [one === two, two.length, p.agents().length, p.spaces().length], [false, 1, 1, 1]);
});

// Nested: the inner snapshot reuses the outer one (no second read) and doesn't end it.
zero();
p.withSnapshot(() => {
  p.agents();
  p.withSnapshot(() => { p.agents(); p.spaces(); });
  p.agents(); p.spaces();
});
eq("nested: still at most two reads each", [reads.agents <= 2, reads.spaces <= 2], [true, true]);
const before = reads.agents;
p.withSnapshot(() => { p.withSnapshot(() => p.agents()); w = { ...w, agents: [...w.agents, { address: "t2", pane: "p-t2", space: "sp1", tab: "b", status: "idle" }] }; eq("nested: after the inner one ends the outer snapshot still holds", p.agents().length, 1); });
eq("nested: the outer snapshot read once", reads.agents - before, 1);

// The snapshot ends with the render: the next render sees Herdr's new list.
eq("after: a new render reads the new list", p.withSnapshot(() => p.agents().length), 2);

// A throw inside still ends the snapshot.
let threw = false;
try { p.withSnapshot(() => { p.agents(); throw new Error("boom"); }); } catch (e) { threw = e.message === "boom"; }
w = { ...w, agents: w.agents.slice(0, 1) };
zero();
eq("throw: passed on, and the snapshot ended (fresh read after)", [threw, p.agents().length, reads.agents], [true, 1, 1]);
eq("throw: a later render reads again", p.withSnapshot(() => p.agents().length), 1);

console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
