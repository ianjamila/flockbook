// Codex review 11-12 P1: "Send anyway" types with hc send, which has no agent / conversation check. It must look the
// terminal's log up again (sidecar.currentLog) and type nothing when a /clear, /resume or another agent replaced the
// conversation since the refusal. Codex recheck 11-12: currentLog fails closed (a failed `status`, or an entry not
// re-located during the call → null); submit keeps ONE `seen` for the send and the offer; no Send anyway for a
// terminal on another machine. Run: node test-sendanyway.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

// A fake helper: `status` re-locates the terminal's log (the cache gets `live`, checked now in SECONDS, like
// locate.rs), like the real one after recheckLog. `relocate`: false = status answers but leaves the cache alone
// (the mark did not stick); `fail`: status answers with an error line.
const OLD = "/logs/a.jsonl", NEW = "/logs/b.jsonl";
let live = { kind: "claude", path: OLD }, files = {}, relocate = true, fail = false, markSticks = true;
const CACHE = "/home/flockbook/cache.json";
const OK = '{"type":"header","protocol":1}\n{"type":"end","ok":true}\n';
const ERR = '{"type":"header","protocol":1}\n{"type":"error","code":"no-core","message":"herdr-core is not running"}\n{"type":"end","ok":false}\n';
const herdrSide = {
  appHome: () => "/home",
  readTextFile: async (p) => files[p] ?? null,
  writeTextFile: async (p, t) => { if (!markSticks) throw new Error("changed meanwhile"); files[p] = t; },
  exec: async (_bin, argv) => {
    if (argv[0] !== "status") return { code: 0, stdout: OK, stderr: "" };
    if (fail) return { code: 0, stdout: ERR, stderr: "" };
    if (relocate) files[CACHE] = JSON.stringify({ entries: { t1: { ...live, cwd: "/x", pids: [1], checked: Date.now() / 1000 } } });
    return { code: 0, stdout: OK, stderr: "" };
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

// Recheck P1: fail closed. A fresh-looking but stale cache entry must not pass.
const stale = () => { files[CACHE] = JSON.stringify({ entries: { t1: { kind: "claude", path: OLD, checked: Date.now() / 1000 - 10 } } }); };
stale(); fail = true;
eq("currentLog: status failed → null (not the cached log)", await sidecar.currentLog("t1"), null);
fail = false; stale(); relocate = false;
eq("currentLog: status did not re-locate → null", await sidecar.currentLog("t1"), null);
stale(); markSticks = false;
eq("currentLog: the stale mark did not stick, nothing re-located → null", await sidecar.currentLog("t1"), null);
relocate = true;
eq("currentLog: mark did not stick but status re-located anyway → the new entry", await sidecar.currentLog("t1"), { kind: "claude", path: NEW });
markSticks = true;
files[CACHE] = JSON.stringify({ entries: { t1: { kind: "claude", path: OLD, checked: "soon" } } }); relocate = false;
eq("currentLog: no numeric checked → null", await sidecar.currentLog("t1"), null);
relocate = true;

// sendAnyway itself, on a stand-in composer.
const calls = [];
const RULE = "─".repeat(40), oneLine = `${RULE}\n❯ \n${RULE}\n`, suggestion = `${RULE}\n❯ /compact\n${RULE}\n`;
let screen = oneLine;
let sendReply = { lines: [{ type: "done", result: "sent" }], error: null };
const sent = [];
const sidecarForComposer = { ...sidecar, send: async (...args) => { sent.push(args[3]); return sendReply; } };
const composer = await loadMod("composer.js", {
  herdr: { hc: async (args) => { calls.push(args[0]); return args[0] === "read" ? { code: 0, stdout: JSON.stringify({ text: screen }) } : { code: 0, stdout: JSON.stringify({ started: true }) }; } },
  "./sidecar.js": sidecarForComposer,
  "./asks.js": { answered: () => {} },
});
const cx = { notify: () => {}, timer: { after: (_ms, f) => f() } };
const fake = (seen, address = "t1") => ({ address, sending: false, note: { anyway: { address, text: "hello", files: [], seen } }, input: { value: () => "" }, keepSoon: () => {}, setText: () => {} });

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

// Recheck P1 end to end: the lookup fails → nothing typed.
live = { kind: "claude", path: OLD }; fail = true;
c = fake({ agent: "claude", path: OLD });
calls.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: lookup failed → nothing typed", calls, []);
fail = false;

// Recheck P2: a terminal on another machine never gets Send anyway (its log is looked up there).
eq("isRemote", [composer.isRemote("box/t7"), composer.isRemote("t7"), composer.isRemote(null)], [true, false, false]);
c = fake({ agent: "claude", path: OLD }, "box/t7");
calls.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: remote terminal → nothing typed", calls, []);

// submit on a stand-in: the box shows a lone "/compact" (box_not_empty). `seenLog` changes between the first and a
// later read, as when the chat catches up with a /clear while the send is out.
const submitFake = (address, seenLog) => {
  const o = {
    address, sending: false, note: null, typed: ["", ""], cmds: new Map(), slashClosed: null, slashFor: () => null,
    files: [], drafts: new Map(), input: { value: () => "hello" }, keepSoon: () => {}, setText: () => {},
    seenCalls: 0,
  };
  o.seen = () => seenLog[Math.min(o.seenCalls++, seenLog.length - 1)];
  return o;
};
screen = suggestion;
sendReply = { lines: [{ type: "done", result: "box_not_empty", message: "The terminal's box has text in it." }], error: null };
const first = { agent: "claude", path: OLD }, later = { agent: "claude", path: NEW };
let s = submitFake("t1", [first, later]);
sent.length = 0; await composer.Composer.prototype.submit.call(s, cx);
eq("submit: the send checks the conversation shown at Send", sent, [first]);
eq("submit: the offer keeps that SAME conversation", s.note?.anyway?.seen, first);
eq("submit: seen read once", s.seenCalls, 1);
s = submitFake("box/t7", [first]);
await composer.Composer.prototype.submit.call(s, cx);
eq("submit: remote box_not_empty → no Send anyway, the sidecar's note", [Boolean(s.note?.anyway), s.note?.text], [false, "The terminal's box has text in it."]);
process.exit(bad ? 1 : 0);
