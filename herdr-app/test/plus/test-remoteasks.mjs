// Tabs on another machine (owner 11-14: "Buttons for PC tabs"): asks.js reads their screens too (`hc read pc-wsl/t3`
// reaches the PC through Herdr), so an extra-round or merge ask there gets Needs you's and the chat strip's button, and
// grantAsk sends the words through the helper (the local helper hands a `pc-wsl/t3` send to the PC's). A PC with no
// Flockbook helper yet: the note says to open its chat (the install card is there). Run: node test-remoteasks.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const RULE = "─".repeat(60);
const screen = (last, footer = "  you:~/webshop | WORK") => ["❯ do the thing", "⏺ Two fixes applied, recheck done.", `  ${last}`, "",
  "✻ Worked for 2s · done 4:07 PM", RULE, "❯ ", RULE, footer].join("\n");
const ROUND = "🔁 Extra review round needed #99999: round 3 · items abc123 · repo demo-org/demo-repo";
const MERGE = "🔀 Ready to merge #4242 — say \"merge\"";

async function setup({ screens, sendResult = { lines: [{ type: "done", result: "sent" }] }, list }) {
  const st = fakeShared({});
  const reads = [], sent = [];
  const herdr = {
    ...st,
    agents: () => list,
    panes: () => [],
    home: () => "/Users/me",
    appHome: () => "/Users/me/.config/herdr-app",
    readTextFile: async () => null,
    writeTextFile: async () => null,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    hc: async (args) => { if (args[0] === "read") { reads.push(args[1]); return screens[args[1]] != null ? { code: 0, stdout: screens[args[1]] } : { code: 1, stdout: "" }; } return { code: 1, stdout: "" }; },
  };
  const m = await loadMod("asks.js", {
    herdr,
    "./sidecar.js": { send: async (t, words) => { sent.push([t, words]); return sendResult; } },
    "./config.js": { setting: () => "on" },
  });
  return { m, st, reads, sent };
}

const agent = (address, status = "idle", title = "Webshop") => ({ address, status, title, app: "claude-code", tab: `tab-${address}`, space: "sp" });

{
  const list = [agent("t1"), agent("pc-wsl/t3")];
  const { m, st, reads } = await setup({ list, screens: { t1: screen("All done."), "pc-wsl/t3": screen(ROUND, "  jamil:~/shop | WORK") } });
  await m.asksTick();
  eq("the PC tab's screen is read", reads.includes("pc-wsl/t3"), true);
  eq("its round ask is recorded", st.data["flockbook.asks"]?.["pc-wsl/t3"], { kind: "round", pr: 99999, round: 3 });
  eq("the Mac tab is read as before", reads.includes("t1"), true);
}
{
  const list = [agent("pc-wsl/t4", "idle", "🔀 Shop PR")];
  const { m, st } = await setup({ list, screens: { "pc-wsl/t4": screen(MERGE, "  jamil:~/shop | WORK") } });
  await m.asksTick();
  eq("a PC merge ask is recorded", st.data["flockbook.asks"]?.["pc-wsl/t4"]?.kind, "merge");
  const p = st.data["flockbook.prs"]?.["pc-wsl/t4"];
  eq("its PR is kept, with no folder (the PC's folders aren't on this Mac)", [p?.pr, p?.dir ?? null], [4242, null]);
}
{
  const list = [agent("pc-wsl/t5", "blocked")];
  const { m, reads } = await setup({ list, screens: { "pc-wsl/t5": screen("Waiting.") } });
  await m.asksTick();
  eq("a blocked PC tab is read too (MCP input / Now line)", reads, ["pc-wsl/t5"]);
}
{
  const { m, sent, st } = await setup({ list: [], screens: { "pc-wsl/t3": screen(ROUND) } });
  st.setShared("flockbook.asks", { "pc-wsl/t3": { kind: "round", pr: 99999, round: 3 } });
  const r = await m.grantAsk("pc-wsl/t3", { kind: "round", pr: 99999, round: 3 });
  eq("Extra round on a PC tab: sent through the helper to that address", sent, [["pc-wsl/t3", "extra round"]]);
  eq("sent note", r.sent, true);
}
{
  const missing = { error: { code: "remote_helper_missing", message: "pc-wsl has no Flockbook helper yet, so the chat cannot read its agents." }, lines: [] };
  const { m, sent } = await setup({ list: [], screens: { "pc-wsl/t3": screen(MERGE) }, sendResult: missing });
  const r = await m.grantAsk("pc-wsl/t3", { kind: "merge", pr: 4242 });
  eq("tried once", sent.length, 1);
  eq("no helper on the PC: says to open its chat to install it", [r.sent, r.bad, /pc-wsl/.test(r.text) && /Open its chat/.test(r.text) && /install/i.test(r.text)], [false, true, true]);
}

console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
