// The "tabs" view: the shown space's tabs as a list down the right of the window, like VS Code's terminal
// list, so every tab stays in sight however many there are (the top bar's strip scrolls them out of view).
// Two blocks in the layout's "tablist" column: props.part "head" (the space's name, the count, New tab and
// Hide; window_drag like the top bar) and "list" (one row per tab). Per row: the program's icon, the status
// mark, the tab's name (background work in words on a second line), then a bell when the session waits for you, the "moved here" badge, and × on the
// shown tab (else a faint ⌘1–⌘9 hint). The shown tab scrolls into sight. Click shows the tab, a double-click keeps its topic as its name (or renames), right-click is
// the tab menu, and press-and-drag reorders. While the list shows, the top bar hides its own strip.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { theme, run, openOverlay, props } from "herdr";
import { spaces } from "./parked.js";
import { openMenu, tabItems, suggestBadge } from "./menu.js";
import { watchGrace, spaceTabs, tabAgents, tabLabel, sessionTitle, subStatus, tabStatus, needReason, keepOrRename, showTab, closeTab, icon, toggleTablist, answerInTerminal, noteWidth, KEY_LIST_W } from "./state.js";
import { elicitOf } from "./asks.js";
import { withHover } from "./hover.js";
import { statusMark, BAR_H } from "./top.js";
import { dragger, dropPlace } from "./drag.js";
import { movedBadge, badgeTip } from "./automove.js";
import { setting } from "./config.js";

// The row being dragged up or down: one at a time, so every copy of the list draws from it.
const drag = dragger("y");

// <pure>
const NEED_WORDS = { question: "waits for your answer", merge: "waits for your merge", round: "waits for your review round", migration: "waits for your migration go", reply: "asks you to reply" };
// A row's text, second line and tooltip. `label`: the tab's name; `ss`: the background work ({ hint, tip },
// subStatus) or null; `title`: the session's title; `need`: why it waits for the owner (needReason) or null;
// `index`: the tab's position in its space, from 1 (⌘1–⌘9 select tabs 1–9). Background work shows in words
// on a second line (`sub`), so the name keeps its room.
export function rowParts({ label, ss, title, need, index }) {
  const lines = [];
  const head = title ?? label;
  if (head) lines.push(head);
  if (ss?.tip) lines.push(ss.tip);
  if (need) lines.push(`Needs you: ${NEED_WORDS[need] ?? "waits for you"}.`);
  const key = index >= 1 && index <= 9 ? `⌘${index}` : null;
  if (key) lines.push(key);
  const sub = ss?.hint || null;
  // The second line says what the symbols in front of the name mean (the tab-title hook puts them there), so
  // the name drops them; emoji only, so "#1841 …" keeps its "#".
  // The ask's symbol (🔁 extra round, 🔀 merge …) stays in front of the name: the owner looks for it (11-12).
  const bare = sub ? stripGlyphs(label) : label;
  const text = ss?.askGlyph && !bare.includes(ss.askGlyph) ? `${ss.askGlyph} ${bare}` : bare;
  return { text, sub, tip: lines.join(" — ") || null, bell: Boolean(need), key };
}
export function stripGlyphs(s) {
  const out = String(s ?? "").replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]|\s)+/u, "");
  return out || String(s ?? "");
}
// The head's line: the space's name and how many tabs ("webshop · 7"); no space: "Tabs".
export function headText(spaceName, n) {
  return spaceName ? `${spaceName} · ${n}` : `Tabs · ${n}`;
}
// Owner 11-13 ("can the claude icon be dancing when its working"): an agent's icon dances while its tab works
// (tabStatus "working", background work included) and the `dance` setting is not off. A shell tab, a tab that waits
// on you, and a finished one stay still.
export function dances({ agent, status, setting }) {
  return Boolean(agent) && status === "working" && setting !== "off";
}
// The dance: a hop (up and back, twice) per sway (left to right and back), both native loops.
export const DANCE = { hop: { from: 0, to: -2.5, period: 460, easing: "ease-out" }, sway: { from: -1.5, to: 1.5, period: 920 } };
// </pure>

// The program's icon (Claude Code, a shell…): tinted glyphs in the row's colour, pictures as they are; a tab
// with no agent shows the terminal glyph. `dance`: the wrapper's id when it dances (dances above), else null.
function programMark(a, t, color, dance = null) {
  const p = a?.program;
  const mark = p?.icon ? (p.tint ? svg(p.icon).size(14).flex_none().text_color(color) : image(p.icon).size(14).flex_none())
    : svg(icon("terminal")).size(14).flex_none().text_color(t.muted);
  if (!dance) return mark;
  // Two wrappers, as each element runs one loop: the outer sways, the inner hops. Natively, only while drawn.
  return div().id(dance).relative().flex_none().loop("left", DANCE.sway)
    .child(div().id(`${dance}-hop`).relative().loop("top", DANCE.hop).child(mark));
}

function head(t) {
  const space = spaces().find((s) => s.active);
  const n = spaceTabs().length;
  const stop = (_e, cx) => cx.stop_propagation();
  const button = (id, child, action, tip) => div().id(id).tooltip(tip).size(26).flex_none().flex().items_center().justify_center().rounded(13)
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop).on_click(action).child(child);
  return h_flex().id("tabs-head").size_full().h(BAR_H).pl(14).pr(8).gap(4).items_center().bg(t.chrome).border_l(1).border_color(t.border)
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_weight(600).text_color(t.muted).child(headText(space?.name, n)))
    .child(button("tabs-new", svg(icon("plus")).size(15), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New tab (⌘T)"))
    .child(button("tabs-hide", svg(icon("tablist")).size(15), () => toggleTablist(), "Hide the tab list (⌥⌘B)"));
}

function list(t, view) {
  const tabs = spaceTabs();
  // A newly shown tab scrolls into sight (rows already in sight stay put).
  const at = tabs.findIndex((x) => x.active), shownId = at >= 0 ? tabs[at].id : null;
  if (shownId !== view.seen) { view.seen = shownId; if (at >= 0) view.scroll?.scroll_to_item(at); }
  const dragging = drag.shown;
  const lineOn = dragging && dropPlace(tabs, dragging) >= 0 ? dragging.target : null;
  const stop = (_e, cx) => cx.stop_propagation();

  const row = (tab) => {
    const on = tab.active;
    const a = tabAgents(tab.id)[0] ?? null;
    const parts = rowParts({ label: tabLabel(tab), ss: subStatus(tab), title: sessionTitle(a), need: needReason(a), index: tab.index });
    const moved = movedBadge(a?.address);
    // Blocked on an MCP server's input request (s10, as the sidebar's 🔌): one click opens its terminal to answer.
    const mcp = a?.status === "blocked" ? elicitOf(a.address) : null;
    const line = lineOn?.id === tab.id ? lineOn : null;
    const name = parts.sub
      ? v_flex().flex_1().min_w(0).child(div().truncate().child(parts.text))
        .child(div().truncate().text_size(11.5).font_weight(400).text_color(t.muted).child(parts.sub))
      : div().flex_1().min_w(0).truncate().child(parts.text);
    const el = h_flex().id(`vtab-${tab.id}`).relative().w_full().min_h(30).py(parts.sub ? 4 : 0).flex_none().pl(8).pr(on ? 4 : 8).gap(8).items_center().rounded(6).text_size(13)
      // A shell tab keeps the plain label; an agent's tab gets the hover box (hover.js, s11).
      .when(Boolean(parts.tip) && !a, (el) => el.tooltip(parts.tip))
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_weight(600))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(dragging?.id === tab.id, (el) => el.opacity(0.45))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation?.(); drag.press(tab.id, e); })
      .on_mouse_move((e, cx) => { if (drag.over(tab.id, e)) cx.notify?.(); })
      // The release after a drag is not a click.
      .on_click((e) => { if (drag.shown) return; if (e?.click_count === 2) keepOrRename(tab); else showTab(tab); })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation?.();
        const shown = drag.shown;
        drag.cancel(cx);
        if (shown) return;
        openMenu(tabItems(tab, { agent: a, list: tabs }));
      })
      .when(Boolean(line), (el) => el.child(div().id("vdrop-line").absolute().left(4).right(4).h(3).rounded(2).bg(t.accent)
        .when(line.after, (l) => l.bottom(-2)).when(!line.after, (l) => l.top(-2))))
      .child(programMark(a, t, on ? t.foreground : t.muted, dances({ agent: a, status: tabStatus(tab), setting: setting("dance") }) ? `vdance-${tab.id}` : null))
      .child(statusMark(tabStatus(tab), t))
      .child(name)
      .when(parts.bell && !mcp, (el) => el.child(svg(icon("bell")).size(13).flex_none().text_color(t.blocked)))
      .when(Boolean(mcp), (el) => el.child(div().id(`vmcp-${tab.id}`).flex_none().px(3).rounded(4).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(mcp ? `MCP “${mcp.server}” asks for input: click to answer in its terminal` : "")
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); answerInTerminal(a); }).child("🔌")))
      .when(Boolean(suggestBadge(a, t, `vsg-${tab.id}`)), (el) => el.child(suggestBadge(a, t, `vsg-${tab.id}`)))
      // Moved here by the auto-mover in the last few minutes (automove.js).
      .when(Boolean(moved), (el) => el.child(div().id(`vmoved-${tab.id}`).flex_none().flex().items_center().text_color(t.accent)
        .tooltip(badgeTip(moved)).child(svg(icon("moved")).size(12))))
      // ⌘1–⌘9 select tabs 1–9 (keys.json): a faint hint; the shown tab has its × there instead.
      .when(Boolean(parts.key) && !on, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(parts.key)))
      .when(on, (el) => el.child(div().id(`vclose-${tab.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(10)
        .text_size(15).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Close tab")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); closeTab(tab.id); }).child("×")));
    if (!a) return el;
    const ss = subStatus(tab);
    return withHover("vt", el, tab, t, { title: sessionTitle(a) ?? tabLabel(tab), extra: [ss?.tip, parts.key ? `${parts.key} shows this tab` : null], always: true, anchor: "right_center", onOpen: () => showTab(tab) });   // opens to the LEFT of the row: never over the rows below (owner 11-12)
  };

  return v_flex().id("tabs-list").size_full().min_h(0).bg(t.chrome).border_l(1).border_color(t.border)
    // The tab list's width, for the terminal window's room (state.termApp).
    .on_size_change((size) => noteWidth(KEY_LIST_W, size))
    .on_hover((inside, cx) => { if (!inside) drag.cancel(cx); })
    .on_mouse_down_out((_e, cx) => drag.cancel(cx))
    // On the whole list, not the rows: a release between rows ends the press too.
    .on_mouse_up("left", (_e, cx) => {
      const d = drag.release(cx);
      if (!d) return;
      const to = dropPlace(tabs, d);
      if (to >= 0) run("tab.move", { id: d.id, index: tabs[to].index });
    })
    .child(tabs.length
      ? v_flex().id("tabs-scroll").when(Boolean(view.scroll), (el) => el.track_scroll(view.scroll)).flex_1().min_h(0).px(6).pb(8).gap(2).overflow_y_scroll()
        .when(Boolean(dragging), (el) => el.cursor_grabbing())
        .children(tabs.map(row))
      : div().px(14).py(6).text_size(12.5).text_color(t.muted).child("No tabs in this space"));
}

export class TabsView {
  constructor(cx) {
    this.part = props()?.part === "head" ? "head" : "list";
    this.scroll = this.part === "list" ? ScrollHandle.new() : null;
    this.seen = undefined;
    if (this.part === "list") watchGrace(cx, this);
  }
  async close(_cx) { this.scroll?.release(); this.scroll = null; }
  render(_cx) {
    const t = theme();
    return this.part === "head" ? head(t) : list(t, this);
  }
}
