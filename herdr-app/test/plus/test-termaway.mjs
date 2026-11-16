// The terminal window steps aside for Needs you and Overview (owner 11-13 16:36: "needs you is lagging. im clicking it
// but its not going there" — "nevermind terminal was blocking it"): switching TO one of those screens closes the open
// window and remembers it; switching back to a chat reopens it for the shown tab. A window opened while one of those
// screens shows (its "Answer in terminal") stays. state.js keepTerminal. Run: node test-termaway.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const st = fakeShared();
const opened = [], closed = [];
let n = 0, active = "tb1";
const space = () => ({ id: "sp1", active: true, tabs: [{ id: "tb1", active: active === "tb1" }, { id: "tb2", active: active === "tb2" }, { id: "tb3", active: active === "tb3" }] });
const agentList = [{ address: "t1", tab: "tb1", tab_name: "One" }, { address: "t2", tab: "tb2", tab_name: "Two" }, { address: "t4", tab: "tb4", tab_name: "Four" }];
// A second workspace (not shown) whose shown tab tb4 runs t4.
const space2 = { id: "sp2", active: false, tabs: [{ id: "tb4", active: true }] };
const state = await loadMod("state.js", {
  herdr: { ...st, agents: () => agentList, panes: () => [], spaces: () => [space(), space2], focused: () => null, run: () => null,
    openOverlay: (spec) => { opened.push(JSON.stringify(spec).match(/"terminal":"([^"]+)"/)?.[1]); return `ov${++n}`; },
    closeOverlay: (id) => { closed.push(id); }, appHome: () => "/h", readTextFile: async () => null },
  "./config.js": { setting: () => null, setSettings: async () => true, setSetting: async () => true },
  "./termresize.js": { gripFrame: (inner) => [inner], geom: {}, fitTerm: (w) => w, termAt: () => null },
});
const tick = () => state.keepTerminal();
const reset = () => { opened.length = 0; closed.length = 0; };

state.showScreen("chat");
state.openTerminal(agentList[0]);
tick();
eq("chat with the window open: it stays", state.termShown()?.address, "t1");

reset();
state.showScreen("needs");
tick();
eq("to Needs you: the window closes", [closed.length, state.termShown()], [1, null]);
reset();
tick(); tick();
eq("…and stays closed on Needs you", [opened, closed], [[], []]);

reset();
state.showScreen("overview");
tick();
eq("Needs you → Overview: still away, nothing opens", opened, []);

reset();
state.showScreen("chat");
tick();
eq("back to the chat: it reopens for the shown tab", [opened, state.termShown()?.address], [["t1"], "t1"]);
reset();
tick();
eq("…once", opened, []);

// Away, then a click on another tab (its chat): it comes back on that tab's terminal.
state.showScreen("overview");
tick();
reset();
active = "tb2";
state.showScreen("chat");
tick();
eq("back on another tab: that tab's terminal", [opened, state.termShown()?.address], [["t2"], "t2"]);

// Away, then back to a tab with no terminal: nothing opens, and nothing is left to reopen later.
state.showScreen("needs");
tick();
reset();
active = "tb3";
state.showScreen("chat");
tick();
eq("back on a tab with no terminal: nothing opens", opened, []);
active = "tb1";
tick();
eq("…and it does not reopen later by itself", opened, []);

// A window opened ON Needs you ("Answer in terminal") stays there.
state.showScreen("needs");
tick();
reset();
state.answerInTerminal(agentList[1]);
tick(); tick();
eq("opened on Needs you: it stays", [closed.length, state.termShown()?.address], [0, "t2"]);
// …and going back to the chat does not open a second one.
reset();
state.showScreen("chat");
tick();
eq("…back to the chat: no second window", [opened.length, closed.length], [0, 0]);

// Away, then the settings dialog (it opens over any screen): not back yet; then the chat: back.
state.showScreen("overview"); tick();
reset();
state.showScreen("settings"); tick();
eq("settings over Overview: still away", opened, []);
state.showScreen("chat"); tick();
eq("…then the chat: back", opened, ["t1"]);

// No window open: switching screens never opens one.
state.openTerminal(null);   // closes it
reset();
state.showScreen("needs"); tick();
state.showScreen("chat"); tick();
eq("never open: never opens", opened, []);

// In the click itself, not on the next sync (owner 11-13 16:50: "it comes back but with a delay. it goes to flockbook
// first but after one second goes to terminal so its eye straining"): the switch puts the window away and brings it
// back at once, for the tab it goes to — no tick in between.
active = "tb1";
state.showScreen("chat"); tick();
state.openTerminal(agentList[0]); tick();
reset();
state.showNeeds();
eq("Needs you: away at once (no sync)", [closed.length, state.termShown()], [1, null]);
reset();
active = "tb1";   // Herdr has not shown the clicked tab yet when the click runs
state.showTab({ id: "tb2", name: "Two" });
eq("a tab clicked: its terminal at once (no sync), not the tab still shown", opened, ["t2"]);
reset();
tick(); tick();
eq("…and the sync opens nothing more", [opened, closed], [[], []]);
state.showOverview();
reset();
state.showAgent("t2");   // tab tb1 still shows when the click runs
eq("Open chat on an agent: its terminal at once", opened, ["t2"]);
// A workspace clicked: that space's shown tab's terminal (sp2 shows tb4 → t4) at once, not the old space's first.
state.showNeeds();
reset();
state.showSpace("sp2");
eq("a workspace clicked: its shown tab's terminal at once", opened, ["t4"]);
state.showNeeds();
reset();
state.openTab("sp1", { id: "tb3", name: "3" });
eq("a tab with no terminal: nothing opens", opened, []);
tick();
eq("…and nothing later", opened, []);

// The wiring (owner 11-13 16:45: "steps aside, no return"): top.js's screen sync called keepTerminal only while a window
// was open, so once it was put away nothing ever brought it back. The sync must call it on every run.
{
  const { MOD } = await import("./paths.mjs");
  const fs = await import("node:fs");
  const top = fs.readFileSync(MOD + "top.js", "utf8");
  const body = top.slice(top.indexOf("export function syncScreen"), top.indexOf("export function syncScreen") + 600);
  eq("top.js syncScreen calls keepTerminal on every run, not only while a window is open",
    /\n\s*keepTerminal\(\);/.test(body) && !/if \(shared\(KEY_TERM\)\) \{ keepTerminal\(\)/.test(body), true);
}
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
