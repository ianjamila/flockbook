// Tests for estimate.js's zoom rule (s9, 11-12): under a zoom below 1, prose (TextView) draws at its unzoomed
// line height while the chat list's rows shrink, so a long reply lost its last lines (the extra-round ask).
// Measured at zoom 0.9: 26 pt a line = 29 row px. Run: node test-estimate.mjs
import { MOD } from "./paths.mjs";
import { pathToFileURL } from "node:url";
const { markdownHeight, lineHeight } = await import(pathToFileURL(MOD + "estimate.js").href);

let bad = 0;
const ok = (name, cond, got) => { if (!cond) bad++; console.log(cond ? "PASS" : "FAIL", name, cond ? "" : `→ ${got}`); };

const para = (n) => Array.from({ length: n }, (_v, i) => `Line ${i} is short.`).join("\n\n");
// Ten one-line paragraphs: 10 lines and 9 gaps of 10 px, plus END_PAD 6.
const at1 = markdownHeight(para(10), 760, null, 1, 1);
ok("zoom 1 unchanged: 10 lines of 26 + 9 gaps + 6", at1 === 10 * lineHeight(16, 1) + 90 + 6, at1);
const at09 = markdownHeight(para(10), 760, null, 1, 0.9);
ok("zoom 0.9: lines counted at ≥ 28.8 row px", at09 >= 10 * 28.8 + 90, at09);
const at11 = markdownHeight(para(10), 760, null, 1, 1.1);
ok("zoom 1.1: never under the zoomed line height", at11 >= 10 * lineHeight(16, 1.1) + 90, at11);
// A long reply ending with an ask line (the 11-12 case): the guess covers 36 lines drawn at 29 px.
const reply = [para(30), "- one\n- two\n  - three", "🔁 Extra review round needed #1838: round 5 · head 777e1c0821d7 · repo o/r"].join("\n\n");
const r = markdownHeight(reply, 760, null, 1, 0.9);
ok("long reply at 0.9 covers 34 lines of 29 px", r >= 34 * 29, r);
// Headings scale too.
ok("heading at 0.9 taller than at 1", markdownHeight("# Title", 760, null, 1, 0.9) > markdownHeight("# Title", 760, null, 1, 1), "");

// Code boxes (owner 11-13: a re-entry prompt in a code box lost its last lines and its footer's Copy all). The box
// is Menlo 13 px (0.602 em, 7.83 px a letter) wrapped by word, in a box 30 px narrower than the column.
const box = (lines) => markdownHeight("```\n" + lines.join("\n") + "\n```", 711, null, 1, 1);
const CL = lineHeight(13, 1);
// 88 letters are 689 px drawn: over the 681 px line, so 2 lines (counted at 0.58 em they fit in one).
ok("88 Menlo letters wrap in a 681 px code line", box(["a".repeat(88)]) === 34 + 2 * CL, box(["a".repeat(88)]));
// The owner's line: by word it takes 3 lines on screen (screenshot 11-13); by character it fit in 2.
const ownerLine = "5. Propose one storage-hardening follow-up PR covering issues #1958-#1961 and #1971-#1973 after #1533 merges (follow-up PR; ask the owner (AskUserQuestion) whether to start it).";
ok("a code line wraps by word: 3 lines as drawn", box([ownerLine]) === 34 + 3 * CL, box([ownerLine]));
// The rest of that box's lines as drawn: 2, 2, 2, 3, 4 (all matched the screenshot).
const drawn = [
  ["1. Propose landing #1502 (inactive-admin fix; closes #1493 and #1850) as the next PR once both merge (follow-up PR).", 2],
  ["2. Tell the owner to run `pipeline update` for cp #333 when convenient (note in the final reply).", 2],
  ["6. Remove eligible worktrees after merge: both wts above, and cp ~/Code/claude-pipeline/.worktrees/agent-past-round-grants once idle ≥24h (≥11-14), following every CLAUDE.md eligibility check.", 3],
  ["Constraints: prod read-only except owner-approved migrations; never `supabase db push`; never stop shared stacks; the owner says \"merge\"; ci.draft_while_iterating on (`P redraft` before pushing to a READY PR); main moves fast, so re-check conflicts right before ready and before the merge dry-run.", 4],
];
for (const [l, n] of drawn) ok(`code line drawn on ${n} lines: ${l.slice(0, 30)}…`, box([l]) === 34 + n * CL, box([l]));
// Indent counts (no-break spaces in the box): 84 letters fit one line, 4 spaces before them do not.
ok("an indented code line counts its indent", box(["    " + "b".repeat(84)]) === 34 + 2 * CL && box(["b".repeat(84)]) === 34 + CL, box(["    " + "b".repeat(84)]));
// A space at a break is not drawn: two 42-letter words with one space fit one 681 px line (85 letters).
ok("two words that just fit stay on one line", box(["c".repeat(42) + " " + "d".repeat(42)]) === 34 + CL, box(["c".repeat(42) + " " + "d".repeat(42)]));
// The space where it breaks is dropped: two 85-letter words (674 px each) take 2 lines, not 3.
ok("the space at a break is not counted on the next line", box(["e".repeat(85) + " " + "f".repeat(85)]) === 34 + 2 * CL, box(["e".repeat(85) + " " + "f".repeat(85)]));
// Short lines and empty ones stay one line each.
ok("short and empty code lines: one line each", box(["State:", "", "x"]) === 34 + 3 * CL, box(["State:", "", "x"]));
process.exit(bad ? 1 : 0);
