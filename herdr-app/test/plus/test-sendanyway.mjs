// Codex review 11-12 P1: "Send anyway" types with hc send, which has no agent / conversation check. It must look the
// terminal's log up again (sidecar.currentLog) and type nothing when a /clear, /resume or another agent replaced the
// conversation since the refusal. Run: node test-sendanyway.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

// A fake helper: `status` re-locates the terminal's log (the cache gets `live`), like the real one after recheckLog.
const OLD = "/logs/a.jsonl", NEW = "/logs/b.jsonl";
let live = { kind: "claude", path: OLD }, files = {};
const CACHE = "/home/flockbook/cache.json";
const herdrSide = {
  appHome: () => "/home",
  readTextFile: async (p) => files[p] ?? null,
  writeTextFile: async (p, t) => { files[p] = t; },
  exec: async (_bin, argv) => {
    if (argv[0] === "status") files[CACHE] = JSON.stringify({ entries: { t1: { ...live, cwd: "/x", pids: [1], checked: Date.now() } } });
    return { code: 0, stdout: "", stderr: "" };
  },
};
const sidecar = await loadMod("sidecar.js", { herdr: herdrSide });

eq("same: nothing seen", sidecar.sameConversation(null, null), true);
eq("same: same log", sidecar.sameConversation({ agent: "claude", path: OLD }, { kind: "claude", path: OLD }), true);
eq("same: another log", sidecar.sameConversation({ agent: "claude", path: OLD }, { kind: "claude", path: NEW }), false);
eq("same: another agent", sidecar.sameConversation({ agent: "claude", path: null }, { kind: "codex", path: null }), false);
eq("same: can't tell now", sidecar.sameConversation({ agent: "claude", path: OLD }, null), false);
files[CACHE] = JSON.stringify({ entries: { t1: { kind: "claude", path: OLD, checked: 5 } } });
eq("currentLog: re-looked up", await sidecar.currentLog("t1"), { kind: "claude", path: OLD });
live = { kind: "claude", path: NEW };
eq("currentLog: after a /clear", await sidecar.currentLog("t1"), { kind: "claude", path: NEW });
eq("currentLog: unknown terminal", await sidecar.currentLog("t9"), null);

// sendAnyway itself, on a stand-in composer.
const calls = [];
const RULE = "─".repeat(40), oneLine = `${RULE}\n❯ \n${RULE}\n`;
const composer = await loadMod("composer.js", {
  herdr: { hc: async (args) => { calls.push(args[0]); return args[0] === "read" ? { code: 0, stdout: JSON.stringify({ text: oneLine }) } : { code: 0, stdout: JSON.stringify({ started: true }) }; } },
  "./sidecar.js": sidecar,
  "./asks.js": { answered: () => {} },
});
const cx = { notify: () => {}, timer: { after: (_ms, f) => f() } };
const fake = (seen) => ({ address: "t1", sending: false, note: { anyway: { address: "t1", text: "hello", files: [], seen } }, input: { value: () => "" }, keepSoon: () => {}, setText: () => {} });

live = { kind: "claude", path: OLD };
let c = fake({ agent: "claude", path: OLD });
calls.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: same conversation → clears and sends", calls, ["keys", "read", "send"]);
eq("anyway: sent note", c.note?.bad, false);

live = { kind: "claude", path: NEW };
c = fake({ agent: "claude", path: OLD });
calls.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: /clear since the refusal → nothing typed", calls, []);
eq("anyway: says why", /another conversation/.test(c.note?.text ?? ""), true);

live = { kind: "codex", path: OLD };
c = fake({ agent: "claude", path: OLD });
calls.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: another agent → nothing typed", calls, []);
process.exit(bad ? 1 : 0);
