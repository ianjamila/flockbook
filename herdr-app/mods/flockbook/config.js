// Flockbook settings: <appHome>/flockbook/config.json, set in the Flockbook settings dialog.
// {"check_updates": true, "status_row": "show", "remote_helper": "ask", "text_size": "default"}. A missing file or key is the default;
// the install never creates the file. A file that is not JSON is the defaults too, and is left alone
// (the screen says so). The helper reads the same file (the mod passes --home) for check_updates and
// remote_helper. Kept in shared(), so every copy of this mod redraws when one changes it.
import { appHome, readTextFile, writeTextFile, shared, setShared, notify } from "herdr";
import * as sidecar from "./sidecar.js";

export const KEY_CONFIG = "flockbook.config";    // { file, bad, text }: the parsed file, and the text it was read from
export const KEY_UPDATE = "flockbook.update";    // the helper's last `update` line
const KEY_UPDATE_AT = "flockbook.update.at";     // when the mod last asked (ms)
const KEY_UPDATE_SEEN = "flockbook.update.seen"; // the version whose line was seen in the open sidebar
// The plus build's workflow switches (pipeline_asks, handoff_marks, worth_considering, auto_move) are off unless
// config.json turns them on: they read a particular way of working (see the README's "Settings" section).
export const DEFAULTS = { check_updates: true, status_row: "show", remote_helper: "ask", phone_read_only: false, text_size: "default", auto_move: "off", about_line: "on", about_cap: "200", terminal_size: "default", terminal_px: null, dance: "on", stay_awake: "on",
  pipeline_asks: "off", handoff_marks: "off", worth_considering: "off", accounts: null, projects: null, claude_path: null, claude_machine: null, helper_rebuild: null };
export const CHOICES = { check_updates: [true, false], status_row: ["show", "hide"], remote_helper: ["ask", "never"], phone_read_only: [false, true], text_size: ["small", "default", "large"], auto_move: ["on", "off"], about_line: ["on", "off"], about_cap: ["100", "200", "400", "none"], terminal_size: ["small", "default", "large", "full", "custom"], dance: ["on", "off"], stay_awake: ["on", "off"],
  pipeline_asks: ["on", "off"], handoff_marks: ["on", "off"], worth_considering: ["on", "off"] };
// Settings that are not one of a few choices: a check instead. terminal_px: the size the terminal window
// was dragged to, [width, height] in px (terminal_size "custom").
// accounts: the Claude Code accounts the tabs run as, when there is more than one ([{ mark, name, config_dir }]: `mark`
// is the word the account's status line shows, like "| WORK …"; `config_dir` its CLAUDE_CONFIG_DIR, none = the
// default ~/.claude). projects: workspaces a session started in "~" may move to ([{ workspace, folder, title,
// suggest_only, machine }]: `title` a pattern its title matches; `machine` the machine its folder and workspace are on,
// none = this computer). claude_path: the claude program on this computer, when it is not found on the usual places.
// claude_machine: the machine the About lines, Summarize and Resume run claude on (where.js; none = this computer). helper_rebuild: the command patchcheck.js shows to rebuild the patched helper.
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
// A machine name as `hc machine ls` shows it ("wsl", "pc-wsl").
const machineName = (v) => typeof v === "string" && /^[\w.@-]{1,64}$/.test(v);
const pattern = (v) => { if (v == null) return true; if (!text(v, 200)) return false; try { new RegExp(v, "i"); return true; } catch { return false; } };
export const VALID = {
  terminal_px: (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 100 && n <= 20000),
  accounts: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 8
    && v.every((a) => a && typeof a === "object" && typeof a.mark === "string" && /^[\w.@-]{1,24}$/.test(a.mark) && text(a.name, 60) && (a.config_dir == null || text(a.config_dir, 300)))
    && new Set(v.map((a) => a.mark)).size === v.length && v.filter((a) => a.config_dir == null).length <= 1,
  projects: (v) => Array.isArray(v) && v.length <= 16
    && v.every((p) => p && typeof p === "object" && text(p.workspace, 60) && text(p.folder, 300) && pattern(p.title) && (p.suggest_only == null || typeof p.suggest_only === "boolean") && (p.machine == null || machineName(p.machine))),
  claude_path: (v) => text(v, 300),
  claude_machine: (v) => machineName(v),
  helper_rebuild: (v) => text(v, 300),
};
// "~/x" → "<home>/x"; anything else as it is.
export const expandHome = (p, homeDir) => (typeof p === "string" && (p === "~" || p.startsWith("~/")) && homeDir ? homeDir + p.slice(1) : p);
// The chat's text size (text_size) over the default 16 px: messages, code boxes and tables follow it.
const TEXT_PX = { small: 14, default: 16, large: 18 };
export const textScale = () => TEXT_PX[setting("text_size")] / 16;
const TEXT_NAME = { small: "Small", default: "Default", large: "Large" };
// The text-smaller / text-larger / text-default keys: one step along Small, Default, Large (no wrap).
export async function stepTextSize(c) {
  const order = CHOICES.text_size, i = order.indexOf(setting("text_size"));
  const to = c === "text-default" ? "default" : order[Math.max(0, Math.min(order.length - 1, i + (c === "text-larger" ? 1 : -1)))];
  if (to === order[i]) return false;
  const ok = await setSetting("text_size", to);
  if (ok) notify({ title: `Chat text: ${TEXT_NAME[to]}`, level: "info", timeout: 1500 });
  return ok;
}
export const configPath = () => `${appHome()}/flockbook/config.json`;

export function parseConfig(text) {
  if (text == null) return { file: {}, bad: false, text: null };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { file: v, bad: false, text };
  } catch { /* not JSON */ }
  return { file: {}, bad: true, text };
}

export function setting(key) {
  const v = shared(KEY_CONFIG)?.file?.[key];
  if (VALID[key]) return VALID[key](v) ? v : DEFAULTS[key];
  return CHOICES[key].includes(v) ? v : DEFAULTS[key];
}
export const configBad = () => shared(KEY_CONFIG)?.bad === true;

// Reads the file again (someone may have edited it); shares it only when it changed.
export async function loadConfig() {
  let text = null;
  try { text = await readTextFile(configPath()); } catch { text = null; }
  const c = parseConfig(text);
  const was = shared(KEY_CONFIG);
  if (!was || was.text !== c.text) setShared(KEY_CONFIG, c);
  return c;
}

// Sets one key and keeps the others. False when the file is not JSON (it stays as it is) or the write failed.
export const setSetting = (key, value) => setSettings({ [key]: value });
// Sets several keys in one write.
export async function setSettings(patch) {
  for (let i = 0; i < 2; i++) {
    const c = await loadConfig();
    if (c.bad) return false;
    const file = { ...c.file, ...patch };
    const text = JSON.stringify(file, null, 2) + "\n";
    // Against the text just read: a change made meanwhile is read again, not overwritten.
    try { await writeTextFile(configPath(), text, c.text); }
    catch { continue; }
    setShared(KEY_CONFIG, { file, bad: false, text });
    if ("check_updates" in patch) {
      setShared(KEY_UPDATE_AT, null);
      setShared(KEY_UPDATE, null);
      if (patch.check_updates) await pollUpdate();
    }
    return true;
  }
  return false;
}

const HOUR = 60 * 60 * 1000;
// Asks the helper whether a newer Flockbook is out, at most once an hour (it asks GitHub at most once a
// day and keeps the answer). Off: the helper is not even asked.
export async function pollUpdate(now = Date.now()) {
  const at = shared(KEY_UPDATE_AT);
  if (at != null && now - at < HOUR) return shared(KEY_UPDATE) ?? null;
  setShared(KEY_UPDATE_AT, now);
  if (!setting("check_updates")) { if (shared(KEY_UPDATE)) setShared(KEY_UPDATE, null); return null; }
  const r = await sidecar.updateCheck();
  const line = r.error ? null : r.lines.find((l) => l.type === "update") ?? null;
  setShared(KEY_UPDATE, line);
  return line;
}

// The update line to show, or null: only for a newer release that was not dismissed, and only while on.
export function updateShown() {
  const u = shared(KEY_UPDATE);
  return u?.state === "newer" && u.latest && setting("check_updates") ? u : null;
}

// The dot on the top bar's sidebar button: a line to show that the sidebar has not shown yet.
export const updateDot = () => { const u = updateShown(); return Boolean(u) && shared(KEY_UPDATE_SEEN) !== u.latest; };
// The sidebar opened (docked or floating): its line is seen, so the dot goes.
export function updateSeen() { const u = updateShown(); if (u && shared(KEY_UPDATE_SEEN) !== u.latest) setShared(KEY_UPDATE_SEEN, u.latest); }

// Not now: hidden at once; the helper keeps it hidden for that version until a newer one.
export async function dismissUpdate() {
  const u = updateShown();
  if (!u) return;
  setShared(KEY_UPDATE, { ...u, state: "dismissed" });
  await sidecar.updateCheck(u.latest);
}
