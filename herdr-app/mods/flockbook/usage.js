// Weekly usage left, at the bottom of the side bar (owner 11-15 s35): for each Claude account (the "accounts" setting)
// and for Codex, how much of the weekly limit is left. The limit belongs to the account, not the computer, so the
// reading shown is the account's figure from this computer or any connected machine: the helper's `usage` command (files
// only: no network, no credentials, nothing spent) is asked here every 60 s and on each connected machine every
// 120 s, and per account the latest week's lowest "left" wins (`newer`). Everything is kept in ONE shared key; render reads it with
// snapShared and calls no helper or host function (s33: Herdr cuts off a slow render).
import { shared, setShared, home, settings } from "herdr";
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as sidecar from "./sidecar.js";
import { knownMachines } from "./machines.js";
import { accounts } from "./accounts.js";
import { snapShared } from "./parked.js";
import { palette } from "./statusline.js";

export const KEY_USAGE = "flockbook.usage";            // { sources: { [machine or ""]: { asked, lines } } }
const KEY_USAGE_BUSY = "flockbook.usage.busy";         // source -> when its ask began
export const USAGE_MS = 60_000;                        // this computer
export const USAGE_REMOTE_MS = 120_000;                // each connected machine
// Longer than the slowest ask: a remote read is the platform check + the command, each up to 35 s (s36 review P3).
const BUSY_MS = 90_000;
export const STALE_MS = 15 * 60_000;                   // older than this: "as of 2 h ago"
export const LOW = 15;                                 // under this % left: red
export const WARN = 40;                                // under this % left: amber; from here on green
const LOCAL = "";

// Codes of a machine's answer that mean "not there": its readings go. Anything else (the link dropped) keeps the last.
const KEEP = new Set(["remote_failed", "no-core", "sidecar", "no-sidecar", "protocol"]);

// <usage-pure>
// Every reading from every source, each marked with where it was read: "" is this computer.
export function readings(data) {
  return Object.entries(data?.sources ?? {}).flatMap(([machine, s]) => (s?.lines ?? [])
    .filter((l) => l?.type === "usage" && (l.kind === "claude" || l.kind === "codex") && Number.isFinite(l.weekly?.left) && Number.isFinite(l.at))
    .map((l) => ({ ...l, machine })));
}
// A folder compared the same way on every machine: "\" as "/", no trailing slash (s36 review: Windows readings).
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const baseName = (p) => norm(p).split("/").pop();
// Two resets this close (seconds) are the same week; a new week is days later.
const SAME_WEEK_S = 3600;
const resetOf = (r) => (Number.isFinite(r.weekly?.resets_at) ? r.weekly.resets_at : null);
// Which reading is the account's (s38 live: each session re-saves its own last figure, so a newer reading can be an
// idle session's old one — the PC showed 32% left 52 s after the Mac's 20%). The latest week wins (a reading without a
// reset time loses to one with); within one week usage only goes up, so the lowest "left" wins; then the newest
// `at`; a tie goes to this computer.
const newer = (a, b) => {
  if (!a) return b;
  const ra = resetOf(a), rb = resetOf(b);
  if (ra !== rb && (ra === null || rb === null || Math.abs(ra - rb) > SAME_WEEK_S)) return (rb ?? -Infinity) > (ra ?? -Infinity) ? b : a;
  if (b.weekly.left !== a.weekly.left) return b.weekly.left < a.weekly.left ? b : a;
  return b.at > a.at || (b.at === a.at && b.machine === LOCAL && a.machine !== LOCAL) ? b : a;
};
// Claude accounts by email (a reading without one by its config folder's name); Codex by kind. { claude: [{ key, email,
// configs, reading }], codex: reading|null }; each account holds the newest reading and every config folder seen for it.
export function merge(list) {
  const accts = new Map();
  let codex = null;
  for (const r of list) {
    if (r.kind === "codex") { codex = newer(codex, r); continue; }
    const key = r.email ? `mail:${String(r.email).toLowerCase()}` : `dir:${baseName(r.config)}`;
    const a = accts.get(key) ?? { key, email: null, configs: new Set(), reading: null };
    if (r.email) a.email = r.email;
    if (r.config) a.configs.add(r.config);
    a.reading = newer(a.reading, r);
    accts.set(key, a);
  }
  return { claude: [...accts.values()], codex };
}
// An account's folder on this computer: the setting's config_dir, else the default ~/.claude.
export const folderOf = (a, list, homeDir) => {
  const c = a.config_dir ? String(a.config_dir) : null;
  if (c) return c.replace(/^~(?=[\\/]|$)/, homeDir ?? "~").replace(/[\\/]+$/, "");
  return `${homeDir ?? "~"}/.claude`;
};
// The rows to draw, in order: the "accounts" setting's accounts (matched by config folder; a reading from another
// machine matches by the folder's name), then any other Claude account found, then Codex. Each: { kind, id, title,
// email, folder, reading|null }.
export function rows(data, list, homeDir) {
  const m = merge(readings(data));
  const used = new Set();
  const setAccounts = list.length ? list : [{ mark: "default" }];
  const folders = setAccounts.map((a) => folderOf(a, list, homeDir));
  // Exact folders first for every row, then the folder's name for the rows still without one (s36 review P3: a row
  // matched by name took the reading a later row matches exactly).
  const hits = folders.map(() => null);
  const pass = (same) => folders.forEach((folder, i) => {
    if (hits[i]) return;
    const hit = m.claude.find((x) => !used.has(x.key) && [...x.configs].some((c) => same(c, folder)));
    if (hit) { used.add(hit.key); hits[i] = hit; }
  });
  pass((c, f) => norm(c) === norm(f));
  pass((c, f) => baseName(c) === baseName(f));
  const out = setAccounts.map((a, i) => {
    const hit = hits[i];
    return { kind: "claude", id: a.mark, name: a.name ?? null, folder: folders[i], email: hit?.email ?? null, reading: hit?.reading ?? null };
  });
  for (const x of m.claude.filter((y) => !used.has(y.key)).sort((p, q) => String(p.email ?? p.key).localeCompare(String(q.email ?? q.key)))) {
    const folder = [...x.configs][0] ?? null;
    out.push({ kind: "claude", id: x.key, name: null, folder, email: x.email, reading: x.reading });
  }
  out.push({ kind: "codex", id: "codex", name: null, folder: null, email: null, reading: m.codex });
  return out;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n) => String(n).padStart(2, "0");
// "Sun 11:53" in local time.
export const clock = (sec) => { const d = new Date(sec * 1000); return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`; };
export const fullClock = (sec) => { const d = new Date(sec * 1000); return `${DAYS[d.getDay()]} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
// How long until the reset (owner 11-15 s38), rounded down so it never says more is left than is: "in 6 d 21 h",
// "in 5 h 7 min", "in 42 min"; under a minute "in 1 min".
export function until(ms) {
  const m = Math.max(1, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d > 0) return h > 0 ? `in ${d} d ${h} h` : `in ${d} d`;
  if (h > 0) return min > 0 ? `in ${h} h ${min} min` : `in ${h} h`;
  return `in ${min} min`;
}
// "5 min ago", "2 h ago", "3 d ago".
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
// What a row shows: { left (0..100 or null), right, line, low, tip }. A reset time already past: 100% left, whatever
// the old reading said (the limit started over). No reading: "—" and why.
export function figures(row, now = Date.now()) {
  const r = row.reading;
  const who = row.kind === "codex" ? "Codex" : row.email ?? row.name ?? baseName(row.folder) ?? "Claude";
  if (!r) {
    const why = row.kind === "codex" ? "no Codex session found" : "no Claude session has run with this account yet";
    return { left: null, right: "—", line: why, low: false, tip: `${who}: ${why}` };
  }
  const resets = Number.isFinite(r.weekly.resets_at) ? r.weekly.resets_at : null;
  const past = resets != null && resets * 1000 <= now;
  const left = past ? 100 : Math.max(0, Math.min(100, Math.round(r.weekly.left)));
  const age = now - r.at;
  const stale = age > STALE_MS;
  const base = past ? "reset since the last reading" : resets != null ? `resets ${clock(resets)} · ${until(resets * 1000 - now)}` : "reset time unknown";
  const line = stale && !past ? `${base} · as of ${ago(age)}` : base;
  const from = r.machine ? r.machine : "this computer";
  const tip = [who, past ? "the weekly limit has reset since this reading" : `${r.weekly.used}% of the weekly limit used`,
    resets != null ? `${past ? "reset" : "resets"} ${fullClock(resets)}` : null, `read ${ago(age)} on ${from}`].filter(Boolean).join(" · ");
  return { left, right: `${left}% left`, line, low: !past && left < LOW, level: levelOf(left), tip };
}
// "ok" (green) from WARN % left, "warn" (amber) from LOW, "low" (red) below; null without a reading.
export const levelOf = (left) => (left == null ? null : left < LOW ? "low" : left < WARN ? "warn" : "ok");
// Owner 11-15 s38: the Flockbook theme is black and white (its warning colour is white too), so the block brings its
// own colours from the owner's VS Code palette (statusline.js `palette`): bright shades in dark mode, the darker
// ones in light mode, where the bright ones are too pale on white. Claude's clay and the palette's blue for the names.
const LEVEL_INDEX = { dark: { ok: 10, warn: 11, low: 9 }, light: { ok: 2, warn: 3, low: 1 } };
// Each Claude account its own shade, in the rows' order (owner 11-15 s38): Claude's clay, then the palette's magenta and
// cyan, repeating; none is a level colour.
const NAME_COLOUR = { dark: { claude: ["#d97757", 13, 14], codex: 12 }, light: { claude: ["#c15f3c", 5, 6], codex: 4 } };
export function usageColours() {
  const p = palette();
  const mode = settings()?.dark === false ? "light" : "dark";
  const pick = (v) => (typeof v === "number" ? p[v] : v);
  const level = Object.fromEntries(Object.entries(LEVEL_INDEX[mode]).map(([k, i]) => [k, p[i]]));
  const shades = NAME_COLOUR[mode].claude.map(pick);
  return { level, claude: (n) => shades[n % shades.length], codex: pick(NAME_COLOUR[mode].codex) };
}
// </usage-pure>

// ---- polling ----
function store(source, patch) {
  const d = shared(KEY_USAGE) ?? { sources: {} };
  setShared(KEY_USAGE, { ...d, sources: { ...d.sources, [source]: { ...(d.sources?.[source] ?? {}), ...patch } } });
}
// Asks one source if it is due; returns after the answer is kept. A failed ask keeps the last readings when only the
// link failed, and drops them when the helper there cannot answer (missing, older, unsupported, Never).
async function ask(source, now, every) {
  const d = shared(KEY_USAGE);
  const was = d?.sources?.[source]?.asked;
  if (was && now - was < every - 500) return;
  const busy = shared(KEY_USAGE_BUSY) ?? {};
  if (busy[source] && now - busy[source] < BUSY_MS) return;
  setShared(KEY_USAGE_BUSY, { ...busy, [source]: now });
  try {
    const a = await sidecar.call("usage", source === LOCAL ? [] : ["--machine", source, "--cache", sidecar.cachePath()]);
    if (a.error) store(source, { asked: now, ...(KEEP.has(a.error.code) ? {} : { lines: [] }) });
    else store(source, { asked: now, lines: a.lines.filter((l) => l.type === "usage") });
  } catch { /* the helper is away: the last readings stay */ }
  finally { const b = { ...(shared(KEY_USAGE_BUSY) ?? {}) }; delete b[source]; setShared(KEY_USAGE_BUSY, b); }
}
// This computer, then each connected machine (a machine not connected is not asked, and its old readings stay: they
// are the freshest known until a newer one arrives). Once per USAGE_MS across every copy of the sidebar. `now`: tests.
export async function pollUsage(now = Date.now()) {
  const machines = knownMachines().filter((m) => m?.state === "connected" && m.name).map((m) => m.name);
  await Promise.all([ask(LOCAL, now, USAGE_MS), ...machines.map((n) => ask(n, now, USAGE_REMOTE_MS))]);
}

// ---- drawing ----
// The block: a heading per account, "Weekly" and what is left, a thin bar, the reset line. Reads the one shared key
// through snapShared; no host or helper call.
export function usageBlock(t, now = Date.now()) {
  const list = accounts();
  const all = rows(snapShared(KEY_USAGE), list, home());
  const c = usageColours();
  let claudeN = 0;                                      // the Claude rows' order, for their shades
  return v_flex().id("usage").flex_none().gap(8).mt(8).pt(10).px(10).border_t(1).border_color(t.border)
    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Weekly usage left"))
    .children(all.map((row, i) => {
      const f = figures(row, now);
      const who = row.kind === "codex" ? null : row.email ?? row.name ?? baseName(row.folder);
      return v_flex().id(`usage-${i}`).gap(3).tooltip(f.tip)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().id(`usage-${i}-name`).flex_none().text_size(12).font_semibold().text_color(row.kind === "codex" ? c.codex : c.claude(claudeN++)).child(row.kind === "codex" ? "Codex" : "Claude"))
          .when(Boolean(who), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(who))))
        .child(h_flex().items_center().text_size(12)
          .child(div().flex_1().text_color(t.muted).child("Weekly"))
          .child(div().id(`usage-${i}-left`).text_color(f.level ? c.level[f.level] : t.foreground).child(f.right)))
        .child(div().id(`usage-${i}-bar`).w_full().h(4).rounded(2).bg(t.border).overflow_hidden()
          .when(f.left != null, (el) => el.child(div().id(`usage-${i}-fill`).h(4).rounded(2).bg(c.level[f.level]).w(`${f.left}%`))))
        .child(div().id(`usage-${i}-line`).text_size(10.5).text_color(t.muted).child(f.line));
    }));
}
