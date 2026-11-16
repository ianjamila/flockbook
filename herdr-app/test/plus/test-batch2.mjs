// Batch 2 items 10–12 (s13): the split request counts in Settings, "Pause automatic About lines until tomorrow", and
// the ask log's measurement (kind + zoned time, 500 lines, GitHub checks per hour). Run: node test-batch2.mjs
import { MOD, WORK_DIR } from "./paths.mjs";
import { loadMod, fakeShared, realAccounts } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const OFF = -new Date().getTimezoneOffset();
let now = Date.UTC(2026, 10, 12, 8, 30);
Date.now = () => now;
const R = "─".repeat(60);
const screen = `⏺ Working.\n\n${R}\n❯ \n${R}\n  you:\\~/x | WORK e@x | p\n  Opus`;

// 11. Pause automatic About lines until tomorrow.
const st = fakeShared(), calls = [];
const herdr = { ...st, home: () => "/Users/you", appHome: () => "/x", agents: () => [{ address: "t1", title: "A", status: "working" }, { address: "t2", title: "B", status: "working" }], terminals: () => [], spaces: () => [],
  hc: async () => ({ code: 0, stdout: screen }), exec: async (_c, args) => { calls.push(args.at(-1).slice(11, 12)); return { code: 0, stdout: "Line: X.\nMore: Y." }; } };
const { acc, cfg, set } = await realAccounts(herdr, { about_cap: "200", accounts: [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }] });
const ai = await loadMod("ai.js", { herdr, "./config.js": cfg, "./accounts.js": acc, "./state.js": { sessionTopic: (a) => a.title } });
eq("nextMidnight: local midnight after now", ai.nextMidnight(now, 480), Date.UTC(2026, 10, 12, 16, 0));
ai.pauseAutoUntilTomorrow();
eq("paused until the next local midnight", ai.autoPausedUntil(), ai.nextMidnight(now, OFF));
await ai.aboutTick({ soon: true });
eq("paused: no automatic About call", calls.length, 0);
ai.requestRewrite("t1");
await ai.aboutTick({ soon: true });
eq("paused: Rewrite still goes", calls.length, 1);
ai.resumeAuto();
eq("resume clears it", ai.autoPausedUntil(), null);
ai.pauseAutoUntilTomorrow();
now = ai.nextMidnight(now, OFF) + 1000;
eq("an expired pause is off", ai.autoPausedUntil(), null);

// 10. Split counts: automatic of cap · Rewrite · Summarize, as requests.
st.setShared("flockbook.ai.calls", { day: ai.dayKey(now, OFF), WORK: { about: 14, rewrite: 2, summary: 1, ok: 16, fail: 1 }, HOME: { about: 0, rewrite: 0, summary: 1, ok: 1, fail: 0 } });
set("about_cap", "100");
eq("usage line per account", ai.usageLines(), ["Work account (WORK): automatic 14 of 100 · Rewrite 2 · Summarize 1 requests (16 worked, 1 failed)", "Personal account (HOME): automatic 0 of 100 · Rewrite 0 · Summarize 1 requests (1 worked)"]);
set("about_cap", "none");
eq("usage line, no cap", ai.usageLines()[0], "Work account (WORK): automatic 14 · Rewrite 2 · Summarize 1 requests (16 worked, 1 failed)");

// 12. Ask log: kind + zoned time; 500 lines; GitHub checks per hour.
const ast = fakeShared();
const asks = await loadMod("asks.js", { herdr: { ...ast, agents: () => [], home: () => "/Users/you", appHome: () => "/x" } });
eq("log keeps 500 lines", asks.QUESTION_KEEP, 500);
eq("log stamp carries its zone", asks.logStamp(Date.UTC(2026, 10, 12, 8, 55), 480), "2026-11-12 16:55 +08:00");
eq("log stamp, negative zone", asks.logStamp(Date.UTC(2026, 10, 12, 8, 55), -150), "2026-11-12 06:25 -02:30");
eq("new asks carry their kind", asks.newQuestions({}, { t1: { kind: "merge", pr: 1838 } }), [{ address: "t1", kind: "merge", text: "[merge #1838]" }]);
eq("log line shape", asks.logLine("2026-11-12 16:55 +08:00", { address: "t1", kind: "merge", text: "[merge  #1838]" }, "Style"), "2026-11-12 16:55 +08:00  t1  merge  [Style]  [merge #1838]");
now = Date.UTC(2026, 10, 12, 8, 5);
asks.countGh(); asks.countGh();
eq("gh count this hour", asks.ghCounts(), { now: 2, last: 0 });
now = Date.UTC(2026, 10, 12, 9, 1);
asks.countGh();
eq("gh count rolls over the hour", asks.ghCounts(), { now: 1, last: 2 });
now = Date.UTC(2026, 10, 12, 11, 0);
eq("gh count: an hour with none", asks.ghCounts(), { now: 0, last: 0 });
// Wiring (source checks): the strip, the pause line, "waiting", the Settings rows and the history timer.
{
  const fs = await import("node:fs");
  const M = MOD;
  const ov = fs.readFileSync(M + "overview.js", "utf8"), nd = fs.readFileSync(M + "needs.js", "utf8"), se = fs.readFileSync(M + "settings.js", "utf8"), tp = fs.readFileSync(M + "top.js", "utf8");
  eq("overview: strip, then pause banners, then auto-pause line", /\.children\(this\.sinceStrip\(t\)\)\s*\.children\(this\.pauseBanners\(t\)\)\s*\.children\(this\.autoPauseLine\(t\)\)/.test(ov), true);
  eq("overview: Copy copies copyText(v) of the shown view", /write_to_clipboard\(copyText\(v\)\)/.test(ov), true);
  eq("needs: waiting age on the row", /waitingFor\(a\.address\)/.test(nd), true);
  eq("settings: pause row in OVERVIEW", /\["OVERVIEW", \["about_line", "about_pause", "about_cap", "accounts_info"\]\]/.test(se), true);
  eq("settings: usage + GitHub line", /usageLines\(\)/.test(se) && /GitHub checks/.test(se), true);
  eq("top: history timer", /every\(HISTORY_TICK_MS, \(\) => historyTick\(\)\)/.test(tp), true);
}
process.exit(bad ? 1 : 0);
