// Tests for cards.js reviewBlocked (the card's copy of the helper's review_ambiguous, herdr-core question/claude_exact.rs).
// Run: node test-review.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "cards.js", "utf8");
const a = src.indexOf("const reviewMark"), b = src.indexOf("const KEY_FULL");
const { reviewBlocked } = new Function(src.slice(a, b).replaceAll("export ", "") + "; return { reviewBlocked };")();
let bad = 0;
const eq = (n, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)}`); };
const m = (...v) => new Map(v.map((x, i) => [i, x]).filter(([, x]) => x != null));
const opt = (...labels) => labels.map((label) => ({ label }));
const card = (...qs) => ({ agent: "claude", toolUseId: "toolu_1", questions: qs });
const one = (text, labels, multi = false) => ({ text, options: opt(...labels), multi });

// The 11-12 card: two single-choice questions, the first "Yes, remind me Dec 28" / "No / not yet".
const nudge = card(one("Should I set a reminder for Dec 28?", ["Yes, remind me Dec 28", "No / not yet"]), one("Second?", ["C", "D"]));
eq("single choice: comma in a label is fine (11-12 card)", reviewBlocked(nudge), null);
eq("single choice: own answer with a comma is fine", reviewBlocked(nudge, m("Later, in January")), null);
eq("single choice: own answer alike a label", reviewBlocked(nudge, m("No / not yet")), "own");
eq("single choice: review mark in a label", reviewBlocked(card(one("Q?", ["A → B", "C"]), one("R?", ["D", "E"]))), "option");
eq("single choice: two labels alike without spaces", reviewBlocked(card(one("Q?", ["A B", "AB"]), one("R?", ["D", "E"]))), "option");
eq("single choice: review mark in the question", reviewBlocked(card(one("Q ● now?", ["A", "B"]), one("R?", ["D", "E"]))), "option");
// Multi-choice: picks ARE joined by commas on the review screen.
const many = card(one("Which?", ["Yes, remind me", "Yes", "remind me"], true));
eq("multi choice: comma in a label", reviewBlocked(many), "option");
eq("multi choice: own answer with a comma", reviewBlocked(card(one("Which?", ["A", "B"], true)), m("x, y")), "own");
eq("multi choice: clean", reviewBlocked(card(one("Which?", ["A", "B"], true)), m("olive")), null);
// No review screen: one single-choice question, a screen-read question, or a message delivery.
eq("one single-choice question: no review", reviewBlocked(card(one("Q?", ["A, B", "A B", "AB"]))), null);
eq("screen question: no review", reviewBlocked({ ...card(one("Q?", ["A → B"]), one("R?", ["C"])), toolUseId: "screen-1" }), null);

console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
