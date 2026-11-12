// The Claude Code accounts the tabs run as (plus build), from the "accounts" setting in config.json:
//   "accounts": [{ "mark": "WORK", "name": "Work account", "config_dir": "~/.claude-work" },
//                { "mark": "HOME", "name": "Personal account" }]
// `mark` is the word the account's Claude Code status line shows ("you:~/x | WORK …"), so a tab's screen says which
// account it runs as; `config_dir` is that account's CLAUDE_CONFIG_DIR (none: the default ~/.claude). Without the
// setting there is one account, the default one, and no status line is needed to tell it.
// The About lines, "Summarize this tab" and Resume run `claude` as the tab's own account (ai.js, resume.js).
import { home } from "herdr";
import { setting, expandHome } from "./config.js";

export const DEFAULT_ACCOUNT = "default";
const RULE_LINE = /^\s*─{20,}\s*$/;
export const STATUS_FROM_BOTTOM = 16;

// <accounts-pure>
// The accounts set, or [] (one default account).
export const accountList = (v) => (Array.isArray(v) ? v : []);
// The account ids: each mark, or the one default account.
export const accountIds = (list) => (list.length ? list.map((a) => a.mark) : [DEFAULT_ACCOUNT]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The account a screen's Claude Code status line names, or null. One account (or none set): always that one, the
// screen is not read. Several: only the real status line counts — the first line under the input box's bottom rule
// (the box: a rule, a "❯" line, …, a rule), near the bottom of the screen, shaped "user:folder | …", naming exactly
// one account's mark after a "|". Output text, a quoted status line or words typed in the box never count; anything
// unclear → null (nothing is sent).
export function accountOfScreen(screen, list) {
  if (list.length <= 1) return accountIds(list)[0];
  const lines = String(screen ?? "").replace(/\s+$/, "").split(/\r?\n/);
  let box = -1;
  for (let i = lines.length - 1; i > 0; i--) if (/^\s*❯/.test(lines[i]) && RULE_LINE.test(lines[i - 1])) { box = i; break; }
  if (box < 0) return null;
  let end = box + 1;
  while (end < lines.length && !RULE_LINE.test(lines[end])) end++;
  const at = end + 1;
  if (at >= lines.length || lines.length - 1 - at > STATUS_FROM_BOTTOM) return null;
  const line = lines[at];
  if (!/^\s*[\w.-]+:\S/.test(line)) return null;
  const marks = new RegExp(`\\|\\s*(${list.map((a) => escape(a.mark)).join("|")})(?=\\s|…|$)`, "g");
  const found = [...line.matchAll(marks)].map((m) => m[1]);
  return found.length === 1 ? found[0] : null;
}
// "Work account (WORK)"; the default account: "Your Claude account"; an id no longer set: "Account X".
export function nameOf(id, list) {
  if (!id) return "Unknown account";
  if (id === DEFAULT_ACCOUNT && !list.length) return "Your Claude account";
  const a = list.find((x) => x.mark === id);
  return a ? `${a.name} (${a.mark})` : `Account ${id}`;
}
// The config folder of an account (expanded), or null for the default one.
export function configDirOf(id, list, homeDir) {
  const a = list.find((x) => x.mark === id);
  return a?.config_dir ? expandHome(a.config_dir, homeDir).replace(/\/+$/, "") : null;
}
// The account a conversation log belongs to: …/<config folder>/projects/<project>/<id>.jsonl, the config folder being
// an account's config_dir, else the default ~/.claude (the account without config_dir, or the one default account).
// { sid, account } or null.
export function sessionOfLog(p, list, homeDir) {
  const m = /^(.*)\/projects\/[^/]+\/([A-Za-z0-9_-]+)\.jsonl$/.exec(String(p ?? ""));
  if (!m) return null;
  const dir = m[1].replace(/\/+$/, "");
  const own = list.find((a) => a.config_dir && configDirOf(a.mark, list, homeDir) === dir);
  if (own) return { sid: m[2], account: own.mark };
  if (homeDir && dir !== `${homeDir}/.claude`) return null;
  if (!homeDir && !/\/\.claude$/.test(dir)) return null;
  const plain = list.find((a) => !a.config_dir);
  if (list.length && !plain) return null;
  return { sid: m[2], account: plain ? plain.mark : DEFAULT_ACCOUNT };
}
// The folders `claude` is looked for in when claude_path is not set (a Mac app's PATH has none of them).
export const CLAUDE_DIRS = ["~/.local/bin", "~/.npm-global/bin", "~/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "~/.bun/bin", "~/.volta/bin"];
// The argv that runs claude as `id`: [command, args]. /usr/bin/env sets or clears CLAUDE_CONFIG_DIR (exec has no env
// option) and, without claude_path, a PATH with the usual folders so `claude` is found. Unknown id → null.
export function claudeArgv(id, args, { list, homeDir, claudePath = null, envPath = "" }) {
  if (!accountIds(list).includes(id)) return null;
  const dir = configDirOf(id, list, homeDir);
  const env = dir ? [`CLAUDE_CONFIG_DIR=${dir}`] : ["-u", "CLAUDE_CONFIG_DIR"];
  if (claudePath) return ["/usr/bin/env", [...env, expandHome(claudePath, homeDir), ...args]];
  const where = [...CLAUDE_DIRS.map((d) => expandHome(d, homeDir)), ...String(envPath || "/usr/bin:/bin").split(":")].filter(Boolean);
  return ["/usr/bin/env", [...env, `PATH=${[...new Set(where)].join(":")}`, "claude", ...args]];
}
// </accounts-pure>

export const accounts = () => accountList(setting("accounts"));
export const accountName = (id) => nameOf(id, accounts());
export const accountOf = (screen) => accountOfScreen(screen, accounts());
export const claudeCommand = (id, args) => claudeArgv(id, args, { list: accounts(), homeDir: home(), claudePath: setting("claude_path"), envPath: globalThis.process?.env?.PATH ?? "" });
