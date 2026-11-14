// Right-click menus: a popup at the pointer with one row per item. The items are data (a command
// and its arguments, or one of the mod's own actions) because the popup is another copy of the mod.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, openOverlay, closeOverlay, shared, setShared, notify } from "herdr";
import { agents, spaces as allSpaces } from "./parked.js";
import { openTerminal, showScreen, shownScreen, showAgent, openTab, showSettings, KEY_SCREEN, KEY_REMOVE, machineOf, sessionTopic, autoNamed } from "./state.js";
import { setting } from "./config.js";
import { moveTargets, suggestOf, suggestTip } from "./automove.js";
import { SUMMARY_W, SUMMARY_H } from "./summary.js";
import { aboutSupported } from "./ai.js";

const ROW_H = 28, PAD = 6, WIDTH = 220;

// Item: { label, cmd?, args?, act?, danger?, sep? }. `sep`: a line above it.
// `at`: where to open; "pointer" by default. A view in an overlay window passes the press's own
// position, as Herdr's pointer is not updated while the pointer is over an overlay.
export function openMenu(items, at = "pointer") {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  const seps = list.filter((i) => i.sep).length;
  return openOverlay({ mod: "flockbook", props: { view: "menu", items: list }, kind: "popup", at,
    width: WIDTH, height: PAD * 2 + list.length * ROW_H + seps * 9 + 2 });
}

// The mod's own actions, by name.
export function act(item) {
  if (item.cmd) return run(item.cmd, item.args ?? {});
  const a = item.args ?? {};
  switch (item.act) {
    case "terminal": return openTerminal(agents().find((x) => x.address === a.address) ?? null);
    case "panes": return showScreen("tab");
    case "chat": return showScreen("chat");
    case "open-agent": return showAgent(a.address);
    case "open-tab": return openTab(a.space, { id: a.tab });
    // The chat shows a card that asks before anything is removed.
    case "remove-helper": setShared(KEY_REMOVE, a.machine); return showScreen("chat");
    case "settings": return showSettings();
    // Plain-English summary by Haiku (summary.js).
    // A new About line now (ai.js, through the top bar: a value set here never reached it, see move-to).
    case "rewrite-about": return run(`flockbook.about-redo:${a.address}`);
    case "summarize": return openOverlay({ mod: "flockbook", props: { view: "summary", address: a.address }, kind: "dialog", width: SUMMARY_W, height: SUMMARY_H });
    // Moved by the top bar (it has a timer to wait on each step; this popup closes now). As a mod command: a value
    // set with setShared() here never reached the bar (tested 2026-11-11), a command does.
    case "move-to": return run(`flockbook.move-to:${a.address}:${a.space}`);
    // "Keep it in <here>" for a wrong-workspace suggestion (automove.js keepHere, via the bar as move-to is).
    case "keep-here": return run(`flockbook.keep-here:${a.address}:${a.name}`);
    case "copy": return null;   // handled in the view: the clipboard needs cx
  }
  return null;
}

// The items for a tab pill or an Overview card.
// The "Move to <workspace>" rows for a tab (the first with a line above it in the tab menu).
export function moveItems(tab, agent, sep = true) {
  return moveTargets(tab, agent).map((s, j) => ({ label: `Move to ${s.name}`, act: "move-to", args: { address: agent.address, space: s.id }, sep: sep && j === 0 }));
}
// A wrong-workspace suggestion (automove.js suggestTick): "Move to webshop?" and "Keep it in tools", or none.
export function suggestItems(agent, sep = false) {
  const sg = suggestOf(agent?.address);
  if (!sg) return [];
  const here = allSpaces().find((s) => s.id === agent.space)?.name ?? "this workspace";
  return [{ label: `Move to ${sg.name}?`, act: "move-to", args: { address: agent.address, space: sg.space } },
    { label: `Keep it in ${here}`, act: "keep-here", args: { address: agent.address, name: sg.name }, sep }].map((x, j) => (j === 0 ? { ...x, sep } : { ...x, sep: false }));
}
// The badge's click: the two rows alone.
export const openSuggestMenu = (agent) => openMenu(suggestItems(agent));
// The badge: "→ webshop?" in the accent colour; hover says why, a click offers Move / Keep.
export function suggestBadge(agent, t, id) {
  const sg = suggestOf(agent?.address);
  if (!sg) return null;
  return div().id(id).flex_none().px(5).h(18).flex().items_center().rounded(9).text_size(11).text_color(t.accent)
    .border(1).border_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(suggestTip(sg))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); openSuggestMenu(agent); })
    .child(`→ ${sg.name}?`);
}
// ⌘⇧M: those rows alone, for the shown tab, at the pointer; a note when it can't move.
export function openMoveMenu(tab, agent) {
  const items = moveItems(tab, agent, false);
  if (items.length) return openMenu(items);
  const why = !tab ? "no tab is shown" : !agent ? "no agent runs in this tab" : (tab.panes ?? 1) !== 1 ? "the tab is split" : "a sub-agent's tab stays with its parent";
  notify({ title: `Can't move this tab: ${why}.`, level: "info", timeout: 2500 });
  return null;
}

export function tabItems(tab, { agent = null, spaceId = null, list = [] } = {}) {
  const i = list.findIndex((x) => x.id === tab.id);
  const machine = machineOf(agent?.address);
  const shown = tab.active && !spaceId;   // the bar's shown tab: the screen and split items apply
  const topic = sessionTopic(agent);
  const short = (s) => ([...s].length > 26 ? `${[...s].slice(0, 25).join("")}…` : s);
  return [
    // A wrong-workspace suggestion first (s10).
    ...suggestItems(agent),
    spaceId && !tab.active ? { label: "Open", act: "open-tab", args: { space: spaceId, tab: tab.id }, sep: Boolean(suggestOf(agent?.address)) } : null,
    { label: "Rename…", cmd: "tab.rename", args: { id: tab.id }, sep: Boolean(suggestOf(agent?.address)) && !(spaceId && !tab.active) },
    // Keep the session's current topic as the name, or hand naming back to the session.
    topic && autoNamed(tab, agent) ? { label: `Keep name “${short(topic)}”`, cmd: "tab.rename", args: { id: tab.id, name: topic } } : null,
    topic && !autoNamed(tab, agent) && tab.name !== topic ? { label: "Name from session again", cmd: "tab.rename", args: { id: tab.id, name: "" } } : null,
    i > 0 ? { label: "Move left", cmd: "tab.move", args: { id: tab.id, index: list[i - 1].index } } : null,
    i >= 0 && i < list.length - 1 ? { label: "Move right", cmd: "tab.move", args: { id: tab.id, index: list[i + 1].index } } : null,
    // To another workspace: the session keeps running and the view stays (automove.js moveTerminal).
    ...moveItems(tab, agent),
    agent ? { label: "Summarize this tab", act: "summarize", args: { address: agent.address }, sep: true } : null,
    // Only where the About tick can write it (a tab on this Mac, not a helper agent; s13).
    agent && aboutSupported(agent.address) ? { label: "Rewrite About line", act: "rewrite-about", args: { address: agent.address } } : null,
    agent ? { label: "Open terminal", act: "terminal", args: { address: agent.address } } : null,
    shown && agent ? (shownScreen() === "tab" ? { label: "Show chat", act: "chat" } : { label: "Show panes", act: "panes" }) : null,
    shown ? { label: "Split right", cmd: "pane.split", args: { direction: "right" } } : null,
    shown ? { label: "Split down", cmd: "pane.split", args: { direction: "down" } } : null,
    // Never: nothing runs there, and nothing is removed from here either; the line says where to change that.
    machine ? (setting("remote_helper") !== "never"
      ? { label: `Remove helper from ${machine}…`, act: "remove-helper", args: { machine }, sep: true }
      : { label: "Remove helper: choose Ask in Flockbook settings first…", act: "settings", sep: true }) : null,
    { label: "Put away", cmd: "tab.settle", args: { id: tab.id }, sep: true },
    { label: "Close tab", cmd: "tab.close", args: { id: tab.id }, danger: true },
  ];
}

export function spaceItems(space) {
  return [
    { label: "New tab here", cmd: "tab.new", args: { space: space.id } },
    { label: "Rename…", cmd: "space.rename", args: { id: space.id } },
    { label: "Close workspace…", cmd: "space.close", args: { id: space.id }, danger: true, sep: true },
  ];
}

export class MenuView {
  constructor(_cx) {}

  render(_cx) {
    const t = theme();
    const p = props() ?? {};
    const rows = [];
    for (const [i, item] of (p.items ?? []).entries()) {
      if (item.sep) rows.push(div().h(1).mx(6).my(4).bg(t.border));
      rows.push(h_flex().id(`menu-${i}`).h(ROW_H).px(10).items_center().rounded(6).text_size(13)
        .text_color(item.danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { closeOverlay(p.overlay); if (item.act === "copy") cx?.write_to_clipboard?.(item.args?.text ?? ""); else act(item); })
        .child(div().truncate().child(item.label)));
    }
    return v_flex().size_full().p(PAD).gap(0).children(rows);
  }
}
