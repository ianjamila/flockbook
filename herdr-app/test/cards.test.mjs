import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space, passBlockGrace } from "./fixtures.mjs";
import { Cards, wanted, answersFor } from "../mods/flockbook/cards.js";
import { NeedsView } from "../mods/flockbook/needs.js";

const jl = (...lines) => ({ code: 0, stdout: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", stderr: "" });
const header = (command) => ({ type: "header", protocol: 1, sidecar: "0.1.0", command });
const end = { type: "end", ok: true };
const T = new Proxy({}, { get: (_t, k) => `#${k}` });
const approval = { type: "card", kind: "approval", request: "toolu_1", title: "Bash command", command: "rm -rf build", tool: "Bash" };
const question = { type: "card", kind: "question", request: "toolu_q", unread: 0, question: { toolUseId: "toolu_q", state: "pending", delivery: "picker", questions: [
  { id: "a", header: "Color", text: "Pick a color?", multi: false, options: [{ label: "Red", detail: "warm", recommended: true }, { label: "Blue" }] },
  { id: "b", header: "Sizes", text: "Which sizes?", multi: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] }] } };

let cardNow, acts;
beforeEach(() => {
  reset(); acts = []; cardNow = approval;
  fake.spaces = [space()];
  fake.agents = [agent("t1", "blocked")];
  passBlockGrace();   // plus build: blocked counts as Needs you only once it has lasted the grace (state.js BLOCK_GRACE_MS)
  fake.exec = (_c, args) => {
    if (args[0] === "card") return jl(header("card"), cardNow ?? { type: "card" }, end);
    if (args[0] === "approve" || args[0] === "answer") { acts.push(args); const r = fake.result ?? "sent"; if (r === "sent") cardNow = null; return jl(header(args[0]), { type: "done", result: r, message: fake.message ?? null }, end); }
    return jl(header(args[0]), end);
  };
});

test("wanted: a blocked agent, or a log that ends with a pending call", () => {
  assert.equal(wanted(agent("t", "blocked"), []), true);
  assert.equal(wanted(agent("t", "working"), [{ k: "perm", perm: { state: "pending" } }]), true);
  assert.equal(wanted(agent("t", "working"), [{ k: "perm", perm: { state: "resolved" } }]), false);
  assert.equal(wanted(agent("t", "idle"), [{ k: "question", question: { state: "pending" } }, { k: "perm", perm: { state: "resolved" } }]), false);
  assert.equal(wanted(null, []), false);
});

test("answersFor: one per question, picks sorted, other text; null while one is empty", () => {
  const q = question.question;
  assert.equal(answersFor(q, new Map([[0, new Set([0])]]), new Map()), null);
  assert.deepEqual(answersFor(q, new Map([[0, new Set([0])], [1, new Set([2, 0])]]), new Map()), [{ picks: [0] }, { picks: [0, 2] }]);
  assert.deepEqual(answersFor(q, new Map([[0, new Set([1])]]), new Map([[1, " XL "]])), [{ picks: [1] }, { picks: [], other: "XL" }]);
});

test("approval card: Allow once sends approve --allow with the card's request, then the card goes", async () => {
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "t1", true);
  let el = c.view("t1", T);
  assert.match(textOf(el), /Bash command.*rm -rf build/);
  byId(el, "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(acts[0].slice(0, 6), ["approve", "--terminal", "t1", "--request", "toolu_1", "--allow"]);
  assert.equal(c.view("t1", T), null);
});

test("Deny sends --deny; a changed card shows the new one with a note", async () => {
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "t1", true);
  fake.result = "changed"; const later = { ...approval, request: "toolu_2", command: "git push" };
  const exec0 = fake.exec; fake.exec = (cmd, args) => { const r = exec0(cmd, args); if (args[0] === "approve") cardNow = later; return r; };
  byId(c.view("t1", T), "card-deny")._h.on_click({}, cx); await cx.settle();
  assert.ok(acts[0].includes("--deny"));
  const el = c.view("t1", T);
  assert.match(textOf(el), /git push/);
  assert.match(textOf(byId(el, "card-note")), /changed on screen/);
});

test("question card: one question at a time; a one-choice pick goes on; Back; Send answer on the last", async () => {
  cardNow = question;
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "t1", true);
  let el = c.view("t1", T);
  assert.match(textOf(el), /question 1 of 2.*Pick a color\?.*Red.*Recommended/);
  assert.doesNotMatch(textOf(el), /Which sizes/);
  assert.equal(byId(el, "card-next")._h.on_click, undefined, "Next is off until the question has an answer");
  byId(el, "card-q0-o1")._h.on_click({}, cx);
  el = c.view("t1", T);
  assert.match(textOf(el), /question 2 of 2.*Which sizes\?/);
  byId(el, "card-back")._h.on_click({}, cx); await cx.settle();
  assert.match(textOf(c.view("t1", T)), /Pick a color/);
  byId(c.view("t1", T), "card-dot-1")._h.on_click({}, cx);
  el = c.view("t1", T);
  assert.equal(byId(el, "card-answer")._h.on_click, undefined, "Send is off until each question has an answer");
  byId(el, "card-q1-o0")._h.on_click({}, cx);
  byId(c.view("t1", T), "card-q1-o2")._h.on_click({}, cx);
  byId(c.view("t1", T), "card-answer")._h.on_click({}, cx); await cx.settle();
  const i = acts[0].indexOf("--answers");
  assert.deepEqual(JSON.parse(acts[0][i + 1]), [{ picks: [1] }, { picks: [0, 2] }]);
  assert.ok(acts[0].includes("toolu_q"));
});

test("a question with unread ones: Show all reads every question (card --all), then Send answer shows", async () => {
  const first = { ...question, unread: 1, question: { ...question.question, questions: question.question.questions.slice(0, 1) } };
  cardNow = first;
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  let el = c.view("t1", T);
  assert.match(textOf(el), /Show all 2 questions.*1 more question follows/);
  assert.equal(byId(el, "card-answer"), null);
  fake.exec = ((prev) => (cmd, args) => args.includes("--all") ? (acts.push(args), jl(header("card"), question, end)) : prev(cmd, args))(fake.exec);
  byId(el, "card-all")._h.on_click({}, cx); await cx.settle();
  assert.ok(acts.some((a) => a.includes("--all")));
  await c.poll(cx, "t1", true, true);   // the screen still shows one question; the full card stays
  el = c.view("t1", T);
  assert.match(textOf(el), /question 1 of 2/);
  assert.ok(byId(el, "card-next"));
});

test("keys: 1-9 pick in the first open question, Enter sends; approval 1 allows, 2 denies", async () => {
  cardNow = question;
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  const key = (k, mods = {}) => c.key_down({ key: k, modifiers: mods }, cx, "t1");
  assert.equal(key("enter"), false, "nothing picked yet");
  assert.equal(key("2"), true, "picks Blue and goes on to question 2");
  assert.equal(key("1", { platform: true }), false, "cmd-1 is the tab key");
  assert.equal(key("7"), false, "no 7th option");
  key("1"); key("3");
  assert.equal(key("enter"), true); await cx.settle();
  const i = acts[0].indexOf("--answers");
  assert.deepEqual(JSON.parse(acts[0][i + 1]), [{ picks: [1] }, { picks: [0, 2] }]);
  cardNow = approval; await c.poll(cx, "t1", true, true);
  assert.equal(key("2"), true); await cx.settle();
  assert.ok(acts.at(-1).includes("--deny"));
});

test("not wanted: the card is dropped and card is not read", async () => {
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  const before = log.exec.length;
  await c.poll(cx, "t1", false);
  assert.equal(c.card("t1"), null);
  assert.equal(log.exec.length, before);
});

test("Needs you shows the picked agent's card", async () => {
  const cx = fakeCx(); const v = new NeedsView(cx);
  let el = v.render(cx);
  assert.match(textOf(byId(el, "needs-detail")), /Reading what it waits for/);
  v.tick(cx); await cx.settle();
  el = v.render(cx);
  assert.ok(byId(el, "needs-card-allow"));
});

test("no view makes input state while it draws (herdr-app refuses it)", async () => {
  const { made } = await import("./stub/ui.mjs");
  const { ChatView } = await import("../mods/flockbook/chat.js");
  cardNow = { ...question };
  fake.exec = (_c, args) => args[0] === "card" ? jl(header("card"), cardNow, end)
    : args[0] === "feed" ? jl(header("feed"), { type: "log", agent: "claude", path: "/l", start: 0, size: 1, cursor: "c" }, { type: "splice", at: 0, count: 1 }, { type: "row", id: "u1", k: "user", text: "hi" }, end)
    : jl(header(args[0]), end);
  fake.agents = [agent("t1", "blocked"), agent("t2", "blocked")];
  const cx = fakeCx(); const chat = new ChatView(cx); const needs = new NeedsView(cx);
  await chat.tick(cx); needs.tick(cx); await cx.settle();
  const before = made.textarea;
  chat.render(cx); needs.render(cx);
  fake.shared["flockbook.agent"] = "t2"; await chat.tick(cx); await cx.settle();
  chat.render(cx); needs.render(cx);
  assert.equal(made.textarea, before);
});

test("a question with unread ones never reads the others without a click", async () => {
  cardNow = { ...question, unread: 1, question: { ...question.question, questions: question.question.questions.slice(0, 1) } };
  let alls = 0;
  fake.exec = ((prev) => (cmd, args) => args.includes("--all") ? (alls++, jl(header("card"), question, end)) : prev(cmd, args))(fake.exec);
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "t1", true); await cx.settle();
  await c.poll(cx, "t1", true, true); await cx.settle();
  assert.equal(alls, 0, "no keys on a timer");
  assert.ok(byId(c.view("t1", T), "card-all"));
});

test("the card has no outer border; Next and Send sit at the right end, after the hint", async () => {
  cardNow = question;
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  const el = c.view("t1", T);
  assert.equal(el._a.border, undefined);
  const row = (function find(n) { return n?.kids?.some?.((k) => k._a?.id === "card-next") ? n : (n?.kids ?? []).map(find).find(Boolean); })(el);
  const ids = row.kids.map((k) => k._a?.id ?? (textOf(k).includes("picks") ? "hint" : "gap"));
  assert.equal(ids.at(-1), "card-next");
  assert.ok(ids.indexOf("hint") < ids.indexOf("card-next"));
});

test("two views of one card: Show all in one, both show every question", async () => {
  cardNow = { ...question, unread: 1, question: { ...question.question, questions: question.question.questions.slice(0, 1) } };
  let alls = 0;
  fake.exec = ((prev) => (cmd, args) => args.includes("--all") ? (alls++, jl(header("card"), question, end)) : prev(cmd, args))(fake.exec);
  const cx = fakeCx(); const a = new Cards(), b = new Cards();
  await a.poll(cx, "t1", true); await b.poll(cx, "t1", true);
  byId(a.view("t1", T), "card-all")._h.on_click({}, cx); await cx.settle();
  await b.poll(cx, "t1", true, true); await cx.settle();
  assert.equal(alls, 1);
  assert.match(textOf(b.view("t1", T)), /question 1 of 2/);
});

test("own answer: a row like the options; clicks and keys in it stay in the text box", async () => {
  cardNow = question;
  const cx = fakeCx(); const c = new Cards(cx); await c.poll(cx, "t1", true);
  const row = byId(c.view("t1", T), "card-q0-other");
  assert.match(textOf(row), /3/, "numbered after the options");
  let stopped = 0; const ecx = { ...cx, stop_propagation() { stopped++; } };
  row._h.on_mouse_down?.({}, ecx);
  assert.equal(stopped, 1, "the card does not take the focus");
  // plus build: the row no longer stops keys (a stopped key never reaches the box as typed text); the card's own key handler skips them while the box has the keyboard.
  assert.equal(row._h.on_key_down, undefined);
  c.typingIn = 0;
  assert.equal(c.key_down({ key: "1", modifiers: {} }, ecx, "t1"), false, "the card does not pick option 1");
  assert.equal(c.byAgent.get("t1").picks.size, 0);
});

test("the number after the options moves the keyboard into the own-answer box", async () => {
  cardNow = question;
  const cx = fakeCx(); const c = new Cards(cx); await c.poll(cx, "t1", true);
  let focused = 0; c.others[0].focus = () => { focused++; };
  assert.equal(c.key_down({ key: "3", modifiers: {} }, cx, "t1"), true);
  assert.equal(focused, 1);
});

test("another agent in the pane: the card says so, nothing sent", async () => {
  cardNow = approval;
  fake.result = "changed"; fake.message = "another agent is in this pane now; nothing was sent";
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.match(textOf(byId(c.view("t1", T), "card-note")), /Another agent is in this pane now/);
});

test("an approval already answered and still on screen: buttons off, 1 and 2 do nothing, it says so", async () => {
  const cx = fakeCx(); const c = new Cards();
  // The key went out but the agent has not redrawn yet: the card comes back marked answered.
  fake.result = "unconfirmed"; fake.message = "no answer in time; the key may still arrive";
  await c.poll(cx, "t1", true);
  const exec0 = fake.exec; fake.exec = (cmd, args) => { const r = exec0(cmd, args); if (args[0] === "approve") cardNow = { ...approval, answered: true }; return r; };
  byId(c.view("t1", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.equal(acts.length, 1);
  const el = c.view("t1", T);
  assert.match(textOf(el), /may still arrive/);
  assert.equal(byId(el, "card-allow")._h.on_click, undefined, "Allow is off");
  assert.equal(byId(el, "card-deny")._h.on_click, undefined, "Deny is off");
  assert.match(textOf(el), /Answer sent/);
  assert.equal(c.key_down({ key: "1", keystroke: { key: "1" } }, cx, "t1"), false);
  await cx.settle();
  assert.equal(acts.length, 1, "no second approve");
  fake.message = undefined; fake.result = undefined;
});

test("an agent Flockbook cannot tell apart: the card shows the sidecar's reason, not 'another agent'", async () => {
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "t1", true);
  fake.result = "no-identity"; fake.message = "Flockbook cannot tell this agent from another program in this terminal, so it sends nothing. Use the terminal.";
  byId(c.view("t1", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  const note = textOf(byId(c.view("t1", T), "card-note"));
  assert.match(note, /cannot tell this agent/);
  assert.doesNotMatch(note, /Another agent/);
  fake.result = undefined; fake.message = undefined;
});

test("another press was being handled at the same moment: it says press again, and the buttons stay on", async () => {
  cardNow = approval;
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "t1", true);
  const n = acts.length;
  fake.result = "busy"; fake.message = "Another press was being handled at the same moment, so this one sent nothing. Press again.";
  byId(c.view("t1", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  const el = c.view("t1", T);
  assert.match(textOf(byId(el, "card-note")), /Press again/);
  assert.doesNotMatch(textOf(el), /Answer sent/, "not shown as answered");
  fake.result = undefined; fake.message = undefined;
  assert.notEqual(byId(el, "card-allow")._h.on_click, undefined, "Allow is still on");
  byId(el, "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.equal(acts.length, n + 2, "the second press goes to the sidecar");
});

// Issue #11, item 4: the sidecar's `blocked` (the rule `answer` refuses with) shows from the start: Send off, the
// reason, and a button that opens the terminal.
const LABELS = "The terminal's review screen could not show which options were picked (an option with a comma or a ● or → mark, or two options alike). Answer in the terminal.";
const OWN = "Your own answer has a comma, a ● or → mark, or is the same as an option, so the terminal's review screen could not show it. Change it, or answer in the terminal.";

test("a question the review cannot show: Send off from the start, the reason, and Answer in terminal", async () => {
  cardNow = { ...question, blocked: LABELS };
  const cx = fakeCx(); const c = new Cards(cx); await c.poll(cx, "t1", true);
  let el = c.view("t1", T);
  assert.match(textOf(byId(el, "card-blocked")), /review screen could not show/, "said on the first question already");
  byId(el, "card-q0-o1")._h.on_click({}, cx);
  byId(c.view("t1", T), "card-q1-o0")._h.on_click({}, cx);
  el = c.view("t1", T);
  assert.equal(byId(el, "card-answer")._h.on_click, undefined, "Send is off");
  assert.equal(c.key_down({ key: "enter", modifiers: {} }, cx, "t1"), false, "Enter sends nothing");
  await cx.settle();
  assert.equal(acts.length, 0, "nothing went to the sidecar");
  byId(el, "card-terminal")._h.on_click({}, cx); await cx.settle();
  assert.equal(log.overlays.length, 1, "the terminal opens");
  assert.match(JSON.stringify(log.overlays[0]), /"terminal":"t1"/);
});

test("an own answer the review cannot show: checked again as it changes, Send off until it is fine", async () => {
  cardNow = question;
  const cards = [];
  fake.exec = (_c, args) => {
    if (args[0] !== "card") return jl(header(args[0]), end);
    cards.push(args);
    const i = args.indexOf("--answers");
    const a = i < 0 ? [] : JSON.parse(args[i + 1]);
    return jl(header("card"), a.some((x) => (x.other ?? "").includes(",")) ? { ...question, blocked: OWN } : question, end);
  };
  const cx = fakeCx(); const c = new Cards(cx); await c.poll(cx, "t1", true);
  assert.ok(!cards[0].includes("--answers"), "nothing typed yet: the labels only");
  byId(c.view("t1", T), "card-q0-o1")._h.on_click({}, cx);
  c.view("t1", T);
  const type = async (text) => { c.others[1].set_value(text); c.others[1]._h.change({}, cx); await c.poll(cx, "t1", true); };
  await type("x, y");
  const last = () => JSON.parse(cards.at(-1)[cards.at(-1).indexOf("--answers") + 1]);
  assert.deepEqual(last(), [{ picks: [1] }, { picks: [], other: "x, y" }], "a change reads the card again at once, with the answers so far");
  let el = c.view("t1", T);
  assert.match(textOf(byId(el, "card-blocked")), /Change it, or answer in the terminal/);
  assert.equal(byId(el, "card-answer")._h.on_click, undefined, "Send is off");
  await type("olive");
  el = c.view("t1", T);
  assert.equal(byId(el, "card-blocked"), null, "fine now");
  assert.notEqual(byId(el, "card-answer")._h.on_click, undefined, "Send is on");
  assert.equal(c.others[1].value(), "olive", "the typed text stays");
});

// s27 (owner 11-14 "one-click MCP Supabase migrations"): an MCP server's input request (an "elicitation", e.g. Supabase
// apply_migration's "destructive operations … Run it on project …?") gets Accept / Decline on its card. Each press
// reads the screen again and sends keys only while the SAME request is still there, with the terminal's selection
// where the press needs it; nothing is ever pressed by itself.
const RULE = "─".repeat(60);
const elicitScreen = (focus = "accept", text = "Run it on project webshop-prod?") => [
  "⏺ Applying the migration", "", RULE, " MCP server “supabase” requests your input", "",
  " This tool performs destructive operations on the database.", ` ${text}`, "",
  focus === "accept" ? " ❯ Accept    Decline" : "   Accept  ❯ Decline", "", " Esc to cancel · ↑↓ to navigate"].join("\n");
const after = "⏺ Migration applied.\n\n" + RULE + "\n❯ \n" + RULE;
// The fake terminal: `screens` are what `hc read` shows, one per read (the last one stays); every `hc keys` recorded.
function elicitWorld(screens) {
  const keys = [];
  let i = 0;
  cardNow = null;
  const exec0 = fake.exec;
  fake.exec = (cmd, args) => {
    if (cmd === "hc" && args[0] === "read") { const s = screens[Math.min(i, screens.length - 1)]; i++; return { code: 0, stdout: s, stderr: "" }; }
    if (cmd === "hc" && args[0] === "keys") { keys.push(args.slice(1)); return { code: 0, stdout: "", stderr: "" }; }
    return exec0(cmd, args);
  };
  return { keys, reads: () => i };
}
const quick = (c) => { c.wait = async () => {}; return c; };

test("MCP request card: server and request text, Accept / Decline / Answer in terminal; reading it presses nothing", async () => {
  const w = elicitWorld([elicitScreen()]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  await c.poll(cx, "t1", true, true);
  const el = c.view("t1", T);
  assert.match(textOf(el), /MCP server “supabase” asks for your input/);
  assert.match(textOf(byId(el, "card-elicit")), /destructive operations on the database\. Run it on project webshop-prod\?/);
  assert.ok(byId(el, "card-elicit-accept")); assert.ok(byId(el, "card-elicit-decline")); assert.ok(byId(el, "card-elicit-terminal"));
  assert.deepEqual(w.keys, [], "a card that is read sends no key");
});

test("Accept: the same request still on screen with Accept selected → one Enter, then the card goes", async () => {
  const w = elicitWorld([elicitScreen(), elicitScreen(), after]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, [["t1", "enter"]]);
  assert.equal(c.view("t1", T), null, "answered: the request is gone");
});

test("Accept: a different request on screen now → no key, the new one shown with a note", async () => {
  const w = elicitWorld([elicitScreen(), elicitScreen("accept", "Run it on project OTHER-prod?")]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, []);
  const el = c.view("t1", T);
  assert.match(textOf(el), /OTHER-prod/);
  assert.match(textOf(byId(el, "card-note")), /Not sent: the request on screen changed/);
});

test("Accept: a changed request that shares its first 1200 characters → no key; the card shows the whole request", async () => {
  const pre = "y".repeat(1300);
  const w = elicitWorld([elicitScreen("accept", `${pre} Run it on project webshop-prod?`), elicitScreen("accept", `${pre} Run it on project OTHER-prod?`)]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  assert.match(textOf(byId(c.view("t1", T), "card-elicit")), /webshop-prod\?$/, "the card shows the request in full");
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, []);
  assert.match(textOf(byId(c.view("t1", T), "card-note")), /Not sent: the request on screen changed/);
});

test("a request whose screen can't be checked well enough: the card shows it, but only Answer in terminal", async () => {
  const odd = elicitScreen() + "\n Some other words under the dialog";
  const w = elicitWorld([odd]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  const el = c.view("t1", T);
  assert.match(textOf(byId(el, "card-elicit")), /webshop-prod/);
  assert.equal(byId(el, "card-elicit-accept"), null); assert.equal(byId(el, "card-elicit-decline"), null);
  assert.ok(byId(el, "card-elicit-terminal"));
  assert.match(textOf(el), /Answer it in its terminal/);
  assert.deepEqual(w.keys, []);
});

test("Accept: the request gone from the screen → no key", async () => {
  const w = elicitWorld([elicitScreen(), after]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, []);
  assert.equal(c.view("t1", T), null);
});

test("Accept: the terminal's selection on Decline → no key, a note to answer in the terminal", async () => {
  const w = elicitWorld([elicitScreen("decline")]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, []);
  assert.match(textOf(byId(c.view("t1", T), "card-note")), /selection is not on Accept/);
});

test("Decline: down, checked on Decline, then Enter; never Enter while Accept is selected (Esc instead)", async () => {
  let w = elicitWorld([elicitScreen(), elicitScreen(), elicitScreen("decline"), after]);
  let cx = fakeCx(); let c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-decline")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, [["t1", "down"], ["t1", "enter"]]);
  assert.equal(c.view("t1", T), null);
  // The selection did not move: Esc (cancel: nothing runs), never Enter.
  reset(); fake.agents = [agent("t1", "blocked")]; passBlockGrace();
  fake.exec = (_c, args) => (args[0] === "card" ? jl(header("card"), { type: "card" }, end) : jl(header(args[0]), end));
  w = elicitWorld([elicitScreen(), elicitScreen(), elicitScreen(), after]);
  cx = fakeCx(); c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-decline")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, [["t1", "down"], ["t1", "esc"]]);
});

test("Decline already selected: Enter straight away; a request on another machine is answered there", async () => {
  fake.agents = [agent("wsl/t3", "blocked")];
  const w = elicitWorld([elicitScreen("decline"), elicitScreen("decline"), after]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "wsl/t3", true);
  byId(c.view("wsl/t3", T), "card-elicit-decline")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, [["wsl/t3", "enter"]]);
});

test("the request still on screen after the key: a note says to check its terminal", async () => {
  const w = elicitWorld([elicitScreen()]);
  const cx = fakeCx(); const c = quick(new Cards());
  await c.poll(cx, "t1", true);
  byId(c.view("t1", T), "card-elicit-accept")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(w.keys, [["t1", "enter"]]);
  assert.match(textOf(byId(c.view("t1", T), "card-note")), /still shows/);
});

// s34 (owner, item 12): approve and answer for a terminal on another machine ask the helper there first; one of
// another version runs nothing and answers outdated with the install card's data. The card says so and shows the
// install card; Needs you shows it in place of a card it could not read; installed, it goes and the card is read again.
const SHA34 = "ab".repeat(32);
const outdated34 = { type: "error", code: "remote_helper_outdated", message: "The helper on box is another version (0.0.9); this Flockbook needs 0.1.0.",
  remote: { protocol: 1, sidecar: "0.0.9" }, install: { machine: "box", target: "aarch64-apple-darwin", path: "~/.local/share/flockbook/helper/0.1.0/flockbook-modfeed", bytes: 4e6, sha256: SHA34, source: "release" } };
const remoteHelper34 = (state) => (_c, args) => {
  if (args[0] === "helper" && args[1] === "install") { state.installed = true; acts.push(args); return jl(header("helper"), { type: "installed", machine: "box", sha256: SHA34, parts: 1 }, end); }
  if (args[0] === "card") return state.cardFails ? jl(header("card"), outdated34, { type: "end", ok: false }) : jl(header("card"), cardNow ?? { type: "card" }, end);
  if (args[0] === "approve" || args[0] === "answer") { acts.push(args); return state.installed ? jl(header(args[0]), { type: "done", result: "sent" }, end) : jl(header(args[0]), outdated34, { type: "end", ok: false }); }
  return jl(header(args[0]), end);
};

test("approve on another machine whose helper is another version: nothing sent, the card says install, the install card shows", async () => {
  fake.agents = [agent("box/t7", "blocked")];
  const state = {}; fake.exec = remoteHelper34(state);
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "box/t7", true);
  assert.equal(c.helperCard("box/t7", T), null, "no install card while the card reads fine");
  byId(c.view("box/t7", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  const el = c.view("box/t7", T);
  assert.match(textOf(byId(el, "card-note")), /Not sent: the Flockbook helper on box has to be installed or updated first/);
  assert.match(textOf(el), /Install the Flockbook helper on box\?.*another version \(0\.0\.9\)/);
  byId(el, "helper-install")._h.on_click({}, cx); await cx.settle();
  assert.deepEqual(acts.find((a) => a[0] === "helper")?.slice(0, 6), ["helper", "install", "--machine", "box", "--sha256", SHA34]);
  assert.equal(c.helperCard("box/t7", T), null, "installed: the card goes");
  byId(c.view("box/t7", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.equal(acts.filter((a) => a[0] === "approve").length, 2, "pressed again after the install, it goes");
  assert.equal(c.helperCard("box/t7", T), null);
});

test("answer on another machine whose helper is another version: the same install card", async () => {
  fake.agents = [agent("box/t7", "blocked")];
  cardNow = question;
  const state = {}; fake.exec = remoteHelper34(state);
  const cx = fakeCx(); const c = new Cards(); await c.poll(cx, "box/t7", true);
  byId(c.view("box/t7", T), "card-q0-o1")._h.on_click({}, cx);
  byId(c.view("box/t7", T), "card-q1-o0")._h.on_click({}, cx);
  byId(c.view("box/t7", T), "card-answer")._h.on_click({}, cx); await cx.settle();
  const el = c.view("box/t7", T);
  assert.ok(acts.some((a) => a[0] === "answer"));
  assert.match(textOf(byId(el, "card-note")), /has to be installed or updated first/);
  assert.ok(byId(el, "helper-install"), "the install card under the note");
});

test("Needs you: a card on another machine that can't be read for its helper shows the install card, not 'Reading…'", async () => {
  fake.agents = [agent("box/t7", "blocked")];
  fake.spaces = [space("sp1", { machine: "box" })];
  passBlockGrace();
  const state = { cardFails: true }; fake.exec = remoteHelper34(state);
  const cx = fakeCx(); const v = new NeedsView(cx);
  v.tick(cx); await cx.settle();
  let el = v.render(cx);
  assert.match(textOf(byId(el, "needs-detail")), /Install the Flockbook helper on box\?/);
  assert.doesNotMatch(textOf(byId(el, "needs-detail")), /Reading what it waits for/);
  state.cardFails = false;
  byId(el, "helper-install")._h.on_click({}, cx); await cx.settle();
  el = v.render(cx);
  assert.equal(byId(el, "helper-install"), null, "installed: the card goes");
  assert.ok(byId(el, "needs-card-allow"), "and the card is read again");
});

test("an install from another card (the chat's, Needs you's) clears a press's install card and its note", async () => {
  fake.agents = [agent("box/t7", "blocked")];
  const state = {}; fake.exec = remoteHelper34(state);
  const cx = fakeCx(); const c = new Cards();
  await c.poll(cx, "box/t7", true);
  byId(c.view("box/t7", T), "card-allow")._h.on_click({}, cx); await cx.settle();
  assert.ok(byId(c.view("box/t7", T), "helper-install"), "the press's card");
  fake.shared["flockbook.helper.installed"] = { box: Date.now() + 1000 };
  const el = c.view("box/t7", T);
  assert.equal(byId(el, "helper-install"), null, "installed elsewhere: the card goes");
  assert.equal(byId(el, "card-note"), null, "and its note");
  assert.ok(byId(el, "card-allow"), "the approval stays, to press again");
});
