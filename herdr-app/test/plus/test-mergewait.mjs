// A finished turn that waits on a merge (owner 11-12 22:15, two tabs: "why is this done" — "its still merging"):
// the owner said "merge", the session started the merge watch in the background and ended its turn. asks.js
// backgroundWork's `merge`, state.js keeping such a tab working under "Merging" (not Done), history's "merging".
// Run: node test-mergewait.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const st = fakeShared();
const asks = await loadMod("asks.js", { herdr: { ...st, agents: () => [], home: () => "/Users/you", appHome: () => "/x" } });
const { backgroundWork } = asks;
const R = "─".repeat(60);
const foot = (extra = "") => `${R}\n❯ \n${R}\n  you:\\~/x | WORK e@x | p\n  Opus 5.5\n  ⏵⏵ auto mode on${extra}`;

// The two real replies (generic wording kept).
const q1 = `⏺ PR #1922 is going into GitHub's merge queue now, behind #1916. Both merge once the queue's checks\n  pass. I'll confirm both merges and then remove the two worktrees.\n\n${foot(" · 1 shell")}`;
const q2 = `⏺ #1891's folder holds a local-only settings file. I'll ask about both folders together once #1899 merges.\n\n${foot(" · 1 shell")}`;
eq("merge queue reply + shell: merge", backgroundWork(q1), { shells: 1, agents: 0, merge: true });
eq("'once #N merges' + shell: merge", backgroundWork(q2), { shells: 1, agents: 0, merge: true });
eq("merge job still running (t1f 22:16)", backgroundWork(`⏺ The #1922 merge job is still running its pre-queue checks. Its background wait will report when it finishes.\n\n${foot(" · 1 shell")}`)?.merge, true);
eq("following through the queue", backgroundWork(`⏺ #1891 is merged. Now following #1899 through the queue.\n\n${foot(" · 1 shell")}`)?.merge, true);
eq("merge wait without a shell: nothing", backgroundWork(`⏺ PR #3 is in the merge queue now.\n\n${foot()}`), null);
eq("merged, shell left: no merge wait", backgroundWork(`⏺ #3 is merged and the worktree is removed.\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0 });
eq("a merge ask is not a merge wait", backgroundWork(`⏺ Head abc · items none · repo o/r\n  🔀 Ready to merge #3 — say "merge"\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0 });
eq("CI wins over merge when both", backgroundWork(`⏺ Waiting for CI on #3; it joins the merge queue after.\n\n${foot(" · 1 shell")}`)?.ci, true);

// state.js
const tab = { id: "tb1", status: "done" };
let agent = { address: "t5", tab: "tb1", status: "done", title: "🔀 Webshop checkout, PR #1916" };
let bg = { shells: 1, agents: 0 }, ask = null, pr = null, handoff = false;
const state = await loadMod("state.js", {
  herdr: { ...st, agents: () => [agent], panes: () => [], spaces: () => [], focused: () => null, appHome: () => "/x" },
  "./asks.js": { askOf: () => ask, prOf: () => pr, bgOf: () => bg, bgWords: asks.bgWords, askMark: (k) => (k?.kind === "merge" ? { glyph: "🔀", group: "merge", word: "ready to merge", tip: "x" } : null), handoffOf: () => handoff },
});
let ss = state.subStatus(tab);
eq("🔀 after 'merge' + a shell: Merging", ss?.key, "merging");
eq("🔀 after 'merge' + a shell: working", [ss?.background, state.tabStatus(tab)], [true, "working"]);
eq("🔀 merging: no hand-off flag while it runs", /🤝/.test(ss?.glyphs ?? ""), false);
handoff = true;
ss = state.subStatus(tab);
eq("🔀 + a shell after a HAND-OFF: leftover, Done (owner 16:45)", [ss?.key, ss?.background, state.tabStatus(tab)], ["handoff", false, "done"]);
handoff = false; bg = null;
ss = state.subStatus(tab);
eq("🔀 after 'merge', nothing running: Done", [ss?.key, ss?.background, state.tabStatus(tab)], ["merging", false, "done"]);
bg = { shells: 1, agents: 0 }; pr = { pr: 1916, state: "MERGED" };
ss = state.subStatus(tab);
eq("🔀 + shell but GitHub says merged: merged, not working", [ss?.key, ss?.background], ["merged", false]);
pr = null; ask = { kind: "merge" };
ss = state.subStatus(tab);
eq("still asking for 'merge' + a shell: Ready to merge, owner's", [ss?.key, ss?.owner, ss?.background], ["merge", true, false]);
ask = null; agent = { ...agent, title: "Webshop checkout" }; bg = { shells: 1, agents: 0, merge: true };
ss = state.subStatus(tab);
eq("no 🔀 in the title, reply says merge queue: Merging, working", [ss?.key, ss?.background, state.tabStatus(tab)], ["merging", true, "working"]);
pr = { pr: 1916, state: "MERGED" };
ss = state.subStatus(tab);
eq("reply says merge queue but PR merged: not working", ss?.background, false);
pr = null; handoff = true;
eq("reply says merge queue after a hand-off: not working", state.subStatus(tab)?.background, false);
handoff = false;

// history.js: a merge wait is its own state, not "finished".
const h = await loadMod("history.js", {
  herdr: { ...st, agents: () => [], terminals: () => [] },
  "./state.js": { agentName: () => "x", needReason: () => null, overlays: () => [] },
  "./asks.js": { askOf: () => null, askLine: () => "", bgOf: () => null, handoffOf: () => false, prOf: () => null },
  "./ai.js": { aboutOf: () => null, accountFor: () => null, accountName: () => null, clockText: () => "", localOffset: () => 0 },
});
eq("history: merging state", h.snapOf({ status: "done", merging: true }).state, "merging");
const s = (o) => ({ label: "x", account: null, ask: null, about: null, pr: null, handoff: false, ...o });
eq("history: → merging event", h.diffSnap(s({ state: "working" }), s({ state: "merging" })).map((e) => e.text), ["merging (the PR is in the merge queue)"]);
process.exit(bad ? 1 : 0);
