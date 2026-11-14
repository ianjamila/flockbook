// Tests for termresize.js fitTerm/termAt: the terminal window stays clear of the tab list (owner 11-13: a window
// dragged big in a wide app covered the tab list once the app got narrower; its tabs could not be clicked).
// Run: node test-termfit.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const tr = fs.readFileSync(MOD + "termresize.js", "utf8");
const pure = tr.slice(tr.indexOf("// <pure>"), tr.indexOf("// </pure>")).replaceAll("export ", "");
const R = new Function(pure + "; return { fitTerm, termAt, TERM_MIN, TERM_MARGIN };")();

let bad = 0;
const eq = (n, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); const ok = g === w; if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${g} (want ${w})`); };
const M = R.TERM_MARGIN;
// The owner's case: app 1227×1055, sidebars 250 each → work column x 250, 727 wide; the window remembered at (132, 24).
const app = { width: 1227, height: 1055 };
const room = { x: 250, w: 727, h: 1055 };
const at = { x: 132, y: 24 };
eq("the owner's case: narrower, clear of the tab list", R.fitTerm([1079, 996], room, app, at), [250 + 727 - M - 132, 996]);
eq("a window that fits stays as it is", R.fitTerm([700, 600], room, app, at), [700, 600]);
eq("taller than the app: shorter", R.fitTerm([700, 1200], room, app, at), [700, 1055 - M - 24]);
eq("never grows", R.fitTerm([500, 300], { x: 0, w: 3000, h: 2000 }, { width: 3000, height: 2000 }, at), [500, 300]);
eq("a share becomes px, then fits", R.fitTerm([0.7, 0.7], room, app, at), [Math.min(Math.round(0.7 * 1227), 250 + 727 - M - 132), Math.round(0.7 * 1055)]);
eq("a small share stays its px", R.fitTerm([0.3, 0.3], room, app, at), [Math.round(0.3 * 1227), Math.round(0.3 * 1055)]);
eq("no spot known: inside the work column", R.fitTerm([1079, 996], room, app, null), [727 - 2 * M, 996]);
eq("no room for the minimum: the minimum", R.fitTerm([1079, 996], { x: 250, w: 300, h: 1055 }, app, at), [R.TERM_MIN.w, 996]);
eq("a spot right of the column: the minimum", R.fitTerm([900, 500], room, app, { x: 1100, y: 24 }), [R.TERM_MIN.w, 500]);
eq("nothing measured: as wanted", R.fitTerm([1079, 996], null, null, at), [1079, 996]);
eq("no app size: as wanted", R.fitTerm([0.7, 0.7], room, null, at), [0.7, 0.7]);
eq("zero room: as wanted", R.fitTerm([1079, 996], { x: 0, w: 0, h: 0 }, app, at), [1079, 996]);
// termAt: a window Herdr has no spot for is centered in the work column, not over the tab list.
eq("centered in the column", R.termAt([527, 455], room), { x: 250 + 100, y: 300 });
eq("wider than the column: its left edge", R.termAt([900, 455], room), { x: 250, y: 300 });
eq("taller than the app: the top", R.termAt([527, 2000], room), { x: 350, y: 0 });

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
