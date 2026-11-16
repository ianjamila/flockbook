// CI spending this month, in the side bar above the weekly usage (owner 11-15 s39: "CI spending for the month … github
// out of 300 dollars, ubicloud current usage"). The Mac's 3-hourly CI-budget check (ci-allowance-check.mjs →
// ci-spend.mjs, outside this repo) writes ~/Library/Caches/ci-spend/spend.json:
//   { v: 1, at, month, github: { usedUsd, includedUsd, perDayUsd, projectedExhaustion, action, ubicloudConnected, at },
//     ubicloud: { listUsd, creditUsd, estUsd, minutes, exact, counting, labels, firstDay, lastAt, inUse: [groups] },
//     links: { github, ubicloud } }
// GitHub's figure is GitHub's own (Enterprise billing, used of the $300 included). Ubicloud has no billing API, so its
// figure is an estimate from GitHub's job records (minutes on Ubicloud runners × list price, minus its $2.50 monthly
// credit) — shown with "≈" (owner chose: estimate + in-use status + a link). This computer's file is read when it is a
// Mac, and each connected machine's (the PC reads the Mac's over the machine link); the newest `at` wins. Kept in ONE
// shared key; render reads it with snapShared and calls nothing (s33: Herdr cuts off a slow render).
import { shared, setShared, home, readTextFile, window as hostWindow } from "herdr";
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { knownMachines } from "./machines.js";
import { machineHome } from "./where.js";
import { snapShared } from "./parked.js";
import { ago, levelOf, usageColours } from "./usage.js";

export const KEY_CISPEND = "flockbook.cispend";        // { sources: { [machine or ""]: { asked, data } } }
export const CISPEND_MS = 5 * 60_000;                  // the file changes every 3 h
export const SPEND_FILE = "Library/Caches/ci-spend/spend.json";
export const CHECK_EVERY_MS = 3 * 3600_000;
// Older than one missed check (the Mac asleep or away): the line says how old.
export const SPEND_STALE_MS = CHECK_EVERY_MS + 30 * 60_000;
const LOCAL = "";

// <cispend-pure>
// The newest valid reading of every source, or null.
export function newestSpend(data) {
  let best = null;
  for (const [machine, s] of Object.entries(data?.sources ?? {})) {
    const d = s?.data;
    if (d?.v !== 1 || !Number.isFinite(d.at)) continue;
    if (!best || d.at > best.at || (d.at === best.at && machine === LOCAL)) best = { ...d, machine };
  }
  return best;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-11-16" → "Mon 16 Nov" (a calendar day: read as UTC, so no time zone moves it).
export function dayText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");
const GROUP_WORDS = { CHECKS: "checks", LIGHT: "light jobs", DB: "database jobs", BROWSER: "browser tests" };
const groupsText = (list) => list.map((g) => GROUP_WORDS[g] ?? g.toLowerCase()).join(", ");
// What the two rows show. github: { left (0..100), used (0..100), right, line, level, tip } or null; ubicloud: { right,
// line, tip } or null; age words when the reading is older than one missed check.
export function spendFigures(s, now = Date.now()) {
  if (!s) return null;
  const age = now - s.at;
  const stale = age > SPEND_STALE_MS ? `as of ${ago(age)}` : null;
  const from = s.machine ? s.machine : "this computer";
  let github = null;
  const g = s.github;
  if (g && Number.isFinite(g.usedUsd) && Number.isFinite(g.includedUsd) && g.includedUsd > 0) {
    const used = Math.max(0, Math.min(100, (g.usedUsd / g.includedUsd) * 100));
    const left = 100 - used;
    const over = g.usedUsd > g.includedUsd;
    const pace = Number.isFinite(g.perDayUsd) ? `~${usd(g.perDayUsd)}/day` : null;
    const out = dayText(g.projectedExhaustion);
    const moved = (s.ubicloud?.inUse ?? []).length > 0;
    const parts = [over ? `${usd(g.usedUsd - g.includedUsd)} over` : pace, moved ? "CI on Ubicloud now" : out && !over ? `runs out ${out}` : null, stale].filter(Boolean);
    // s41: where the CI-budget check moves CI to Ubicloud (its switchAtUsd; an older file has none): a mark on the bar,
    // red past it, amber before it however little is left (the switch, not the $300, is the line that matters).
    const switchAt = Number.isFinite(g.switchAtUsd) && g.switchAtUsd > 0 && g.switchAtUsd < g.includedUsd ? g.switchAtUsd : null;
    let level = levelOf(Math.round(left));
    if (switchAt != null) level = g.usedUsd >= switchAt ? "low" : level === "low" ? "warn" : level;
    github = {
      used: Math.round(used), left: Math.round(left), level,
      mark: switchAt != null ? Math.round((switchAt / g.includedUsd) * 1000) / 10 : null,
      right: `${usd(g.usedUsd)} of ${usd(g.includedUsd).replace(/\.00$/, "")}`,
      line: parts.join(" · "),
      tip: [`GitHub Actions this month: ${usd(g.usedUsd)} of the ${usd(g.includedUsd)} included in Enterprise`, pace ? `${pace} on average` : null,
        out ? `at this pace the included amount runs out ${out}` : null,
        `the CI-budget check moves CI to Ubicloud past ${switchAt != null ? usd(switchAt).replace(/\.00$/, "") : "$270"}${switchAt != null ? " (the mark on the bar)" : ""}`,
        `read ${ago(age)} on ${from}`, "click to open GitHub billing"].filter(Boolean).join(" · "),
    };
  }
  let ubicloud = null;
  const u = s.ubicloud;
  if (u && Number.isFinite(u.listUsd)) {
    const inUse = u.inUse ?? [];
    const credit = Number.isFinite(u.creditUsd) ? u.creditUsd : 0;
    const right = u.estUsd > 0 ? `≈ ${usd(u.estUsd)}` : u.listUsd > 0 ? "$0 (credit)" : "$0";
    const status = inUse.length ? `in use now: ${groupsText(inUse)}` : "not in use · CI on GitHub";
    // s41: while CI is on Ubicloud, the day the check moved it (its open "switched" issue) and the day it moves back.
    const sw = inUse.length && u.switched ? { since: dayText(u.switched.since), back: dayText(u.switched.backOn), issue: u.switched.issue } : null;
    const dates = sw ? [sw.since ? `since ${sw.since}` : null, sw.back ? `back to GitHub ${sw.back}` : null].filter(Boolean) : [];
    const counting = u.counting > 0 ? `counting… ${u.counting} ${u.counting === 1 ? "day" : "days"} left` : null;
    const mins = u.minutes > 0 ? `${u.minutes.toLocaleString("en-US")} min this month` : null;
    ubicloud = {
      right,
      line: [status, ...dates, counting ?? mins, stale].filter(Boolean).join(" · "),
      tip: [`Ubicloud this month: an estimate from GitHub's job records, ${usd(u.listUsd)} at list price${credit ? `, less its ${usd(credit)} monthly credit` : ""}`,
        sw?.since ? `moved to Ubicloud ${sw.since}${Number.isFinite(sw.issue) ? ` (issue #${sw.issue})` : ""}${sw.back ? `, back to GitHub ${sw.back}` : ""}` : null,
        u.minutes > 0 ? `${u.minutes.toLocaleString("en-US")} runner minutes${u.firstDay ? ` since ${dayText(u.firstDay)}` : ""}` : "no Ubicloud minutes this month",
        u.exact ? null : "busy workflows are sampled (a few runs a day, scaled up)",
        "premium machines would cost more", counting, `read ${ago(age)} on ${from}`, "click to open the Ubicloud console"].filter(Boolean).join(" · "),
    };
  }
  return github || ubicloud ? { github, ubicloud, links: s.links ?? {} } : null;
}
// </cispend-pure>

// ---- polling ----
const isWindows = () => { try { return hostWindow()?.platform === "windows"; } catch { return false; } };
function store(source, patch) {
  const d = shared(KEY_CISPEND) ?? { sources: {} };
  setShared(KEY_CISPEND, { ...d, sources: { ...d.sources, [source]: { ...(d.sources?.[source] ?? {}), ...patch } } });
}
// One source, if due. A file that is not there, or a machine that can't be read, keeps the last reading (it stays the
// freshest known; its age shows once it is old).
async function ask(source, now) {
  const was = shared(KEY_CISPEND)?.sources?.[source]?.asked;
  if (was && now - was < CISPEND_MS - 500) return;
  store(source, { asked: now });
  try {
    const h = source === LOCAL ? home() : await machineHome(source);
    if (!h || !String(h).startsWith("/")) return;
    const text = await readTextFile(`${h}/${SPEND_FILE}`, source === LOCAL ? undefined : { on: source });
    const data = text ? JSON.parse(text) : null;
    if (data?.v === 1 && Number.isFinite(data.at)) store(source, { data });
  } catch { /* not there, or unreadable: the last reading stays */ }
}
// This computer (a Mac: Windows has no such file), then each connected machine. `now`: tests.
export async function pollSpend(now = Date.now()) {
  const machines = knownMachines().filter((m) => m?.state === "connected" && m.name).map((m) => m.name);
  await Promise.all([...(isWindows() ? [] : [ask(LOCAL, now)]), ...machines.map((n) => ask(n, now))]);
}

// ---- drawing ----
// The block: "CI spending this month", a GitHub row (used of the included amount, a bar filled to what is used, the
// pace) and a Ubicloud row (the estimate, in use or not). Nothing until a reading exists. A click opens the billing page.
export function spendBlock(t, now = Date.now()) {
  const f = spendFigures(newestSpend(snapShared(KEY_CISPEND)), now);
  if (!f) return null;
  const c = usageColours();
  const open = (url) => (_e, cx) => { if (url) cx?.open_url?.(url); };
  const name = (id, text) => div().id(id).flex_none().text_size(12).font_semibold().text_color(t.foreground).child(text);
  return v_flex().id("cispend").flex_none().gap(8).mt(8).pt(10).px(10).border_t(1).border_color(t.border)
    .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("CI spending this month"))
    .when(Boolean(f.github), (el) => el.child(v_flex().id("cispend-github").gap(3).tooltip(f.github.tip).cursor_pointer().on_click(open(f.links.github))
      .child(h_flex().items_center().text_size(12)
        .child(div().flex_1().min_w(0).child(name("cispend-github-name", "GitHub")))
        .child(div().id("cispend-github-right").text_color(c.level[f.github.level] ?? t.foreground).child(f.github.right)))
      .child(div().id("cispend-github-bar").relative().w_full().h(4).rounded(2).bg(t.border).overflow_hidden()
        .child(div().id("cispend-github-fill").h(4).rounded(2).bg(c.level[f.github.level]).w(`${f.github.used}%`))
        // s41: the switch point ($270): a thin tick in the text colour, over the fill.
        .when(f.github.mark != null, (b) => b.child(div().id("cispend-github-mark").absolute().top(0).h(4).w(2).bg(t.foreground).left(`${f.github.mark}%`))))
      .when(Boolean(f.github.line), (r) => r.child(div().id("cispend-github-line").text_size(10.5).text_color(t.muted).child(f.github.line)))))
    .when(Boolean(f.ubicloud), (el) => el.child(v_flex().id("cispend-ubicloud").gap(3).tooltip(f.ubicloud.tip).cursor_pointer().on_click(open(f.links.ubicloud))
      .child(h_flex().items_center().text_size(12)
        .child(div().flex_1().min_w(0).child(name("cispend-ubicloud-name", "Ubicloud")))
        .child(div().id("cispend-ubicloud-right").text_color(t.foreground).child(f.ubicloud.right)))
      .child(div().id("cispend-ubicloud-line").text_size(10.5).text_color(t.muted).child(f.ubicloud.line))));
}
