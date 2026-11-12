// Tests for ai.js's pure parts (s10, 11-12): the About answer's parsing, one-line cleanup, when a tab is due, and
// the input's size cap. Run: node test-ai.mjs
import { MOD, WORK_DIR } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "ai.js", "utf8");
const i = src.indexOf("// <ai-pure>"), j = src.indexOf("// </ai-pure>");
const { aiInput, oneLine, parseAbout, aboutDue, isStale, normTitle, classifyFailure, parseReset, coolUntil, clockText, dayKey, failureText, agoText, RETRY_MS } = new Function(src.slice(i, j).replaceAll("export ", "") + "; return { aiInput, oneLine, parseAbout, aboutDue, isStale, normTitle, classifyFailure, parseReset, coolUntil, clockText, dayKey, failureText, agoText, RETRY_MS };")();
// accountOfScreen / nameOf come from accounts.js's pure block (its constants and expandHome stood in).
const asrc = fs.readFileSync(MOD + "accounts.js", "utf8");
const { accountOfScreen, nameOf } = new Function("expandHome", 'const DEFAULT_ACCOUNT = "default", STATUS_FROM_BOTTOM = 16, RULE_LINE = /^\\s*─{20,}\\s*$/;' + asrc.slice(asrc.indexOf("// <accounts-pure>"), asrc.indexOf("// </accounts-pure>")).replaceAll("export ", "") + "; return { accountOfScreen, nameOf };")((p) => p);

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

eq("labelled answer", parseAbout("Line: Shoppers can see their order offline (#1838).\nMore: It lets shoppers open the cart without signal. It is in review."),
  { line: "Shoppers can see their order offline (#1838).", more: "It lets shoppers open the cart without signal. It is in review." });
eq("More over two lines", parseAbout("Line: A.\nMore: One.\nTwo."), { line: "A.", more: "One. Two." });
eq("no labels", parseAbout("Fixes sign-out between tabs.\nIt is waiting on review."), { line: "Fixes sign-out between tabs.", more: "It is waiting on review." });
eq("empty", parseAbout(""), { line: null, more: null });
eq("oneLine strips About: and quotes", oneLine("About: \"Makes reports faster\""), "Makes reports faster");
eq("oneLine cuts at a word", oneLine("word ".repeat(50)).endsWith("…"), true);
eq("due: none yet", aboutDue(null, "x", 0, 1000), true);
eq("due: same title", aboutDue({ title: "x", text: "A", at: 0 }, "x", 99_999, 1000), false);
eq("due: new title, old enough", aboutDue({ title: "x", text: "A", at: 0 }, "y", 2000, 1000), true);
eq("due: new title, too soon", aboutDue({ title: "x", text: "A", at: 0 }, "y", 500, 1000), false);
eq("due: no text, failed just now", aboutDue({ title: "x", at: 0 }, "x", 99_999, 1000), false);
eq("due: no text, failed 5 min ago", aboutDue({ title: "x", triedAt: 0, error: "e" }, "x", RETRY_MS, 1000), true);
// s11 bug 2: a failed refresh kept A's text under B's title and a new time, so it looked fresh and never retried.
const failedRefresh = { title: "B", text: "A line", wroteTitle: "A", wroteAt: 0, triedAt: 10 * 60_000, error: "limit" };
eq("failed refresh: waits 5 min", aboutDue(failedRefresh, "B", 10 * 60_000 + 1000, 1000), false);
eq("failed refresh: retried after 5 min", aboutDue(failedRefresh, "B", 10 * 60_000 + RETRY_MS, 1000), true);
eq("failed refresh: line is stale", isStale(failedRefresh, "B"), true);
eq("written for this title: not stale", isStale({ text: "x", wroteTitle: "B" }, "B"), false);
eq("legacy entry: title is the written one", isStale({ text: "x", title: "B", at: 1 }, "B"), false);
eq("glyph-only title change is not new", aboutDue({ text: "A", wroteTitle: "✳ Fix login 🔀", wroteAt: 0 }, "⠂ Fix login", 9e9, 1000), false);
eq("normTitle keeps #", normTitle("🔀 PR #1838 — Checkout"), "pr #1838 checkout");
// Account: the status line within the last 20 lines.
// s13: only the status line under the input box counts (more cases in test-aitick.mjs).
const RR = "─".repeat(40);
const LIST = [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }];
const accountOf = (screen) => accountOfScreen(screen, LIST);
eq("account WORK", accountOf("x\n" + "\n".repeat(15) + RR + "\n❯ \n" + RR + "\n  you:\\~/x | WORK a@x | pipeline\n  Opus"), "WORK");
eq("account HOME", accountOf(RR + "\n❯ \n" + RR + "\n  you:\\~ | HOME me@x |…"), "HOME");
eq("account: a bare | HOME line is not a status line", accountOf("a | HOME you"), null);
eq("account unknown", accountOf("no status line"), null);
eq("account: a mark that isn't in the list is no account", accountOf(RR + "\n❯ \n" + RR + "\n  you:\\~ | OTHER me@x"), null);
eq("one account: returned without a status line", accountOfScreen("no status line", [{ mark: "WORK", name: "Work account" }]), "WORK");
eq("one account: an empty screen too", accountOfScreen("", [{ mark: "HOME", name: "Personal account" }]), "HOME");
eq("no accounts: the default one", accountOfScreen("no status line", []), "default");
eq("no accounts: no screen at all", accountOfScreen(undefined, []), "default");
eq("nameOf: account with its mark", nameOf("HOME", LIST), "Personal account (HOME)");
eq("nameOf: the default account", nameOf("default", []), "Your Claude account");
eq("nameOf: an id no longer set", nameOf("GONE", LIST), "Account GONE");
// Failures: the cause from stdout; a sign-in warning on stderr alone proves nothing (Codex 11-12).
eq("quota", classifyFailure({ stdout: "You've hit your weekly limit · resets 1am (Asia/Singapore)\n", stderr: "Warning: this sign-in can end", code: 1 }).kind, "quota");
eq("warning only = other", classifyFailure({ stdout: "", stderr: "Warning: this sign-in can end at any time", code: 1 }).kind, "other");
eq("auth", classifyFailure({ stdout: "Not logged in · Please run /login", code: 1 }).kind, "auth");
eq("timeout", classifyFailure({ stdout: "", code: null, error: "timed out after 45000 ms" }).kind, "timeout");
// Reset times. now = 2026-11-12 14:40 Singapore (06:40 UTC).
const now = Date.UTC(2026, 10, 12, 6, 40);
eq("reset 1am Singapore = next 1am", parseReset("resets 1am (Asia/Singapore)", now, 480), Date.UTC(2026, 10, 12, 17, 0));
eq("reset with a date", parseReset("resets Nov 14, 1am (Asia/Singapore)", now, 480), Date.UTC(2026, 10, 13, 17, 0));
eq("reset later today, local zone", parseReset("resets 3:30pm", now, 480), Date.UTC(2026, 10, 12, 7, 30));
eq("reset time passed today = tomorrow", parseReset("resets 2pm", now, 480), Date.UTC(2026, 10, 13, 6, 0));
// Codex 11-12 P2: the offset is the reset's own, not now's. New York leaves daylight saving on Sun Nov 1, 2026 (2am).
const oct31 = Date.UTC(2026, 9, 31, 16, 0);   // Sat Oct 31, 12 noon New York (EDT, UTC-4)
eq("DST end: Nov 1, 3am New York = 08:00Z (EST)", parseReset("resets Nov 1, 3am (America/New_York)", oct31, 0), Date.UTC(2026, 10, 1, 8, 0));
eq("DST end: no date, 3am New York tomorrow", parseReset("resets 3am (America/New_York)", oct31, 0), Date.UTC(2026, 10, 1, 8, 0));
eq("before the change: 1am Nov 1 still EDT = 05:00Z", parseReset("resets Nov 1, 1am (America/New_York)", oct31, 0), Date.UTC(2026, 10, 1, 5, 0));
// Spring forward (Sun Mar 8, 2026, 2am → 3am): 4am that day is EDT.
const mar7 = Date.UTC(2026, 2, 7, 17, 0);   // Sat Mar 7, 12 noon EST
eq("DST start: Mar 8, 4am New York = 08:00Z (EDT)", parseReset("resets Mar 8, 4am (America/New_York)", mar7, 0), Date.UTC(2026, 2, 8, 8, 0));
// The Mac's own zone with daylight saving: the offset as a function of time.
const ny = (t) => (t >= Date.UTC(2026, 10, 1, 6, 0) ? -300 : -240);
eq("local zone as a function: 3am after the change", parseReset("resets 3am", oct31, ny), Date.UTC(2026, 10, 1, 8, 0));
eq("local zone as a number still works", parseReset("resets 3am", oct31, -240), Date.UTC(2026, 10, 1, 7, 0));
eq("reset in another machine zone", parseReset("resets 1am (UTC)", now, -480), Date.UTC(2026, 10, 13, 1, 0));
eq("any IANA zone (Intl): New York 1am", parseReset("resets 1am (America/New_York)", now, 480), Date.UTC(2026, 10, 13, 6, 0));
eq("any IANA zone (Intl): half-hour zone", parseReset("resets 9am (Asia/Kolkata)", now, 480), Date.UTC(2026, 10, 12, 3, 30) + 86_400_000);
eq("unknown zone = unreadable", parseReset("resets 1am (Mars/Base)", now, 480), null);
eq("no time = unreadable", parseReset("You've hit your limit", now, 480), null);
eq("far date = unreadable", parseReset("resets Dec 30, 1am (Asia/Singapore)", now, 480), null);
eq("cool: quota without a time = 1 h", coolUntil("quota", "hit your limit", now, 480), now + 3600_000);
eq("cool: auth = 1 h", coolUntil("auth", "", now, 480), now + 3600_000);
eq("cool: timeout = none", coolUntil("timeout", "", now, 480), null);
eq("clock 1am", clockText(Date.UTC(2026, 10, 12, 17, 0), now, 480), "1:00 am");
eq("clock far = weekday", clockText(Date.UTC(2026, 10, 13, 17, 0), now, 480), "Sat 1:00 am");
eq("day key", dayKey(now, 480), "2026-11-12");
eq("day key after local midnight", dayKey(Date.UTC(2026, 10, 12, 17, 0), 480), "2026-11-13");
eq("quota words", failureText("quota", "Personal account (HOME)", Date.UTC(2026, 10, 12, 17, 0), now, 480), "Personal account (HOME) is out of its Claude usage until 1:00 am.");
eq("auth words take the account's name", failureText("auth", "Work account (WORK)", 0, now, 480), "Work account (WORK) needs signing in again (claude auth login).");
eq("cap words take the account's name", failureText("cap", "Work account (WORK)", 0, now, 480).startsWith("Work account (WORK) reached"), true);
eq("unknown account words", failureText("unknown-account", null, 0, now, 480).startsWith("Couldn't tell which Claude account"), true);
eq("ago", [agoText(now - 30_000, now), agoText(now - 12 * 60_000, now), agoText(now - 3 * 3600_000, now)], ["just now", "12 min ago", "3 h ago"]);
eq("input keeps the end", aiInput("T", "a".repeat(50) + "END", 10).endsWith("aaaaaaaEND"), true);
eq("input has the title", aiInput("Style Guide", "x").startsWith("Tab title: Style Guide"), true);
process.exit(bad ? 1 : 0);
