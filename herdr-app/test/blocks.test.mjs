// The one block parser (blocks.js) that the drawing and the row height estimate share: fences as in CommonMark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks } from "../mods/flockbook/blocks.js";

const codes = (text) => splitBlocks(text).filter((b) => b.k === "code").map((b) => [b.lang, b.text]);

test("a ~~~ fence is a code box", () => {
  assert.deepEqual(codes("~~~\none\n~~~"), [["", "one"]]);
  assert.deepEqual(codes("~~~py\none\n~~~"), [["py", "one"]]);
});

test("an opening fence may have more words after the language", () => {
  assert.deepEqual(codes("```js title=a.js\nconst a = 1;\n```\nafter"), [["js", "const a = 1;"]]);
  assert.deepEqual(splitBlocks("```js title=a.js\nx\n```\nafter").map((b) => b.k), ["code", "md"]);
});

test("a closing fence is the same character, as long or longer, with nothing after it", () => {
  assert.deepEqual(codes("```\na\n```py\nb\n```"), [["", "a\n```py\nb"]]);   // "```py" inside does not close
  assert.deepEqual(codes("~~~\na\n```\nb\n~~~"), [["", "a\n```\nb"]]);        // a backtick line inside ~~~
  assert.deepEqual(codes("````\na\n```\nb\n````"), [["", "a\n```\nb"]]);      // a shorter fence inside a longer one
  assert.deepEqual(codes("```\na\n`````"), [["", "a"]]);                       // a longer one closes
});

test("a backtick fence's info has no backtick: ```a``` on one line is inline code, not a box", () => {
  assert.deepEqual(splitBlocks("```a``` text").map((b) => b.k), ["md"]);
});

test("a code box keeps its source lines, an empty box has none", () => {
  assert.deepEqual(splitBlocks("```\n```")[0].lines, []);
  assert.deepEqual(splitBlocks("```\n\n```")[0].lines, [""]);
  assert.deepEqual(splitBlocks("```\na\r\n\tb\n```")[0].lines, ["a\r", "\tb"]);
});

// Owner 11-13: "Copy all" for a re-entry prompt (chat.js footer).
test("reentryPrompt: the quote under a line naming the prompt, as written, without the quote marks", async () => {
  const { reentryPrompt } = await import("../mods/flockbook/blocks.js");
  const reply = "Recommended next step: start fresh with the prompt below.\n\nYes, clear: it saves rereads. Re-entry prompt (`--effort high`):\n\n"
    + "> Continue the auto-close work (`P arbiter needed --round 2`).\n> All in scope: (1) PR 2a.\n>\n> **Also worth considering (in scope):**\n> 1. Card link.\n";
  assert.equal(reentryPrompt(reply), "Continue the auto-close work (`P arbiter needed --round 2`).\nAll in scope: (1) PR 2a.\n\n**Also worth considering (in scope):**\n1. Card link.");
  // The quote starts on the next line too, and quotes split by a blank line are one prompt; text after the quote is not in it.
  assert.equal(reentryPrompt("**Resume prompt:**\n> one\n\n> two\n\nThat's all."), "one\n\ntwo");
  // A code fence under the line: its body.
  assert.equal(reentryPrompt("Re-entry prompt:\n\n```text\nContinue X.\n  - keep indent\n```\nafter"), "Continue X.\n  - keep indent");
  assert.equal(reentryPrompt("A prompt for a fresh session:\n~~~\nGo on.\n~~~"), "Go on.");
  // CRs dropped; "reentry" and "hand-off prompt" count.
  assert.equal(reentryPrompt("Reentry prompt:\r\n> a\r\n> b\r\n"), "a\nb");
  assert.equal(reentryPrompt("Hand-off prompt:\n> x"), "x");
});

test("reentryPrompt: none without a quote or fence under the line; a later mention is passed over", async () => {
  const { reentryPrompt } = await import("../mods/flockbook/blocks.js");
  assert.equal(reentryPrompt("I'll write a re-entry prompt when we stop."), null);
  assert.equal(reentryPrompt("Re-entry prompt:\n\nContinue the work."), null, "a plain paragraph is not taken");
  assert.equal(reentryPrompt("Re-entry prompt:\n\n> \n>   \n"), null, "an empty quote is none");
  assert.equal(reentryPrompt("Re-entry prompt:"), null);
  assert.equal(reentryPrompt(""), null);
  assert.equal(reentryPrompt(null), null);
  assert.equal(reentryPrompt("> quoted re-entry prompt line\n> more"), null, "the naming line inside a quote is not the heading");
  assert.equal(reentryPrompt("Re-entry prompt:\n> the prompt\n\nCopy the re-entry prompt above into a fresh session."), "the prompt");
  assert.equal(reentryPrompt("Plain quote:\n> not a prompt"), null);
});

// Owner 11-13 follow-up: a reply that was only the fenced prompt + "The prompt is ready to paste." had no Copy all.
test("reentryPrompt: a block counts when the line under it speaks of the prompt, when it reads like one, or when asked for", async () => {
  const { reentryPrompt } = await import("../mods/flockbook/blocks.js");
  const fenced = "```\nContinue the auto-close work.\n1. Map C.\n```\n\nThe prompt is ready to paste. Exit this terminal with `/exit`, then paste it.";
  assert.equal(reentryPrompt(fenced), "Continue the auto-close work.\n1. Map C.");
  assert.equal(reentryPrompt("> Go on with PR 5.\n\nPaste this into the new session."), "Go on with PR 5.");
  // Reads like one: starts "Continue …" and is long; a short one or code starting with `continue;` is not.
  const long = ("Continue webshop PR #1945 " + "with the review rounds and the migration go ".repeat(5)).trim();
  assert.equal(reentryPrompt(`If you start fresh instead:\n> ${long}`), long);
  assert.equal(reentryPrompt("Note:\n> Continue later."), null, "short");
  assert.equal(reentryPrompt("```js\ncontinue;\n" + "x();\n".repeat(60) + "```"), null, "code that starts with continue;");
  // Asked for: the owner's message wanted a re-entry prompt, so the reply's block is it.
  assert.equal(reentryPrompt("```\nGo on.\n```", "can you give me a re-entry prompt?"), "Go on.");
  assert.equal(reentryPrompt("```\nGo on.\n```", "write me a resume prompt"), "Go on.");
  assert.equal(reentryPrompt("```\nGo on.\n```", "fix the bug"), null, "not asked: a plain code block is not a prompt");
  assert.equal(reentryPrompt("```sh\nnpm test\n```\n\nRun that, then tell me what fails."), null);
  assert.equal(reentryPrompt("> a quote\n\nThat's what the docs say."), null);
  // The last block that counts wins.
  assert.equal(reentryPrompt("Re-entry prompt:\n> first\n\nOr, shorter:\n\n```\nsecond\n```\n\nThat prompt is ready to paste."), "second");
});

// s19: the chat's Copy all and the Overview's Copy prompt share one finder over a feed's rows.
test("replyPrompt: the newest reply's prompt (its footer skipped), back to the owner's message only", async () => {
  const { replyPrompt, askBefore } = await import("../mods/flockbook/blocks.js");
  const r = (id, k, text, extra = {}) => ({ id, k, text, ...extra });
  const named = "Re-entry prompt:\n\n> Continue the work.";
  const rows = [r("u0", "user", "start"), r("a0", "assistant", "Re-entry prompt:\n\n> OLD."), r("f0", "footer", "9:00"),
    r("u1", "user", "go"), r("a1", "assistant", named), r("t1", "tools", ""), r("a1b", "assistant", "All done."), r("f1", "footer", "10:00")];
  assert.equal(replyPrompt(rows), "Continue the work.", "the last assistant text WITH a prompt in the newest reply");
  assert.equal(replyPrompt(rows, 2), "OLD.", "an explicit end: the reply that footer closes");
  assert.equal(replyPrompt(rows.slice(0, 7)), "Continue the work.", "no footer yet: the reply so far");
  assert.equal(replyPrompt([...rows, r("u2", "user", "thanks"), r("a2", "assistant", "Sure."), r("f2", "footer", "")]), null, "a newer reply without one");
  assert.equal(replyPrompt([...rows, r("u2", "user", "thanks")]), null, "the owner wrote after it");
  assert.equal(replyPrompt([r("x", "user", "hi", { from: "t9" }), r("a", "assistant", named)]), "Continue the work.", "another agent's message is not the owner's");
  // A bare fence counts only when the owner asked for a prompt (blocks.js reentryPrompt's `ask`).
  const fenced = "```\nPick up the parser work.\n```";
  assert.equal(replyPrompt([r("u", "user", "write me a re-entry prompt"), r("a", "assistant", fenced)]), "Pick up the parser work.");
  assert.equal(replyPrompt([r("u", "user", "show the snippet"), r("a", "assistant", fenced)]), null);
  assert.equal(replyPrompt([r("x", "user", "write me a re-entry prompt", { from: "t9" }), r("a", "assistant", fenced)]), null, "another agent asking is not the owner asking");
  assert.equal(askBefore([r("u", "user", "go"), r("x", "user", "prompt?", { from: "t9" })], 2), "go", "passes over another agent's message");
  assert.equal(askBefore(rows, 7), "go");
  assert.equal(askBefore(rows, 3), null, "a footer first: no ask");
  assert.equal(replyPrompt([]), null);
});

// s27 (owner 11-14 "make re entry prompts as handoffs ... just add a button if the user wants the long re entry
// message"): a short prompt names the full one's file, ~/claude-notes/handoffs/<topic>.md. handoffFile finds it.
test("handoffFile: the hand-off file a re-entry prompt names, or null", async () => {
  const { handoffFile, expandHome } = await import("../mods/flockbook/blocks.js");
  assert.equal(handoffFile("Continue X.\nFull prompt: ~/claude-notes/handoffs/flockbook-s27.md — read it first."), "~/claude-notes/handoffs/flockbook-s27.md");
  assert.equal(handoffFile("Read `~/claude-notes/handoffs/a_b.2.md` first"), "~/claude-notes/handoffs/a_b.2.md", "in backticks");
  assert.equal(handoffFile("Full prompt: /home/you/claude-notes/handoffs/x.md."), "/home/you/claude-notes/handoffs/x.md", "absolute, a full stop after it");
  assert.equal(handoffFile("see (~/notes/handoffs/y.md)"), "~/notes/handoffs/y.md", "any folder named handoffs");
  assert.equal(handoffFile("**~/claude-notes/handoffs/z.md**"), "~/claude-notes/handoffs/z.md", "in bold");
  assert.equal(handoffFile("~/claude-notes/handoffs/one.md then ~/claude-notes/handoffs/two.md"), "~/claude-notes/handoffs/one.md", "the first");
  assert.equal(handoffFile("~/claude-notes/handoffs/../secrets.md"), null, "no way out of the folder");
  assert.equal(handoffFile("~/claude-notes/handoffs/sub/x.md"), null, "a file right in handoffs/ only");
  assert.equal(handoffFile("~/claude-notes/notes/x.md"), null, "not a hand-off folder");
  assert.equal(handoffFile("~/claude-notes/handoffs/x.txt"), null, "markdown only");
  assert.equal(handoffFile("relative claude-notes/handoffs/x.md"), null, "a relative path has no machine-independent meaning");
  assert.equal(handoffFile(""), null);
  assert.equal(handoffFile(null), null);
  assert.equal(expandHome("~/claude-notes/handoffs/x.md", "/Users/you"), "/Users/you/claude-notes/handoffs/x.md");
  assert.equal(expandHome("/abs/handoffs/x.md", "/Users/you"), "/abs/handoffs/x.md");
  assert.equal(expandHome("~/x.md", null), null, "no home known");
});

test("replyHandoff: the newest reply's prompt and the file it (or its reply) names", async () => {
  const { replyHandoff } = await import("../mods/flockbook/blocks.js");
  const r = (id, k, text) => ({ id, k, text });
  const short = "Done.\n\nRe-entry prompt:\n\n> Continue the work.\n> Full prompt: ~/claude-notes/handoffs/w.md — read it first.";
  assert.deepEqual(replyHandoff([r("u", "user", "go"), r("a", "assistant", short), r("f", "footer", "1")]),
    { prompt: "Continue the work.\nFull prompt: ~/claude-notes/handoffs/w.md — read it first.", file: "~/claude-notes/handoffs/w.md" });
  const outside = "Full prompt written to ~/claude-notes/handoffs/v.md.\n\nRe-entry prompt:\n\n> Continue.";
  assert.deepEqual(replyHandoff([r("u", "user", "go"), r("a", "assistant", outside)]), { prompt: "Continue.", file: "~/claude-notes/handoffs/v.md" }, "named in the reply around the prompt");
  assert.deepEqual(replyHandoff([r("u", "user", "go"), r("a", "assistant", "Re-entry prompt:\n\n> Continue.")]), { prompt: "Continue.", file: null });
  assert.equal(replyHandoff([r("u", "user", "go"), r("a", "assistant", "No prompt; ~/claude-notes/handoffs/v.md exists.")]), null, "no prompt, no hand-off");
  assert.deepEqual(replyHandoff([r("u", "user", "go"), r("a", "assistant", short), r("f", "footer", "1"), r("u2", "user", "x")], 2).file, "~/claude-notes/handoffs/w.md", "an explicit end");
});
