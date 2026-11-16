// The terminal window follows the shown tab and stays clear of the tab list (owner 11-13: "i cant click on tabs
// here nothing happens": a window dragged big covered the tab list once the app got narrower, and a click on a
// visible tab left the window on the old tab). state.js keepTerminal / termWindowDims / terminalWindow.
// Run: node test-termfollow.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
import { MOD } from "./paths.mjs";
import fs from "node:fs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const tr = fs.readFileSync(MOD + "termresize.js", "utf8");
const R = new Function(tr.slice(tr.indexOf("// <pure>"), tr.indexOf("// </pure>")).replaceAll("export ", "") + "; return { fitTerm, termAt, TERM_MARGIN };")();
const st = fakeShared();
const geom = { w: 0, h: 0, app: null };
const opened = [], closed = [];
let n = 0, active = "tb1";
const space = () => ({ id: "sp1", active: true, tabs: [{ id: "tb1", active: active === "tb1" }, { id: "tb2", active: active === "tb2" }, { id: "tb3", active: active === "tb3" }] });
const agentList = [{ address: "t1", tab: "tb1", tab_name: "One" }, { address: "t2", tab: "tb2", tab_name: "Two" }];
let windowsJson = null;
const settings = { terminal_size: "custom", terminal_px: [1079, 996] };
const state = await loadMod("state.js", {
  herdr: { ...st, agents: () => agentList, panes: () => [], spaces: () => [space()], focused: () => null,
    openOverlay: (spec) => { opened.push({ terminal: JSON.stringify(spec).match(/"terminal":"([^"]+)"/)?.[1], w: spec.width, h: spec.height, at: spec.at ?? null }); return `ov${++n}`; },
    closeOverlay: (id) => { closed.push(id); }, appHome: () => "/h", readTextFile: async (p) => (p === "/h/windows.json" ? windowsJson : null) },
  "./config.js": { setting: (k) => settings[k] ?? null, setSettings: async () => true, setSetting: async () => true },
  "./termresize.js": { gripFrame: (inner) => [inner], geom, fitTerm: R.fitTerm, termAt: R.termAt },
});
const M = R.TERM_MARGIN;

// Nothing measured yet: the setting as it is (the window opens as before).
state.openTerminal(agentList[0]);
eq("opens at the saved size before any measure", opened.at(-1), { terminal: "t1", w: 1079, h: 996, at: null });
// The owner's app: 1227×1055, both sidebars shown (250), the window remembered at (132, 24).
st.setShared("flockbook.sidebar", true);
st.setShared("flockbook.window.height", 1055);
for (const [k, v] of [["flockbook.work.width", 727], ["flockbook.side.width", 250], ["flockbook.list.width", 250], ["flockbook.terminal.place", { x: 132, y: 24 }]]) st.setShared(k, v);
opened.length = 0;
state.keepTerminal();
eq("measured: reopens in place, clear of the tab list", opened, [{ terminal: "t1", w: 250 + 727 - M - 132, h: 996, at: null }]);
opened.length = 0;
state.keepTerminal();
eq("then nothing more while nothing changes", opened, []);
// The app got wider: the window grows back toward its saved size.
st.setShared("flockbook.work.width", 1500);
state.keepTerminal();
eq("wider app: back to the saved size", opened.at(-1), { terminal: "t1", w: 1079, h: 996, at: null });
st.setShared("flockbook.work.width", 727);
state.keepTerminal();
// A click on another tab: the window shows that tab's terminal.
opened.length = 0;
active = "tb2";
state.keepTerminal();
eq("another tab: its terminal", opened.map((o) => o.terminal), ["t2"]);
eq("…shown", state.termShown()?.address, "t2");
opened.length = 0;
state.keepTerminal();
eq("…once", opened, []);
// A tab with no terminal: the window closes.
closed.length = 0;
active = "tb3";
state.keepTerminal();
eq("a tab with no terminal: closed", [closed.length, state.termShown()], [1, null]);
// The sidebar's 🔌 opens another tab's agent: no follow until the shown tab changes.
active = "tb1";
state.answerInTerminal(agentList[1]);
opened.length = 0;
state.keepTerminal();
eq("🔌 window for another tab stays", [opened.length, state.termShown()?.address], [0, "t2"]);
active = "tb2";
state.keepTerminal();
eq("the shown tab changes to its own: stays (same terminal)", [opened.length, state.termShown()?.address], [0, "t2"]);
// Full size (⤢) covers the app on purpose: not fitted.
settings.terminal_size = "full";
opened.length = 0;
state.keepTerminal();
eq("full: as Herdr's share", opened.at(-1), { terminal: "t2", w: 0.97, h: 0.97, at: null });
// A window never dropped: centered in the work column.
settings.terminal_size = "custom";
st.setShared("flockbook.terminal.place", null);
state.openTerminal(null);   // close
state.openTerminal(agentList[0]);
const w = 727 - 2 * M;
eq("no spot: centered in the work column", opened.at(-1), { terminal: "t1", w, h: 996, at: { x: 250 + Math.round((727 - w) / 2), y: Math.round((1055 - 996) / 2) } });
// The sidebar hidden: the column starts at 0.
st.setShared("flockbook.sidebar", false);
st.setShared("flockbook.terminal.place", { x: 40, y: 24 });
opened.length = 0;
state.keepTerminal();
eq("sidebar hidden: room from 0", opened.at(-1)?.w, Math.min(1079, 0 + 727 - M - 40));
// Herdr's remembered spot, from windows.json (at most every 2 s; a bad file: none).
windowsJson = JSON.stringify({ places: { "flockbook-terminal": [210, 30], other: [1, 2] } });
await state.readTermPlace(1_000_000);
eq("spot read from windows.json", st.shared("flockbook.terminal.place"), { x: 210, y: 30 });
windowsJson = "not json";
await state.readTermPlace(1_001_000);
eq("…not again within 2 s", st.shared("flockbook.terminal.place"), { x: 210, y: 30 });
await state.readTermPlace(1_003_000);
eq("a bad file: no spot", st.shared("flockbook.terminal.place") ?? null, null);
process.exit(bad ? 1 : 0);
