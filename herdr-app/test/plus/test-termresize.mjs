// Tests for termresize.js (drag-resize of the terminal window) and state.js nextTermSize/termDims
// with the "custom" (dragged) size. Run: node test-termresize.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const DIR = MOD;
const tr = fs.readFileSync(DIR + "termresize.js", "utf8");
const pure = tr.slice(tr.indexOf("// <pure>"), tr.indexOf("// </pure>")).replaceAll("export ", "");
const R = new Function(pure + "; return { gripTint, dragRect, zoneEdge, boxFromGrip, sizeFromGrip, movedEnough, catcherAction, idleAction, IDLE_MS, TERM_MIN, TERM_EDGE, TERM_CORNER, ACTIVE };")();
const st = fs.readFileSync(DIR + "state.js", "utf8");
const a = st.indexOf("export const TERM_SIZES"), b = st.indexOf("// `at`: the top left");
const c = st.indexOf("export function nextTermSize"), d = st.indexOf("// A custom size's share");
const S = new Function(st.slice(a, b).replaceAll("export ", "") + st.slice(c, d).replaceAll("export ", "") + "; return { nextTermSize, termDims };")();

let bad = 0;
const eq = (n, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); const ok = g === w; if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${g} (want ${w})`); };
const start = { x: 100, y: 50, w: 800, h: 500 };
const app = { width: 1600, height: 1000 };

// dragRect
eq("e grows width", R.dragRect(start, "e", 120, 40, app), { x: 100, y: 50, w: 920, h: 500 });
eq("s grows height", R.dragRect(start, "s", 40, 90, app), { x: 100, y: 50, w: 800, h: 590 });
eq("se grows both", R.dragRect(start, "se", -100, -50, app), { x: 100, y: 50, w: 700, h: 450 });
eq("e keeps the minimum width", R.dragRect(start, "e", -700, 0, app), { x: 100, y: 50, w: R.TERM_MIN.w, h: 500 });
eq("s keeps the minimum height", R.dragRect(start, "s", 0, -900, app), { x: 100, y: 50, w: 800, h: R.TERM_MIN.h });
eq("e stops at the app's right edge", R.dragRect(start, "e", 5000, 0, app), { x: 100, y: 50, w: 1500, h: 500 });
eq("s stops at the app's bottom", R.dragRect(start, "s", 0, 5000, app), { x: 100, y: 50, w: 800, h: 950 });
eq("no app size: no upper bound", R.dragRect(start, "e", 5000, 0, null), { x: 100, y: 50, w: 5800, h: 500 });
eq("w moves the left edge, right stays", R.dragRect(start, "w", -50, 0, app), { x: 50, y: 50, w: 850, h: 500 });
eq("n stops at the top", R.dragRect(start, "n", 0, -500, app), { x: 100, y: 0, w: 800, h: 550 });
eq("fractions round", R.dragRect(start, "se", 10.4, 10.6, app), { x: 100, y: 50, w: 810, h: 511 });

// zoneEdge: only the right edge, bottom edge and bottom-right corner resize
eq("ACTIVE", R.ACTIVE, ["e", "s", "se"]);
eq("e grip middle", R.zoneEdge("e", { x: 3, y: 200 }, { width: 6, height: 480 }), "e");
eq("e grip bottom end = se", R.zoneEdge("e", { x: 3, y: 475 }, { width: 6, height: 480 }), "se");
eq("e grip top end stays e (ne not active)", R.zoneEdge("e", { x: 3, y: 2 }, { width: 6, height: 480 }), "e");
eq("s grip right end = se", R.zoneEdge("s", { x: 780, y: 3 }, { width: 786, height: 6 }), "se");
eq("s grip left end stays s", R.zoneEdge("s", { x: 2, y: 3 }, { width: 786, height: 6 }), "s");
eq("corner grip", R.zoneEdge("se", { x: 1, y: 1 }, { width: 6, height: 6 }), "se");
eq("no press point", R.zoneEdge("e", null, null), "e");

// boxFromGrip + sizeFromGrip: the window's box from where a grip sits (border 1, edge 6)
const size = { w: 800, h: 500 };
eq("e grip box", R.boxFromGrip("e", { x: 893, y: 57, width: 6, height: 486 }, size), { x: 100, y: 50, w: 800, h: 500 });
eq("s grip box", R.boxFromGrip("s", { x: 107, y: 543, width: 786, height: 6 }, size), { x: 100, y: 50, w: 800, h: 500 });
eq("se grip box", R.boxFromGrip("se", { x: 893, y: 543, width: 6, height: 6 }, size), { x: 100, y: 50, w: 800, h: 500 });
eq("size from e grip", R.sizeFromGrip("e", { width: 6, height: 486 }, { w: 1, h: 1 }), { w: 1, h: 500 });
eq("size from s grip", R.sizeFromGrip("s", { width: 786, height: 6 }, { w: 1, h: 1 }), { w: 800, h: 1 });
eq("size from a corner: unchanged", R.sizeFromGrip("se", { width: 6, height: 6 }, { w: 3, h: 4 }), { w: 3, h: 4 });

// termDims
eq("custom px", S.termDims("custom", [900, 520]), [900, 520]);
eq("custom without px = default share", S.termDims("custom", null), [0.7, 0.7]);
eq("preset share", S.termDims("large", [900, 520]), [0.85, 0.85]);

// nextTermSize with a custom size
eq("custom 0.6 + larger", S.nextTermSize("custom", "larger", 0.6), "default");
eq("custom 0.6 + smaller", S.nextTermSize("custom", "smaller", 0.6), "small");
eq("custom 0.5 + smaller stays", S.nextTermSize("custom", "smaller", 0.5), "custom");
eq("custom 0.99 + larger stays", S.nextTermSize("custom", "larger", 0.99), "custom");
eq("custom 0.7 + larger skips the same size", S.nextTermSize("custom", "larger", 0.7), "large");
eq("custom, unknown share + larger", S.nextTermSize("custom", "larger", null), "large");
eq("custom, unknown share + smaller", S.nextTermSize("custom", "smaller", null), "small");
eq("toggle custom → full", S.nextTermSize("custom", "toggle", 0.6), "full");
eq("toggle full → back to custom", S.nextTermSize("full", "toggle", null, "custom"), "custom");
eq("toggle full → back to large", S.nextTermSize("full", "toggle", null, "large"), "large");
eq("toggle full, no back → default", S.nextTermSize("full", "toggle", null, null), "default");
eq("preset steps unchanged", S.nextTermSize("default", "larger"), "large");
eq("grip tint: accent at 25%", R.gripTint({ accent: "#3b82f6", hover: "#222222" }), "#3b82f640");
eq("grip tint: odd accent → hover", R.gripTint({ accent: "rgb(1,2,3)", hover: "#222222" }), "#222222");
// catcherAction (s8 11-12): the catcher applies on a press or release once the outline moved; a release
// before any move keeps following; a press before any move cancels.
const START = { x: 256, y: 117, w: 850, h: 740 };
eq("movedEnough: same box", R.movedEnough(START, { ...START }), false);
eq("movedEnough: 1 px wider", R.movedEnough(START, { ...START, w: 851 }), false);
eq("movedEnough: 2 px taller", R.movedEnough(START, { ...START, h: 742 }), true);
eq("movedEnough: no outline", R.movedEnough(START, null), false);
eq("catcherAction: release after a drag → apply", R.catcherAction("up", START, { ...START, w: 1000 }), "apply");
eq("catcherAction: click after following → apply", R.catcherAction("down", START, { ...START, h: 600 }), "apply");
eq("catcherAction: release before any move → wait", R.catcherAction("up", START, { ...START }), "wait");
eq("catcherAction: click without moving → cancel", R.catcherAction("down", START, { ...START }), "cancel");
eq("catcherAction: no start → cancel on click", R.catcherAction("down", null, null), "cancel");
// idleAction (try 5: the catcher hears moves only while the button is down, never the release).
eq("idleAction: moves still coming → wait", R.idleAction(1000, 1000 - R.IDLE_MS + 1, START, { ...START, w: 1000 }), null);
eq("idleAction: at rest after a drag → apply", R.idleAction(1000, 1000 - R.IDLE_MS, START, { ...START, w: 1000 }), "apply");
eq("idleAction: at rest with no drag → cancel", R.idleAction(5000, 1000, START, { ...START }), "cancel");
eq("idleAction: try 5's drag (pointer 1385,946 → 868,802, smaller) → apply", R.idleAction(5000, 1000, START, R.dragRect(START, "se", 868 - 1385, 802 - 946, null)), "apply");
process.exit(bad ? 1 : 0);
