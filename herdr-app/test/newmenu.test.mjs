// The "+" menu with one Claude row per account (owner 11-16 s41: "Claude Code (jamilaian21), Claude Code
// (eaglewatch9002), Codex").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shortEmail, claudeAccounts, menuRows } from "../mods/flockbook/newmenu.js";

const LIST = [{ mark: "EWI", name: "Work account", config_dir: "~/.claude-work" }, { mark: "ME", name: "Personal account" }];
const USAGE = [
  { kind: "claude", id: "EWI", email: "eaglewatch9002@example.ph" },
  { kind: "claude", id: "ME", email: "jamilaian21@example.com" },
  { kind: "codex", id: "codex", email: null },
];
const KNOWN = [
  { key: "codex", name: "Codex", icon: "icons/codex.svg", run: ["codex"], installed: true },
  { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, run: ["claude"], installed: true },
  { key: "claude-work", name: "Claude Code (Work)", icon: "icons/claude.svg", run: ["claude-work"], installed: true },
  { key: "pi", name: "Pi", installed: false }, { key: "opencode", name: "OpenCode", installed: false }, { key: "x", name: "X", installed: false },
];

test("an email's name, or nothing", () => {
  assert.equal(shortEmail("jamilaian21@example.com"), "jamilaian21");
  assert.equal(shortEmail(null), null);
  assert.equal(shortEmail("no-at"), null);
});

test("one Claude row per account: the default account first, named by its email", () => {
  assert.deepEqual(claudeAccounts(LIST, USAGE), [
    { mark: "ME", label: "Claude Code (jamilaian21)" },
    { mark: "EWI", label: "Claude Code (eaglewatch9002)" },
  ]);
  // No reading yet: the account's name.
  assert.deepEqual(claudeAccounts(LIST, []).map((a) => a.label), ["Claude Code (Personal account)", "Claude Code (Work account)"]);
});

test("the rows: the Claude accounts, then Herdr's other agents; Herdr's own Claude entries replaced", () => {
  const { installed, choices } = menuRows(KNOWN, claudeAccounts(LIST, USAGE));
  assert.deepEqual(installed.map((a) => a.name), ["Claude Code (jamilaian21)", "Claude Code (eaglewatch9002)", "Codex"]);
  assert.deepEqual(installed.slice(0, 2).map((a) => a.account), ["ME", "EWI"]);
  assert.equal(installed[0].icon, "icons/claude.svg");
  assert.deepEqual(choices.map((a) => a.name), ["Claude Code (jamilaian21)", "Claude Code (eaglewatch9002)", "Codex", "Pi", "OpenCode"]);
  // Claude not installed on that machine: the account rows show as not installed.
  const off = menuRows(KNOWN.map((a) => (a.key === "claude" ? { ...a, installed: false } : a)), claudeAccounts(LIST, USAGE));
  assert.deepEqual(off.installed.map((a) => a.name), ["Codex"]);
  // No accounts set (or Windows here): Herdr's rows as they are.
  assert.deepEqual(menuRows(KNOWN, []).installed.map((a) => a.name), ["Codex", "Claude Code", "Claude Code (Work)"]);
  assert.deepEqual(menuRows(KNOWN, claudeAccounts(LIST, USAGE), true).choices.length, 3, "a failed check: installed only");
});

test("Flockbook's + buttons open this menu (view \"new\"), not Herdr's", () => {
  const dir = new URL("../mods/flockbook/", import.meta.url);
  for (const f of ["tabs.js", "side.js", "top.js"]) {
    const src = fs.readFileSync(new URL(f, dir), "utf8");
    assert.ok(!src.includes('mod: "new-menu"'), `${f} still opens Herdr's menu`);
    assert.match(src, /mod: "flockbook", props: \{ view: "new" \}/, `${f} opens view "new"`);
  }
  assert.match(fs.readFileSync(new URL("main.js", dir), "utf8"), /\bnew: NewView\b/);
});
