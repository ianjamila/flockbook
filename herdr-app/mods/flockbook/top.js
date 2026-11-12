// The "top" view: the sidebar button, a capsule with one tab per tab of the shown space (or, while the tab
// list on the right shows, just the shown tab's name), a capsule with "+", the terminal button and the
// tab list's button.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, window, settings, openOverlay, run, setAgentOrder, nextCommand, shared, setShared, props } from "herdr";
import { openMenu, tabItems, openMoveMenu } from "./menu.js";
import { spaceAgents, spaceTabs, activeTab, currentAgent, currentTerminal, tabLabel, plainLabel, sessionTitle, subStatus, withAsk, keepOrRename, screenFor, showTab, closeTab, openTerminal, showNeeds, icon, tabAgents, shownScreen,
  SPIN_MS, FADE, sidebarShown, toggleSidebar, loadSidebar, showScreen, showOverview, showSettings, watchEdge, noteWindowHeight, applyTermRect, agentName, tabStatus, tablistShown, toggleTablist, watchGrace } from "./state.js";
import { loadConfig, pollUpdate, updateDot, stepTextSize } from "./config.js";
import { checkHelperPatch } from "./patchcheck.js";
import { asksTick, TICK_MS as ASKS_MS } from "./asks.js";
import { aboutTick, ABOUT_TICK_MS, requestRewrite, KEY_REDO, KEY_BUSY, lockFree } from "./ai.js";
import { historyTick, HISTORY_TICK_MS } from "./history.js";
import { resumeTick, RESUME_TICK_MS } from "./resume.js";
import { withHover } from "./hover.js";
import { dragger, dropPlace } from "./drag.js";
import { suggestTick, keepHere } from "./automove.js";
import { suggestBadge } from "./menu.js";
import { autoMoveTick, TICK_MS as AUTO_MOVE_MS, serveMoveRequest, KEY_REQUEST as MOVE_REQUEST, requestMove, movedBadge, badgeTip } from "./automove.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

// The status mark at the start of a tab: a spinner while working, a check when done, a dot when it
// waits for you, an empty ring otherwise (idle, or no agent).
export function statusMark(status, t) {
  if (status === "working") return svg(icon("spinner")).size(13).flex_none().text_color(t.working).spin(SPIN_MS);
  if (status === "done") return svg(icon("check")).size(13).flex_none().text_color(t.done);
  if (status === "blocked") return div().size(9).m(2).flex_none().rounded(5).bg(t.blocked);
  return div().size(12).m(0.5).flex_none().rounded(6).border(1.3).border_color(t.dim);
}

const SYNC_MS = 300;

// Room left of the bar for the macOS window buttons (no title bar), else a plain margin.
export function lightsRoom() {
  const root = layout(), w = window();
  return w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
    ? (root.traffic_lights[0] + 60) / (settings().zoom ?? 1) : 12;
}

export const BAR_H = 56;

// The tab being dragged (drag.js): one at a time, so every copy of the bar draws from it.
const drag = dragger("x");
export { dropPlace };

const KEY_CMD = "flockbook.command";   // the last key command and when, so two copies don't both act

// Keys bound to "flockbook.<command>" in keys.json.
export function command(c) {
  const tabs = spaceTabs(), tab = activeTab(), i = tabs.findIndex((x) => x.id === tab?.id);
  if (c === "terminal") return openTerminal(currentTerminal());
  // "term-rect:x,y,w,h": the terminal window to that box, as a drag on its edges leaves it (a test hook, and a key can use it).
  if (typeof c === "string" && c.startsWith("term-rect:")) {
    const [x, y, w, h] = c.slice(10).split(",").map(Number), a = currentTerminal();
    if (a && [x, y, w, h].every(Number.isFinite)) return applyTermRect({ x, y, w: Math.round(w), h: Math.round(h) }, a.address, agentName(a), true);
    return;
  }
  // The tab menu's "Move to …": "move-to:<terminal>:<space id>" (menu.js).
  if (typeof c === "string" && c.startsWith("move-to:")) { const [, address, space] = c.split(":"); return requestMove(address, space); }
  // "Keep it in <here>" for a wrong-workspace suggestion: "keep-here:<terminal>:<workspace name>" (menu.js).
  // "Rewrite About line" (hover link, tab menu): queued for the one-copy About tick (ai.js), which the timer below runs soon.
  if (typeof c === "string" && c.startsWith("about-redo:")) return requestRewrite(c.slice("about-redo:".length));
  if (typeof c === "string" && c.startsWith("keep-here:")) { const [, address, ...name] = c.split(":"); return keepHere(address, name.join(":")); }
  // ⌘⇧M: the tab menu's "Move to …" rows for the shown tab.
  if (c === "move-menu") return openMoveMenu(tab, tab ? tabAgents(tab.id)[0] ?? null : null);
  if (c === "needs") return showNeeds();
  if (c === "sidebar") return toggleSidebar();
  if (c === "tablist") return toggleTablist();
  if (c === "overview") return showOverview();
  if (c === "settings") return showSettings();
  // The shown tab, as a double-click on it: keep the session's topic as its name, or the rename box.
  if (c === "keep-name") return tab ? keepOrRename(tab) : undefined;
  if (c === "text-smaller" || c === "text-larger" || c === "text-default") return stepTextSize(c);
  if ((c === "move-left" || c === "move-right") && i >= 0) {
    const to = i + (c === "move-left" ? -1 : 1);
    if (to >= 0 && to < tabs.length) run("tab.move", { id: tab.id, index: tabs[to].index });
  }
}

// Each screen (chat, Needs you, Overview, the tab's terminals) draws the bar, so each runs its
// work: the key commands, the screen sync, the saved sidebar state. Should the app hand one key
// to every copy, the first acts and the others see it in KEY_CMD and skip it.
export function startTop(cx, owner) {
  owner.seen = undefined;
  cx?.timer?.every(SYNC_MS, () => syncScreen(owner));
  watchGrace(cx, owner);
  cx?.spawn?.(async (cx) => {
    for (;;) {
      const c = await nextCommand();
      const last = shared(KEY_CMD), at = Date.now();
      if (last && last.c === c && at - last.at < 150) continue;
      setShared(KEY_CMD, { c, at });
      command(c); cx.notify();
    }
  });
  cx?.spawn?.(async (cx) => { await loadSidebar(); cx.notify(); });
  // The settings file, read again each minute (someone may edit it), and the update check (pollUpdate
  // asks the helper at most once an hour).
  // Also: whether a Flockbook update put the official helper over the patched one (patchcheck.js, every 10 min).
  const settings = async (cx) => { await loadConfig(); await pollUpdate(); await checkHelperPatch(); cx.notify(); };
  cx?.spawn?.(settings);
  cx?.timer?.every(60_000, (cx) => cx.spawn(settings));
  // Asks at the end of a reply (extra review round, merge hand-off) for the Needs you page (asks.js; one copy per tick).
  cx?.timer?.every(ASKS_MS, (cx) => cx.spawn(async (cx) => { await asksTick(); cx.notify(); }));
  cx?.spawn?.(async (cx) => { await asksTick(); cx.notify(); });
  // The Overview's About lines (ai.js; Haiku, once per tab and title; one copy per tick).
  cx?.timer?.every(ABOUT_TICK_MS, (cx) => cx.spawn(async () => { await aboutTick(); }));
  cx?.timer?.after?.(8000, (cx) => cx.spawn(async () => { await aboutTick(); }));
  // A rewrite asked for: within 2 s, not at the next minute (the tick's lock keeps it to one run at a time).
  // Same lock test as the tick (s13: an expired lock left by a reload no longer blocks it for good).
  cx?.timer?.every(2000, (cx) => { if (Object.keys(shared(KEY_REDO) ?? {}).length && lockFree(shared(KEY_BUSY), Date.now())) cx.spawn(async () => { await aboutTick({ soon: true }); }); });
  // What changed in each tab, for the Overview's "Since you last looked" and Needs you's "waiting 2 h" (history.js;
  // free, no model call).
  cx?.timer?.every(HISTORY_TICK_MS, () => historyTick());
  // Each Claude tab's conversation, so a restart can offer them back on the Overview (resume.js; owner 11-12 s13).
  cx?.timer?.every(RESUME_TICK_MS, (cx) => cx.spawn(async (cx) => { await resumeTick(); cx.notify(); }));
  // Sessions in a "~" workspace that belong to a project move there (automove.js; one copy acts per tick).
  cx?.timer?.every(AUTO_MOVE_MS, (cx) => cx.spawn((cx) => autoMoveTick(cx)));
  // Tabs whose work belongs in another workspace: a badge and a menu row, never a move (automove.js suggestTick).
  cx?.timer?.every(AUTO_MOVE_MS, (cx) => cx.spawn(async (cx) => { await suggestTick(); cx.notify(); }));
  // The tab menu's "Move to …" (one copy takes it), and a redraw when a "moved here" badge comes or goes.
  cx?.timer?.every(400, (cx) => { if (shared(MOVE_REQUEST)) cx.spawn((cx) => serveMoveRequest(cx)); });
  cx?.timer?.every(15_000, (cx) => {
    const n = spaceTabs().filter((x) => movedBadge(tabAgents(x.id)[0]?.address)).length;
    if (n || owner.badges) cx.notify();
    owner.badges = n;
  });
}

// Keeps the screen right for the shown tab: the chat for an agent, the tab's terminals for a
// shell. It acts only when the tab changes or an agent starts or stops in it, so a choice
// made by hand (Needs you, the tab's terminals) stays until then.
export function syncScreen(owner) {
  const tab = activeTab();
  const now = tab ? `${tab.id}:${screenFor(tab)}` : null;
  if (now === owner.seen) return;
  owner.seen = now;
  if (!tab) return;
  // layout() is the file, not the live tree, so the shown screen is unknown: select it outright.
  showScreen(screenFor(tab));
}

// The bar: the sidebar button, the tab capsule, the tools capsule. `over`: drawn over a screen's
// content, so only the capsules and buttons have a background and the rest shows what scrolls
// under it.
export function topBar(t, over = false) {
  setAgentOrder(spaceAgents().map((a) => a.address));
  const tabs = spaceTabs();
  const cur = currentTerminal();  // the agent, else the tab's own terminal
  const side = sidebarShown();
  // While the sidebar is hidden, the sidebar button sits right of the window buttons; while it
  // shows, the button is in the sidebar (side.js) and the bar starts at its edge.
  const left = side ? 12 : lightsRoom();
  const stop = (_e, cx) => cx.stop_propagation();
  const button = (id, child, action, size = 28, tip = null) => div().id(id).when(Boolean(tip), (el) => el.tooltip(tip)).size(size).flex_none().flex().items_center().justify_center().rounded(size / 2)
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop).on_click(action).child(child);
  const capsule = (id) => h_flex().id(id).h(38).px(4).gap(2).items_center().flex_none().rounded(19)
    .bg(t.chrome).border(1).border_color(t.border).shadow_sm();

  const dragging = drag.shown;
  const lineOn = dragging && dropPlace(tabs, dragging) >= 0 ? dragging.target : null;

  const pill = (tab) => {
    const on = tab.active;
    const line = lineOn?.id === tab.id ? lineOn : null;
    // Long session titles truncate at 170px: hovering shows the whole one (named tabs too).
    // Background work (the tab-title hook's symbols): said in words under the title; a named tab, whose
    // label hides the session title, shows the symbols in front of its name.
    const ss = subStatus(tab);
    const label = tabLabel(tab);
    const shownLabel = ss && label === plainLabel(tab) ? `${ss.glyphs} ${label}` : withAsk(ss, label);
    const title = sessionTitle(tabAgents(tab.id)[0]);
    const full = ss ? `${title ?? label} — ${ss.tip}` : title;
    const moved = movedBadge(tabAgents(tab.id)[0]?.address);
    const agent = tabAgents(tab.id)[0] ?? null;
    // A shell tab keeps the plain label; an agent's tab gets the hover box (hover.js, s11).
    const el = h_flex().id(`tab-${tab.id}`).relative().when(Boolean(full) && !agent, (el) => el.tooltip(full)).h(30).pl(13).pr(on ? 6 : 14).gap(8).items_center().flex_none().rounded(15).text_size(13)
      .text_color(on ? t.foreground : t.muted)
      // The selected fill fades in and out instead of jumping between tabs.
      .child(div().id(`fill-${tab.id}`).absolute().inset_0().rounded(15).bg(t.selected).opacity(on ? 1 : 0).transition("opacity", FADE))
      .when(on, (el) => el.font_weight(600))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(dragging?.id === tab.id, (el) => el.opacity(0.45))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation?.(); drag.press(tab.id, e); })
      .on_mouse_move((e, cx) => { if (drag.over(tab.id, e)) cx.notify?.(); })
      // The release after a drag is not a click.
      // A double-click keeps the tab's current topic as its name (or renames a named tab).
      .on_click((e) => { if (drag.shown) return; if (e?.click_count === 2) keepOrRename(tab); else showTab(tab); })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation?.();
        const shown = drag.shown;
        drag.cancel(cx);
        if (shown) return;
        openMenu(tabItems(tab, { agent: tabAgents(tab.id)[0] ?? null, list: tabs })); })
      .when(Boolean(line), (el) => el.child(div().id("drop-line").absolute().top(2).bottom(2).w(3).rounded(2).bg(t.accent)
        .when(line.after, (l) => l.right(-3.5)).when(!line.after, (l) => l.left(-3.5))))
      .child(statusMark(tabStatus(tab), t))
      .child(div().max_w(170).truncate().child(shownLabel))
      // Moved here by the auto-mover in the last few minutes (automove.js).
      .when(Boolean(suggestBadge(tabAgents(tab.id)[0], t, `sg-${tab.id}`)), (el) => el.child(suggestBadge(tabAgents(tab.id)[0], t, `sg-${tab.id}`)))
      .when(Boolean(moved), (el) => el.child(div().id(`moved-${tab.id}`).flex_none().flex().items_center().text_color(t.accent)
        .tooltip(badgeTip(moved)).child(svg(icon("moved")).size(12))))
      .when(on, (el) => el.child(div().id(`close-${tab.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(9)
        .text_size(15).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); closeTab(tab.id); }).child("×")));
    if (!agent) return el;
    return withHover("pill", el, tab, t, { title: title ?? label, extra: [ss?.tip], always: true, anchor: "top_left", onOpen: () => showTab(tab) });
  };

  // The tab list on the right shows every tab (tabs.js): the bar then shows only the shown tab's name.
  const listed = tablistShown();
  const shownTab = tabs.find((x) => x.active);
  const named = listed && shownTab ? h_flex().id("tab-title").min_w(0).flex_shrink(1).gap(8).items_center().px(4).text_size(13).font_weight(600)
    .text_color(t.foreground).child(statusMark(tabStatus(shownTab), t)).child(div().min_w(0).truncate().child(withAsk(subStatus(shownTab), tabLabel(shownTab)))) : null;
  const strip = capsule("tabs").min_w(0).flex_shrink(1)
    .on_hover((inside, cx) => { if (!inside) drag.cancel(cx); })
    .on_mouse_down_out((_e, cx) => drag.cancel(cx))
    // On the whole capsule, not the pills' row: a release on its padding ends the press too.
    .on_mouse_up("left", (_e, cx) => {
      const d = drag.release(cx);
      if (!d) return;
      const to = dropPlace(tabs, d);
      if (to >= 0) run("tab.move", { id: d.id, index: tabs[to].index });
    })
    .child(tabs.length ? h_flex().id("tab-scroll").min_w(0).gap(4).items_center().overflow_x_scroll()
      .when(Boolean(dragging), (el) => el.cursor_grabbing())
      .children(tabs.map(pill))
      : div().px(12).text_size(12.5).text_color(t.muted).child("No tabs in this space"));
  const tools = capsule("tools").px(5).gap(4)
    .child(button("new", svg(icon("plus")).size(15), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), 30, "New tab (⌘T)"))
    .when(Boolean(cur), (el) => el.child(button("terminal", svg(icon("terminal")).size(16), () => openTerminal(cur), 30, currentAgent() ? "Agent's terminal (⌃`)" : "Terminal (⌃`)")))
    .child(button("tablist", svg(icon("tablist")).size(16), () => toggleTablist(), 30, listed ? "Hide the tab list (⌥⌘B)" : "Show the tab list (⌥⌘B)")
      .when(listed, (b) => b.text_color(t.foreground)));

  // The right padding matches the left, so the capsules stay centred. The sidebar button gets a
  // round backing when drawn over content, like the capsules.
  return watchEdge(h_flex().id("top-root").w_full().h(BAR_H).min_w(0)).pl(left).pr(left + (side ? 0 : 36)).gap(8).items_center()
    .when(!over, (el) => el.bg(t.background))
    // A newer Flockbook while the sidebar is hidden: a small dot on its button, until it opens or Not now.
    .when(!side, (el) => el.child(button("sidebar", svg(icon("sidebar")).size(16), () => toggleSidebar(), 28, "Sidebar (⌘B)")
      .relative().when(updateDot(), (b) => b.child(div().id("update-dot").absolute().top(4).right(4).size(7).rounded(4).bg(t.accent)))
      .when(over, (b) => b.bg(t.chrome).border(1).border_color(t.border))))
    .child(h_flex().flex_1().min_w(0).justify_center().gap(10).child(listed ? named ?? div() : strip).child(tools));
}

// Puts the bar over a screen's content (absolute, at the top).
export const overBar = (t) => div().id("over-bar").absolute().top(0).left(0).right(0).h(BAR_H).child(topBar(t, true));

// Where a screen's bar is. By default the screen draws it over its content (overBar) and its block has
// window_drag, so the bar moves the window; but then a press on the content moves the window too, and
// text in it cannot be selected. With `props.bar: "outside"` the layout puts a "top" block (window_drag)
// above the screen's block (no window_drag): the screen draws no bar, leaves no room for one and runs no
// bar work (the "top" block's copy does), and its text can be selected. Read once, in the constructor:
// a block's props never change for a running copy.
export const barOver = () => props()?.bar !== "outside";
export const barRoom = (over) => (over ? BAR_H : 0);
// The window height, for the floating sidebar: with the bar outside, the screen is BAR_H shorter.
export const noteScreenHeight = (size, over) => noteWindowHeight({ height: (size?.height ?? 0) + BAR_H - barRoom(over) });

export class TopView {
  constructor(cx) { startTop(cx, this); }
  sync() { syncScreen(this); }
  command(c) { command(c); }
  render(_cx) { return topBar(theme()); }
}
