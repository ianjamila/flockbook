// Tests for termresize.js fitTerm/termAt: the terminal window stays clear of the tab list (owner 11-13: a window
// dragged big in a wide app covered the tab list once the app got narrower; its tabs could not be clicked).
// Run: node test-termfit.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const tr = fs.readFileSync(MOD + "termresize.js", "utf8");
const pure = tr.slice(tr.indexOf("// <pure>"), tr.indexOf("// </pure>")).replaceAll("export ", "");
const R = new Function(pure + "; return { fitTerm, fitRoom, overlayPx, termAt, TERM_MIN, TERM_MARGIN };")();

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
// fitRoom (owner 11-24 "drag wins"): a dragged (custom) size may cover the tab list, up to the app's right edge;
// the preset sizes stay clear of it. Owner's 11-24 drag: app 1698 wide, sidebar 198, work column 1199, window at (198, 8):
// dragged to 1457 × 1048, it opened 1187 × 1041 (snapped back to the tab list's edge).
{
  const app2 = { width: 1698, height: 1061 }, room2 = { x: 198, w: 1199, h: 1061 }, at2 = { x: 198, y: 8 };
  eq("custom: the drag wins over the tab list", R.fitTerm([1457, 900], R.fitRoom("custom", room2, app2), app2, at2), [1457, 900]);
  eq("custom: still stops inside the app", R.fitTerm([1800, 1048], R.fitRoom("custom", room2, app2), app2, at2), [1698 - M - 198, 1061 - M - 8]);
  eq("a preset stays clear of the tab list", R.fitTerm([0.85, 0.85], R.fitRoom("large", room2, app2), app2, at2), [198 + 1199 - M - 198, Math.round(0.85 * 1061)]);
  eq("nothing measured: the room as it is", R.fitRoom("custom", null, app2), null);
}
// overlayPx (owner 11-24, zoom 0.9): Herdr draws a window `width`×zoom screen px wide, so a size in screen px (what
// the outline and the measures use) is asked for ÷ zoom. Live: asked 1300 × 950, drawn 1171 × 856.
eq("zoom 0.9: screen px ÷ zoom", R.overlayPx([1300, 950], 0.9), [1444, 1056]);
eq("zoom 1: as it is", R.overlayPx([1300, 950], 1), [1300, 950]);
eq("a share stays a share", R.overlayPx([0.7, 0.97], 0.9), [0.7, 0.97]);
eq("no zoom known: as it is", R.overlayPx([1300, 950], undefined), [1300, 950]);
// termAt: a window Herdr has no spot for is centered in the work column, not over the tab list.
eq("centered in the column", R.termAt([527, 455], room), { x: 250 + 100, y: 300 });
eq("wider than the column: its left edge", R.termAt([900, 455], room), { x: 250, y: 300 });
eq("taller than the app: the top", R.termAt([527, 2000], room), { x: 350, y: 0 });

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
