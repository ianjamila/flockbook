// The "sessions" dialog: Resume sessions (owner 11-14 s26: "a resume session in herdr that lists all closed sessions … with
// a search function and can batch resume click multiple items"). It lists the Claude Code conversations that are CLOSED
// (their logs, newest first, the last 30 days, at most 300 a machine) for every account on this computer and on the
// "claude_machine" (where.js), with a search box and tick boxes; "Resume selected" opens each pick as its own account on
// its own machine, in the workspace of the project that holds its folder, else that machine's "~" workspace, else a new
// one. A session running in a tab now is not listed and is never opened twice (resume.js liveSids, asked again just
// before opening). Nothing runs until the button is pressed.
//
// The logs are read by ONE fixed `sh` script per machine (LIST_SCRIPT): its text never holds a value, the 30 days, the
// cap and the config folders are positional arguments. It needs no helper and no new code on the other machine, only
// sh, find, stat, grep, sort and head, which a Mac (BSD) and Linux (GNU) both have.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, shared, setShared, run, notify } from "herdr";
import { spaces } from "./parked.js";
import { accounts, accountName, sessionOfLog, claudeRun, configDirOf } from "./accounts.js";
import { claudeMachine, localWindows, connected, machineHome, knownHome, execAt, sameMachine, NEEDS_MACHINE } from "./where.js";
import { liveSids, claimOpening, releaseOpening, noteOpened, mayBe, placeNow, returnTo } from "./resume.js";
import { projects, projectsOn, projectSpace } from "./automove.js";
import { agoText } from "./ai.js";
import { sessionsClosed } from "./state.js";

export const KEY_LIST = "flockbook.sessions.list";   // { at, days, by: { [machine, "" = this computer]: { rows } | { error } } }
// s28 (Fable): a log changed this recently may be a conversation running in a terminal Herdr doesn't see (VS Code, …).
export const RECENT_MS = 5 * 60_000;
export const LIST_DAYS = 30, LIST_MAX = 300, SHOW_MAX = 200, STALE_MS = 60_000, LIVE_MS = 10_000, LIST_TIMEOUT_MS = 90_000;

// One line per conversation log, tab separated: mtime (epoch seconds), path, then the cwd, the title and the first prompt
// as the logs write them (JSON strings, decoded in JS; empty when the log has none). Only top-level logs (project folder
// → <id>.jsonl, never a sub-agent's folder), changed within `days`; the newest `max` of them. cwd: the first "cwd" in the
// first 64 KB. Title: the LAST "customTitle" (a /rename), else the last "summary", else an AI-written title, in the last
// 256 KB. First prompt: the first user line in the first 64 KB that isn't a meta line or a command wrapper ("<…>").
// $1 days, $2 max, the rest the config folders.
export const LIST_SCRIPT = String.raw`LC_ALL=C; export LC_ALL
days=$1; max=$2; shift 2
if stat -c %Y / >/dev/null 2>&1; then gnu=1; else gnu=; fi
val() { sed -e 's/^"[A-Za-z]*"://'; }
for d in "$@"; do
  [ -d "$d/projects" ] || continue
  if [ -n "$gnu" ]; then
    find "$d/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -"$days" -exec stat -c '%Y %n' {} + 2>/dev/null
  else
    find "$d/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -"$days" -exec stat -f '%m %N' {} + 2>/dev/null
  fi
done | sort -rn | head -n "$max" | while read -r m f; do
  [ -f "$f" ] || continue
  first=$(head -c 65536 "$f")
  last=$(tail -c 262144 "$f")
  cwd=$(printf '%s\n' "$first" | grep -a -E -o '"cwd":"([^"\\]|\\.)*"' | head -n 1 | cut -c 1-4200 | val)
  title=$(printf '%s\n' "$last" | grep -a -E -o '"customTitle":"([^"\\]|\\.)+"' | tail -n 1 | cut -c 1-500 | val)
  [ -n "$title" ] || title=$(printf '%s\n' "$last" | grep -a -E -o '"summary":"([^"\\]|\\.)+"' | tail -n 1 | cut -c 1-500 | val)
  [ -n "$title" ] || title=$(printf '%s\n' "$last" | grep -a -E -o '"(aiTitle|aiGeneratedTitle)":"([^"\\]|\\.)+"' | tail -n 1 | cut -c 1-500 | val)
  prompt=$(printf '%s\n' "$first" | grep -a '"type":"user"' | grep -a -v -E '"isMeta":true|"(content|text)":"(<|Caveat)' | head -n 1 | grep -a -E -o '"(content|text)":"([^"\\]|\\.)+"' | head -n 1 | cut -c 1-700 | val)
  printf '%s\t%s\t%s\t%s\t%s\n' "$m" "$f" "$cwd" "$title" "$prompt"
done 2>/dev/null`;

// <sessions-pure>
// A JSON string literal ("…" as the logs write it) decoded; a cut-off or bad one keeps its text without the quotes;
// anything that is not a quoted string → "".
export function unJson(raw) {
  const s = String(raw ?? "");
  if (!s.startsWith("\"")) return "";
  try { const v = JSON.parse(s); return typeof v === "string" ? v : ""; } catch { return s.slice(1).replace(/"$/, ""); }
}
// The exact string a JSON literal holds, or "" when it is cut off or bad (s28 Codex R1 P2: a folder is used as it is,
// never a guess).
export function unJsonExact(raw) {
  try { const v = JSON.parse(String(raw ?? "")); return typeof v === "string" ? v : ""; } catch { return ""; }
}
const tidy = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// The listing script's output as rows { sid, account, machine ("" = this computer), cwd, title (or null), prompt, at (ms) },
// newest first. A line that is no log of one of the accounts there, or whose log says nothing at all (an empty one), is left out.
export function parseListing(out, { machine, list, homeDir }) {
  const seen = new Set(), rows = [];
  for (const ln of String(out ?? "").split("\n")) {
    const p = ln.split("\t");
    if (p.length < 2) continue;
    const mtime = Number(p[0]), s = sessionOfLog(p[1], list, homeDir);
    if (!s || !Number.isFinite(mtime) || mtime <= 0) continue;
    // The folder is opened as the log names it: exact (no whitespace folded, no cut); a cut-off one is unknown.
    const cwd = unJsonExact(p[2]), title = tidy(unJson(p[3]), 120), prompt = tidy(unJson(p[4]), 160);
    if (!cwd && !title && !prompt) continue;
    const key = `${s.account}\t${s.sid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ sid: s.sid, account: s.account, machine: machine ?? "", cwd, title: title || null, prompt, at: mtime * 1000 });
  }
  return rows.sort((a, b) => b.at - a.at);
}
// The row's heading: its title, else its first prompt, else "(no title)".
export const headingOf = (r) => r.title || r.prompt || "(no title)";
// The rows whose title, first prompt, folder, account (`label(row)`) or machine hold every word of `query` (any case).
export function filterRows(rows, query, label = (r) => r.account) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = [r.title, r.prompt, r.cwd, label(r), r.account, r.machine].filter(Boolean).join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
// A folder with that machine's home as "~"; "?" when the log named none.
export function folderText(cwd, homeDir) {
  const c = String(cwd ?? "");
  if (!c) return "?";
  return homeDir && (c === homeDir || c.startsWith(`${homeDir}/`)) ? `~${c.slice(homeDir.length)}` : c;
}
// Each account's config folder on a machine whose home is `homeDir` (the default one is <home>/.claude), once each.
export function configDirs(list, homeDir) {
  const dirs = list.length ? list.map((a) => configDirOf(a.mark, list, homeDir) ?? `${homeDir}/.claude`) : [`${homeDir}/.claude`];
  return [...new Set(dirs)];
}
// Where a session opens: a tab in the workspace of the project that holds its folder (the deepest one) on its machine, else
// that machine's "~" workspace, else (this computer) the shown workspace when it is this computer's, else a new
// workspace on that machine ("" = this computer, s28 Codex R1 P2: a bare tab.new would land in the shown workspace even
// when that is another machine's). { name, args } for run(); the caller adds argv. `projs`: automove.js projects(); `list`: the workspaces.
export function placeOf(row, projs, list) {
  const m = row.machine || null, cwd = String(row.cwd ?? "");
  const inside = (f) => Boolean(f) && (cwd === f || cwd.startsWith(`${f}/`));
  const held = projectsOn(projs, m).filter((p) => inside(p.folder)).sort((a, b) => b.folder.length - a.folder.length);
  for (const p of held) { const s = projectSpace(p, list); if (s) return { name: "tab.new", args: { space: s.id, folder: cwd } }; }
  const home = list.find((s) => s.name === "~" && sameMachine(s.machine, m));
  if (home) return { name: "tab.new", args: { space: home.id, folder: cwd } };
  const shown = m ? null : list.find((s) => s.active && !s.machine);
  if (shown) return { name: "tab.new", args: { space: shown.id, folder: cwd } };
  return { name: "space.new", args: { machine: m ?? "", folder: cwd } };
}
// The notice after a resume: "Resumed 3 sessions. Skipped 2: 1 already open, 1 couldn't reach wsl."
export function resumeNotice({ opened, skipped }) {
  const head = `Resumed ${opened} ${opened === 1 ? "session" : "sessions"}.`;
  if (!skipped.length) return head;
  const why = new Map();
  for (const s of skipped) why.set(s.why, (why.get(s.why) ?? 0) + 1);
  const parts = [...why].map(([w, n]) => (why.size === 1 && n === skipped.length ? w : `${n} ${w}`));
  return `${head} Skipped ${skipped.length}: ${parts.join(", ")}.`;
}
export const keyOf = (r) => `${r.machine ?? ""}\t${r.account}\t${r.sid}`;
// </sessions-pure>

// The closed sessions of one machine (null / "" = this computer): { rows } or { error }.
export async function readMachine(machine, { days = LIST_DAYS, max = LIST_MAX } = {}) {
  const m = machine || null, homeDir = await machineHome(m);
  if (!homeDir) return { error: "it can't be reached" };
  const list = accounts();
  const r = await execAt(m, "/bin/sh", ["-c", LIST_SCRIPT, "sh", String(days), String(max), ...configDirs(list, homeDir)], { timeout: LIST_TIMEOUT_MS });
  const rows = parseListing(r?.stdout, { machine: m, list, homeDir });
  if (r?.code !== 0 && !rows.length) return { error: String(r?.stderr || r?.error || `exit code ${r?.code}`).trim().slice(0, 120) };
  return { rows };
}
// The machines the dialog reads: this computer (not Windows: Claude can't run there) and the connected claude_machine.
export function targets() {
  const cm = claudeMachine();
  return [...(localWindows() ? [] : [""]), ...(cm && connected(cm) ? [cm] : [])];
}
export const needsMachine = () => localWindows() && !claudeMachine();
export const cached = () => shared(KEY_LIST) ?? null;

// Opens each of `rows` as its account on its machine. A pick is skipped (and told why) when it runs in a tab now (asked
// again here, not taken from the list), its machine isn't connected or reachable, its account is no longer set or its folder
// is unknown. { opened, skipped: [{ row, why }] }.
// Picks on a machine with no "~" or project workspace share one new workspace (s27): the first makes it, named "~" (that
// machine's home workspace, so the auto-mover files its sessions as usual); the batch waits for it (WAIT_STEP_MS steps,
// at most NEW_SPACE_WAIT_MS) before the next pick there, which then opens as a tab in it. `wait(ms)`: a pause.
const WAIT_STEP_MS = 150, NEW_SPACE_WAIT_MS = 3000;
const pause = (ms) => new Promise((res) => (typeof setTimeout === "function" ? setTimeout(res, ms) : res()));
// s31 (from herdr-sessions, owner 11-14): once the picks show, the workspace and tab shown before are shown again.
export async function resumeSessions(rows, { wait = pause } = {}) {
  const was = placeNow(spaces()), before = spaces().reduce((n, s) => n + (s.tabs?.length ?? 0), 0);
  const skipped = [], live = await liveSids(), projs = projects(), done = new Set(), named = new Set();
  let opened = 0;
  const skip = (row, why) => skipped.push({ row, why });
  for (const row of rows) {
    const key = keyOf(row), m = row.machine || null;
    if (done.has(key)) continue;
    done.add(key);
    if (!live.looked.has(row.machine ?? "")) { skip(row, m ? (connected(m) ? `couldn't reach ${m}` : `${m} isn't connected now`) : "this computer can't run Claude here"); continue; }
    if (live.by[row.machine ?? ""]?.has(row.sid)) { skip(row, "already open"); continue; }
    // s28 (Codex R1 + R2 P2): a Claude tab there not identified yet may be this very session (a folder or title that
    // differs proves nothing: it may have moved, or be named anew), so it doesn't open until that tab is identified.
    // s31: only when that tab's command line says it may hold it (resume.js mayBe; a plain `claude` holds none).
    if ((live.unknownTabs ?? []).some((u) => u.machine === (row.machine ?? "") && mayBe(row, u.could))) { skip(row, "may be open already"); continue; }
    if (!row.cwd) { skip(row, "its folder is unknown"); continue; }
    // Claimed before anything is awaited (R2 P2), so another resume at the same time (a second dialog, the restart
    // offer) opens nothing more; given up again when this pick can't open.
    const claim = claimOpening(m, row.sid);
    if (!claim) { skip(row, "being opened already"); continue; }
    const c = await claudeRun(row.account, ["--resume", row.sid], m);
    if (!c) { releaseOpening(m, row.sid, claim); skip(row, "its account isn't set any more"); continue; }
    if (c.unreachable) { releaseOpening(m, row.sid, claim); skip(row, `couldn't reach ${c.unreachable}`); continue; }
    const place = placeOf(row, projs, spaces());
    const fresh = place.name === "space.new" && !named.has(m);
    if (fresh) named.add(m);
    run(place.name, { ...place.args, ...(fresh ? { name: "~" } : {}), argv: [c.cmd, ...c.args] });
    noteOpened(m, row.sid);
    opened++;
    // More picks for that machine still to place: wait for the new "~" workspace to show (not on the last one).
    const more = rows.slice(rows.indexOf(row) + 1).some((r) => (r.machine || null) === m && !done.has(keyOf(r)));
    if (fresh && more) {
      const there = () => spaces().some((x) => x.name === "~" && sameMachine(x.machine, m));
      for (let t = 0; !there() && t < NEW_SPACE_WAIT_MS; t += WAIT_STEP_MS) await wait(WAIT_STEP_MS);
    }
  }
  await returnTo(was, before, opened, wait);
  return { opened, skipped };
}

export class SessionsView {
  constructor(cx) {
    this.overlay = props()?.overlay ?? null;
    this.picked = new Set();
    this.live = null;
    this.loading = false;
    this.busy = false;
    this.search = InputState.new({ placeholder: "Search title, first prompt, folder, account or machine" });
    this.search.on("change", (_e, cx) => cx?.notify?.());
    cx?.spawn?.(async (cx) => { await this.refreshLive(cx); await this.load(cx, false); });
    // A session opened by hand meanwhile leaves the list.
    cx?.timer?.every?.(LIVE_MS, (cx) => cx.spawn((cx) => this.refreshLive(cx)));
    cx?.timer?.after?.(150, () => this.search.focus?.());
  }

  close(_cx) { sessionsClosed(this.overlay); }

  async refreshLive(cx) {
    try { this.live = await liveSids(); } catch { /* keep the last view */ }
    cx?.notify?.();
  }

  // Reads the logs (every machine at once) unless the cached list is fresh; `force`: always.
  async load(cx, force) {
    if (needsMachine() || this.loading) return;
    const c = cached();
    if (!force && c && c.days === LIST_DAYS && Date.now() - c.at < STALE_MS && targets().every((m) => c.by?.[m])) return;
    this.loading = true; cx?.notify?.();
    try {
      const list = targets();
      const got = await Promise.all(list.map((m) => readMachine(m)));
      setShared(KEY_LIST, { at: Date.now(), days: LIST_DAYS, by: Object.fromEntries(list.map((m, i) => [m, got[i]])) });
    } finally { this.loading = false; cx?.notify?.(); }
  }

  // Every closed session of the machines read now, newest first.
  rows() {
    const c = cached(), out = [];
    if (!c || needsMachine()) return out;
    for (const m of targets()) for (const r of c.by?.[m]?.rows ?? []) if (!this.live?.by?.[m]?.has(r.sid)) out.push(r);
    return out.sort((a, b) => b.at - a.at);
  }
  matching() { return filterRows(this.rows(), this.search.value(), (r) => accountName(r.account)); }
  // The rows drawn: the matching ones, the newest SHOW_MAX.
  shown() { return this.matching().slice(0, SHOW_MAX); }
  errors() {
    const c = cached();
    return targets().filter((m) => c?.by?.[m]?.error).map((m) => `Couldn't read ${m || "this computer"}'s sessions: ${c.by[m].error}.`);
  }

  toggle(r) { const k = keyOf(r); if (this.picked.has(k)) this.picked.delete(k); else this.picked.add(k); }

  async resume(cx) {
    if (this.busy) return;
    const rows = this.rows().filter((r) => this.picked.has(keyOf(r)));
    if (!rows.length) return;
    this.busy = true; cx?.notify?.();
    try {
      const r = await resumeSessions(rows, { wait: (ms) => new Promise((res) => (cx?.timer?.after ? cx.timer.after(ms, () => res()) : pause(ms).then(res))) });
      notify?.(resumeNotice(r));
      if (r.opened) { sessionsClosed(this.overlay); if (this.overlay) closeOverlay(this.overlay); }
      else for (const s of r.skipped) if (s.why === "already open") this.picked.delete(keyOf(s.row));
    } finally { this.busy = false; cx?.notify?.(); }
  }

  render(_cx) {
    const t = theme(), now = Date.now();
    const stop = (_e, cx) => cx.stop_propagation();
    const link = (id, label, on) => div().id(id).flex_none().text_size(12.5).text_color(t.accent).hover((s) => s.opacity(0.8)).cursor_pointer()
      .on_mouse_down("left", stop).on_click((_e, cx) => { on(cx); cx.notify(); }).child(label);
    const button = (id, label, on, primary = false, off = false) => div().id(id).px(14).h(30).flex().items_center().rounded(8).text_size(13)
      .bg(primary ? t.accent : t.chrome).text_color(primary ? t.background : t.foreground).border(1).border_color(primary ? t.accent : t.border)
      .when(off, (el) => el.opacity(0.5)).when(!off, (el) => el.hover((s) => s.opacity(0.9)))
      .on_mouse_down("left", stop).on_click((_e, cx) => { if (!off) on(cx); }).child(label);
    const title = div().text_size(16).font_semibold().text_color(t.foreground).child("Resume sessions");
    const close = () => { sessionsClosed(this.overlay); if (this.overlay) closeOverlay(this.overlay); };
    if (needsMachine()) {
      return v_flex().id("sessions").size_full().p(20).gap(12).bg(t.raised).child(title)
        .child(div().id("ses-needs").flex_1().text_size(13).text_color(t.muted).child(NEEDS_MACHINE))
        .child(h_flex().justify_end().child(button("ses-close", "Close", close, true)));
    }
    const all = this.rows(), match = this.matching(), shown = match.slice(0, SHOW_MAX);
    const here = new Set(all.map(keyOf)), picked = [...this.picked].filter((k) => here.has(k)).length;
    const pickedShown = shown.filter((r) => this.picked.has(keyOf(r))).length, hidden = picked - pickedShown;
    const c = cached(), q = this.search.value().trim();
    const off = targets().length === 0 || (claudeMachine() && !connected(claudeMachine()));
    const box = (on) => div().size(16).flex_none().mt(1).rounded(4).flex().items_center().justify_center().text_size(11)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.accent : t.chrome).text_color(t.background).child(on ? "✓" : "");
    const rowEl = (r) => {
      const on = this.picked.has(keyOf(r));
      const meta = [tidy(folderText(r.cwd, knownHome(r.machine || null)), 200), accountName(r.account), r.machine || null].filter(Boolean).join(" · ");
      return h_flex().id(`ses-row-${r.machine || "here"}-${r.sid}`).w_full().gap(10).px(10).py(7).items_start().rounded(8).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.toggle(r); cx.notify(); })
        .child(box(on))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(headingOf(r)))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(agoText(r.at, now))))
          .when(Boolean(r.title && r.prompt), (el) => el.child(div().truncate().text_size(12).text_color(t.dim).child(r.prompt)))
          .when(now - r.at < RECENT_MS, (el) => el.child(div().truncate().text_size(11.5).text_color(t.blocked)
            .child("Changed minutes ago: it may be open in another terminal. Select all leaves it out.")))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(meta)));
    };
    const empty = this.loading && !c ? "Reading the conversation logs…"
      : off && !c ? "No machine to read: Claude's sessions are on the claude_machine, which isn't connected now."
      : q ? `Nothing matches “${q}”.` : `No closed sessions in the last ${LIST_DAYS} days.`;
    const updated = this.loading ? "Reading…" : c ? `Updated ${agoText(c.at, now)}` : "";
    return v_flex().id("sessions").size_full().p(20).gap(10).bg(t.raised)
      .child(h_flex().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2).child(title)
          .child(div().text_size(12).text_color(t.muted).child(`Closed Claude conversations from the last ${LIST_DAYS} days, newest first. Each opens in its project's workspace and folder as its own account.`)))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(updated))
        .child(link("ses-refresh", "Refresh", (cx) => cx.spawn((cx) => this.load(cx, true)))))
      .child(Input.new(this.search).w_full())
      .child(h_flex().gap(14).items_center()
        .child(link("ses-all", "Select all shown", () => { for (const r of shown) if (!(now - r.at < RECENT_MS)) this.picked.add(keyOf(r)); }))
        .child(link("ses-clear", "Clear", () => { this.picked.clear(); }))
        .child(div().flex_1().text_size(12).text_color(t.muted).child(`${shown.length}${match.length > shown.length ? ` of ${match.length}` : ""} shown · ${picked} selected${hidden > 0 ? ` (${hidden} hidden by the search)` : ""}`)))
      .children(this.errors().map((e, i) => div().id(`ses-err-${i}`).text_size(12).text_color(t.blocked).child(e)))
      .when(Boolean(this.live?.unknown), (el) => el.child(div().id("ses-unknown").text_size(12).text_color(t.muted)
        .child("A Claude tab isn't identified yet. Sessions it could be won't open until it is (usually a moment).")))
      .child(v_flex().id("ses-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(shown.map(rowEl))
        .when(match.length > shown.length, (el) => el.child(div().id("ses-more").p(8).text_size(12).text_color(t.dim).child(`Showing the newest ${SHOW_MAX} of ${match.length}. Type in the search to narrow the list.`)))
        .when(!shown.length, (el) => el.child(div().id("ses-empty").p(8).text_size(13).text_color(t.muted).child(empty))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("A session that is open in a tab now is not listed. Nothing runs until you press Resume."))
        .child(button("ses-close", "Close", close))
        .child(button("ses-resume", this.busy ? "Opening…" : `Resume selected (${picked})`, (cx) => cx.spawn((cx) => this.resume(cx)), true, picked === 0 || this.busy)));
  }
}
