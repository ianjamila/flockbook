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
