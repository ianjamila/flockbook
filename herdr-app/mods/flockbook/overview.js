// The "overview" view: every tab of every space as a card, grouped by status or by space.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { withHover } from "./hover.js";
import { theme, shared, setShared, home, notify } from "herdr";
import { spaces, agents } from "./parked.js";
import { tabLabel, plainLabel, subStatus, SUB_GROUPS, tabAgents, agentName, openTab, showNeeds, needing, icon, FADE, watchEdge, noteWindowHeight } from "./state.js";
import { openMenu, tabItems, suggestBadge } from "./menu.js";
import { movedBadge, badgeTip } from "./automove.js";
import { askOf, nowOf, handoffOf } from "./asks.js";
import * as sidecar from "./sidecar.js";
import { emptyFeed, applyFeed } from "./feedstate.js";
import { replyPrompt } from "./blocks.js";
import { aboutOf, aboutMore, cooledAccounts, agentsOn, accountName, clockText, localOffset, autoPausedUntil, resumeAuto } from "./ai.js";
import { sinceView, copyText, markSeen } from "./history.js";
import { offer, resumeOne, resumeAll, dismissOffer, opening } from "./resume.js";
import { statusMark, startTop, overBar, barOver, barRoom, noteScreenHeight } from "./top.js";

export const KEY_GROUP = "flockbook.overview.group";   // "status" | "space"
const CARD_MIN = 300, GAP = 12, MAX_W = 1220;

export function greeting(hour) {
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// "now", "13m", "5h", "2d" since `ms`; "" when unknown.
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// A card's time, said with what it times: "working 13m", "waiting 5m", "done 2h ago", "idle 1d";
// "" when unknown.
export function since(tab, now = Date.now()) {
  const st = tab.status;
  const d = ago(st === "working" ? tab.working_since ?? tab.changed_at : tab.changed_at, now);
  if (!d) return "";
  if (st === "working") return d === "now" ? "just started" : `working ${d}`;
  if (st === "blocked") return d === "now" ? "waiting now" : `waiting ${d}`;
  if (st === "done") return d === "now" ? "just done" : `done ${d} ago`;
  if (st === "idle") return d === "now" ? "idle now" : `idle ${d}`;
  return d;  // no agent: just the time, as before
}

// Every tab that is not put away, with its space.
export function allTabs() {
  return spaces().flatMap((s) => (s.tabs ?? []).filter((t) => !t.settled).map((tab) => ({ space: s, tab })));
}

// Grouped by status, the Overview leaves out the tabs that wait on the owner's answer (the sidebar's
// "Needs you" page lists them; the summary line links to it). The tabs at the end of a piece of work (the
// tab-title hook's 🔀 ✅ ⏳ 🔍 and review dots: merging, final review, CI) get a section of their own, right after
// Working (owner's order) while that work runs (✅ / answered 🔀 only until the turn ends: inPipeline); the rest go by status, sub-grouped by background work (build agents).
export const PIPELINE = ["merge", "merging", "results", "ci", "reviewwait", "review"];
// A question or approval, or an extra review round its reply asks for (asks.js): the Needs you page has them.
// Every ask but the merge hand-off (that one keeps its "Ready to merge" spot here).
export const waitsOnAnswer = (tab) => tab.status === "blocked" || tabAgents(tab.id).some((a) => { const k = askOf(a.address)?.kind; return Boolean(k) && k !== "merge"; });
// ✅ (results to read) and a 🔀 left after the hand-off was answered ("merging") say what the title says, not
// that work runs: once the turn has finished (nothing running behind it) the tab goes by its status — Done or
// Resting — under its sub-group. Owner 11-12: a finished, handed-off session belongs in Done, not "CI / …".
const UNTIL_FINISHED = ["merging", "results"];
const inPipeline = (tab, sub) => {
  const k = sub(tab)?.key;
  return PIPELINE.includes(k) && !(UNTIL_FINISHED.includes(k) && statusOf(tab, sub) !== "working");
};
// A finished turn with a shell or agent still running behind it counts as working (subStatus().background).
export const statusOf = (tab, sub = subStatus) => (tab.status !== "blocked" && sub(tab)?.background ? "working" : tab.status);
const STATUS_GROUPS = [
  ["Working", (tab, sub) => !waitsOnAnswer(tab) && !inPipeline(tab, sub) && statusOf(tab, sub) === "working"],
  ["CI / Final Review / Merging", (tab, sub) => !waitsOnAnswer(tab) && inPipeline(tab, sub)],
  ["Done", (tab, sub) => !waitsOnAnswer(tab) && !inPipeline(tab, sub) && statusOf(tab, sub) === "done"],
  ["Resting", (tab, sub) => !waitsOnAnswer(tab) && !inPipeline(tab, sub) && !["working", "done"].includes(statusOf(tab, sub))],
];

// Inside a status group, the tabs with background work (the tab-title hook's symbols) go under
// sub-groups in SUB_GROUPS order: [{ key, title, items }], the plain tabs last as "Other". No
// background work in the group: one sub-group without a title. `sub(tab)` is subStatus.
export function subGroups(items, sub = subStatus) {
  const keyed = items.map((it) => ({ it, key: sub(it.tab)?.key ?? null }));
  if (!keyed.some((k) => k.key)) return [{ key: null, title: "", items }];
  const out = SUB_GROUPS.map(([key, title]) => ({ key, title, items: keyed.filter((k) => k.key === key).map((k) => k.it) }));
  out.push({ key: null, title: "Other", items: keyed.filter((k) => !k.key || !SUB_GROUPS.some(([g]) => g === k.key)).map((k) => k.it) });
  return out.filter((g) => g.items.length);
}

// The sections to show: [{ title, items, subs }], empty ones left out; by workspace every tab, no sub-groups.
export function groups(items, by, sub = subStatus) {
  if (by === "space") {
    const out = new Map();
    for (const it of items) {
      if (!out.has(it.space.id)) out.set(it.space.id, { title: it.space.name, items: [] });
      out.get(it.space.id).items.push(it);
    }
    return [...out.values()];
  }
  return STATUS_GROUPS.map(([title, test]) => ({ title, items: items.filter((it) => test(it.tab, sub)) }))
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, waiting: waitingOn(g.items, sub), subs: subGroups(g.items, sub).map((sg) => ({ ...sg, waiting: waitingOn(sg.items, sub) })) }));
}

// How many of these tabs wait on the owner: a merge hand-off (🔀 at the reply's end) or review results to read (✅).
export const waitingOn = (items, sub = subStatus) => items.filter((it) => sub(it.tab)?.owner).length;
// The heading's "N waiting on you" (a section) or "N waiting" (a sub-group), or null. A sub-group whose every tab
// waits ("Ready to merge", "Review results waiting") says it in its title already: its count is tinted instead.
export function waitingLabel(g, sub) {
  if (!(g.waiting > 0)) return null;
  if (!sub) return `${g.waiting} waiting on you`;
  return g.waiting < g.items.length ? `${g.waiting} waiting` : null;
}

export class OverviewView {
  constructor(cx) {
    this.width = 900;
    this.barOver = barOver();
    this.top = {}; if (this.barOver) startTop(cx, this.top);
    // The "13m" labels age; redraw twice a minute.
    cx?.timer?.every?.(30000, (cx) => cx.notify());
  }

  // "Copy re-entry prompt" (s19, owner yes): a hand-off tab's prompt without opening the tab. Its newest reply is read
  // through the helper (the chat's own feed call) and the prompt found the way the chat's Copy all finds it
  // (blocks.js replyPrompt). Nothing found: a notice saying so (the chat still has the reply).
  async copyHandoff(cx, address) {
    if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't copy: no clipboard here. Open the tab and use Copy all.", level: "warning", timeout: 3000 }); return; }
    if (this.copying) return;
    this.copying = address; cx.notify?.();
    let prompt = null, problem = null;
    try {
      const f = emptyFeed(address);
      applyFeed(f, await sidecar.feed(address));
      if (f.error) problem = f.error.message || "the helper could not read its chat";
      else prompt = replyPrompt(f.rows);
    } catch (e) { problem = String(e?.message ?? e); } finally { this.copying = null; }
    if (!prompt) {
      notify({ title: problem ? `Couldn't read its chat: ${problem}` : "No re-entry prompt in its last reply. Open the tab to see it.", level: "warning", timeout: 4000 });
    } else {
      cx.write_to_clipboard(prompt);
      notify({ title: "Re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
      this.copiedHandoff = address;
      cx.timer?.after?.(2000, (cx2) => { if (this.copiedHandoff === address) { this.copiedHandoff = null; cx2?.notify?.(); } });
    }
    cx.notify?.();
  }
  // The small button on a hand-off card (a click on it does not open the tab, as the card's own click does).
  copyButton(id, address, t) {
    const busy = this.copying === address, done = this.copiedHandoff === address;
    return div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(6).text_size(11.5)
      .bg(t.chrome).border(1).border_color(t.border).text_color(done ? t.done : t.foreground)
      .tooltip("Copy its re-entry prompt (from its last reply) without opening the tab")
      .when(!busy, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation?.(); if (!busy) cx.spawn((cx2) => this.copyHandoff(cx2, address)); })
      .child(busy ? "Copying…" : done ? "Copied" : "Copy prompt");
  }

  card(it, t, w) {
    const { space, tab } = it;
    const a = tabAgents(tab.id)[0];
    const sub = [space.name, a ? agentName(a) : null].filter(Boolean).filter((x, i, l) => l.indexOf(x) === i && x !== tabLabel(tab)).join(" · ");
    const when = since(tab);
    const moved = movedBadge(a?.address);
    // Background work (the tab-title hook's symbols): a line of its own, the title without them.
    const ss = subStatus(tab);
    // What it works on, in plain words (owner 11-12): "Now: …" while working, "Last: …" after; the hover tells the story.
    const nw = nowOf(a?.address), about = aboutOf(a?.address);
    const card = h_flex().id(`ov-${tab.id}`).w(w).max_w_full().h(64 + (this.tall ? 20 : 0) + (this.tallAbout ? 20 : 0)).px(16).gap(12).items_center().flex_none().rounded(12)
      .bg(t.raised).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click(() => openTab(space.id, tab))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openMenu(tabItems(tab, { agent: a ?? null, spaceId: space.id, list: (space.tabs ?? []).filter((x) => !x.settled) })); })
      .child(h_flex().size(20).flex_none().items_center().justify_center().child(statusMark(tab.status, t)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(ss ? plainLabel(tab) : tabLabel(tab)))
          .when(Boolean(moved), (el) => el.child(h_flex().id(`ov-moved-${tab.id}`).flex_none().gap(4).items_center().text_size(11.5).text_color(t.accent)
            .tooltip(badgeTip(moved)).child(svg(icon("moved")).size(11)).child("moved here")))
          .when(Boolean(suggestBadge(a, t, `ov-sg-${tab.id}`)), (el) => el.child(suggestBadge(a, t, `ov-sg-${tab.id}`)))
          .when(ss?.key === "handoff" && Boolean(a?.address), (el) => el.child(this.copyButton(`ov-copy-${tab.id}`, a.address, t)))
          .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child(when)))
          // The hover box opens from this ⓘ only (owner 11-12: opening on the whole card covered the cards below it,
          // so the next card could not be clicked). A click on it opens the tab, as the card does.
          .when(Boolean(about || nw), (el) => el.child(withHover("ov", div().id(`ov-info-${tab.id}`).flex_none().size(18).flex().items_center()
            .justify_center().rounded(9).text_size(13).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child("ⓘ"),
            tab, t, { anchor: "top_right", onOpen: () => openTab(space.id, tab) }))))
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(Boolean(ss), (el) => el.child(div().id(`ov-sub-${tab.id}`).flex_none().max_w_full().truncate().text_size(12)
            .text_color(ss.owner ? t.foreground : t.muted).tooltip(ss.tip).child(ss.hint)))
          .when(!ss || Boolean(sub), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
            .child(ss ? `· ${sub}` : (sub || " ")))))
        // What the work is for (ai.js, Haiku): above the Now line.
        .when(Boolean(about), (el) => el.child(div().id(`ov-about-${tab.id}`).w_full().truncate().text_size(12).text_color(t.foreground)
          .child(`About: ${about}`)))
        .when(Boolean(nw), (el) => el.child(div().id(`ov-now-${tab.id}`).w_full().truncate().text_size(12).text_color(t.foreground).opacity(0.85)
          .child(`${tab.status === "working" || nw.helpers.length ? "Now" : "Last"}: ${nw.now}`))));
    // The hover (hover.js): what it's about, needs you, now, steps, helpers, freshness, Summarize / Rewrite.
    return card;
  }

  // One line per Claude account that ran out of usage or needs signing in (ai.js KEY_COOL; Q2 + Fable 11-12): when it
  // comes back and which tabs run as it (they are likely paused too). Not repeated on each card.
  pauseBanners(t) {
    const now = Date.now();
    return cooledAccounts().map((c) => {
      const tabs = agentsOn(c.account).map((a) => agentName(a));
      const what = c.kind === "auth" ? `${accountName(c.account)} needs signing in again (claude auth login)`
        : `${accountName(c.account)} is out of its Claude usage until ${clockText(c.until, now, localOffset())}`;
      const on = tabs.length ? ` ${tabs.length === 1 ? "Its tab is" : `Its ${tabs.length} tabs are`} likely paused too: ${tabs.join(", ")}.` : "";
      return h_flex().id(`ov-pause-${c.account}`).w_full().gap(10).items_start().px(14).py(10).rounded(10)
        .bg(t.raised).border(1).border_color(t.blocked)
        .child(div().flex_none().text_size(13).child("⏸"))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(12.5).line_height("18px").text_color(t.foreground)
          .child(`${what}. Its About lines wait until then.${on}`));
    });
  }

  // "Since you last looked" (history.js; s13 item 8, redesigned 11-13 for the owner's "hard to read … organized
  // better"): the tabs that changed after the last "Mark seen" (or since midnight), grouped by what they do now
  // (Waiting on you first). A tab is a small card: name, account, how long since its last change, what it does now,
  // its About line, and its changes as time chips. A click on an open tab's card opens it. Every group starts folded (owner 11-13: "collapse this by default"); a
  // group's heading opens or folds it, Expand all / Collapse all do every group.
  // Copy puts the same layout on the clipboard as text (copyText); Mark seen clears the strip.
  sinceStrip(t) {
    const v = sinceView();
    if (!v.groups.length) return [];
    const now = Date.now();
    const copied = this.copiedAt && now - this.copiedAt < 3000;
    this.sinceOpen ??= new Set();
    const btn = (id, label, on) => div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(12)
      .bg(t.chrome).border(1).border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(on).child(label);
    const tint = { needs: t.blocked, busy: t.accent, working: t.working, finished: t.done, closed: t.dim };
    const copy = (_e, cx) => {
      if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't copy: no clipboard here.", level: "warning", timeout: 3000 }); return; }
      cx.write_to_clipboard(copyText(v)); this.copiedAt = Date.now();
      notify({ title: "Copied what changed to the clipboard", level: "info", timeout: 2000 });
      cx.notify();
    };
    const tabFor = (addr) => {
      const ag = agents().find((x) => x.address === addr);
      if (!ag?.tab) return null;
      for (const sp of spaces()) { const tab = (sp.tabs ?? []).find((x) => x.id === ag.tab); if (tab) return { space: sp, tab }; }
      return null;
    };
    const chip = (id, e) => h_flex().id(id).flex_none().gap(5).items_center().px(7).py(1).rounded(6).bg(t.chrome).text_size(11.5)
      .child(div().text_color(t.dim).child(e.when))
      .child(div().text_color(e.kind === "needs" ? t.blocked : e.kind === "pr" ? t.done : t.foreground).child(e.text));
    const item = (g, it, i) => {
      const id = `ov-since-${g.key}-${i}`;
      const open = g.key === "closed" ? null : tabFor(it.addr);
      return v_flex().id(id).w_full().gap(4).px(10).py(8).rounded(8)
        .when(Boolean(open), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Open this tab").on_click(() => openTab(open.space.id, open.tab)))
        .child(h_flex().w_full().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(g.key === "closed" ? t.muted : t.foreground).child(it.label))
          .when(Boolean(it.account), (el) => el.child(div().id(`${id}-acct`).flex_none().px(5).rounded(4).border(1).border_color(t.border)
            .text_size(10.5).text_color(t.muted).tooltip(accountName(it.account)).child(it.account)))
          .when(Boolean(open) && handoffOf(it.addr), (el) => el.child(this.copyButton(`${id}-copy`, it.addr, t)))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(it.at, now) === "now" ? "just now" : `${ago(it.at, now)} ago`)))
        .child(div().w_full().whitespace_normal().text_size(12).text_color(tint[g.key]).child(it.now))
        .when(Boolean(it.about), (el) => el.child(div().id(`${id}-about`).w_full().whitespace_normal().text_size(12).line_height("17px")
          .text_color(t.muted).tooltip("About: written by Haiku from the tab's screen").child(it.about)))
        .when(it.events.length > 0, (el) => el.child(h_flex().w_full().flex_wrap().gap(4).items_center()
          .when(it.more > 0, (r) => r.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${it.more} earlier`)))
          .children(it.events.map((e, k) => chip(`${id}-e${k}`, e)))));
    };
    const group = (g) => {
      const shown = this.sinceOpen.has(g.key);
      return v_flex().id(`ov-since-g-${g.key}`).w_full().gap(2)
        .child(h_flex().id(`ov-since-h-${g.key}`).gap(6).items_center().pt(6).pb(2).cursor_pointer()
          .on_click((_e, cx) => { if (shown) this.sinceOpen.delete(g.key); else this.sinceOpen.add(g.key); cx.notify(); })
          .child(div().size(7).rounded(4).bg(tint[g.key]))
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(g.title.toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(`${g.items.length} ${shown ? "▾" : "▸"}`)))
        .when(shown, (el) => el.children(g.items.map((it, i) => item(g, it, i))));
    };
    return [v_flex().id("ov-since").w_full().gap(4).px(14).py(10).rounded(10).bg(t.raised).border(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(v.header))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${v.count} ${v.count === 1 ? "tab" : "tabs"} changed${v.note ? ` · ${v.note}` : ""}`)))
        .child(btn("ov-since-expand", "Expand all", (_e, cx) => { this.sinceOpen = new Set(v.groups.map((g) => g.key)); cx.notify(); }))
        .child(btn("ov-since-collapse", "Collapse all", (_e, cx) => { this.sinceOpen = new Set(); cx.notify(); }))
        .child(btn("ov-since-copy", copied ? "Copied" : "Copy", (_e, cx) => copy(_e, cx)))
        .child(btn("ov-since-seen", "Mark seen", (_e, cx) => { markSeen(); cx.notify(); })))
      .children(v.groups.map(group))];
  }

  // Claude sessions open before a restart (resume.js, owner 11-12 s13): Resume all / Dismiss, and a Resume per row.
  resumeBanner(t) {
    const o = offer();
    if (!o) return [];
    const n = o.tabs.length, now = Date.now(), h = home();
    const link = (id, label, on) => div().id(id).flex_none().text_size(12.5).text_color(t.accent).hover((s) => s.opacity(0.8)).on_click((_e, cx) => { on(); cx.notify(); }).child(label);
    // A row a click is opening (its claim is fresh): "Opening…", nothing to press, until it opens or the claim ends.
    const busy = (id) => div().id(id).flex_none().text_size(12.5).text_color(t.muted).child("Opening…");
    const allOpening = o.tabs.every((x) => opening(x, now));
    const where = (cwd) => { const c = String(cwd ?? ""); return h && (c === h || c.startsWith(`${h}/`)) ? `~${c.slice(h.length)}` : c; };
    return [v_flex().id("ov-resume").w_full().gap(6).px(14).py(10).rounded(10).bg(t.raised).border(1).border_color(t.accent)
      .child(h_flex().gap(12).items_center()
        .child(div().flex_none().text_size(13).child("↻"))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child(`${n} Claude ${n === 1 ? "session was" : "sessions were"} open before the restart`))
        .child(allOpening ? busy("ov-resume-all") : link("ov-resume-all", n === 1 ? "Resume" : "Resume all", () => resumeAll()))
        .child(link("ov-resume-dismiss", "Dismiss", () => dismissOffer())))
      .children(o.tabs.map((x) => h_flex().id(`ov-resume-${x.sid}`).gap(10).items_center().pl(25)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground)
          .child(`${x.name || x.title || "Untitled session"} · ${x.spaceName ?? "?"} · ${where(x.cwd)} · ${accountName(x.account)}`))
        .when(n > 1, (el) => el.child(opening(x, now) ? busy(`ov-resume-one-${x.sid}`) : link(`ov-resume-one-${x.sid}`, "Resume", () => resumeOne(x.sid))))))];
  }

  // Automatic About lines paused until tomorrow (Settings, s13 F6): one line with "Resume".
  autoPauseLine(t) {
    const until = autoPausedUntil();
    if (!until) return [];
    return [h_flex().id("ov-autopause").w_full().gap(10).items_center().px(14).py(8).rounded(10).bg(t.raised).border(1).border_color(t.border)
      .child(div().flex_none().text_size(13).child("⏸"))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(`Automatic About lines are paused until ${clockText(until, Date.now(), localOffset())}. Rewrite and Summarize still work.`))
      .child(div().id("ov-autopause-resume").flex_none().text_size(12.5).text_color(t.accent).hover((s) => s.opacity(0.8)).on_click((_e, cx) => { resumeAuto(); cx.notify(); }).child("Resume"))];
  }

  segmented(t, by) {
    const opt = (key, label) => div().id(`group-${key}`).h(26).px(12).flex().items_center().rounded(7).text_size(12.5)
      .text_color(by === key ? t.foreground : t.muted).when(by === key, (el) => el.bg(t.selected))
      .when(by !== key, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { setShared(KEY_GROUP, key); cx.notify(); }).child(label);
    return h_flex().gap(8).items_center()
      .child(div().text_size(12.5).text_color(t.muted).child("Group by"))
      .child(h_flex().p(2).gap(2).rounded(9).bg(t.chrome).border(1).border_color(t.border)
        .child(opt("status", "Status")).child(opt("space", "Workspace")));
  }

  render(_cx) {
    const t = theme();
    const by = shared(KEY_GROUP) ?? "status";
    const items = allTabs();
    // One card height for all: the taller one when any card has a "Now" line.
    this.tall = items.some((it) => nowOf(tabAgents(it.tab.id)[0]?.address));
    this.tallAbout = items.some((it) => aboutOf(tabAgents(it.tab.id)[0]?.address));
    const working = items.filter((it) => statusOf(it.tab) === "working").length;
    // The Needs you page's count (questions, extra rounds, merges), which the link opens.
    const waiting = needing().length;
    const merging = items.filter((it) => subStatus(it.tab)?.key === "merge").length;
    const inner = Math.min(MAX_W, this.width - 64);
    const cols = Math.max(1, Math.min(3, Math.floor((inner + GAP) / (CARD_MIN + GAP))));
    const w = Math.floor((inner - GAP * (cols - 1)) / cols);

    const cards = (list) => h_flex().flex_wrap().gap(GAP).children(list.map((it) => this.card(it, t, w)));
    // A sub-group: a small heading with its count, then its cards. One without a title is the whole group.
    // How many wait on you (a 🔀 hand-off or ✅ results): after the count, in the accent colour.
    const waitTag = (id, label) => div().id(id).text_color(t.accent).font_semibold().child(`· ${label}`)
      .tooltip("Waiting on you: a merge hand-off (🔀) or review results to read (✅)");
    const subSection = (g, sg) => {
      if (!sg.title) return cards(sg.items);
      const label = waitingLabel(sg, true), all = sg.waiting > 0 && sg.waiting === sg.items.length;
      return v_flex().id(`sub-${g.title}-${sg.key ?? "other"}`).gap(8)
        .child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
          .child(div().font_semibold().child(sg.title))
          .child(div().text_color(all ? t.accent : t.dim).child(String(sg.items.length)))
          .when(Boolean(label), (el) => el.child(waitTag(`sub-wait-${g.title}-${sg.key ?? "other"}`, label))))
        .child(cards(sg.items));
    };
    const section = (g) => v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(g.title))
        .child(div().text_size(12).text_color(t.dim).child(String(g.items.length)))
        .when(Boolean(waitingLabel(g, false)), (el) => el.child(div().text_size(12).child(waitTag(`wait-${g.title}`, waitingLabel(g, false))))))
      .when(!g.subs, (el) => el.child(cards(g.items)))
      .when(Boolean(g.subs), (el) => el.child(v_flex().gap(14).children(g.subs.map((sg) => subSection(g, sg)))));

    // Sized from the last measured width, but never wider than the room it has: a stale width
    // (the window shrank while the overview was not shown) used to spill the page off both sides.
    // Normally the same as before: `inner` wide with 32 px each side.
    const body = v_flex().w(inner + 64).max_w_full().px(32).gap(28).pt(barRoom(this.barOver) + 20).pb(48)
      .child(h_flex().items_start()
        .child(v_flex().flex_1().gap(4)
          .child(div().text_size(26).font_semibold().text_color(t.foreground).child(greeting(new Date().getHours())))
          .child(div().text_size(13.5).text_color(t.muted)
            // "N need you" opens the Needs you page (those tabs are not in the sections below).
            .child(h_flex().gap(0).items_center().flex_wrap()
              .child(`${items.length} ${items.length === 1 ? "tab" : "tabs"} · ${working} working · `)
              .child(div().id("ov-need-you").when(waiting > 0, (el) => el.text_color(t.foreground).hover((s) => s.underline()).on_click(() => showNeeds()))
                .child(`${waiting} need you`))
              .when(merging > 0, (el) => el.child(` · ${merging} ready to merge`)))))
        .child(this.segmented(t, by)))
      .children(this.resumeBanner(t))
      .children(this.sinceStrip(t))
      .children(this.pauseBanners(t))
      .children(this.autoPauseLine(t))
      .children(items.length ? groups(items, by).map(section)
        : [div().pt(40).text_size(13).text_color(t.muted).child("No tabs yet. Start one with +.")]);

    return watchEdge(v_flex().id("overview").size_full().bg(t.background))
      
      .on_size_change((size, cx) => { noteScreenHeight(size, this.barOver); if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .relative()
      .child(v_flex().id("overview-scroll").size_full().items_center().overflow_y_scrollbar()
        .when(this.barOver, (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())).child(body))
      .when(this.barOver, (el) => el.child(overBar(t)));
  }
}
