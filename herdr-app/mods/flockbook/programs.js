// Herdr's own "+" menu (the plain Herdr layout's tab bar) gets one Claude row per account (owner 11-16 s43: "Add both
// account rows"): Flockbook keeps one entry per account in Herdr's programs.json (`run` = start claude as that
// account), named as Flockbook's own menu names it ("Claude Code (jamilaian21)"). The person's own entries and other
// fields stay; only Flockbook's (key prefix PREFIX) are replaced, and a stale one is removed. Herdr can't hide its
// plain "Claude Code" row (s43 probe: `run: []` is ignored, `null` is refused), so that row stays.
// Run through `sh -c` so the config folder is the home of whichever machine starts it (a Mac, WSL, a server); the
// launcher loads the login profile first, so `claude` is found as Herdr's plain row finds it. Flockbook's menu skips
// these entries (it has its own account rows).
import { appHome, home, readTextFile, writeTextFile } from "herdr";
import { accounts } from "./accounts.js";
import { rows as usageRows, KEY_USAGE } from "./usage.js";
import { snapShared } from "./parked.js";
import { claudeAccounts, PROGRAM_PREFIX } from "./newmenu.js";

// <programs-pure>
export const PREFIX = PROGRAM_PREFIX;
export const programKey = (mark) => PREFIX + String(mark).toLowerCase().replace(/[^a-z0-9-]/g, "-");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The shell line that starts claude as an account with this config folder (none: the default account).
export function launchScript(configDir) {
  if (!configDir) return "unset CLAUDE_CONFIG_DIR; exec claude";
  const d = String(configDir).replace(/\/+$/, "") || "/";
  const v = d === "~" ? `"$HOME"` : d.startsWith("~/") ? `"$HOME"/${sq(d.slice(2))}` : sq(d);
  return `CLAUDE_CONFIG_DIR=${v} exec claude`;
}
// { key: entry } for the accounts set, in Flockbook's menu order and names.
export function programEntries(list, usage) {
  return Object.fromEntries(claudeAccounts(list, usage).map((a) => {
    const acct = list.find((x) => x.mark === a.mark);
    return [programKey(a.mark), { name: a.label, icon: "icons/claude.svg", run: ["sh", "-c", launchScript(acct?.config_dir)] }];
  }));
}
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
// The new programs.json text with these entries, or text null when nothing changes; bad when the file isn't a JSON
// object whose `programs` is an object (it is left alone).
export function mergePrograms(text, entries) {
  const blank = text == null || !String(text).trim();
  let file = {};
  if (!blank) {
    try { file = JSON.parse(text); } catch { return { bad: true, text: null }; }
    if (!isObj(file) || (file.programs != null && !isObj(file.programs))) return { bad: true, text: null };
  }
  if (blank && !Object.keys(entries).length) return { bad: false, text: null };
  const kept = Object.fromEntries(Object.entries(file.programs ?? {}).filter(([k]) => !k.startsWith(PREFIX)));
  const next = { ...file, programs: { ...kept, ...entries } };
  if (!blank && JSON.stringify(next) === JSON.stringify(file)) return { bad: false, text: null };
  return { bad: false, text: JSON.stringify(next, null, 2) + "\n" };
}
// </programs-pure>

export const programsPath = () => `${appHome()}/programs.json`;

// Once a minute (top.js, after the settings load). Waits for the usage readings, so the names don't change a minute
// later; writes only on change, against the text just read (an edit made meanwhile is read again next minute, never
// overwritten). `rows`: the usage rows reader (tests).
export async function syncPrograms({ rows = usageRows } = {}) {
  const data = snapShared(KEY_USAGE);
  if (data == null) return;
  const list = accounts();
  let was;
  try { was = await readTextFile(programsPath()); } catch { return; }
  const r = mergePrograms(was ?? null, programEntries(list, rows(data, list, home())));
  if (r.bad || r.text == null) return;
  try { await writeTextFile(programsPath(), r.text, was ?? null); } catch { /* changed meanwhile: next minute */ }
}
