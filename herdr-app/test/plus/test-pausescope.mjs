// s37 (owner's PC banner, 11-15): the PC's Work login expired ("cannot be renewed") after a Summarize from the PC on a
// Mac tab; its Overview then said the Work account needs signing in and listed the MAC tab as likely paused, though the
// Mac's own Work login was fine. A sign-in pause is this computer's login: it names this computer and covers only tabs
// that run here (bare addresses; on Windows also the WSL machine Claude runs on). Out of usage stays account-wide.
// Run: node test-pausescope.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const now = Date.UTC(2026, 10, 15, 2, 0);
Date.now = () => now;

const st = fakeShared({
  "flockbook.ai.accounts": { "ians-macbook-pro-2/t2x": "EWI", "pc-wsl/t4": "EWI", t7: "EWI", "ians-macbook-pro-2/t9": "ME" },
  "flockbook.ai.cool": { EWI: { until: now + 3600_000, kind: "auth", message: "cannot be renewed", at: now - 1000 } },
});
const list = [
  { address: "ians-macbook-pro-2/t2x", title: "EagleWatch PR #2116", status: "done" },
  { address: "pc-wsl/t4", title: "WSL work", status: "working" },
  { address: "t7", title: "Windows tab", status: "idle" },
  { address: "ians-macbook-pro-2/t9", title: "Personal", status: "working" },
];
const herdr = { ...st, home: () => "/Users/you", appHome: () => "/x", agents: () => list, terminals: () => [], spaces: () => [] };
const machineOf = (address) => { const s = String(address ?? ""), i = s.lastIndexOf("/"); return i > 0 ? s.slice(0, i) : null; };
let windows = true;
const where = { claudeMachine: () => "pc-wsl", localWindows: () => windows, machineOf, NEEDS_MACHINE: "x" };
const accounts = { accountName: (a) => (a === "EWI" ? "Work account" : "Personal account"), accountOf: () => null, claudeRun: async () => null };
const ai = await loadMod("ai.js", { herdr, "./where.js": where, "./accounts.js": accounts, "./config.js": { setting: () => null }, "./state.js": { sessionTopic: (a) => a.title } });

const cool = ai.coolOf("EWI");
eq("sign-in pause: the PC's own WSL and Windows tabs, not the Mac's", ai.agentsOn("EWI").map((a) => a.address), ["pc-wsl/t4", "t7"]);
eq("coolCovers: a Mac tab is not covered by the PC's sign-in", ai.coolCovers(cool, "ians-macbook-pro-2/t2x"), false);
eq("coolCovers: a WSL tab on the PC is", ai.coolCovers(cool, "pc-wsl/t4"), true);
eq("the words name this computer", ai.pauseWords("EWI", cool, now), "Work account needs signing in again on this computer (claude auth login)");
// On a Mac (not Windows) a machine-named tab is another computer, even one named like claude_machine.
windows = false;
eq("off Windows: only bare addresses", ai.agentsOn("EWI").map((a) => a.address), ["t7"]);
windows = true;

// Out of usage: the account's, every computer's tabs.
st.setShared("flockbook.ai.cool", { EWI: { until: now + 3600_000, kind: "usage", message: "limit", at: now - 1000 } });
eq("usage pause: every tab on the account, Mac's too", ai.agentsOn("EWI").map((a) => a.address), ["ians-macbook-pro-2/t2x", "pc-wsl/t4", "t7"]);
eq("usage words keep the reset time", /^Work account is out of its Claude usage until /.test(ai.pauseWords("EWI", ai.coolOf("EWI"), now)), true);
eq("no pause: agentsOn lists the account's tabs", (st.setShared("flockbook.ai.cool", {}), ai.agentsOn("ME").map((a) => a.address)), ["ians-macbook-pro-2/t9"]);
process.exit(bad ? 1 : 0);
