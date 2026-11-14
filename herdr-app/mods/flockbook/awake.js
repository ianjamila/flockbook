// Stay awake while agents work (owner 11-15 s36: "Yes, but lid open only"). When this computer sleeps, every agent on it
// stops; so while an agent here works, the helper's `awake` command holds the machine back from IDLE sleep (the screen
// may still turn off and lock; closing the lid still sleeps it: that needs admin rights and is not touched).
//
// Work is what the Overview already counts, not a second opinion: a tab working (its turn runs), a finished turn with
// something running behind it (CI watch ⏳, Codex round 🔍, build agents 🛠: state.js subStatus().background, which is
// what puts a tab under "Working" / "CI / Final Review / Merging" there), or a tab blocked on the owner for less than 3 h.
// Only this computer's agents count (a tab on another machine keeps THAT machine awake); on Windows the WSL machine named
// by "claude_machine" is this computer too.
//
// The hold is renewed every minute for 3 minutes, so a crashed Herdr lets go within 3 minutes. When work ends it is kept
// 15 more minutes (a gap between two turns), then released. The tick runs where the other ticks do (top.js startTop, one
// copy at a time) and keeps everything in ONE shared key; render reads it with snapShared and calls no host or helper
// function (s33: Herdr cuts off a slow render).
import { shared, setShared } from "herdr";
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import * as sidecar from "./sidecar.js";
import { setting, setSetting } from "./config.js";
import { snapShared, withSnapshot } from "./parked.js";
import { subStatus } from "./state.js";
import { allTabs, statusOf } from "./overview.js";
import { claudeMachine, localWindows } from "./where.js";

export const KEY_AWAKE = "flockbook.awake";         // { work, lastWork, holding, renewedAt, phase, error, retryAt, seen }
const KEY_BUSY = "flockbook.awake.busy";            // when a tick began
export const AWAKE_MS = 15_000;                     // how often work is looked at
export const RENEW_MS = 60_000;                     // how often the hold is renewed while there is work
export const HOLD_SECS = 180;                       // each renewal holds this long
export const GRACE_MS = 15 * 60_000;                // kept this long after the last work
export const BLOCKED_MAX_MS = 3 * 60 * 60_000;      // a tab blocked on the owner longer than this lets the computer sleep
export const BACKOFF_MS = 5 * 60_000;               // after a failure the helper is not asked again for this long
const BUSY_MS = 45_000;

// <awake-pure>
// Whether a space's tabs run on this computer.
export const isLocal = (space, { windows = false, wsl = null } = {}) => !space?.machine || (windows && Boolean(wsl) && space.machine === wsl);

const EMPTY = { working: 0, ci: 0, review: 0, other: 0, waiting: 0, total: 0 };
// What this computer's tabs are doing: { working, ci, review, other, waiting, total, seen }. `items`: the Overview's
// allTabs(). A tab is counted once: working (its turn runs), background (statusOf says working behind a finished turn:
// `ci`, `review` or `other` by its sub-status), or blocked on the owner for less than BLOCKED_MAX_MS (`waiting`; since
// the tab's changed_at, else when it was first seen blocked, kept in `seen`). Everything else is not work.
export function classify(items, now, { windows = false, wsl = null, seen = {}, sub = subStatus, status = statusOf } = {}) {
  const out = { ...EMPTY, seen: {} };
  for (const { space, tab } of items) {
    if (!isLocal(space, { windows, wsl })) continue;
    if (tab.status === "blocked") {
      const first = seen[tab.id] ?? now;
      out.seen[tab.id] = first;
      const since = Number.isFinite(tab.changed_at) && tab.changed_at > 0 ? tab.changed_at : first;
      if (now - since < BLOCKED_MAX_MS) out.waiting++;
    } else if (tab.status === "working") out.working++;
    else if (status(tab, sub) === "working") {
      const key = sub(tab)?.key;
      if (key === "ci") out.ci++;
      else if (key === "review" || key === "reviewwait") out.review++;
      else out.other++;
    }
  }
  out.total = out.working + out.ci + out.review + out.other + out.waiting;
  return out;
}

// "3 agents working · 1 waiting for you · CI running": the counts, merged.
export function phrase(w) {
  const parts = [];
  if (w.working) parts.push(`${w.working} agent${w.working === 1 ? "" : "s"} working`);
  if (w.ci) parts.push("CI running");
  if (w.review) parts.push("review running");
  if (w.other) parts.push("background work");
  if (w.waiting) parts.push(`${w.waiting} waiting for you`);
  return parts.join(" · ");
}

// What the side bar's line says: { text, kind } or null (nothing to show: an older helper, or a computer that can't).
// kind: "on" | "grace" | "idle" | "off" | "error".
export function lineOf(st, on, now) {
  if (!on) return { text: "Stay awake: off", kind: "off" };
  const s = st ?? {};
  if (s.phase === "unsupported" || s.phase === "older") return null;
  if (s.phase === "error") return { text: `Can't keep awake: ${s.error ?? "the helper failed"}`, kind: "error" };
  if (s.work?.total > 0) return { text: `☕ Awake — ${phrase(s.work)}`, kind: "on" };
  const left = s.lastWork ? GRACE_MS - (now - s.lastWork) : 0;
  if (s.holding && left > 0) return { text: `☕ Awake — ${Math.ceil(left / 60_000)} min more`, kind: "grace" };
  return { text: "Sleep allowed", kind: "idle" };
}

// The helper's failure in a few words: one line, no path.
export const shortWhy = (m) => String(m ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "the helper failed";
// </awake-pure>

const put = (patch) => setShared(KEY_AWAKE, { ...(shared(KEY_AWAKE) ?? {}), ...patch });

// One look at the work and, when due, one helper call. Returns whether the line the side bar shows changed.
// `force` (the switch was just changed): runs even when another copy's tick is under way. Once per AWAKE_MS across
// every copy of the top bar. `now`: tests.
export async function awakeTick(now = Date.now(), { force = false } = {}) {
  const busy = shared(KEY_BUSY);
  if (!force && busy && now - busy < BUSY_MS) return false;
  setShared(KEY_BUSY, now);
  const on = setting("stay_awake") === "on";
  const before = lineOf(shared(KEY_AWAKE), on, now)?.text;
  try { await step(now, on); }
  catch { /* the last state stays; the next tick looks again */ }
  finally { setShared(KEY_BUSY, null); }
  return lineOf(shared(KEY_AWAKE), on, now)?.text !== before;
}

async function step(now, on) {
  const st = { ...(shared(KEY_AWAKE) ?? {}) };
  if (!on) {
    // Off: let go at once, and forget the rest.
    if (st.holding) await release();
    setShared(KEY_AWAKE, { holding: false, work: null, lastWork: null, seen: {}, phase: null });
    return;
  }
  const w = withSnapshot(() => classify(allTabs(), now, { windows: localWindows(), wsl: claudeMachine(), seen: st.seen ?? {} }));
  st.work = w;
  st.seen = w.seen;
  if (w.total > 0) st.lastWork = now;
  const active = w.total > 0 || (Boolean(st.lastWork) && now - st.lastWork < GRACE_MS);
  if (active) {
    const waitingOut = st.retryAt && now < st.retryAt;
    const fresh = st.holding && st.renewedAt && now - st.renewedAt < RENEW_MS - 500;
    if (!waitingOut && !fresh) Object.assign(st, await renew(now));
  } else if (st.holding) {
    await release();
    st.holding = false;
  }
  setShared(KEY_AWAKE, st);
}

// Asks the helper to hold for HOLD_SECS: the state's new fields.
async function renew(now) {
  const quiet = (phase) => { sidecar.forgetCommands(); return { holding: false, phase, error: null, retryAt: now + BACKOFF_MS }; };
  // An older helper has no `awake`: nothing to say (asked again after the back-off, in case it was updated).
  if (!(await sidecar.hasCommand("awake"))) return quiet("older");
  const r = await sidecar.call("awake", ["--for", String(HOLD_SECS)]);
  if (r.error) {
    if (r.error.code === "no-sidecar" || r.error.code === "protocol") return quiet("older");
    return { phase: "error", error: shortWhy(r.error.message), retryAt: now + BACKOFF_MS };
  }
  const line = r.lines.find((l) => l.type === "awake");
  if (line?.state === "unsupported") return { holding: false, phase: "unsupported", error: null, retryAt: now + BACKOFF_MS };
  if (line?.state === "holding") return { holding: true, renewedAt: now, phase: "ok", error: null, retryAt: null };
  return { phase: "error", error: "the helper gave no answer", retryAt: now + BACKOFF_MS };
}

async function release() {
  try { await sidecar.call("awake", ["--release"]); } catch { /* it ends by itself within HOLD_SECS */ }
}

// For the top bar: the tick now and every AWAKE_MS; redraws that view when the line changed.
export function startAwake(cx) {
  const go = (c) => c.spawn(async (c2) => { if (await awakeTick()) c2.notify(); });
  cx?.timer?.after?.(3000, go);
  cx?.timer?.every?.(AWAKE_MS, go);
}

// The words the side bar's line shows now (null: no line), for a copy of the side bar to see when to redraw.
export const awakeText = (now = Date.now()) => lineOf(shared(KEY_AWAKE), setting("stay_awake") === "on", now)?.text ?? null;

// The switch, from the settings dialog or a click on the line: saved, and acted on at once (off: released now).
export async function setStayAwake(value) {
  const ok = await setSetting("stay_awake", value);
  if (ok) await awakeTick(Date.now(), { force: true });
  return ok;
}

// ---- drawing ----
// The side bar's line, or null. Reads the one shared key through snapShared; no host or helper call. A click turns the
// switch the other way.
export function awakeBlock(t, now = Date.now()) {
  const on = setting("stay_awake") === "on";
  const l = lineOf(snapShared(KEY_AWAKE), on, now);
  if (!l) return null;
  const colour = l.kind === "on" || l.kind === "grace" ? t.foreground : l.kind === "error" ? t.blocked : t.dim;
  const tip = on
    ? "Keeps this computer from going to sleep on its own while agents here work. The screen can still turn off, and closing the lid still sleeps it. Click to turn off."
    : "Stay awake while agents work is off: this computer may sleep and stop them. Click to turn on.";
  return h_flex().id("awake").flex_none().min_w(0).items_center().mt(8).px(10).h(22).rounded(6).cursor_pointer().tooltip(tip)
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.spawn(async (c2) => { await setStayAwake(on ? "off" : "on"); c2.notify(); }); })
    .child(div().id("awake-text").flex_1().min_w(0).truncate().text_size(12).text_color(colour).child(l.text));
}
