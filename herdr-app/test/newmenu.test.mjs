// The "+" menu with one Claude row per account (owner 11-16 s41: "Claude Code (jamilaian21), Claude Code
// (eaglewatch9002), Codex").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shortEmail, claudeAccounts, menuRows, claudeHost, placeFor, withClaude } from "../mods/flockbook/newmenu.js";

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

// Owner 11-16 s42: a space on the Windows PC itself gets the account rows too, "starting Claude in WSL as that account"
// (claude_machine). A tab belongs to its space's machine, so the tab opens in that machine's "~" workspace.
test("where the account rows start Claude: the space's machine, or claude_machine from a Windows space", () => {
  assert.deepEqual(claudeHost({ machine: null, windows: false, cm: null }), { on: null, away: false }, "a Mac space");
  assert.deepEqual(claudeHost({ machine: "pc-wsl", windows: false, cm: null }), { on: "pc-wsl", away: false });
  assert.deepEqual(claudeHost({ machine: "wsl", windows: true, cm: "wsl" }), { on: "wsl", away: false }, "a WSL space on the PC");
  assert.deepEqual(claudeHost({ machine: null, windows: true, cm: "wsl" }), { on: "wsl", away: true }, "a Windows space on the PC");
  assert.equal(claudeHost({ machine: null, windows: true, cm: null }), null, "Windows without claude_machine: Herdr's rows");
});

test("an away row opens in claude_machine's \"~\" workspace, else a new one; a normal row in the space", () => {
  const list = [{ id: "w1", name: "~", machine: null }, { id: "w2", name: "eaglewatch", machine: "wsl" }, { id: "w3", name: "~", machine: "wsl" }];
  assert.deepEqual(placeFor({ on: null, away: false }, "w1", list, "Claude Code (x)"), { name: "tab.new", args: { space: "w1", name: "Claude Code (x)" }, select: null });
  assert.deepEqual(placeFor({ on: "wsl", away: true }, "w1", list, "Claude Code (x)"), { name: "tab.new", args: { space: "w3", name: "Claude Code (x)" }, select: "w3" });
  assert.deepEqual(placeFor({ on: "wsl", away: true }, "w1", list.slice(0, 2), "Claude Code (x)"), { name: "space.new", args: { machine: "wsl", name: "~", tab: "Claude Code (x)" }, select: null });
});

test("away rows are installed when Claude is on claude_machine, whatever this computer has", () => {
  const here = KNOWN.map((a) => (a.key === "claude" ? { ...a, installed: false } : a));
  const there = [{ key: "claude", name: "Claude Code", icon: "icons/claude.svg", installed: true }, { key: "codex", installed: false }];
  const merged = withClaude(here, there);
  assert.equal(merged.find((a) => a.key === "claude").installed, true);
  assert.equal(merged.find((a) => a.key === "codex").installed, true, "the other agents stay this space's");
  assert.deepEqual(menuRows(merged, claudeAccounts(LIST, USAGE)).installed.map((a) => a.name), ["Claude Code (jamilaian21)", "Claude Code (eaglewatch9002)", "Codex"]);
  // Not known there (yet): this space's own entry stays.
  assert.equal(withClaude(here, []).find((a) => a.key === "claude").installed, false);
  assert.equal(withClaude(here, null), here);
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
