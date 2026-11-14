// s29 (owner 11-14 "Yes, save the first one"): the first real MCP input request seen on any tab is saved once, as its
// screen text, to <app home>/flockbook/elicit-capture.txt, so its real layout can be compared with the modelled one.
// Only a screen whose dialog title stands alone on its line counts (a chat line quoting the title does not); a file
// already there is never replaced; nothing is ever sent to the terminal. Run: node test-elicitcapture.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const HOME = "/Users/you/.config/herdr-app", FILE = `${HOME}/flockbook/elicit-capture.txt`;
const R = "─".repeat(60);
const DIALOG = ["⏺ Running the check", "", R, " MCP server “supabase” requests your input", "", " Run it on project shop?", "", " ❯ Accept    Decline", "", " Esc to cancel"].join("\n");
const ODD = ["⏺ Running", R, " MCP server “supabase” requests your input", " Run it?", " (y) yes  (n) no"].join("\n");
const QUOTED = ["⏺ The card shows 'MCP server “supabase” requests your input' when it asks.", "", R, "❯ ", R].join("\n");

async function setup({ screens = {}, agents = [], files = {} } = {}) {
  const st = fakeShared(), writes = [], sent = [];
  const herdr = {
    ...st, appHome: () => HOME, home: () => "/Users/you", agents: () => agents, exec: async () => ({ code: 1, stdout: "" }),
    hc: async (args) => { if (args[0] === "read") return { code: 0, stdout: screens[args[1]] ?? "" }; sent.push(args); return { code: 0, stdout: "" }; },
    readTextFile: async (p) => files[p] ?? null,
    writeTextFile: async (p, text, expected) => { if ((files[p] ?? null) !== expected) throw new Error("stale"); files[p] = text; writes.push(p); return null; },
  };
  const m = await loadMod("asks.js", { herdr, "./config.js": { setting: () => "off" }, "./sidecar.js": { send: async (...a) => { sent.push(a); return {}; } } });
  return { m, files, writes, sent };
}
{
  const { m, files, writes, sent } = await setup();
  eq("capture: a real dialog is saved", await m.captureElicit("pc-wsl/t3", DIALOG), true);
  eq("capture: written to the app home's flockbook folder", writes, [FILE]);
  eq("capture: the header names the tab, the server and what the readers made of it", /pc-wsl\/t3/.test(files[FILE]) && /supabase/.test(files[FILE]) && /answerable/.test(files[FILE]) && /selection accept/.test(files[FILE]), true);
  eq("capture: the whole screen follows", files[FILE].endsWith(DIALOG + "\n"), true);
  eq("capture: only the first one", await m.captureElicit("t9", DIALOG.replace("shop", "other")), false);
  eq("capture: file unchanged", /shop/.test(files[FILE]) && !/other/.test(files[FILE]), true);
  eq("capture: nothing sent to any terminal", sent, []);
}
{
  const { m, writes } = await setup();
  eq("capture: a chat line quoting the title is not a dialog", await m.captureElicit("t1", QUOTED), false);
  eq("capture: …and leaves the capture for a real one", await m.captureElicit("t1", ODD), true);
  eq("capture: one written", writes.length, 1);
}
{
  const { m, files } = await setup();
  await m.captureElicit("t2", ODD);
  eq("capture: a layout neither reader knows is still saved, marked NOT read", /NOT read/.test(files[FILE]), true);
}
{
  const { m, writes } = await setup({ files: { [FILE]: "earlier capture\n" } });
  eq("capture: a file already there is kept (another view or an earlier run)", [await m.captureElicit("t1", DIALOG), writes], [false, []]);
}
{
  // The asks tick saves it from whatever screen it reads, blocked or not (Herdr may not mark the tab blocked).
  const agents = [{ address: "t1", status: "idle", title: "Chat", app: "claude-code" }, { address: "pc-wsl/t4", status: "blocked", title: "DB", app: "claude-code" }];
  const { m, files, sent } = await setup({ agents, screens: { t1: QUOTED, "pc-wsl/t4": DIALOG } });
  await m.asksTick();
  await new Promise((r) => setTimeout(r, 10));
  eq("tick: the blocked tab's dialog is captured", /pc-wsl\/t4/.test(files[FILE] ?? ""), true);
  eq("tick: nothing sent", sent, []);
}
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log("all passed");
