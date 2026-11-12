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
process.exit(bad ? 1 : 0);
