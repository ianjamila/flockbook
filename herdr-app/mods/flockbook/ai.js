// Plain-English words about a tab, written by a small model (owner 11-12: "show me in layman terms what each tab is
// working on" → the Overview's "Now:" line (asks.js nowDoing, free) and, here, "About:" — one line on what the tab's
// work is for — and the tab menu's "Summarize this tab"). Claude Code runs headless on Haiku with the tab's screen:
// no tools, no hooks or plugins (--setting-sources local), no MCP servers, no saved session; about 2 s a call.
// An About line is written once per tab and again only when the tab's title changes (at most every ABOUT_REDO_MS),
// at most ABOUT_PER_TICK calls a tick, in one copy of the mod at a time. Off with the "About lines" setting.
//
// s11 (owner 11-12, after a Codex + Fable review of the follow-ups):
// - Every call runs as the tab's OWN account (accounts.js: with several accounts set, the mark its status line shows,
//   remembered per tab in KEY_ACCOUNTS). An unknown account sends nothing (no fallback to Herdr's own login).
// - An account out of usage (or signed out) is paused as a whole until its reset time (KEY_COOL), for About lines and
//   Summarize alike; after the reset one call probes it before the rest go.
// - Calls are counted per account per day (KEY_CALLS); automatic About calls stop at the "About daily cap" setting.
// - An entry keeps when its text was written, for which title and by which account (wroteAt / wroteTitle / account)
//   apart from the last try (triedAt / error), so a failed refresh never makes an old line look new.
// - "Rewrite About line" (hover link, tab menu) → KEY_REDO → done by the same one-copy tick, never alongside it.
// - Tabs idle or done for IDLE_MS are left alone once they have a line.
import { exec, hc, home, appHome, terminals, shared, setShared } from "herdr";
import { agents, spaces, snapShared } from "./parked.js";
import { setting } from "./config.js";
import { sessionTopic } from "./state.js";
import { accountOf, accountName, claudeRun } from "./accounts.js";
import { claudeMachine, localWindows, NEEDS_MACHINE } from "./where.js";
export { accountOf, accountName };

const FLAGS = ["-p", "--model", "haiku", "--setting-sources", "local", "--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--no-session-persistence"];
export const KEY_ABOUT = "flockbook.about";   // { [address]: entry } — see the s11 note above
const KEY_AT = "flockbook.about.at";
export const KEY_BUSY = "flockbook.about.busy";   // { at, token } of the copy running the tick, or null
export const KEY_REDO = "flockbook.about.redo";   // { [address]: asked at } — "Rewrite About line"
export const KEY_ACCOUNTS = "flockbook.ai.accounts";   // { [address]: account id (accounts.js) }
export const KEY_COOL = "flockbook.ai.cool";   // { [account]: { until, kind, message, at } }
export const KEY_CALLS = "flockbook.ai.calls";   // { day, [account]: { about, rewrite, summary, ok, fail } }
export const ABOUT_TICK_MS = 60_000;
const ABOUT_REDO_MS = 20 * 60_000;
const ABOUT_PER_TICK = 3;
// The tick sends no new call later than this before its lock expires (a call's 45 s timeout fits inside it), so no
// other copy can take an expired lock while this one still sends (s13 Codex P2).
const LOCK_SPARE_MS = 50_000;
const IDLE_MS = 3 * 3600_000;
const ACCOUNT_READS_PER_TICK = 6;

// <ai-pure>
export const RETRY_MS = 5 * 60_000;
// The text to send: the last `max` characters of the screen (with its history), the title on top.
export function aiInput(title, screen, max = 12_000) {
  const s = String(screen ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return `Tab title: ${title || "(none)"}\n\nThe tab's terminal (latest at the bottom):\n${s.length > max ? s.slice(-max) : s}`;
}
// The model's answer as one line: no quotes, no "About:" it may add, at most 160 characters.
export function oneLine(text) {
  const l = String(text ?? "").split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? "";
  const s = l.replace(/^(?:about|summary)\s*:\s*/i, "").replace(/^["“']|["”']$/g, "").trim();
  return s.length <= 160 ? s : s.slice(0, 160).replace(/\s+\S*$/, "") + "…";
}
// The About answer's two parts (owner 11-12: the hover should say what the PR / project is about): "Line: …" (the
// card's About line) and "More: …" (2–3 sentences for the hover). An answer without the labels: its first line is
// the Line, the rest the More.
export function parseAbout(text) {
  const lines = String(text ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  const li = lines.findIndex((x) => /^line\s*:/i.test(x)), mi = lines.findIndex((x) => /^more\s*:/i.test(x));
  const line = oneLine((li >= 0 ? lines[li].replace(/^line\s*:\s*/i, "") : lines[0]) ?? "");
  const more = (mi >= 0 ? lines.slice(mi).join(" ").replace(/^more\s*:\s*/i, "") : lines.slice(1).join(" ")).trim().slice(0, 700);
  return { line: line || null, more: more || null };
}
// A title for comparing: case, symbols (spinners, ✳, 🔀 …) and spacing dropped, so a glyph that comes and goes is
// not a new title (Fable 11-12).
export function normTitle(s) {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, " ").trim();
}
// Whether a tab needs a (new) About line: none yet; a failed first try 5 min on; or the title changed (not just its
// symbols) and the line is old enough. A failed refresh keeps the old line and tries again 5 min on.
export function aboutDue(entry, title, now, redoMs) {
  if (!entry) return true;
  const tried = entry.triedAt ?? entry.at ?? 0;
  if (!entry.text) return now - tried >= RETRY_MS;
  if (entry.error && now - tried < RETRY_MS) return false;
  if (normTitle(entry.wroteTitle ?? entry.title) === normTitle(title)) return false;
  return now - (entry.wroteAt ?? entry.at ?? 0) >= redoMs;
}
// The line was written for another title (the tab moved on and the refresh has not come yet).
export function isStale(entry, title) {
  return Boolean(entry?.text) && normTitle(entry.wroteTitle ?? entry.title) !== normTitle(title);
}
// The account a tab's session runs as (owner 11-12: "it should use the current account being used"): accountOf
// (accounts.js) — one account set: that one; several: the mark its status line shows, else null (nothing sent).
// The About lock (KEY_BUSY) is free: none, or its holder started BUSY_MS ago or more (a reload cut it short). A lock
// is { at, token } since s13; a bare number is the old shape.
export const BUSY_MS = 150_000;
export function lockFree(busy, now) {
  if (!busy) return true;
  const at = typeof busy === "number" ? busy : Number(busy.at);
  return !Number.isFinite(at) || now - at >= BUSY_MS;
}
// Why a call failed, from what Claude Code printed (it says why on stdout — "You've hit your weekly limit · resets
// 1am (Europe/London)"; stderr may hold only a sign-in warning, which proves nothing, Codex 11-12).
// { kind: "quota" | "auth" | "timeout" | "other", raw }.
export function classifyFailure({ stdout, stderr, code, error }) {
  const out = String(stdout ?? "").trim(), err = String(stderr ?? "").trim(), ex = String(error ?? "").trim();
  const raw = (out || ex || err || `claude exited with ${code}`).slice(0, 300);
  const said = `${out}\n${ex}`;
  if (/(?:weekly|daily|usage|session|5-hour)\s+limit|hit your (?:\w+ )?limit|limit reached|rate.?limit|out of (?:extra )?usage|credit balance is too low/i.test(said)) return { kind: "quota", raw };
  if (/not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication (?:failed|error)|claude auth login/i.test(said)) return { kind: "auth", raw };
  if (/timed? ?out|timeout|ETIMEDOUT|SIGTERM|killed/i.test(ex) || (code == null && !out)) return { kind: "timeout", raw };
  return { kind: "other", raw };
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TZ_MIN = { "asia/manila": 480, "asia/singapore": 480, "asia/hong_kong": 480, "asia/shanghai": 480, "asia/tokyo": 540, utc: 0, "etc/utc": 0, gmt: 0 };
// A zone's minutes ahead of UTC at `now`: the table, else the JS engine's time zone data (any IANA name, when it has
// Intl), else null.
function zoneOffset(name, now) {
  const z = name.toLowerCase();
  if (z in TZ_MIN) return TZ_MIN[z];
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "longOffset" }).formatToParts(new Date(now)).find((x) => x.type === "timeZoneName")?.value;
    const g = /^GMT(?:([+-])(\d{1,2}):?(\d{2})?)?$/.exec(p ?? "");
    if (g) return g[1] ? (g[1] === "-" ? -1 : 1) * (Number(g[2]) * 60 + Number(g[3] ?? 0)) : 0;
  } catch { /* no Intl, or no such zone */ }
  return null;
}
// The time a usage limit resets, as ms since the epoch: "resets 1am (Europe/London)", "resets 3:30pm",
// "resets Nov 14, 1am (America/New_York)". A time with no date is its next coming; no zone = this Mac's
// (`localOffsetMin`: minutes ahead of UTC, or a function of the time for a zone with daylight saving). Null when it
// can't be read, is past, or is over 8 days off. The zone's offset is the one AT the reset (a daylight-saving change
// between now and then moves it), not now's.
export function parseReset(text, now, localOffsetMin) {
  const m = /resets?\s+(?:on\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*(?:\(([^)]+)\))?/i.exec(String(text ?? ""));
  if (!m) return null;
  const offAt = (t) => (m[6] ? zoneOffset(m[6].trim(), t) : typeof localOffsetMin === "function" ? localOffsetMin(t) : localOffsetMin);
  const off = offAt(now);
  if (off == null || !Number.isFinite(off)) return null;
  // A wall-clock time in that zone (ms, its UTC fields) → the instant: twice, so the offset is the reset's own.
  const instant = (wallMs) => { let t = wallMs - off * 60_000; for (let i = 0; i < 2; i++) { const o = offAt(t); if (o == null || !Number.isFinite(o)) break; t = wallMs - o * 60_000; } return t; };
  // Every instant a wall time is, earliest first (Codex recheck 11-12 P2): two in the hour a fall-back repeats
  // ("1am" New York on Nov 1 is 05:00Z, then 06:00Z), one otherwise. Each offset in force a day either side is tried
  // and kept when the zone really has it at that instant; none for a time the spring-forward skips → `instant`.
  const instants = (wallMs) => {
    const offs = new Set([off]);
    for (const probe of [wallMs - 86_400_000, wallMs + 86_400_000]) { const o = offAt(probe); if (o != null && Number.isFinite(o)) offs.add(o); }
    const out = [...offs].map((o) => wallMs - o * 60_000).filter((t, k) => offAt(t) === [...offs][k]);
    return out.length ? [...new Set(out)].sort((p, q) => p - q) : [instant(wallMs)];
  };
  // The first of them still to come, else the first.
  const next = (wallMs) => { const all = instants(wallMs); return all.find((t) => t > now) ?? all[0]; };
  let h = Number(m[3]) % 12; if (m[5].toLowerCase() === "pm") h += 12;
  const min = m[4] ? Number(m[4]) : 0;
  const wall = new Date(now + off * 60_000);   // its UTC fields = the wall clock in that zone
  let y = wall.getUTCFullYear(), mo = wall.getUTCMonth(), d = wall.getUTCDate();
  const dated = Boolean(m[1]);
  if (dated) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    mo = mi; d = Number(m[2]);
  }
  let at = next(Date.UTC(y, mo, d, h, min));
  if (dated && at < now - 86_400_000) at = next(Date.UTC(y + 1, mo, d, h, min));   // "Jan 2" seen on Dec 30
  if (!dated && at <= now) at = next(Date.UTC(y, mo, d + 1, h, min));
  if (at <= now || at - now > 8 * 86_400_000) return null;
  return at;
}
// How long an account rests after a failure: until its reset (or an hour when that can't be read) for a usage limit,
// an hour for a sign-in problem, not at all otherwise (that tab alone tries again 5 min on).
export function coolUntil(kind, raw, now, localOffsetMin) {
  if (kind === "quota") return parseReset(raw, now, localOffsetMin) ?? now + 3600_000;
  if (kind === "auth") return now + 3600_000;
  return null;
}
// "1:05 am" in this Mac's time (`localOffsetMin`), no day.
export function timeOnly(at, localOffsetMin) {
  const w = new Date(at + localOffsetMin * 60_000);
  const h = w.getUTCHours(), mm = String(w.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${mm} ${h < 12 ? "am" : "pm"}`;
}
// The day of `at` as seen from `now`, by local calendar day, past or future (s19: past times used to lose their
// day): null on the same day, "yesterday", "tomorrow", a weekday within 6 days either way, else "3 Nov".
export function dayWord(at, now, localOffsetMin) {
  const day = (x) => Math.floor((x + localOffsetMin * 60_000) / 86_400_000);
  const d = day(at) - day(now), w = new Date(at + localOffsetMin * 60_000);
  if (d === 0) return null;
  if (d === -1) return "yesterday";
  if (d === 1) return "tomorrow";
  if (Math.abs(d) <= 6) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][w.getUTCDay()];
  return `${w.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][w.getUTCMonth()]}`;
}
// "1:05 am" today, else with its day: "tomorrow 1:05 am", "yesterday 9:10 pm", "Sat 1:05 am", "3 Nov 1:05 am".
export function clockText(at, now, localOffsetMin) {
  const d = dayWord(at, now, localOffsetMin), t = timeOnly(at, localOffsetMin);
  return d ? `${d} ${t}` : t;
}
// The next local midnight after `now`: "Pause automatic About lines until tomorrow" (s13 F6).
export function nextMidnight(now, localOffsetMin) {
  const w = new Date(now + localOffsetMin * 60_000);
  return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1) - localOffsetMin * 60_000;
}
// "2026-11-12" in this Mac's time: the call counter's day.
export function dayKey(now, localOffsetMin) {
  return new Date(now + localOffsetMin * 60_000).toISOString().slice(0, 10);
}
// What the owner reads for a failure (Q2): plain words, the cause named. `who`: the account's name (accountName).
export function failureText(kind, who, until, now, localOffsetMin, raw = "") {
  if (kind === "quota") return `${who} is out of its Claude usage until ${clockText(until, now, localOffsetMin)}.`;
  if (kind === "auth") return `${who} needs signing in again (claude auth login).`;
  if (kind === "timeout") return "Claude took too long to answer. It tries again in a few minutes.";
  if (kind === "unknown-account") return "Couldn't tell which Claude account this tab uses (its status line isn't on screen), so nothing was sent.";
  if (kind === "cap") return `${who} reached today's About-line limit (Settings → About daily cap).`;
  return `Claude didn't answer${raw ? `: ${raw.slice(0, 120)}` : "."}`;
}
// "just now", "12 min ago", "3 h ago", "2 d ago".
export function agoText(at, now) {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
// </ai-pure>

export const ABOUT_SYSTEM = "You describe a coding agent's work for a busy business owner who is not a developer. "
  + "Plain English only: no jargon, file names, function names or tool names. Say what the work (the pull request or "
  + "project) is FOR, not the current step. Answer in exactly two lines:\n"
  + "Line: one sentence, at most 16 words, on what this work is for and what it changes for the app's users; if it is "
  + "about a pull request, end with its number in parentheses, like (#1838).\n"
  + "More: two or three sentences: what the project or pull request is, why it matters to the people who use the app, "
  + "and where it stands now (building, in review, waiting on the owner, done).";
export const SUMMARY_SYSTEM = "You explain a coding agent's work to a busy business owner who is not a developer. "
  + "Use plain English, no jargon, file names or code. Answer in this exact shape, each part on its own line:\n"
  + "About: one sentence on what this work is for and what it changes for the app's users.\n"
  + "Done so far: up to 3 short bullets starting with \"- \".\n"
  + "Now: one sentence on what it is doing right now.\n"
  + "Needs you: one sentence on what it waits for from the owner, or \"Nothing right now.\"\n"
  + "Keep pull request numbers (like #1838). Output only those parts.";

// This Mac's offset from UTC, in minutes ahead.
export const localOffset = () => -new Date().getTimezoneOffset();
// The same at time `t` (ms): a reset after a daylight-saving change has that day's offset (parseReset).
export const localOffsetAt = (t) => -new Date(t).getTimezoneOffset();

// The account remembered for a tab: for DISPLAY only (hover footer, pause banner, skipping a paused account early).
// What is sent goes as the account read off the very screen being sent (sendAccount; s13 Codex P1).
export function accountFor(address) {
  return address ? (shared(KEY_ACCOUNTS) ?? {})[address] ?? null : null;
}
// The account on `screen` (accountOf), remembered for display. The only account a call may go as; null = send nothing.
export function sendAccount(address, screen) {
  const seen = accountOf(screen);
  const known = shared(KEY_ACCOUNTS) ?? {};
  if (seen && address && known[address] !== seen) setShared(KEY_ACCOUNTS, { ...known, [address]: seen });
  return seen;
}

// The command for an account: claudeCommand (accounts.js) sets its config folder, or clears CLAUDE_CONFIG_DIR for the
// default one. There is no "as Herdr runs it": an unknown account sends nothing (Codex P1 11-12).

// The account's pause, when it is still on: { until, kind, message } or null.
export function coolOf(account) {
  const c = account ? shared(KEY_COOL)?.[account] : null;
  return c && Date.now() < c.until ? c : null;
}
// Every account on pause now: [{ account, until, kind, message }].
export function cooledAccounts() {
  const all = shared(KEY_COOL) ?? {}, now = Date.now();
  return Object.entries(all).filter(([, c]) => c && now < c.until).map(([account, c]) => ({ account, ...c }));
}
// The local tabs (agents) that run as `account`, as remembered.
export function agentsOn(account) {
  const known = shared(KEY_ACCOUNTS) ?? {};
  return agents().filter((a) => known[a.address] === account);
}
// Today's calls: { day, [account]: { about, rewrite, summary, ok, fail } }.
export function callsToday() {
  const c = shared(KEY_CALLS);
  return c?.day === dayKey(Date.now(), localOffset()) ? c : { day: dayKey(Date.now(), localOffset()) };
}
function count(account, field) {
  const c = callsToday(), a = { about: 0, rewrite: 0, summary: 0, ok: 0, fail: 0, ...(c[account] ?? {}) };
  a[field] = (a[field] ?? 0) + 1;
  setShared(KEY_CALLS, { ...c, [account]: a });
}
// "Pause automatic About lines until tomorrow" (s13 F6, one click in Settings or on the Overview): no automatic
// About call until the next local midnight; Rewrite and Summarize still go. Kept in the shared store (survives a
// restart). { until } or none.
export const KEY_AUTO_PAUSE = "flockbook.about.paused";
export function autoPausedUntil() {
  const u = shared(KEY_AUTO_PAUSE)?.until;
  return u && Date.now() < u ? u : null;
}
export function pauseAutoUntilTomorrow() { setShared(KEY_AUTO_PAUSE, { until: nextMidnight(Date.now(), localOffset()), at: Date.now() }); }
export function resumeAuto() { setShared(KEY_AUTO_PAUSE, null); }
// Today's requests per account, split (s13 C1; requests, not tokens): "Work account (WORK): automatic 14 of 40 ·
// Rewrite 2 · Summarize 1 requests (16 worked, 1 failed)".
export function usageLines() {
  const c = callsToday(), cap = setting("about_cap"), of = cap === "none" || !Number(cap) ? "" : ` of ${Number(cap)}`;
  return Object.entries(c).filter(([k]) => k !== "day").map(([acct, n]) =>
    `${accountName(acct)}: automatic ${n.about ?? 0}${of} · Rewrite ${n.rewrite ?? 0} · Summarize ${n.summary ?? 0} requests (${n.ok ?? 0} worked${n.fail ? `, ${n.fail} failed` : ""})`);
}
// The automatic About calls left today for an account (the "About daily cap" setting; "none" = no cap).
function capLeft(account) {
  const cap = setting("about_cap");
  if (cap === "none" || !Number(cap)) return Infinity;
  return Number(cap) - (callsToday()[account]?.about ?? 0);
}

// { text } or { error, kind, until? }. `account`: the tab's (accountFor). `purpose`: "about" (automatic, capped),
// "rewrite" (asked for) or "summary". The one gate every call goes through: known account, not on pause, under cap.
export async function askHaiku(system, prompt, timeout = 60_000, account = null, purpose = "about") {
  const now = Date.now(), off = localOffset();
  // Where claude runs: the "claude_machine" (where.js), else this computer — which can't on Windows (no /usr/bin/env).
  const machine = claudeMachine();
  if (!machine && localWindows()) return { error: NEEDS_MACHINE, kind: "needs-machine" };
  // An account no longer in the "accounts" setting is unknown too (claudeRun gives null).
  const argv = account ? await claudeRun(account, [...FLAGS, "--system-prompt", system, prompt], machine) : null;
  if (!argv) return { error: failureText("unknown-account", null, 0, now, off), kind: "unknown-account" };
  // That machine is not reachable now (its home can't be learnt): no pause, the next try asks again.
  if (argv.unreachable) return { error: `Couldn't reach ${argv.unreachable} to run Claude there. It tries again in a few minutes.`, kind: "unreachable" };
  const who = accountName(account);
  const cool = coolOf(account);
  if (cool) return { error: failureText(cool.kind, who, cool.until, now, off), kind: cool.kind, until: cool.until, paused: true };
  if (purpose === "about" && capLeft(account) <= 0) return { error: failureText("cap", who, 0, now, off), kind: "cap" };
  count(account, purpose);
  let r;
  try {
    // On another machine it starts in that machine's home (exec `on`); here, in Flockbook's own folder.
    r = await exec(argv.cmd, argv.args, argv.on ? { on: argv.on, timeout } : { cwd: `${appHome()}/flockbook`, timeout });
  } catch (e) { r = { code: null, stdout: "", stderr: "", error: String(e?.message ?? e) }; }
  const out = String(r.stdout ?? "").trim();
  if (r.code === 0 && out) {
    count(account, "ok");
    // Back after a pause: a call that worked lifts it — only a pause set before this call began (s13 Codex P3: a
    // late success must not lift a pause another call set meanwhile).
    const c0 = shared(KEY_COOL)?.[account];
    if (c0 && !(Number(c0.at) >= now)) { const c = { ...(shared(KEY_COOL) ?? {}) }; delete c[account]; setShared(KEY_COOL, c); }
    return { text: out };
  }
  count(account, "fail");
  const f = classifyFailure(r);
  const until = coolUntil(f.kind, f.raw, Date.now(), localOffsetAt);
  if (until) setShared(KEY_COOL, { ...(shared(KEY_COOL) ?? {}), [account]: { until, kind: f.kind, message: f.raw.slice(0, 200), at: Date.now() } });
  return { error: failureText(f.kind, who, until ?? 0, Date.now(), off, f.raw), kind: f.kind, ...(until ? { until } : {}) };
}

// The tab's screen with `lines` of history, or null.
export async function screenOf(address, lines) {
  try { const r = await hc(["read", address, "--lines", String(lines)]); return r.code === 0 ? r.stdout : null; } catch { return null; }
}

export const aboutEntry = (address) => (address ? snapShared(KEY_ABOUT)?.[address] ?? null : null);
export const aboutOf = (address) => aboutEntry(address)?.text ?? null;
export const aboutMore = (address) => aboutEntry(address)?.more ?? null;
export const rewriting = (address) => Boolean(address && shared(KEY_REDO)?.[address]);
// "Rewrite About line": queued for the tick (top.js serves the command and runs the tick soon). Each request is a
// newer generation than the last, so one asked while a rewrite runs is not lost (s13 Codex P3).
export function requestRewrite(address) {
  if (!address) return;
  const r = shared(KEY_REDO) ?? {};
  setShared(KEY_REDO, { ...r, [address]: Math.max(Date.now(), (Number(r[address]) || 0) + 1) });
}
// Done with the request the tick took (`gen`); a newer one stays queued for the next run.
function doneRewrite(address, gen) {
  const r = { ...(shared(KEY_REDO) ?? {}) };
  if (!(address in r) || r[address] !== gen) return;
  delete r[address]; setShared(KEY_REDO, r);
}
// Whether the tick can write a tab's About line: a tab on this Mac (a remote one's address has its machine in front:
// "box/t7") that is not another tab's helper agent. Menu and hover offer "Rewrite" only there (s13: elsewhere it sat
// at "Rewriting…" forever).
export function aboutSupported(address) {
  if (!address || address.includes("/")) return false;
  return !terminals().some((t) => t.parent && t.address === address);
}
const UNSUPPORTED = "Rewrite works only for tabs running on this Mac (not helper agents or tabs on other machines).";
const putEntry = (address, entry) => setShared(KEY_ABOUT, { ...(shared(KEY_ABOUT) ?? {}), [address]: entry });

// How long the tab has sat idle or done (0 while working or waiting, or when unknown).
function idleFor(a, now) {
  if (a.status !== "done" && a.status !== "idle") return 0;
  const tab = spaces().flatMap((s) => s.tabs ?? []).find((t) => t.id === a.tab);
  return tab?.changed_at ? now - tab.changed_at : 0;
}

// When the tick last read each tab's screen (this copy of the mod; a reload starts over): the reading order.
const lookedAt = new Map();

// `soon`: a rewrite was asked for — don't wait for the minute (the one-copy lock still holds).
export async function aboutTick({ soon = false } = {}) {
  const redo = shared(KEY_REDO) ?? {};
  if (setting("about_line") === "off" && !Object.keys(redo).length) return;
  const start = Date.now(), at = shared(KEY_AT);
  if (!soon && at && start - at < ABOUT_TICK_MS - 2000) return;
  // One copy at a time: a lock with this run's own token. A run cut short (a mod reload) leaves its lock; it holds
  // for BUSY_MS at most (lockFree).
  if (!lockFree(shared(KEY_BUSY), start)) return;
  const token = `${start}-${Math.random().toString(36).slice(2, 10)}`;
  setShared(KEY_AT, start); setShared(KEY_BUSY, { at: start, token });
  // Still this run's lock and still in time: checked after the terminal reads, right before each model call.
  const mine = () => shared(KEY_BUSY)?.token === token && Date.now() < start + BUSY_MS - LOCK_SPARE_MS;
  try {
    const live = new Set(agents().map((a) => a.address));
    // Gone tabs leave the cache, their remembered account and any rewrite asked for them.
    const prune = (key) => { const v = shared(key) ?? {}; const k = Object.keys(v).filter((x) => !live.has(x)); if (k.length) { const n = { ...v }; for (const x of k) delete n[x]; setShared(key, n); } };
    prune(KEY_ABOUT); prune(KEY_ACCOUNTS); prune(KEY_REDO);
    // Automatic lines: the setting on and not paused until tomorrow (Rewrites asked for go either way). Asked again
    // right before each automatic call: a pause clicked while this tick runs stops its later calls (s13 Codex R1 P2).
    const autoOn = () => setting("about_line") !== "off" && !autoPausedUntil();
    const auto = autoOn();
    // Rewrites asked for first; then the tabs whose screen was read longest ago, so tabs that are due but can't be
    // served (their account at its daily cap) don't take every screen read, tick after tick (s13 Codex R1 P2).
    const list = agents().filter((a) => aboutSupported(a.address))
      .sort((x, y) => Number(Boolean(redo[y.address])) - Number(Boolean(redo[x.address])) || (lookedAt.get(x.address) ?? 0) - (lookedAt.get(y.address) ?? 0));
    // A rewrite asked for a tab the tick can't serve (a stale menu, an old hover): dropped, the reason on the tab.
    const served = new Set(list.map((a) => a.address));
    for (const [addr, gen] of Object.entries(redo)) {
      if (served.has(addr) || !live.has(addr)) continue;
      putEntry(addr, { ...(shared(KEY_ABOUT)?.[addr] ?? {}), triedAt: Date.now(), error: UNSUPPORTED, errorKind: "unsupported" });
      doneRewrite(addr, gen);
    }
    let calls = 0, reads = 0;
    const perAccount = {};
    for (const a of list) {
      if (calls >= ABOUT_PER_TICK || reads >= ACCOUNT_READS_PER_TICK || !mine()) break;
      const gen = redo[a.address], force = Boolean(gen);
      if (!force && !auto) continue;
      const title = sessionTopic(a) ?? a.title ?? "";
      const old = shared(KEY_ABOUT)?.[a.address] ?? null;
      if (!force && !aboutDue(old, title, Date.now(), ABOUT_REDO_MS)) continue;
      // Idle or done for hours and it has a line already: left alone until it works again (Fable 11-12).
      if (!force && old && idleFor(a, Date.now()) > IDLE_MS) continue;
      const fail = (kind, error) => putEntry(a.address, { ...(shared(KEY_ABOUT)?.[a.address] ?? old ?? {}), title, triedAt: Date.now(), error, errorKind: kind });
      // The screen decides even a pause: the remembered account can be another session's (a reused address; live
      // 11-12: a tab remembered as one account, its screen showing the other). A tab is due at most every 5 min after a
      // failure (aboutDue).
      reads++; lookedAt.set(a.address, Date.now());
      const screen = await screenOf(a.address, 150);
      if (!screen) { if (force) doneRewrite(a.address, gen); continue; }
      // Sent as the account on THIS screen, never the remembered one (s13 Codex P1).
      const acct = sendAccount(a.address, screen);
      if (!acct) { fail("unknown-account", failureText("unknown-account", null, 0, Date.now(), localOffset())); if (force) doneRewrite(a.address, gen); continue; }
      const cool = coolOf(acct);
      if (cool) {
        if (force || !old?.text) fail(cool.kind, failureText(cool.kind, accountName(acct), cool.until, Date.now(), localOffset()));
        if (force) doneRewrite(a.address, gen);
        continue;
      }
      // Just back from a pause: at most one automatic call per account this tick until one works.
      if (shared(KEY_COOL)?.[acct] && (perAccount[acct] ?? 0) >= 1) continue;
      if (!force && capLeft(acct) <= 0) continue;
      // The reads took time: still this run's lock, with room for the call before it expires? Automatic lines still on?
      if (!mine()) break;
      if (!force && !autoOn()) continue;
      calls++; perAccount[acct] = (perAccount[acct] ?? 0) + 1;
      const r = await askHaiku(ABOUT_SYSTEM, aiInput(title, screen, 8000), 45_000, acct, force ? "rewrite" : "about");
      const p = r.text ? parseAbout(r.text) : null;
      // Kept at once (a reload mid-run keeps what is done), merged into the latest state, never a stale copy.
      if (p?.line) {
        const t = Date.now();
        putEntry(a.address, { title, text: p.line, more: p.more, wroteAt: t, wroteTitle: title, account: acct, triedAt: t });
      } else fail(r.kind ?? "other", r.error ?? "Claude's answer had no About line.");
      if (force) doneRewrite(a.address, gen);
    }
    // Learn the account of tabs that need no line now (a screen read, no model call), so the Overview's pause line
    // and each hover can say which tabs sit on a paused account. Display only.
    for (const a of list) {
      if (reads >= ACCOUNT_READS_PER_TICK || !mine()) break;
      if (accountFor(a.address)) continue;
      reads++;
      const s = await screenOf(a.address, 40);
      if (s) sendAccount(a.address, s);
    }
  } finally { if (shared(KEY_BUSY)?.token === token) setShared(KEY_BUSY, null); }
}
