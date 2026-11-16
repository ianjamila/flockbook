// Herdr's own "+" menu gets one Claude row per account (owner 11-16 s43: "Add both account rows"): Flockbook keeps
// its entries in Herdr's programs.json, beside the person's own, named as Flockbook's menu names them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { PREFIX, programKey, launchScript, programEntries, mergePrograms, syncPrograms } from "../mods/flockbook/programs.js";
import { menuRows } from "../mods/flockbook/newmenu.js";

const LIST = [{ mark: "EWI", name: "Work account", config_dir: "~/.claude-eaglewatch" }, { mark: "ME", name: "Personal account" }];
const USAGE = [
  { kind: "claude", id: "EWI", email: "eaglewatch9002@example.ph" },
  { kind: "claude", id: "ME", email: "jamilaian21@example.com" },
];

test("an account's program key: Flockbook's prefix and the mark, lower case, safe", () => {
  assert.equal(programKey("EWI"), `${PREFIX}ewi`);
  assert.equal(programKey("My Acct/2"), `${PREFIX}my-acct-2`);
});

test("the launch line: the default account clears the config folder; others set it from $HOME, quoted", () => {
  assert.equal(launchScript(null), "unset CLAUDE_CONFIG_DIR; exec claude");
  assert.equal(launchScript("~/.claude-eaglewatch"), `CLAUDE_CONFIG_DIR="$HOME"/'.claude-eaglewatch' exec claude`);
  assert.equal(launchScript("~/.claude-work/"), `CLAUDE_CONFIG_DIR="$HOME"/'.claude-work' exec claude`);
  assert.equal(launchScript("~"), `CLAUDE_CONFIG_DIR="$HOME" exec claude`);
  assert.equal(launchScript("/opt/it's"), `CLAUDE_CONFIG_DIR='/opt/it'\\''s' exec claude`);
});

test("one entry per account, the default first, named by its email like Flockbook's menu", () => {
  const e = programEntries(LIST, USAGE);
  assert.deepEqual(Object.keys(e), [`${PREFIX}me`, `${PREFIX}ewi`]);
  assert.deepEqual(e[`${PREFIX}me`], { name: "Claude Code (jamilaian21)", icon: "icons/claude.svg", run: ["sh", "-c", "unset CLAUDE_CONFIG_DIR; exec claude"] });
  assert.deepEqual(e[`${PREFIX}ewi`].run, ["sh", "-c", `CLAUDE_CONFIG_DIR="$HOME"/'.claude-eaglewatch' exec claude`]);
  assert.equal(e[`${PREFIX}ewi`].name, "Claude Code (eaglewatch9002)");
  assert.deepEqual(programEntries([], USAGE), {});
});

test("merging keeps the person's entries and other fields, replaces Flockbook's, drops stale ones", () => {
  const was = JSON.stringify({ programs: { lazygit: { name: "Git" }, [`${PREFIX}old`]: { name: "gone" }, [`${PREFIX}me`]: { name: "Claude Code (Personal account)" } }, shells: ["xonsh"] });
  const r = mergePrograms(was, programEntries(LIST, USAGE));
  assert.equal(r.bad, false);
  const out = JSON.parse(r.text);
  assert.deepEqual(Object.keys(out.programs), ["lazygit", `${PREFIX}me`, `${PREFIX}ewi`]);
  assert.equal(out.programs[`${PREFIX}me`].name, "Claude Code (jamilaian21)");
  assert.deepEqual(out.shells, ["xonsh"]);
  assert.ok(r.text.endsWith("\n"));
});

test("no write when nothing changed, or when there is nothing to add to a missing file", () => {
  const first = mergePrograms(null, programEntries(LIST, USAGE));
  assert.ok(first.text);
  assert.deepEqual(mergePrograms(first.text, programEntries(LIST, USAGE)), { bad: false, text: null });
  assert.deepEqual(mergePrograms(null, {}), { bad: false, text: null });
  assert.deepEqual(mergePrograms("  \n", {}), { bad: false, text: null });
});

test("accounts removed: Flockbook's entries go, the person's stay", () => {
  const was = JSON.stringify({ programs: { lazygit: { name: "Git" }, [`${PREFIX}me`]: { name: "x" } } });
  assert.deepEqual(JSON.parse(mergePrograms(was, {}).text), { programs: { lazygit: { name: "Git" } } });
});

test("a file that isn't the expected JSON is left alone", () => {
  assert.deepEqual(mergePrograms("{ nope", programEntries(LIST, USAGE)), { bad: true, text: null });
  assert.deepEqual(mergePrograms("[]", programEntries(LIST, USAGE)), { bad: true, text: null });
  assert.deepEqual(mergePrograms(JSON.stringify({ programs: [1] }), programEntries(LIST, USAGE)), { bad: true, text: null });
});

// The sync itself, against the stub's files.
function setup({ text = null, usage = true } = {}) {
  reset();
  fake.shared["flockbook.config"] = { file: { accounts: LIST } };
  if (usage) fake.shared["flockbook.usage"] = { sources: { "": { asked: 1, lines: [] } } };
  const files = { [`${fake.appHome}/programs.json`]: text };
  fake.readText = (p) => files[p] ?? null;
  fake.writeText = (p, t) => { files[p] = t; return null; };
  return files;
}

test("sync writes the entries against the text it read", async () => {
  const files = setup({ text: JSON.stringify({ programs: { lazygit: { name: "Git" } } }) });
  await syncPrograms({ rows: () => USAGE });
  assert.equal(log.writes.length, 1);
  const [p, text, expected] = log.writes[0];
  assert.equal(p, `${fake.appHome}/programs.json`);
  assert.equal(expected, JSON.stringify({ programs: { lazygit: { name: "Git" } } }));
  assert.deepEqual(Object.keys(JSON.parse(text).programs), ["lazygit", `${PREFIX}me`, `${PREFIX}ewi`]);
  await syncPrograms({ rows: () => USAGE });                       // second tick: same entries, no write
  assert.equal(log.writes.length, 1);
  assert.ok(files[p]);
});

test("sync waits for the usage readings (names would change a minute later otherwise)", async () => {
  setup({ usage: false });
  await syncPrograms({ rows: () => USAGE });
  assert.equal(log.writes.length, 0);
});

test("sync leaves a broken programs.json alone", async () => {
  setup({ text: "{ nope" });
  await syncPrograms({ rows: () => USAGE });
  assert.equal(log.writes.length, 0);
});

test("Flockbook's own menu doesn't list these entries a second time", () => {
  const known = [
    { key: "claude", name: "Claude Code", icon: "icons/claude.svg", installed: true },
    { key: `${PREFIX}me`, name: "Claude Code (jamilaian21)", installed: true },
    { key: `${PREFIX}ewi`, name: "Claude Code (eaglewatch9002)", installed: true },
    { key: "codex", name: "Codex", installed: true },
  ];
  const accts = [{ mark: "ME", label: "Claude Code (jamilaian21)" }, { mark: "EWI", label: "Claude Code (eaglewatch9002)" }];
  assert.deepEqual(menuRows(known, accts).installed.map((a) => a.key), ["claude-ME", "claude-EWI", "codex"]);
});
