// The plus build's helper (install.sh --build-helper) carries fixes the official release may not have yet: long
// Claude Code questions, the "edit in <editor>" key line, typed capitals (upstream PR #12) and a send over Claude
// Code's dim "/" suggestion (upstream main since 0.13.0: the box's first paint shows it dim). An
// official Flockbook update installs the official helper over it. This looks every 10 minutes (one copy of the mod
// acts, through shared state) for one mark per fix that only the patched helper has, and warns once per helper file
// (its size and time) — only once this machine has run a patched helper (state.everPatched): someone who kept the
// official helper is never warned.
import { exec, notify, shared, setShared } from "herdr";
import { sidecarPath } from "./sidecar.js";
import { setting } from "./config.js";

const KEY = "flockbook.patchcheck";          // { at, file, patched, missing, warned }
const EVERY_MS = 10 * 60_000;
// One mark per fix. PR #12: its refusal text for untypeable answers. The suggestion send: upstream's function name,
// which the release build keeps as a symbol (checked 2026-11-13: absent from v0.13.0 official, present in a build
// from upstream fe57f10). It replaced this build's own fix (its mark was "suggested_slash").
export const MARKS = [
  { mark: "cannot type yet", fix: "long questions, typed capitals and \"edit in VS Code\" answers" },
  { mark: "claude_suggestion_in_paint", fix: "sending over Claude Code's dim / suggestion" },
];
// The rebuild command shown in the warning: the "helper_rebuild" setting, else the plus build's installer.
export const REBUILD = "./install.sh --build-helper (in your flockbook-herdr-plus folder)";
const rebuild = () => setting("helper_rebuild") ?? REBUILD;

// Whether a check is due now; claims the slot so the other copies of the mod skip it.
export function due(state, now = Date.now()) {
  return !state?.at || now - state.at >= EVERY_MS;
}
// grep exit codes (one per mark) → true (all marks), false (one is missing), null (unreadable: no verdict).
export function patchedFrom(codes) {
  if (!codes.length || codes.some((c) => c !== 0 && c !== 1)) return null;
  return codes.every((c) => c === 0);
}
// The fixes whose mark is missing, from the same codes.
export const missingFrom = (codes) => MARKS.filter((_, i) => codes[i] === 1).map((m) => m.fix);
// What to do with a result: "warn" (a fix is missing and this file wasn't warned about yet), or null.
export function verdict(state, file, patched) {
  if (patched !== false || !file) return null;
  return state?.warned === file ? null : "warn";
}

export async function checkHelperPatch(now = Date.now()) {
  const st = shared(KEY) ?? {};
  if (!due(st, now)) return;
  setShared(KEY, { ...st, at: now });
  const path = sidecarPath();
  let file = null, codes = [];
  try {
    const s = await exec("/usr/bin/stat", ["-f", "%z %m", path], { timeout: 5000 });
    if (s.code === 0) file = s.stdout.trim();
    for (const m of MARKS) codes.push((await exec("/usr/bin/grep", ["-q", "-a", "-F", m.mark, path], { timeout: 15000 })).code);
  } catch { return; }
  const patched = patchedFrom(codes), missing = missingFrom(codes);
  const cur = shared(KEY) ?? {}, everPatched = Boolean(cur.everPatched || patched === true);
  if (!everPatched || verdict(cur, file, patched) !== "warn") { setShared(KEY, { ...cur, file, patched, missing, everPatched }); return; }
  setShared(KEY, { ...cur, file, patched, missing, everPatched, warned: file });
  notify({
    title: "Flockbook update replaced the patched helper",
    body: `These fixes are gone again: ${missing.join("; ")}. Rebuild it in a terminal: ${rebuild()} (skip this if the new release already has the fixes).`,
    level: "warning",
  });
}
