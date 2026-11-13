// Tests for asks.js pendingAsk (the extra-round / merge asks on a session's screen). Run: node test-asks.mjs [real-screen.txt]
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "asks.js", "utf8");
const a = src.indexOf("const RULE"), b = src.indexOf("const CHECK_MS");
const shared = () => null;
const { pendingAsk, mergedHint, backgroundWork, newQuestions, keepLog } = new Function("shared", src.slice(a, b).replaceAll("export ", "") + "; return { pendingAsk, mergedHint, backgroundWork, newQuestions, keepLog };")(shared);
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)}`); };
const R = "─".repeat(60), stat = "  you:\\~ | HOME x\n  Opus 5.5";
const box = (typed = "") => `${R}\n❯ ${typed}\n${R}\n${stat}`;
const ROUND = "  🔁 Extra review round needed #1803: round 6 · head f43aed1c10ce · repo acme/webshop";
eq("round ask, idle", pendingAsk(`  - text\n\n${ROUND}\n\n${box()}`), { kind: "round", pr: 1803, round: 6 });
eq("round ask under a status line", pendingAsk(`${ROUND}\n\n✻ Waiting for 1 background agent to finish\n\n${box()}`), { kind: "round", pr: 1803, round: 6 });
eq("typed but not sent still pending", pendingAsk(`${ROUND}\n\n${box("extra round")}`), { kind: "round", pr: 1803, round: 6 });
eq("wrapped line", pendingAsk(`  🔁 Extra review round needed #1803: round 6 · head f43aed1c10ce · repo acme\n  /webshop\n\n${box()}`), { kind: "round", pr: 1803, round: 6 });
eq("answered: prompt after it", pendingAsk(`${ROUND}\n\n❯ extra round\n\n⏺ Running round 6…\n\n${box()}`), null);
eq("new output after it", pendingAsk(`${ROUND}\n\n⏺ Bash(ls)\n  ⎿ done\n\n${box()}`), null);
eq("merge hand-off", pendingAsk(`  Head abc · items none · repo o/r\n  🔀 Ready to merge #1818 — say "merge"\n\n${box()}`), { kind: "merge", pr: 1818 });
eq("several PRs to merge", pendingAsk(`  🔀 Ready to merge #1318, #1319 — say "merge"\n\n${box()}`), { kind: "merge", pr: 1318, prs: [1318, 1319] });   // s9: keeps every PR
eq("mentioned mid-reply only", pendingAsk(`${ROUND}\n  and then more words after it.\n\n${box()}`), null);
eq("no input box", pendingAsk(`${ROUND}`), null);
const GO = `  The only thing left is the live database change.\n\n  Next step: reply "go migration 1818". I'll do the practice run, apply the change to the live database,\n  confirm it took effect with one harmless test call, then show you the merge request lines.`;
eq("go migration in the last paragraph", pendingAsk(`${GO}\n\n${box()}`), { kind: "migration", pr: 1818 });
eq("go migration under a status line", pendingAsk(`${GO}\n\n✻ Waiting for 1 background agent to finish\n\n${box()}`), { kind: "migration", pr: 1818 });
eq("curly quotes, 'go for the N migration'", pendingAsk(`  Still waiting for you to type “go for the 1790 migration”.\n\n${box()}`), { kind: "migration", pr: 1790 });
eq("go migration in an earlier paragraph only", pendingAsk(`  - #1790: still waiting for you to type "go for the 1790 migration".\n\n  All other checks are green.\n\n${box()}`), null);
eq("notice line under the reply (t1d 17:16)", pendingAsk(`${GO}\n✻ Crunched for 22s · done 4:54 PM\nContext past 200K: plan a hand-off at the next checkpoint                     [-]\n${box("go migration 1818")}`), { kind: "migration", pr: 1818 });
eq("one-line reply starting with ⏺", pendingAsk(`⏺ 🔁 Extra review round needed #1803: round 6 · head f43aed1c10ce · repo o/r\n\n${box()}`), { kind: "round", pr: 1803, round: 6 });
eq("agent-finished notice under the reply (t1t 17:34)", pendingAsk(`  Head 078ee2a79a5b · items de7139ccdc66 · repo o/r\n  🔀 Ready to merge #1790 — say "merge"\n\n✻ Waiting for 1 background agent to finish\n\n⏺ Agent "Opus pre-round check #1803 R6" finished · 1m 36s\n\n${box()}`), { kind: "merge", pr: 1790 });
eq("a real reply after the ask still ends it", pendingAsk(`  🔀 Ready to merge #1790 — say "merge"\n\n⏺ The Agent check finished cleanly, so here is more.\n\n${box()}`), null);
eq("go migration answered", pendingAsk(`${GO}\n\n❯ go migration 1818\n\n⏺ Running the practice run…\n\n${box()}`), null);
eq("round line wins over a go in the paragraph above", pendingAsk(`  reply "go migration 1818" later.\n${ROUND}\n\n${box()}`), { kind: "round", pr: 1803, round: 6 });
eq("empty", pendingAsk(""), null);

// Any other answer the reply asks for (the last paragraph of a reply).
const SAYP = `  Should I run both scheduled jobs from this branch now?\n\n  - Why: it proves the new steps work.\n\n  Say "OK, run both" to approve. Or say "watchdog only", and I'll run just the read-only watchdog\n  now and the backup by hand right after the merge.`;
eq("say \"…\" or say \"…\"", pendingAsk(`${SAYP}\n\n${box()}`), { kind: "reply", words: ["OK, run both", "watchdog only"], text: `Say "OK, run both" to approve. Or say "watchdog only", and I'll run just the read-only watchdog now and the backup by hand right after the merge.` });
eq("curly quotes, reply “…”", pendingAsk(`  Reply “yes” to go on.\n\n${box()}`)?.words, ["yes"]);
eq("a question as the last line", pendingAsk(`  The checks passed.\n\n  Want me to open the follow-up PR now?\n\n${box()}`), { kind: "question", text: "Want me to open the follow-up PR now?" });
// False catches from asks-questions.log (11-11/11-12): a running tool's block whose command ends in `$?`.
const RUN = (title, cmd) => `⏺ ${title}\n  ⎿ $ ${cmd}\n\n✻ Running… (3s)\n\n${box()}`;
eq("tool block ending $? (t18 12:24)", pendingAsk(RUN("Running the test-integrity scan · 3s", `node ~/bin/tool.mjs integrity --base origin/main --head HEAD > /tmp/integrity.json; echo "exit $?"`)), null);
eq("tool block, no spinner (t26 02:24)", pendingAsk(`⏺ Running 2 shell commands · 4s…\n  ⎿ $ node ~/bin/tool.mjs config > /tmp/config.json 2>&1; echo "cfg exit $?"\n\n${box()}`), null);
eq("tool block wrapped over two lines (t1f 13:57)", pendingAsk(`⏺ Confirming no parked sessions, then removing the worktree · 3s\n  ⎿ $ node /Users/x/bin/tool.mjs worktrees sessions /Users/x/wt | head -c 300; echo; git worktree\n    remove /Users/x/wt; echo "rm $?"\n\n${box()}`), null);
eq("tool output line ending ?", pendingAsk(`⏺ Bash(grep -c x f)\n  ⎿  Did you mean x?\n\n${box()}`), null);
eq("real question still caught (t4 02:12)", pendingAsk(`  The two fixes overlap.\n\n  Do you want me to start that combined PR, or keep #1833 on its own since it decides which banner gets shown?\n\n${box()}`), { kind: "question", text: "Do you want me to start that combined PR, or keep #1833 on its own since it decides which banner gets shown?" });
eq("a question earlier, a statement last",pendingAsk(`  Want me to open it?\n\n  I'll wait for CI first.\n\n${box()}`), null);
eq("quoted words without say/reply", pendingAsk(`  The label "No hard copy" is back.\n\n${box()}`), null);
eq("answered: prompt after it", pendingAsk(`  Say "OK" to go.\n\n❯ OK\n\n⏺ Running…\n\n${box()}`), null);

// "#N is merged" on screen: the PR a leftover 🔀 is about (owner 18:15, #1821).
eq("merged hint", mergedHint(`  Head abc · items none · repo acme/webshop\n  🔀 Ready to merge #1821 — say "merge"\n\n❯ merge\n\n  #1821 is merged (commit b9426910f). It went through the merge queue.\n${box()}`), { pr: 1821, repo: "acme/webshop" });
eq("merged #N", mergedHint(`  I merged #1790 a minute ago.\n${box()}`), { pr: 1790, repo: null });
eq("no merge on screen", mergedHint(`  #1816 is ready.\n${box()}`), null);

// Work still running after the turn ended (owner 18:18): the footer under the input box.
const FOOT = (extra) => `⏺ #1825 is first in the merge queue.\n\n✻ Brewed for 20s · done 6:17 PM · 1 shell still running\n\n${R}\n❯ \n${R}\n  you:\\~ | HOME x\n  Opus 5.5 | effort:high\n${extra}`;
// Owner 11-12 22:15: a reply that says the PR is in the merge queue, with a shell, is a merge wait (`merge`).
eq("1 shell in the footer (t10 18:19)", backgroundWork(FOOT("  ⏵⏵ auto mode on · 1 shell · ← 4 agents")), { shells: 1, agents: 0, merge: true });
eq("2 shells and a running agent row", backgroundWork(FOOT("  ▶▶ auto mode on · 2 shells · ← 4 agents\n\n  ● main\n  ○ implementer  Running verify.mjs quick check        7m 0s · ↓ 73.3k tokens")), { shells: 2, agents: 1, merge: true });
eq("only finished agents (← N agents)", backgroundWork(FOOT("  ⏵⏵ auto mode on · ← 4 agents")), null);
eq("no footer work", backgroundWork(FOOT("  ⏵⏵ auto mode on")), null);
eq("no box", backgroundWork("1 shell"), null);
// Real screens: node test-asks.mjs <file>=<kind> … (e.g. t1t-screen.txt=round t1d-screen.txt=migration)
for (const arg of process.argv.slice(2)) {
  const [file, kind] = arg.split("=");
  eq(`real screen ${file.split("/").pop()}`, pendingAsk(fs.readFileSync(file, "utf8"))?.kind, kind ?? "round");
}
// The question log (noise watch, 11-11 s6).
const Q = (text) => ({ kind: "question", text });
eq("new question logged", JSON.stringify(newQuestions({}, { t1: Q("Run both?") })), JSON.stringify([{ address: "t1", kind: "question", text: "Run both?" }]));
eq("same question next tick: not again", newQuestions({ t1: Q("Run both?") }, { t1: Q("Run both?") }).length, 0);
eq("changed question: logged", newQuestions({ t1: Q("Run both?") }, { t1: Q("Merge now?") }).length, 1);
// 11-12: every new ask is logged (a missed extra round could not be traced).
eq("other kinds: logged as tags", JSON.stringify(newQuestions({}, { t1: { kind: "reply", words: ["go"], text: "say go" }, t2: { kind: "merge", pr: 1 } })),
  JSON.stringify([{ address: "t1", kind: "reply", text: "[reply “go”] say go" }, { address: "t2", kind: "merge", text: "[merge #1]" }]));
eq("round ask logged", JSON.stringify(newQuestions({}, { t23: { kind: "round", pr: 242, round: 16 } })), JSON.stringify([{ address: "t23", kind: "round", text: "[round #242 r16]" }]));
eq("same round next tick: not again", newQuestions({ t23: { kind: "round", pr: 242, round: 16 } }, { t23: { kind: "round", pr: 242, round: 16 } }).length, 0);
eq("next round: logged", newQuestions({ t23: { kind: "round", pr: 242, round: 16 } }, { t23: { kind: "round", pr: 242, round: 17 } }).length, 1);
// 11-12 real screen (t23, #242 round 16, under "✻ Worked for 3m 3s · done 12:06 PM").
eq("11-12 #242 round 16 under a done line", pendingAsk(`  Round 16 now covers the round 15 fix plus this one. Type extra round to grant it.\n\n  🔁 Extra review round needed #242: round 16 · head 1c5f7f66fcbe · repo acme/tools\n\n✻ Worked for 3m 3s · done 12:06 PM\n\n${box()}`), { kind: "round", pr: 242, round: 16 });
eq("reply → question on one tab: logged", newQuestions({ t1: { kind: "reply", text: "x" } }, { t1: Q("x") }).length, 1);
eq("log keeps the newest 500 (s13)", keepLog(Array.from({ length: 500 }, (_, i) => "l" + i).join("\n"), ["new"]).split("\n").filter(Boolean).length, 500);
eq("log ends with the new line", keepLog("a\nb\n", ["c"]), "a\nb\nc\n");
eq("empty log", keepLog(null, ["c"]), "c\n");
// s9: the Needs you "Extra round" button sends only while the screen still ends with that same round's ask.
const si = src.indexOf("export function prList"), sj = src.indexOf("export function askDetail");
const stillAsks = new Function("pendingAsk", src.slice(si, sj).replaceAll("export ", "") + "; return stillAsks;")(pendingAsk);
const ASK6 = { kind: "round", pr: 1803, round: 6 };
eq("stillAsks: same round", stillAsks(`${ROUND}\n\n${box()}`, ASK6), true);
eq("stillAsks: newer round", stillAsks(`${ROUND}\n\n${box()}`, { ...ASK6, round: 5 }), false);
eq("stillAsks: other PR", stillAsks(`${ROUND}\n\n${box()}`, { ...ASK6, pr: 1838 }), false);
eq("stillAsks: turn moved on", stillAsks(`${ROUND}\n\n❯ extra round\n\n⏺ Working\n\n${box()}`, ASK6), false);
eq("stillAsks: no ask", stillAsks("", ASK6), false);
// s9: a merge of two PRs keeps both; the button's screen check matches it.
const TWO = '  🔀 Ready to merge #1864, #1867 — say "merge"';
eq("two-PR merge", pendingAsk(`${TWO}\n\n${box()}`), { kind: "merge", pr: 1864, prs: [1864, 1867] });
eq("one-PR merge unchanged", pendingAsk(`  🔀 Ready to merge #5 — say "merge"\n\n${box()}`), { kind: "merge", pr: 5 });
eq("stillAsks two-PR merge", stillAsks(`${TWO}\n\n${box()}`, { kind: "merge", pr: 1864, prs: [1864, 1867] }), true);
// Codex 11-12 P1: the button showed "#1864" but the screen now asks to merge "#1864, #1867" → nothing sent.
eq("stillAsks: merge now names more PRs", stillAsks(`${TWO}\n\n${box()}`, { kind: "merge", pr: 1864 }), false);
eq("stillAsks: merge now names fewer PRs", stillAsks(`  🔀 Ready to merge #1864 — say "merge"\n\n${box()}`, { kind: "merge", pr: 1864, prs: [1864, 1867] }), false);
eq("stillAsks merge after a round ask replaced it", stillAsks(`${ROUND}\n\n${box()}`, { kind: "merge", pr: 1803 }), false);
const pl = src.indexOf("export function prList"), pe = src.indexOf("export function stillAsks");
const prList = new Function(src.slice(pl, pe).replace("export ", "") + "; return prList;")();
eq("prList two", prList({ kind: "merge", pr: 1864, prs: [1864, 1867] }), "#1864, #1867");
eq("prList one", prList({ kind: "merge", pr: 5 }), "#5");
// s10: an answered ask stays out of Needs you for ANSWERED_MS (asks.js dropAnswered, between <answered> markers).
const da = src.indexOf("// <answered>"), db = src.indexOf("// </answered>");
const dropAnswered = new Function("ANSWERED_MS", src.slice(da, db).replace("export ", "") + "; return dropAnswered;")(45_000);
const merge = { kind: "merge", pr: 1818 }, round = { kind: "round", pr: 1803, round: 6 };
const ans = { t1: { ask: JSON.stringify(merge), at: 1000 } };
eq("answered merge kept out", dropAnswered({ t1: merge, t2: round }, ans, 20_000), { out: { t2: round }, answered: ans });
eq("answered expires", dropAnswered({ t1: merge }, ans, 1000 + 45_000), { out: { t1: merge }, answered: {} });
eq("a different ask comes through", dropAnswered({ t1: round }, ans, 5000), { out: { t1: round }, answered: ans });
eq("nothing answered", dropAnswered({ t1: merge }, null, 5000), { out: { t1: merge }, answered: {} });
// s10: the Overview's "Now:" line (asks.js nowDoing / plainStep, <now> markers; shapes from real screens, scrubbed).
const na = src.indexOf("const RULE"), nb = src.indexOf("// </now>");
const { nowDoing, plainStep } = new Function("shared", src.slice(na, nb).replaceAll("export ", "") + "; return { nowDoing, plainStep };")(() => null);
eq("step: tests", plainStep("⏺ Bash(npx vitest run src/a.test.ts)"), "running tests");
eq("step: typecheck", plainStep("⏺ Bash(npm run typecheck)"), "checking the code for type errors");
eq("step: other command", plainStep("⏺ Bash(uptime)"), "running a command");
eq("step: folders", plainStep("⏺ Bash(ls -la)"), "looking through folders");
eq("step: reading", plainStep("⏺ Bash(grep -n foo a.js)"), "reading files");
eq("step: script", plainStep("⏺ Bash(node scripts/spaces.mjs)"), "running a script");
eq("step: build", plainStep("⏺ Bash(npm run build)"), "building the app");
eq("step: node test still tests", plainStep("⏺ Bash(node test-asks.mjs)"), "running tests");
eq("step: edit", plainStep("⏺ Update(src/app/chat.js)"), "editing chat.js");
eq("step: read", plainStep("⏺ Read(/Users/x/notes.md)"), "reading notes.md");
eq("step: agent type", plainStep("⏺ implementer(Fix PR 12 accepted items)"), "a helper is on it: Fix PR 12 accepted items");
eq("step: mcp", plainStep("⏺ supabase - execute_sql (MCP)(query: \"select 1\")"), "using supabase (execute sql)");
eq("step: words, first sentence", plainStep("⏺ Round 6 is in. Next I push."), "Round 6 is in.");
eq("step: timer dropped", plainStep("⏺ Starting the granted round-4 Codex review · 9s"), "Starting the granted round-4 Codex review");
eq("step: heading skipped", plainStep("⏺ What happened"), null);
const footer = `${R}\n❯ \n${R}\n  you:\\~ | HOME x\n\n  ⏺ main\n  ◯ implementer  Running the latch tests                1m 33s · ↓ 61.5k tokens`;
eq("now: last words + helper", nowDoing(`⏺ Bash(git push)\n  ⎿ ok\n\n⏺ Round 6 accepted three items, and an implementer is on them:\n  - one\n\n${footer}`),
  { now: "Round 6 accepted three items, and an implementer is on them", steps: ["pushing its work to GitHub", "Round 6 accepted three items, and an implementer is on them"], helpers: ["implementer: Running the latch tests"] });
eq("now: a spinner naming a step wins", nowDoing(`⏺ Update(a.js)\n\n✻ Running the unit tests… (2m · ↓ 1k tokens)\n\n${box()}`).now, "Running the unit tests");
eq("now: a one-word spinner says nothing", nowDoing(`⏺ Update(a.js)\n\n✽ Perusing… (16s)\n\n${box()}`).now, "editing a.js");
eq("now: nothing on screen", nowDoing(box()), null);

// s15 live hot-fix (#299 tab, 19:05): Claude Code may print "(disable recaps in /config)" after the reply's last line.
const HEAD = "  Head ca9448d05d74 · items none · repo acme/app";
eq("recap hint after the merge marker", pendingAsk(`${HEAD}\n  🔀 Ready to merge #13 — say "merge" (disable recaps in /config)\n\n${box()}`), { kind: "merge", pr: 13 });
eq("recap hint after the round line", pendingAsk(`  🔁 Extra review round needed #13: round 2 · head abc · repo acme/app (disable recaps in /config)\n\n${box()}`), { kind: "round", pr: 13, round: 2 });
// Owner 11-13 (#326 tab): a "※ recap:" block that wraps, and a right-aligned "✔ Update installed" notice, under the
// round line. The recap's 'type "extra round"' must not hide the round line (no Extra round button otherwise).
const RECAP = `\n✻ Crunched for 8m 44s · done 9:57 AM · 2 shells still running\n\n※ recap: We're finishing the review of PR #326. Next,\n  type "extra round" to approve review round 8. (disable recaps in /config)\n${" ".repeat(80)}✔ Update installed · Restart to apply\n`;
eq("recap block + update notice under the round line", pendingAsk(`  🔁 Extra review round needed #326: round 8 · head e9aae19c0017 · repo acme/pipeline\n${RECAP}${box()}`), { kind: "round", pr: 326, round: 8 });
eq("recap block under a merge marker", pendingAsk(`${HEAD}\n  🔀 Ready to merge #13 — say "merge"\n${RECAP}${box()}`), { kind: "merge", pr: 13 });
eq("recap block under a plain reply: nothing asked", pendingAsk(`⏺ Fixed it; tests pass.\n${RECAP}${box()}`), null);
eq("a one-line recap is skipped too", pendingAsk(`  🔁 Extra review round needed #3: round 2 · head abc · repo acme/app\n\n※ recap: Waiting for you to approve round 2.\n\n${box()}`), { kind: "round", pr: 3, round: 2 });
eq("an indented reply line far right is still reply text", pendingAsk(`⏺ Which one?\n${" ".repeat(12)}Should I use A or B?\n\n${box()}`)?.kind, "question");
eq("other words after the marker are not the hint", pendingAsk(`${HEAD}\n  Ready to merge #13 — say "merge" (or not)\n\n${box()}`)?.kind, "reply");

// The workflow switches (config pipeline_asks / worth_considering): off, the pipeline's lines are plain text and an
// "Also worth considering" list is read like any other paragraph.
const OFF = { pipeline: false, worth: true };
eq("pipeline off: round line is no round ask", pendingAsk(`${ROUND}\n\n${box()}`, OFF), null);
eq("pipeline off: merge marker is read as a reply ask", pendingAsk(`  🔀 Ready to merge #1818 — say "merge"\n\n${box()}`, OFF)?.kind, "reply");
eq("pipeline off: go migration is read as a reply ask", pendingAsk(`${GO}\n\n${box()}`, OFF)?.kind, "reply");
eq("pipeline off: a plain question still counts", pendingAsk(`  Want me to open the follow-up PR now?\n\n${box()}`, OFF), { kind: "question", text: "Want me to open the follow-up PR now?" });
const WC = `  Done.\n\n  Also worth considering\n  - Dark mode: want it next?\n\n${box()}`;
eq("worth on: suggestion list asks nothing", pendingAsk(WC, { pipeline: true, worth: true }), null);
eq("worth off: the list's question is an ask", pendingAsk(WC, { pipeline: true, worth: false })?.kind, "question");
eq("defaults: both on", pendingAsk(`${ROUND}\n\n${box()}`, {}), { kind: "round", pr: 1803, round: 6 });
process.exit(bad ? 1 : 0);
