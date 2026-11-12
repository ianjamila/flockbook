// Tests for a finished turn that waits on CI (owner 11-12 16:49: "this terminal is waiting for CI but was already put
// as Done in the overview"): asks.js ciWaiting + backgroundWork's `ci`, and state.js putting such a tab under
// "Waiting on CI" (working), not Done. Run: node test-ciwait.mjs
import { FIXDIR } from "./paths.mjs";
import fs from "node:fs";
import { loadMod, fakeShared } from "./loadmod.mjs";
const FIX = FIXDIR;
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const st = fakeShared();
const asks = await loadMod("asks.js", { herdr: { ...st, agents: () => [], home: () => "/Users/you", appHome: () => "/x" } });
const { ciWaiting, backgroundWork } = asks;
const R = "─".repeat(60);
const foot = (extra = "") => `${R}\n❯ \n${R}\n  you:\\~/x | WORK e@x | p\n  Opus 5.5\n  ⏵⏵ auto mode on${extra}`;

// The real screen (t24, PR #316): "CI on PR #316 is still running", 1 shell.
const real = fs.readFileSync(FIX + "ci-wait-t24.txt", "utf8");
eq("real: waiting on CI", ciWaiting(real), true);
eq("real: backgroundWork carries ci", backgroundWork(real), { shells: 1, agents: 0, ci: true });
eq("waiting for CI + shell", ciWaiting(`⏺ Waiting for CI on PR #316, including its Windows run.\n\n✻ Churned · done 4:42 PM · 1 shell still running\n\n${foot(" · 1 shell")}`), true);
eq("CI still in progress", ciWaiting(`⏺ CI is in progress on #12; I'll report when it ends.\n\n${foot(" · 1 shell")}`), true);
eq("no shell running: not waiting", ciWaiting(`⏺ Waiting for CI on PR #316.\n\n${foot()}`), false);
eq("shell but no CI words: not waiting", ciWaiting(`⏺ Fixed the bug; tests pass.\n\n${foot(" · 1 shell")}`), false);
eq("CI passed: not waiting", ciWaiting(`⏺ CI passed on #316. Ready to merge.\n\n${foot(" · 1 shell")}`), false);
eq("an older turn's CI wait above a newer prompt does not count", ciWaiting(`⏺ Waiting for CI on #1.\n❯ do something else\n\n⏺ Done, nothing else.\n\n${foot(" · 1 shell")}`), false);
eq("background command line is not the reply", ciWaiting(`⏺ Background command "Wait for CI on PR 316" completed (exit code 0)\n\n⏺ All green; merged.\n\n${foot(" · 1 shell")}`), false);
eq("no input box", ciWaiting("⏺ Waiting for CI"), false);
// s13 Codex R1 P2: the CI words in a later paragraph of the same final reply.
eq("CI wait in the reply's 2nd paragraph", ciWaiting(`⏺ Changes are committed and pushed.\n\n  Waiting for CI on PR #320 now.\n\n${foot(" · 1 shell")}`), true);
eq("2nd paragraph, wrapped", ciWaiting(`⏺ Pushed the fix.\n\n  Next I'm waiting for CI on PR #320,\n  then I'll report.\n\n${foot(" · 1 shell")}`), true);
eq("a tool's output below the reply is not the reply", ciWaiting(`⏺ Fixed it.\n\n⏺ Bash(gh pr checks 320)\n  ⎿  waiting for CI to finish\n\n${foot(" · 1 shell")}`), false);
eq("plain shell: ci absent", backgroundWork(`⏺ Started the dev server.\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0 });

// Owner 11-12 s14 ("this is waiting on codex recheck not me"): a finished turn whose shell runs a Codex review.
const t1h = `⏺ The live resume poll is running (last ran 28 s ago, 11 sessions remembered) and its lock is free. Waiting\n  on the Codex recheck.\n\n✻ Worked for 11m 21s · 1 shell still running\n\n${foot(" · 1 shell")}`;
eq("Codex recheck wait (t1h): review", backgroundWork(t1h), { shells: 1, agents: 0, review: true });
eq("Codex review running in the background: review", backgroundWork(`⏺ The Codex review is running in the background (effort high). I'll read its report when it finishes.\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0, review: true });
eq("Codex review still running: review", backgroundWork(`⏺ The Codex review is still running (effort high).\n\n${foot(" · 1 shell")}`)?.review, true);
eq("Codex findings reported, shell left: no review wait", backgroundWork(`⏺ Codex found 7 issues; all fixed and tested.\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0 });
eq("Codex wait without a shell: nothing", backgroundWork(`⏺ Waiting on the Codex recheck.\n\n${foot()}`), null);
eq("CI wins over review when both", backgroundWork(`⏺ Waiting for CI on #3; the Codex review is still running too.\n\n${foot(" · 1 shell")}`), { shells: 1, agents: 0, ci: true });

// state.js: a ✅ tab (results) whose turn ended waiting on CI sits under "Waiting on CI" and counts as working.
const tab = { id: "tb1", status: "done" };
const agent = { address: "t24", tab: "tb1", status: "done", title: "✅ Claude-pipeline PR #299 follow-ups" };
let bg = { shells: 1, agents: 0, ci: true };
const state = await loadMod("state.js", {
  herdr: { ...st, agents: () => [agent], panes: () => [], spaces: () => [], focused: () => null, appHome: () => "/x" },
  "./asks.js": { askOf: () => null, prOf: () => null, bgOf: () => bg, bgWords: asks.bgWords, askMark: () => null, handoffOf: () => true },
});
const ss = state.subStatus(tab);
eq("CI wait: sub-group", ss?.key, "ci");
eq("CI wait: counts as working", ss?.background, true);
eq("CI wait: tab mark working", state.tabStatus(tab), "working");
eq("CI wait: hint names it", /⏳ waiting on CI/.test(ss?.hint ?? ""), true);
eq("CI wait: no hand-off flag while CI runs", /🤝/.test(ss?.glyphs ?? ""), false);
bg = { shells: 1, agents: 0, review: true };
const sr = state.subStatus(tab);
eq("review wait: sub-group Waiting on a review", sr?.key, "reviewwait");
eq("review wait: counts as working", [sr?.background, state.tabStatus(tab)], [true, "working"]);
eq("review wait: hint names it", /🔍 waiting on a review/.test(sr?.hint ?? ""), true);
eq("review wait: no hand-off flag", /🤝/.test(sr?.glyphs ?? ""), false);
bg = { shells: 1, agents: 0 };
const s2 = state.subStatus(tab);
eq("leftover shell only: goes by status (hand-off allowed with shells)", [s2?.key, s2?.background, state.tabStatus(tab)], ["handoff", false, "done"]);
process.exit(bad ? 1 : 0);
