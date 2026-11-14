// Codex review 11-12 P2: a drag on the terminal window's grip resized "the selected agent's" terminal, so with
// agent B's window open (the sidebar's 🔌) while A is selected, the let-go reopened A. The grip now names its
// window's terminal, and only that window is reopened. state.js termShown / applyTermRect. Run: node test-termrect.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const st = fakeShared();
const opened = [], saved = [];
let n = 0;
const terminalOf = (spec) => JSON.stringify(spec).match(/"terminal":"([^"]+)"/)?.[1] ?? null;
const state = await loadMod("state.js", {
  herdr: { ...st, agents: () => [], panes: () => [], spaces: () => [], openOverlay: (spec) => { opened.push(terminalOf(spec)); return `ov${++n}`; }, closeOverlay: () => {} },
  "./config.js": { setting: () => null, setSettings: async (o) => { saved.push(o); return true; }, setSetting: async () => true },
  "./termresize.js": { gripFrame: (inner) => [inner], geom: {}, fitTerm: (want) => want, termAt: () => null },
});
const A = { address: "tA", name: "Agent A" }, B = { address: "tB", name: "Agent B" };
eq("nothing open", state.termShown(), null);
state.answerInTerminal(B);
eq("B's window open", state.termShown()?.address, "tB");
opened.length = 0;
await state.applyTermRect({ x: 1, y: 2, w: 800, h: 600 }, "tB", "Agent B", true);
eq("drag on B's grip reopens B", opened, ["tB"]);
eq("size saved", saved.at(-1), { terminal_size: "custom", terminal_px: [800, 600] });
opened.length = 0;
await state.applyTermRect({ x: 1, y: 2, w: 700, h: 500 }, "tA", "Agent A", true);
eq("a stale drag for A doesn't swap B's window", opened, []);
eq("…its size is still saved", saved.at(-1).terminal_px, [700, 500]);
eq("B still shown", state.termShown()?.address, "tB");
state.openTerminal(A);   // open → closes B's window
eq("closed", state.termShown(), null);
opened.length = 0;
await state.applyTermRect({ x: 1, y: 2, w: 640, h: 480 }, "tB", "Agent B", true);
eq("no window open: nothing reopened", opened, []);
process.exit(bad ? 1 : 0);
