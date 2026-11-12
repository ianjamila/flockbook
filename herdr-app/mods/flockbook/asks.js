// Asks a session ends its turn with in plain text, not as a question card: the review pipeline's
// "🔁 Extra review round needed #N: round K · head … · repo …" (the owner grants it by typing `extra round`
// themselves; the pipeline counts only the owner's own words, so nothing here answers it) and the merge
// hand-off "🔀 Ready to merge #N — say "merge"". They wait for the owner like a question does, so the
// "Needs you" page lists them. Read from the bottom of each local agent's screen (hc read) every 15 s,
// one copy of the mod at a time (a claim in shared state, as the auto-mover does).
// Also any other reply that waits on the owner (owner 11-11, 18:17): its last paragraph tells the owner what to
// say ('Say "OK, run both" to approve. Or say "watchdog only"…': kind "reply") or its last line is a question
// ("Should I run both now?": kind "question").
// And whether a 🔀 left in a tab's title after the merge is really merged (owner 11-11, 18:15: a merged PR still
// showed as "Merging"): the PR's number comes from the merge hand-off, or from a "#N is merged" line on screen, and
// GitHub says (gh pr view, at most every 2 minutes per tab, only while a 🔀 without a hand-off shows).
import { agents, hc, shared, setShared, exec, panes, home, appHome, readTextFile, writeTextFile } from "herdr";
import { setting } from "./config.js";

export const KEY_ASKS = "flockbook.asks";       // { [address]: { kind: "round" | "merge" | "migration" | "reply" | "question", pr?, round?, words?, text? } }
export const KEY_BG = "flockbook.background";  // { [address]: { shells, agents } }: work still running after the turn ended
export const KEY_HANDOFF = "flockbook.handoff"; // { [address]: true }: a finished turn whose last reply gave a hand-off (re-entry prompt)
export const KEY_PRS = "flockbook.prs";         // { [address]: { pr, repo, state?: "OPEN" | "MERGED" | "CLOSED", checked? } }
const KEY_AT = "flockbook.asks.at";
export const TICK_MS = 15_000;

const RULE = /^\s*─{20,}\s*$/;
// Each must END the reply (its last line, or the last two when the terminal wrapped it).
// Claude Code may draw a dim hint after the last line ("(disable recaps in /config)", 11-12 19:02: a merge ask
// showed as a plain reply, without its Merge button): allowed after either line.
const ROUND = /Extra review round needed\s+#(\d{1,6})\s*:\s*round\s+(\d{1,3})\s*·.*\brepo\s+\S+?(?:\s*\([^()\n]*\bin \/config\))?\s*$/i;
const MERGE = /Ready to merge\s+#(\d{1,6}(?:\s*,\s*#?\d{1,6})*)\s*—\s*say\s+"merge"\S*(?:\s*\([^()\n]*\bin \/config\))?\s*$/i;
// 'reply "go migration 1818"', 'type “go for the 1790 migration”', 'say "go migration #1818"'.
const MIGRATION = /\b(?:reply|type|say)\s*:?\s*["“'`]go\s+(?:for\s+(?:the\s+)?)?(?:migration\s+#?(\d{1,6})|#?(\d{1,6})\s+migration)/i;
// 'Say "OK, run both" to approve', 'reply “watchdog only”', 'type `yes`'. The words in quotes are the answers.
// The heading may start the reply, after Claude Code's ⏺ marker (s13 Codex R1 P2).
const WORTH = /^\s*(?:⏺\s*)?(?:\*\*)?(?:also\s+)?worth\s+considering\b/i;
const SAY = /\b(?:say|reply|type|answer)\s*(?:with\s+)?:?\s*(?:"([^"\n]{1,60})"|“([^”\n]{1,60})”|'([^'\n]{1,60})'|`([^`\n]{1,60})`)/gi;
// A merge that happened: "#1821 is merged", "#1821 was merged", "merged #1821", "#1821 merged".
const MERGED = /(?:#(\d{1,6})\b[^.\n]{0,30}?\b(?:is|was|has been|got)?\s*merged\b|\bmerged\s+(?:PR\s+)?#(\d{1,6})\b)/gi;
const REPO = /\brepo\s+([\w.-]+\/[\w.-]+)/g;
const AGENT_NOTICE = /^⏺\s+(?:Agent|Background (?:agent|command|task|shell)|Task|Shell)\b.*\b(?:finished|completed|failed|stopped|killed|was stopped)\b/i;
// Lines Claude Code draws between a finished reply and the input box: its status/spinner line and the tip
// under it. A user prompt (❯ / >) or new output (⏺, ⎿ of a tool) after the ask means the turn moved on.
const STATUS = /^\s*(?:[✻✳✶✢✽·*◐◑◒◓⠀-⣿]\s|⎿\s+Tip)/u;

// The ask a screen ends with, or null. `screen`: hc read's text (the screen, no history). `opts` (the plus build's
// workflow settings, read by the tick): `pipeline` — the review pipeline's round / merge / migration lines are asks;
// `worth` — an "Also worth considering" list at the end asks nothing. Both on when not given.
export function pendingAsk(screen, { pipeline = true, worth = true } = {}) {
  const lines = String(screen ?? "").split(/\r?\n/);
  // The input box: the last "❯" row with a rule above it; the reply ends above that rule.
  let top = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { top = i - 1; break; }
  }
  if (top < 0) return null;
  for (let i = top - 1; i >= 0; i--) {
    if (!lines[i].trim() || STATUS.test(lines[i])) continue;
    // Claude Code indents a reply's text; a line at the left edge is a prompt (❯ / >: the turn moved on),
    // a reply's first line (⏺), or a notice drawn under the reply ("Context past 200K: …") to skip.
    if (/^[❯>]/.test(lines[i])) return null;
    if (/^\S/.test(lines[i]) && !/^⏺/.test(lines[i])) continue;
    // A background agent's or task's notice under the reply ('⏺ Agent "Opus check" finished · 1m 36s') is not a new turn.
    if (AGENT_NOTICE.test(lines[i])) continue;
    const l = lines[i].replace(/^⏺\s?/, "  ");
    // The last lines of the reply: the ask's line may wrap ("· repo acme-co" / "/webshop").
    for (const tail of pipeline ? [l, `${lines[i - 1] ?? ""}${l.trim()}`, `${lines[i - 1] ?? ""} ${l.trim()}`] : []) {
      let m = ROUND.exec(tail);
      if (m) return { kind: "round", pr: Number(m[1]), round: Number(m[2]) };
      m = MERGE.exec(tail);
      // "#1864, #1867": every PR, so the marker names both (11-12); `pr` stays the first.
      if (m) { const prs = m[1].split(",").map((x) => Number(x.replace("#", "").trim())); return prs.length > 1 ? { kind: "merge", pr: prs[0], prs } : { kind: "merge", pr: prs[0] }; }
    }
    // A go for a live-database change has no fixed line: the reply's LAST paragraph asks for it in words
    // ('Next step: reply "go migration 1818" …'). The paragraph: the lines up to the blank line above.
    let j = i;
    while (j > 0 && lines[j - 1].trim() && i - j < 10) j--;
    // A tool's block ("⏺ Running … ⎿ $ cmd; echo "exit $?"") is the turn still working, not a reply asking
    // anything: its ⎿ output line may end in "?" (11-12 log review: 4 of 6 "questions" were these).
    if (lines.slice(j, i + 1).some((x) => /^\s*⎿/.test(x))) return null;
    const para = lines.slice(j, i + 1).map((x) => x.trim()).join(" ");
    const m = pipeline ? MIGRATION.exec(para) : null;
    if (m) return { kind: "migration", pr: Number(m[1] ?? m[2]) };
    // An "Also worth considering" list (the owner's reply format puts it last) holds optional suggestions: a
    // 'say "merge #12" when you want it in' or a "want it next?" there asks nothing (owner 11-12 17:28: a merged,
    // finished tab sat in Needs you). Its heading is in the paragraph or just above it (after a blank line).
    let h = j - 1;
    while (h > 0 && !lines[h].trim()) h--;
    if (worth && (WORTH.test(para) || (h >= 0 && h < j && WORTH.test(lines[h])))) return null;
    // Any other answer the reply asks for in words, or a question it ends with.
    const words = [...para.matchAll(SAY)].map((x) => x[1] ?? x[2] ?? x[3] ?? x[4]).filter((w, k, l) => w.trim() && l.indexOf(w) === k);
    if (words.length) return { kind: "reply", words, text: para.slice(0, 240) };
    if (/\?["”')]*$/.test(para)) return { kind: "question", text: para.slice(0, 240) };
    return null;
  }
  return null;
}

// A finished reply that hands the work to a fresh session: "yes, clear" + a re-entry prompt (the owner's CLAUDE.md
// "Clear vs continue"), "safe to /clear", "start a fresh session with …", or a compaction recap naming the
// re-entry prompt. Read on the screen from just above the input box back to the last prompt (❯ / > at the left
// edge: an older turn's hand-off doesn't count once you typed after it). Not an ask: nothing to answer here.
const HANDOFF = /\byes,\s*clear\b|\bre-?entry prompt\b|\bsafe to \/clear\b|\b(?:paste|start)\b[^.]{0,40}\bfresh session\b/i;
export function handoffGiven(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let top = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { top = i - 1; break; }
  }
  if (top < 0) return false;
  let from = 0;
  for (let i = top - 1; i >= 0; i--) if (/^[❯>]/.test(lines[i])) { from = i + 1; break; }
  return HANDOFF.test(lines.slice(from, top).map((l) => l.trim()).join(" "));
}

// The "question" kind (a reply ending with "?") may also catch a rhetorical ending ("Why does this matter?"),
// so each new one is logged for the owner to judge (11-11 s6): QUESTION_LOG keeps the last QUESTION_KEEP.
// `was` and `out` are the asks before and after a tick: the addresses with a question that is new or changed.
// s13 (F5, for the noise review ≥ 11-19): each line carries the ask's kind and a time with its zone; 500 lines.
export const QUESTION_KEEP = 500;
// Asks that are new since the last tick, as log lines' text: a question's own words, else "[round #242 r16]",
// "[merge #1818]", "[migration #1790]", "[reply “go”]" (11-12: logged so a missed one can be traced).
export function newQuestions(was, out) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return Object.entries(out ?? {}).filter(([k, v]) => v && !same(was?.[k], v)).map(([k, v]) => ({ address: k, kind: v.kind, text: askText(v) }));
}
// "2026-11-12 16:55 +08:00": local time with its offset (`off`: minutes ahead of UTC).
export function logStamp(now, off) {
  const w = new Date(now + off * 60_000).toISOString().slice(0, 16).replace("T", " ");
  const a = Math.abs(off);
  return `${w} ${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
// One log line: time, tab, kind, [tab name], the ask's words on one line.
export const logLine = (stamp, q, name) => `${stamp}  ${q.address}  ${q.kind ?? "?"}  [${name}]  ${String(q.text).replace(/\s+/g, " ")}`;
// GitHub checks (prState's `gh pr view` runs) per clock hour, for the Settings line beside the calls (F5: the shared
// 5,000/hour GitHub limit). { hour, n, prev: { hour, n } }.
const KEY_GH = "flockbook.gh.count";
const hourKey = (at) => new Date(at).toISOString().slice(0, 13);
export function countGh() {
  const now = Date.now(), h = hourKey(now), c = shared(KEY_GH);
  if (c?.hour === h) return setShared(KEY_GH, { ...c, n: c.n + 1 });
  setShared(KEY_GH, { hour: h, n: 1, prev: c ? { hour: c.hour, n: c.n } : null });
}
// { now, last }: this hour's checks and the hour before's.
export function ghCounts() {
  const now = Date.now(), h = hourKey(now), lastH = hourKey(now - 3600_000), c = shared(KEY_GH);
  if (c?.hour === h) return { now: c.n, last: c.prev?.hour === lastH ? c.prev.n : 0 };
  return { now: 0, last: c?.hour === lastH ? c.n : 0 };
}
export function askText(v) {
  if (v.kind === "question") return v.text;
  if (v.kind === "round") return `[round #${v.pr} r${v.round}]`;
  if (v.kind === "merge" || v.kind === "migration") return `[${v.kind} #${v.pr}]`;
  if (v.kind === "reply") return `[reply ${(v.words ?? []).map((w) => `“${w}”`).join(" ")}] ${v.text ?? ""}`.trim();
  return `[${v.kind}]`;
}
// The log's text after adding `lines` to `old`: newest last, at most QUESTION_KEEP lines.
export function keepLog(old, lines) {
  return [...String(old ?? "").split("\n").filter(Boolean), ...lines].slice(-QUESTION_KEEP).join("\n") + "\n";
}
const questionLog = () => `${appHome()}/flockbook/asks-questions.log`;
async function logQuestions(fresh, list) {
  const stamp = logStamp(Date.now(), -new Date().getTimezoneOffset());
  const name = (address) => { const a = list.find((x) => x.address === address); return a?.title ? String(a.title).slice(0, 50) : address; };
  const lines = fresh.map((q) => logLine(stamp, q, name(q.address)));
  let was = null;
  try { was = await readTextFile(questionLog()); } catch { was = null; }
  try { await writeTextFile(questionLog(), keepLog(was, lines), was); } catch { /* the next new one writes again */ }
}

export const askOf = (address) => (address ? shared(KEY_ASKS)?.[address] ?? null : null);

// An answered ask leaves Needs you at once (owner 11-12: after "merge" it took ~10 s, the next tick): a send that went
// out (the Needs you buttons, the chat's reply box) calls answered(address), which drops the ask from KEY_ASKS and
// remembers it for ANSWERED_MS, so a tick that reads the screen before the agent drew the owner's words does not put
// it back. The same ask after that (the send never arrived) comes back.
export const KEY_ANSWERED = "flockbook.asks.answered";   // { [address]: { ask: <JSON of the ask>, at } }
export const ANSWERED_MS = 45_000;
// <answered>
// `out` (the asks a tick read) without those answered less than ANSWERED_MS ago, and the answered list with the old
// ones gone: { out, answered }.
export function dropAnswered(out, answered, now) {
  const keep = {}, list = {};
  for (const [k, v] of Object.entries(answered ?? {})) if (v && now - v.at < ANSWERED_MS) list[k] = v;
  for (const [k, v] of Object.entries(out ?? {})) if (!(list[k] && list[k].ask === JSON.stringify(v))) keep[k] = v;
  return { out: keep, answered: list };
}
// </answered>
export function answered(address) {
  const asks = shared(KEY_ASKS) ?? {}, ask = asks[address];
  if (!address || !ask) return false;
  const rest = { ...asks }; delete rest[address];
  setShared(KEY_ASKS, rest);
  setShared(KEY_ANSWERED, { ...dropAnswered({}, shared(KEY_ANSWERED), Date.now()).answered, [address]: { ask: JSON.stringify(ask), at: Date.now() } });
  return true;
}

// <elicitation>
// An MCP server asking through Claude Code (an "elicitation", 11-12: Supabase's "destructive operations … Run it on
// project …?"): the helper reads no card for it, so Needs you said only "It waits for you in its terminal". Claude
// Code draws a box titled 'MCP server “<name>” requests your input' (the name may be cut to "…"), the server's
// message under it, maybe form fields, then the Accept / Decline buttons. { server, text } or null. `screen`: hc read.
const ELICIT = /MCP server\s+[“"]([^”"]*)[”"]?\s*requests your input/;
const BOX = /^[\s│|╭╮╰╯─┃]+|[\s│|╭╮╰╯─┃]+$/g;
export function elicitation(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (ELICIT.test(lines[i])) { top = i; break; }
  if (top < 0) return null;
  // The buttons: the first line under the title that offers Accept (with Decline on it or just below).
  let btn = -1;
  for (let i = top + 1; i < Math.min(lines.length, top + 60); i++) {
    if (/(?:^|[\s❯>│])Accept\b/.test(lines[i]) && lines.slice(i, i + 3).some((x) => /\bDecline\b/.test(x))) { btn = i; break; }
  }
  if (btn < 0) return null;
  // A prompt box drawn after it means the session moved on.
  if (lines.slice(btn + 1).some((x, k, l) => /^\s*❯/.test(x) && /^\s*─{20,}\s*$/.test(l[k - 1] ?? lines[btn] ?? ""))) return null;
  const server = ELICIT.exec(lines[top])[1].trim() || "an MCP server";
  const text = lines.slice(top + 1, btn).map((x) => x.replace(BOX, "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  return { server, text: text.slice(0, 1200) };
}
// </elicitation>
// Blocked agents whose screen shows an MCP server's input request (owner 11-12: one click from the sidebar to its
// terminal): read by the tick (blocked agents only) and by a chat or Needs you card read, which sees it sooner.
export const KEY_ELICIT = "flockbook.elicit";   // { [address]: { server, text } }
export const elicitOf = (address) => (address ? shared(KEY_ELICIT)?.[address] ?? null : null);
// Sets (or, with null, clears) one agent's entry.
export function noteElicit(address, el) {
  const all = shared(KEY_ELICIT) ?? {};
  if (!address || JSON.stringify(all[address] ?? null) === JSON.stringify(el ? { server: el.server, text: el.text } : null)) return;
  const next = { ...all };
  if (el) next[address] = { server: el.server, text: el.text }; else delete next[address];
  setShared(KEY_ELICIT, next);
}

// Work a Claude Code session still runs after its turn ended (owner 11-11, 18:18: "quick check still running but
// already tagged as done"): its footer under the input box counts background shells ("· 1 shell ·") and lists running
// sub-agents ("○ implementer  Running verify.mjs quick check"). { shells, agents } or null. "← N agents" is not
// counted: it lists finished agents too.
export function backgroundWork(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let box = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { box = i; break; }
  }
  if (box < 0) return null;
  let end = box + 1;
  while (end < lines.length && !RULE.test(lines[end])) end++;
  const foot = lines.slice(end + 1);
  let shells = 0, agents = 0;
  for (const l of foot) {
    const m = /(?:^|·)\s*(\d{1,3})\s+(?:background\s+)?shells?\b/.exec(l);
    if (m) shells = Math.max(shells, Number(m[1]));
    if (/^\s*○\s+\S+\s{2,}\S/.test(l)) agents++;
  }
  if (!shells && !agents) return null;
  // A shell behind a reply that says it waits on CI is the CI watch (owner 11-12 16:49: "this terminal is waiting
  // for CI but was already put as Done"): `ci`, so the Overview keeps it under "Waiting on CI".
  if (!shells) return { shells, agents };
  const reply = lastReply(lines, box - 1);
  if (CI_WAIT.test(reply)) return { shells, agents, ci: true };
  // A shell behind a reply that says the PR is going through the merge queue / gate (owner 11-12 22:15: "why is this
  // done" — "its still merging"): `merge`, so the Overview keeps it under "Merging", working, until the merge lands.
  if (MERGE_WAIT.test(reply)) return { shells, agents, merge: true };
  // A shell behind a reply that waits on a Codex review / recheck (owner 11-12 s14: "this is waiting on codex
  // recheck not me"): `review`, so the Overview keeps it under "In review", working.
  return REVIEW_WAIT.test(reply) ? { shells, agents, review: true } : { shells, agents };
}
const REVIEW_WAIT = /\bwait(?:ing)?\s+(?:for|on)\s+(?:the\s+)?(?:Codex|Fable)\b|\b(?:Codex|Fable)\s+(?:review|recheck|round|rerun)\b[^.\n]{0,60}?\b(?:still running|is running|running in the background|in progress)\b/i;
const MERGE_WAIT = /\b(?:in(?:to)?|through|joins?|joined|entered)\s+(?:GitHub's\s+|the\s+)?(?:merge\s+)?queue\b|\bonce\s+(?:#\d+|it|they|both|the PRs?)\s+(?:merges?|lands?|is merged|are merged)\b|\bmerge queue\b[^.\n]{0,60}?\b(?:now|running|still|in progress|pending)\b|\bwait(?:ing)?\s+(?:for|on)\s+(?:the\s+)?(?:merge|merges)\b|\b(?:both\s+)?merges?\s+once\b|\bmerge (?:job|gate|watch|run)\b[^.\n]{0,60}?\b(?:still running|is running|running|in progress|pending)\b|\bstill merging\b|\bis merging\b/i;
const CI_WAIT = /\bwait(?:ing)?\s+(?:for|on)\s+(?:the\s+)?CI\b|\bCI\b[^.\n]{0,80}?\b(?:still running|is running|in progress|pending|to finish)\b|\bwhile CI runs\b/i;
// The last reply of the turn above the input box (`top`: the box's top rule): its last "⏺ " text that is not a tool
// call ("⏺ Bash(…)") or a background notice, with its wrapped lines AND its later paragraphs (indented text after
// blank lines; s13 Codex R1 P2), up to the next unindented line or a tool's ⎿ output. "" when there is none.
function lastReply(lines, top) {
  let from = 0;
  for (let i = top - 1; i >= 0; i--) if (/^[❯>]/.test(lines[i])) { from = i + 1; break; }
  for (let i = top - 1; i >= from; i--) {
    if (!/^⏺ /.test(lines[i]) || /^⏺ (?:[\w-]+\(|Background command\b)/.test(lines[i])) continue;
    const out = [lines[i].slice(2)];
    for (let j = i + 1; j < top && (!lines[j].trim() || (/^ {2}\S/.test(lines[j]) && !/^\s*⎿/.test(lines[j]))); j++) if (lines[j].trim()) out.push(lines[j]);
    return out.map((l) => l.trim()).join(" ");
  }
  return "";
}
// Whether the session's turn ended while it waits on CI (a shell runs and its last reply says so).
export const ciWaiting = (screen) => Boolean(backgroundWork(screen)?.ci);
// The session's folder from Claude Code's status line under the box ("you:\~/code/webshop | WORK …"), with
// "~" as `home`; null when there is none. The terminal's own folder is often home, which names no repo.
export function footerFolder(screen, homeDir) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let box = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { box = i; break; }
  }
  if (box < 0) return null;
  let end = box + 1;
  while (end < lines.length && !RULE.test(lines[end])) end++;
  const m = /^\s*[\w.-]+:\\?(~[^\s|]*|\/[^\s|]*)/.exec(lines[end + 1] ?? "");
  if (!m) return null;
  return m[1].startsWith("~") ? (homeDir ? homeDir + m[1].slice(1) : null) : m[1];
}
export const handoffOf = (address) => Boolean(address && shared(KEY_HANDOFF)?.[address]);
export const bgOf = (address) => (address ? shared(KEY_BG)?.[address] ?? null : null);
// "1 shell running · 2 agents running"
export const bgWords = (b) => [b?.shells ? `${b.shells} ${b.shells === 1 ? "shell" : "shells"} running` : null, b?.agents ? `${b.agents} ${b.agents === 1 ? "agent" : "agents"} running` : null].filter(Boolean).join(" · ");

// The last PR a screen names as merged ("#1821 is merged"), with the last "repo owner/name" on it: { pr, repo }
// or null. Only a hint: GitHub says whether it is.
export function mergedHint(screen) {
  const s = String(screen ?? "");
  const m = [...s.matchAll(MERGED)].pop();
  if (!m) return null;
  const repo = [...s.matchAll(REPO)].pop()?.[1] ?? null;
  return { pr: Number(m[1] ?? m[2]), repo };
}
// <now>
// What a tab works on, in plain words, for the Overview (owner 11-12: "show me in layman terms what each tab is
// working on"; picked: a "Now:" line on each card + a hover with the last steps). From the screen the tick reads
// anyway: Claude's spinner when it names a step ("Running the tests…", a to-do's words; a lone "Perusing…" says
// nothing), else its last ⏺ line, a tool call said in words ("editing chat.js", "running tests") or the first
// sentence of its own words. { now, steps, helpers } or null: steps = the last 4, oldest first; helpers = running
// sub-agents from the footer ("implementer: Running red notices tests").
const TOOL = /^([A-Za-z][\w.:-]*)\((.*?)\)?\s*(?:·.*)?$/;
const MCP_TOOL = /^(\S+)\s+-\s+(\S+)\s+\(MCP\)/;
const TIMER = /\s+·\s+(?:\d+[hms](?:\s+\d+[ms])?|summary|running in background)\s*$/i;
const base = (p) => String(p).replace(/^["'`]|["'`]$/g, "").split(/[\\/]/).filter(Boolean).pop() ?? p;
const COMMANDS = [
  [/\b(?:vitest|jest|playwright|pytest|npm (?:run )?test|test(?:s)?\.(?:mjs|ts|js)|node \S*test-\S+)/i, "running tests"],
  [/\b(?:typecheck|tsc\b)/i, "checking the code for type errors"],
  [/\b(?:eslint|lint)\b/i, "checking code style"],
  [/\bverify(?:\.mjs)?\b/i, "running the checks"],
  [/\bcodex\b/i, "waiting for the Codex review"],
  [/\bgh (?:run watch|pr checks)\b/i, "waiting for CI on GitHub"],
  [/\bgit push\b/i, "pushing its work to GitHub"],
  [/\bgit commit\b/i, "saving its work (a commit)"],
  [/\bgh pr (?:create|edit)\b/i, "writing the pull request"],
  [/\bgh pr merge\b|\bmerge --pr\b/i, "merging the pull request"],
  [/\bgh\b/i, "checking GitHub"],
  [/\bsupabase\b|\bpsql\b/i, "working with the database"],
  [/\b(?:npm|pnpm|yarn) (?:install|ci)\b/i, "installing packages"],
  // s10 (owner: "go do all"): fewer plain "running a command".
  [/\b(?:next|npm run|pnpm) build\b/i, "building the app"],
  [/\b(?:next dev|npm run dev|pnpm dev)\b/i, "starting the app to look at it"],
  [/\bpipeline\.mjs\b/i, "running a pipeline step"],
  [/\bcurl\b/i, "checking a web address"],
  [/\b(?:hc|herdr-app)\s/i, "checking a terminal"],
  [/\bosascript\b/i, "using a Mac app"],
  [/\b(?:lsof|ps|pgrep|kill)\s/i, "checking running programs"],
  [/^\s*(?:sleep|wait)\b/i, "waiting"],
  [/^\s*(?:cat|sed|head|tail|grep|rg|wc|less|jq)\b/i, "reading files"],
  [/^\s*(?:ls|find|tree|du)\b/i, "looking through folders"],
  [/^\s*(?:rm|mv|cp|mkdir|ln|touch)\s/i, "moving files around"],
  [/\b(?:python3?|node|sh|bash)\s/i, "running a script"],
  [/\bgit\b/i, "working with git"],
];
const isTool = (l) => { const m = TOOL.exec(l); return Boolean(m && !/\s/.test(m[1])); };
export function plainStep(line) {
  const l = String(line ?? "").replace(/^⏺\s*/, "").replace(TIMER, "").trim();
  if (!l) return null;
  let m = MCP_TOOL.exec(l);
  if (m) return `using ${m[1]} (${m[2].replace(/_/g, " ")})`;
  m = TOOL.exec(l);
  if (m && !/\s/.test(m[1])) {
    const [, name, args] = m, arg = args.trim();
    if (name === "Bash") return COMMANDS.find(([re]) => re.test(arg))?.[1] ?? "running a command";
    if (name === "Read") return `reading ${base(arg)}`;
    if (/^(?:Edit|Update|MultiEdit|NotebookEdit)$/.test(name)) return `editing ${base(arg)}`;
    if (name === "Write") return `writing ${base(arg)}`;
    if (/^(?:Grep|Glob|Search|LS)$/.test(name)) return "searching the code";
    if (/^(?:WebSearch|WebFetch|Fetch)$/.test(name)) return "looking something up online";
    if (name === "Skill") return `using the ${arg.replace(/["']/g, "") || "a"} skill`;
    if (/^(?:TodoWrite|TaskCreate|TaskUpdate)$/.test(name)) return "updating its to-do list";
    if (name === "AskUserQuestion") return "asking you a question";
    // An agent: Agent(desc), Task(desc), or its type as the name: implementer(Fix PR 1838 R6 items).
    if (/^(?:Agent|Task|Explore|Plan)$/.test(name) || /^[a-z]/.test(name)) return `a helper is on it: ${arg || name}`;
    return `using ${name}`;
  }
  // Its own words: the first sentence. A short heading ("What happened") says nothing; a long one is cut at a word.
  if (!/[.!?:]/.test(l) && l.split(/\s+/).length <= 3) return null;
  const s = (/^(.{8,}?[.!?:])(?:\s|$)/.exec(l)?.[1] ?? l).replace(/:$/, "");
  return s.length <= 140 ? s : s.slice(0, 140).replace(/\s+\S*$/, "") + "…";
}
export function nowDoing(screen) {
  const lines = String(screen ?? "").split(/\r?\n/);
  let box = -1;
  for (let i = lines.length - 1; i > 0; i--) if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { box = i - 1; break; }
  const end = box < 0 ? lines.length : box;
  // Helpers: the footer's running sub-agents ("◯ implementer  Running …   1m 33s · ↓ 61.5k tokens").
  const helpers = [];
  for (const l of box < 0 ? [] : lines.slice(box + 1)) {
    const m = /^\s*[○◯]\s+(\S+)\s{2,}(.+?)(?:\s{2,}.*)?$/.exec(l);
    if (m) helpers.push(`${m[1]}: ${m[2].trim()}`.slice(0, 120));
  }
  let spin = null;
  const steps = [];
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    // A step: a reply's or tool's ⏺ line (its own words with their wrapped lines); not a sub-agent's notice.
    if (/^⏺\s/.test(l) && !AGENT_NOTICE.test(l)) {
      let text = l;
      if (!isTool(l.replace(/^⏺\s*/, ""))) {
        for (let j = i + 1; j < end && /^\s{2}\S/.test(lines[j]) && !/^\s*[⎿-]/.test(lines[j]) && !/[.!?:]\s*$/.test(text); j++) text += " " + lines[j].trim();
      }
      const p = plainStep(text);
      if (p) steps.push(p);
      spin = null;
    }
    // Claude's spinner, while working: "✻ Running the tests… (2m · ↓ 1k tokens)". A finished one ("✻ Baked for 27m") is not a step.
    const sm = /^\s*[✻✳✶✢✽·*]\s+([^…(]+?)…/.exec(l);
    if (sm && sm[1].trim().split(/\s+/).length >= 2) spin = sm[1].trim();
  }
  const now = spin ?? steps[steps.length - 1] ?? null;
  if (!now && !helpers.length) return null;
  return { now: now ?? `a helper is on it: ${helpers[0]}`, steps: steps.slice(-4), helpers };
}
// </now>
export const KEY_NOW = "flockbook.now";   // { [address]: { now, steps, helpers } }
export const nowOf = (address) => (address ? shared(KEY_NOW)?.[address] ?? null : null);

// The PR a tab's 🔀 is about, and what GitHub said of it: { pr, repo, state? } or null.
export const prOf = (address) => (address ? shared(KEY_PRS)?.[address] ?? null : null);
const CHECK_MS = 120_000;
const hasMergeMark = (a) => (a?.title ?? "").includes("🔀");

// One tick at a time across every copy: a tick still running (GitHub lookups can take 20 s each) keeps the
// next copies out for up to BUSY_MS, so ticks don't pile up (11-12: a pending extra round never reached Needs you).
const KEY_BUSY = "flockbook.asks.busy";
const BUSY_MS = 5 * 60_000;
export async function asksTick() {
  const now = Date.now(), at = shared(KEY_AT), busy = shared(KEY_BUSY);
  if (at && now - at < TICK_MS - 2000) return;
  if (busy && now - busy < BUSY_MS) return;
  setShared(KEY_AT, now);
  setShared(KEY_BUSY, now);
  try { await tickOnce(); } finally { setShared(KEY_BUSY, null); }
}
async function tickOnce() {
  const out = {};
  // Local agents only (a remote one's address has its machine in front: "box/t7"); a question card
  // already covers a blocked agent.
  const prsWas = shared(KEY_PRS) ?? {}, prs = {}, bg = {}, elicit = {}, now = {}, handoff = {};
  // The plus build's workflow switches (Settings → Workflow).
  const opts = { pipeline: setting("pipeline_asks") === "on", worth: setting("worth_considering") === "on" };
  const handoffs = setting("handoff_marks") === "on";
  for (const a of agents()) {
    if (!a.address || a.address.includes("/")) continue;
    // Blocked: only whether it is an MCP server's input request (the sidebar's 🔌).
    if (a.status === "blocked") {
      try { const r = await hc(["read", a.address]); const el = r.code === 0 ? elicitation(r.stdout) : null; if (el) elicit[a.address] = el; const n = r.code === 0 ? nowDoing(r.stdout) : null; if (n) now[a.address] = n; } catch { /* gone meanwhile */ }
      continue;
    }
    try {
      const r = await hc(["read", a.address]);
      const ask = r.code === 0 ? pendingAsk(r.stdout, opts) : null;
      if (ask) out[a.address] = ask;
      const b = r.code === 0 && a.status !== "working" ? backgroundWork(r.stdout) : null;
      if (b) bg[a.address] = b;
      if (handoffs && r.code === 0 && a.status !== "working" && !ask && handoffGiven(r.stdout)) handoff[a.address] = true;
      const n = r.code === 0 ? nowDoing(r.stdout) : null;
      if (n) now[a.address] = n;
      // The PR its 🔀 is about: from the hand-off, else a "#N is merged" line; kept while the 🔀 stays (review-pipeline
      // asks on: the 🔀 is that setup's tab-title mark).
      if (!opts.pipeline || !hasMergeMark(a)) continue;
      const old = prsWas[a.address] ?? null;
      const hint = ask?.kind === "merge" ? { pr: ask.pr, repo: [...r.stdout.matchAll(REPO)].pop()?.[1] ?? null } : r.code === 0 ? mergedHint(r.stdout) : null;
      prs[a.address] = hint && (!old || old.pr !== hint.pr) ? { pr: hint.pr, repo: hint.repo ?? old?.repo ?? null } : old;
      if (!prs[a.address]) { delete prs[a.address]; continue; }
      const dir = r.code === 0 ? footerFolder(r.stdout, home()) : null;
      if (dir && !prs[a.address].dir) prs[a.address] = { ...prs[a.address], dir };
    } catch { /* gone meanwhile */ }
  }
  if (JSON.stringify(shared(KEY_ELICIT) ?? {}) !== JSON.stringify(elicit)) setShared(KEY_ELICIT, elicit);
  if (JSON.stringify(shared(KEY_NOW) ?? {}) !== JSON.stringify(now)) setShared(KEY_NOW, now);
  // The asks first: Needs you must not wait for GitHub. One the owner just answered stays out (answered()).
  const was = shared(KEY_ASKS) ?? {};
  const ans = shared(KEY_ANSWERED) ?? {}, kept = dropAnswered(out, ans, Date.now());
  for (const k of Object.keys(out)) if (!(k in kept.out)) delete out[k];
  if (JSON.stringify(ans) !== JSON.stringify(kept.answered)) setShared(KEY_ANSWERED, kept.answered);
  if (JSON.stringify(was) !== JSON.stringify(out)) setShared(KEY_ASKS, out);
  const fresh = newQuestions(was, out);
  if (fresh.length) await logQuestions(fresh, agents());
  // GitHub, for each 🔀 with no hand-off on screen whose PR is not known to be merged or closed yet.
  const now2 = Date.now();
  for (const [address, p] of Object.entries(prs)) {
    if (out[address]?.kind === "merge" || p.state === "MERGED" || p.state === "CLOSED") continue;
    if (p.checked && now2 - p.checked < CHECK_MS) continue;
    prs[address] = { ...p, checked: now2, state: (await prState(address, p)) ?? p.state ?? null };
  }
  if (JSON.stringify(prsWas) !== JSON.stringify(prs)) setShared(KEY_PRS, prs);
  if (JSON.stringify(shared(KEY_BG) ?? {}) !== JSON.stringify(bg)) setShared(KEY_BG, bg);
  if (JSON.stringify(shared(KEY_HANDOFF) ?? {}) !== JSON.stringify(handoff)) setShared(KEY_HANDOFF, handoff);
}

// "OPEN", "MERGED" or "CLOSED" from gh, or null (no gh, no network, no repo to ask). In the repo it names, else in
// the session's folder (its git remote; a worktree removed after the merge: the nearest folder above it), else the
// terminal's folder.
async function prState(address, p) {
  const args = ["pr", "view", String(p.pr), "--json", "state", "--jq", ".state", ...(p.repo ? ["-R", p.repo] : [])];
  const up = (d, n) => (n ? up(d.replace(/\/[^/]+\/?$/, ""), n - 1) : d);
  const dirs = p.repo ? [null] : [...(p.dir ? [0, 1, 2, 3].map((n) => up(p.dir, n)).filter((d) => d && d !== home()) : []),
    panes().find((x) => x.terminal === address)?.cwd ?? null].filter(Boolean);
  for (const cwd of dirs) {
    for (const gh of ["/opt/homebrew/bin/gh", "gh"]) {
      let r = null;
      try { countGh(); r = await exec(gh, args, { ...(cwd ? { cwd } : {}), timeout: 20_000 }); } catch { continue; }   // no such gh, or folder
      const s = (r.stdout ?? "").trim();
      if (r.code === 0 && ["OPEN", "MERGED", "CLOSED"].includes(s)) return s;
      break;   // gh ran but this folder names no repo (or no such PR there): the next folder
    }
  }
  return null;
}

// The words for an ask: the Needs you list's line and its detail.
export function askLine(ask) {
  if (!ask) return "waits for you";
  if (ask.kind === "reply") return `asks you to say ${ask.words.map((w) => `“${w}”`).join(" or ")}`;
  if (ask.kind === "question") return "asks you a question";
  if (ask.kind === "migration") return `asks for your go on a database change · #${ask.pr}`;
  return ask.kind === "round" ? `asks for an extra review round · #${ask.pr}` : `ready to merge · ${prList(ask)}`;
}
// The ask as a marker (owner 11-12: "the default view is not showing the extra rounds … show the merge and extra
// round icons since it's not always obvious"): { glyph, group, word, tip, title, hint } or null. `word` and `tip` go
// with the tab's other symbols (state.js overlays: tab list, tab bar, Overview); `title` and `hint` make the strip
// above the chat's reply box. A question at the reply's end gets none: it is plain to see in the chat, and some
// are rhetorical (asks-questions.log review).
export function askMark(ask) {
  if (!ask) return null;
  if (ask.kind === "round") return { glyph: "🔁", group: "round", word: `extra round #${ask.pr}`,
    tip: `it asks for an extra review round on #${ask.pr} (round ${ask.round}): type “extra round” in its chat to grant it`,
    title: `Extra review round asked · #${ask.pr} round ${ask.round}`, hint: "To grant it, type “extra round” below yourself: the pipeline only counts your own words." };
  if (ask.kind === "merge") return { glyph: "🔀", group: "merge", word: `ready to merge ${prList(ask)}`,
    tip: `${prList(ask)} ${ask.prs ? "are" : "is"} ready to merge: say “merge” in its chat`,
    title: `Ready to merge · ${prList(ask)}`, hint: "Say “merge” below when you're happy with it." };
  if (ask.kind === "migration") return { glyph: "🗄", group: "migration", word: `migration go #${ask.pr}`,
    tip: `it waits for your go on the live database change for #${ask.pr}`,
    title: `Database change waits for your go · #${ask.pr}`, hint: `Reply “go migration ${ask.pr}” below when you're ready.` };
  if (ask.kind === "reply") return { glyph: "💬", group: "reply", word: "asks you to reply",
    tip: `it asks you to say ${(ask.words ?? []).map((w) => `“${w}”`).join(" or ")}`,
    title: `Asks you to say ${(ask.words ?? []).map((w) => `“${w}”`).join(" or ")}`, hint: "Its reply ends waiting for your answer." };
  return null;
}
// Whether `screen` still ends with the same ask (kind, every PR it names, and round): checked right before a button
// sends the owner's words, so a round already granted, a newer one, or a merge that now names more PRs gets nothing.
// "#1864, #1867" for a merge of two, else "#1864".
export function prList(ask) { return (ask?.prs ?? [ask?.pr]).map((n) => `#${n}`).join(", "); }
export function stillAsks(screen, ask) {
  const now = pendingAsk(screen);
  return Boolean(now && ask && now.kind === ask.kind && now.pr === ask.pr && prList(now) === prList(ask) && (now.round ?? null) === (ask.round ?? null));
}
export function askDetail(ask) {
  if (ask?.kind === "reply") return `Its turn ended waiting for your answer: “${ask.text}” Reply in its chat.`;
  if (ask?.kind === "question") return `Its turn ended with a question for you: “${ask.text}” Reply in its chat.`;
  if (ask?.kind === "migration") return `It waits for your go on the live database change for #${ask.pr}. Reply “go migration ${ask.pr}” in its chat when you're ready.`;
  if (ask?.kind === "round") return `It asks for an extra review round on #${ask.pr} (round ${ask.round}). To grant it, press Extra round below (it sends “extra round” for you, as if typed in its chat), or type it in its chat yourself.`;
  if (ask?.kind === "merge") return `${prList(ask)} ${ask.prs ? "are" : "is"} ready to merge. Press Merge below (it sends “merge” for you, as if typed in its chat), or say it in its chat yourself.`;
  return null;
}
