// "Send anyway" after a box_not_empty that looked like Claude's dim "/word" suggestion. It goes through the helper
// where the terminal runs (`send --over-suggestion /word`, forwarded like every m/tN command), which checks the agent
// and the conversation there (--expect-kind / --expect-path), clears the box's line only when it shows exactly that
// lone word, and sends. So a terminal on another machine gets it too (report 11-14: "/clear" from the PC to a Mac tab
// was refused over Claude's "/handoff" suggestion, with no Send anyway). Earlier rules kept: submit keeps ONE `seen`
// for the send and the offer (Codex recheck 11-12); nothing is typed for another agent or conversation (the helper's
// check now, Codex review 11-12 P1). Run: node test-sendanyway.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

// The real sidecar.js over a fake helper: the argv `send` gets.
const argvs = [];
const OK = '{"type":"header","protocol":1}\n{"type":"done","result":"sent"}\n{"type":"end","ok":true}\n';
const sidecar = await loadMod("sidecar.js", { herdr: {
  appHome: () => "/home", onWindows: () => false,
  exec: async (_bin, argv) => { argvs.push(argv); return { code: 0, stdout: OK, stderr: "" }; },
} });
const OLD = "/logs/a.jsonl", NEW = "/logs/b.jsonl";
const seen = { agent: "claude", path: OLD };
await sidecar.send("box/t7", "hello", [], seen, "/handoff");
const a = argvs.at(-1) ?? [];
const at = (o) => a.indexOf(o);
eq("send: --over-suggestion and its word", a[at("--over-suggestion") + 1], "/handoff");
eq("send: before the text (a text that reads like the option is never taken for it)", at("--over-suggestion") > -1 && at("--over-suggestion") < at("--text"), true);
eq("send: the conversation check still goes", [a[at("--expect-kind") + 1], a[at("--expect-path") + 1]], ["claude", OLD]);
await sidecar.send("t1", "hello", [], seen);
eq("send: a plain send has no --over-suggestion", (argvs.at(-1) ?? []).includes("--over-suggestion"), false);

// sendAnyway on a stand-in composer: every terminal, local or not, goes through the helper's send.
const calls = [], sent = [];
let sendReply = { lines: [{ type: "done", result: "sent" }], error: null };
const sidecarForComposer = { ...sidecar, send: async (...args) => { sent.push(args); return sendReply; } };
let screen = "";
const composer = await loadMod("composer.js", {
  herdr: { hc: async (args) => { calls.push(args[0]); return args[0] === "read" ? { code: 0, stdout: JSON.stringify({ text: screen }) } : { code: 0, stdout: JSON.stringify({ started: true }) }; } },
  "./sidecar.js": sidecarForComposer,
  "./asks.js": { answered: () => {} },
});
const cx = { notify: () => {}, timer: { after: (_ms, f) => f() } };
const fake = (address = "t1", text = "hello") => ({ address, sending: false, note: { anyway: { address, text, files: [], seen, word: "/handoff" } }, input: { value: () => text }, files: [], keepSoon: () => {}, setText: function (t) { this.typed = t; } });

for (const address of ["t1", "box/t7"]) {
  const c = fake(address);
  calls.length = 0; sent.length = 0; sendReply = { lines: [{ type: "done", result: "sent" }], error: null };
  await composer.Composer.prototype.sendAnyway.call(c, cx);
  eq(`anyway ${address}: one helper send with the word and the conversation shown`, sent, [[address, "hello", [], seen, "/handoff"]]);
  eq(`anyway ${address}: no keys or send typed by the mod itself`, calls, []);
  eq(`anyway ${address}: sent note, box emptied`, [c.note?.bad, c.typed], [false, ""]);
}

let c = fake("box/t7");
sendReply = { lines: [{ type: "done", result: "changed", message: "another agent or conversation is in this pane now; nothing was sent" }], error: null };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: another conversation there → says so, text kept", [/another conversation/i.test(c.note?.text ?? ""), c.typed], [true, undefined]);
c = fake("box/t7");
sendReply = { lines: [{ type: "done", result: "box_not_empty", message: "The agent's box still has text in it after Flockbook cleared its line. Clear it in the terminal, then send again. Nothing was sent." }], error: null };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: box still full → the helper's note, no second offer", [/still has text/.test(c.note?.text ?? ""), Boolean(c.note?.anyway), c.note?.bad], [true, false, true]);
c = fake("box/t7");
sendReply = { lines: [{ type: "done", result: "unconfirmed" }], error: null };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: unconfirmed → may still arrive", [c.note?.bad, /not confirm/.test(c.note?.text ?? "")], [false, true]);
c = fake("box/t7");
sendReply = { lines: [], error: { message: "The helper on box is another version (0.0.9); this Flockbook needs 0.1.0." } };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: a helper error is shown", [c.note?.bad, /another version/.test(c.note?.text ?? "")], [true, true]);
c = fake("t1"); c.address = "t2";
sent.length = 0; await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: the box moved to another agent → nothing", sent, []);

// s32 (review): an older helper there (same 0.1.0, no send-over-suggestion) sends nothing and answers outdated with
// the install data. The chat only drew that card for a failed feed (an older helper still reads), so the composer
// keeps it (`helperAsk`) for the chat to draw over the reply box, and keeps Send anyway to press again after.
const OLDER = { code: "remote_helper_outdated", message: "The helper on box is older than this Flockbook (it lacks send-over-suggestion).",
  remote: { protocol: 1, sidecar: "0.1.0", missing: ["send-over-suggestion"] }, install: { machine: "box", sha256: "ab" } };
c = fake("box/t7");
sendReply = { lines: [], error: OLDER };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: an older helper there → the card's data for the chat", [c.helperAsk?.address, c.helperAsk?.err?.code], ["box/t7", "remote_helper_outdated"]);
eq("anyway: an older helper there → says install, Send anyway kept for after", [c.note?.bad, /older/.test(c.note?.text ?? ""), /install/i.test(c.note?.text ?? ""), c.note?.anyway?.word], [true, true, true, "/handoff"]);
sendReply = { lines: [{ type: "done", result: "sent" }], error: null };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: sent after the install → the card goes", [c.helperAsk ?? null, c.note?.bad], [null, false]);
c = fake("box/t7");
sendReply = { lines: [], error: { ...OLDER, install: null } };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: nothing this Flockbook can install → no card, the helper's words", [c.helperAsk ?? null, /older/.test(c.note?.text ?? "")], [null, true]);
c = fake("box/t7");
sendReply = { lines: [], error: { code: "remote_helper_missing", message: "box has no Flockbook helper yet, so the chat cannot read its agents.", install: OLDER.install } };
await composer.Composer.prototype.sendAnyway.call(c, cx);
eq("anyway: no helper there → the chat's own card (failed feed), none here", [c.helperAsk ?? null, /no Flockbook helper/.test(c.note?.text ?? "")], [null, true]);

// submit on a stand-in: the box shows a lone "/handoff" (box_not_empty). `seenLog` changes between the first and a
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
const RULE = "─".repeat(40);
screen = `${RULE}\n❯ /handoff\n${RULE}\n`;
sendReply = { lines: [{ type: "done", result: "box_not_empty", message: "The terminal's box has text in it." }], error: null };
const first = { agent: "claude", path: OLD }, later = { agent: "claude", path: NEW };
let s = submitFake("t1", [first, later]);
sent.length = 0; await composer.Composer.prototype.submit.call(s, cx);
eq("submit: the send checks the conversation shown at Send", sent.map((x) => x[3]), [first]);
eq("submit: the offer keeps that SAME conversation and the word", [s.note?.anyway?.seen, s.note?.anyway?.word], [first, "/handoff"]);
eq("submit: seen read once", s.seenCalls, 1);
s = submitFake("box/t7", [first]);
calls.length = 0; await composer.Composer.prototype.submit.call(s, cx);
eq("submit: remote box_not_empty over a lone /word → Send anyway offered", [Boolean(s.note?.anyway), s.note?.anyway?.word, calls.includes("read")], [true, "/handoff", true]);
screen = `${RULE}\n❯ hello there\n${RULE}\n`;
s = submitFake("box/t7", [first]);
await composer.Composer.prototype.submit.call(s, cx);
eq("submit: typed text in the box → no offer, the helper's note", [Boolean(s.note?.anyway), s.note?.text], [false, "The terminal's box has text in it."]);
process.exit(bad ? 1 : 0);
