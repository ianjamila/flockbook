// C5 (owner 11-12 16:35): "Summarize this tab" keeps asking Haiku on open, but shows the free facts at once at the
// top — the About line with its age, Now/Last, the last steps, and whether it waits on the owner — while Haiku writes
// below. Run: node test-c5.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const MIN = 60_000, now = 1_800_000_000_000;
Date.now = () => now;
const st = fakeShared();
const agent = { address: "t1", tab: "tb1", status: "working", title: "Courier guide" };
let entry = { text: "Couriers read the guide offline (#1838).", wroteAt: now - 12 * MIN, wroteTitle: "Courier guide", account: "WORK" };
let nw = { now: "Running the tests", steps: ["Running the tests", "Edited the guide page", "Read the plan"], helpers: [] };
let need = null, ask = null;
let asked = 0;
const fakes = {
  herdr: { ...st, props: () => ({ address: "t1" }), agents: () => [agent], theme: () => ({}) },
  "./state.js": { agentName: () => "Courier guide", icon: () => "", sessionTopic: (a) => a.title, needReason: () => need },
  "./asks.js": { nowOf: () => nw, askOf: () => ask, askLine: (k) => k.line, elicitOf: () => null },
  "./ai.js": { aboutEntry: () => entry, isStale: (e, t) => e.wroteTitle !== t, agoText: (at, n) => `${Math.round((n - at) / MIN)} min ago`, accountName: () => "Work account (WORK)",
    askHaiku: async () => { asked++; return { text: "About: x" }; }, screenOf: async () => "s", aiInput: () => "", sendAccount: () => "WORK", SUMMARY_SYSTEM: "" },
};
const sum = await loadMod("summary.js", fakes);
const v = new sum.SummaryView({ spawn: (fn) => fn({ notify() {} }) });
await new Promise((r) => setTimeout(r, 0));
eq("C5: still asks Haiku on open", asked, 1);
eq("C5: free facts", v.freeInfo(), [
  { label: "About", text: "Couriers read the guide offline (#1838). (auto-written 12 min ago · Work account (WORK))" },
  { label: "Now", text: "Running the tests" },
  { label: "Last steps", text: ["Edited the guide page", "Read the plan"] },
  { label: "Needs you", text: "Nothing right now." },
]);
agent.status = "done"; agent.title = "Courier guide v2"; need = "merge"; ask = { line: "ready to merge · #1838" }; nw = { now: "Opened PR #1838", steps: [], helpers: [] };
eq("C5: stale About, Last, waits on the owner", v.freeInfo(), [
  { label: "About", text: "Couriers read the guide offline (#1838). (auto-written 12 min ago · Work account (WORK) · may be out of date)" },
  { label: "Last", text: "Opened PR #1838" },
  { label: "Needs you", text: "ready to merge · #1838." },
]);
entry = null; nw = null; need = "question"; ask = null;
eq("C5: nothing stored yet", v.freeInfo(), [{ label: "Needs you", text: "It waits for your answer or approval." }]);
process.exit(bad ? 1 : 0);
