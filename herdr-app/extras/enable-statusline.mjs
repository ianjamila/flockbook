#!/usr/bin/env node
// Optional (plus build): shows each Claude Code session's own status line in the Flockbook chat header.
// It puts extras/flockbook-statusline (copied to <herdr-app home>/flockbook/bin by install.sh) in front of the
// statusLine command in a Claude Code settings.json, so each session's status line is also saved for the chat.
// What Claude Code shows does not change.
//   node extras/enable-statusline.mjs                  turn it on (for ~/.claude/settings.json)
//   node extras/enable-statusline.mjs --undo           back to your plain status line
//   --config-dir <folder>                              another account's config folder (CLAUDE_CONFIG_DIR)
//   --home <herdr-app home>                            default: $HERDR_APP_HOME, else ~/.config/herdr-app
// It changes only statusLine.command, keeps a timestamped backup, and refuses when there is no status line command
// to wrap (set one up in Claude Code first: /statusline).
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
const tilde = (p) => (p && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const configDir = tilde(opt("--config-dir")) ?? join(homedir(), ".claude");
const appHome = tilde(opt("--home")) ?? process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const file = join(configDir, "settings.json");
const wrapper = join(appHome, "flockbook", "bin", "flockbook-statusline");
const dir = join(appHome, "flockbook", "statusline");
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const prefix = `${quote(process.execPath)} ${quote(wrapper)} --dir ${quote(dir)} -- `;

if (!existsSync(file)) { console.error(`No ${file}. Nothing changed.`); process.exit(1); }
if (!argv.includes("--undo") && !existsSync(wrapper)) { console.error(`No ${wrapper}: run ./install.sh first. Nothing changed.`); process.exit(1); }
const text = readFileSync(file, "utf8");
const s = JSON.parse(text);
const now = s.statusLine?.command;
if (typeof now !== "string" || !now.trim()) { console.error("There is no statusLine command to wrap (set one up in Claude Code with /statusline). Nothing changed."); process.exit(1); }
const wrapped = now.includes("flockbook-statusline");
let want;
if (argv.includes("--undo")) {
  if (!wrapped) { console.log("Already plain:", now); process.exit(0); }
  // This script's shape: <prefix> -- sh -c '<your command>'.
  const i = now.indexOf(" -- sh -c '");
  const inner = i >= 0 && now.endsWith("'") ? now.slice(i + " -- sh -c '".length, -1) : null;
  if (inner == null) { console.error("The command does not look like this script's; changed nothing:\n  " + now); process.exit(1); }
  want = inner.replace(/'\\''/g, "'");
} else {
  if (wrapped) { console.log("Already on:", now); process.exit(0); }
  // Through sh -c, so a command with pipes, ~ or $(…) runs as it did (the wrapper runs its argv without a shell).
  want = `${prefix}sh -c '${now.replace(/'/g, `'\\''`)}'`;
}
const backup = `${file}.bak-statusline-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(file, backup);
s.statusLine = { ...s.statusLine, command: want };
writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
console.log(`${argv.includes("--undo") ? "Back to" : "Now"}: ${want}\n(backup: ${backup}). New Claude Code sessions pick it up.`);
