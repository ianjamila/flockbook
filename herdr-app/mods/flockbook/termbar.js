// The title bar of the terminal window (state.openTerminal): the agent's name and Close.
// The bar drags the window; Esc goes to the terminal, so Close is the way out.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, props, closeOverlay, setShared, agents } from "herdr";
import { icon, KEY_TERM, agentName, sessionTitle, resizeTerminal, termSizeFor } from "./state.js";
import { setting } from "./config.js";

export class TermBar {
  constructor(_cx) {}

  render(_cx) {
    const t = theme();
    const p = props() ?? {};
    // The name follows the agent live (its session topic changes as the conversation goes);
    // p.name is what it was when the window opened, for when the agent is gone.
    const live = agents().find((a) => a.address === p.terminal);
    const name = (live && agentName(live)) || p.name || "Agent";
    const full = live ? sessionTitle(live) : null;
    // A title bar: the agent's name with a terminal chip on the left, the close key and a round
    // close button on the right. Presses elsewhere drag the window.
    // Size buttons: ↺ back to the default size, then the preset sizes (the window's edges drag to any size: termresize.js); the window
    // reopens in place at the next one. A button that would change nothing is off.
    const size = setting("terminal_size");
    const stop = (_e, cx) => cx.stop_propagation();
    const sizeBtn = (id, label, how, tip, off) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(13)
      .text_size(15).text_color(off ? t.dim : t.muted).tooltip(tip).on_mouse_down("left", stop)
      .when(!off, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => cx.spawn(async () => resizeTerminal(p.terminal, name, how))))
      .child(label);
    return h_flex().id("termbar").size_full().pl(12).pr(10).gap(10).items_center().border_b(1).border_color(t.border)
      // A double-click on the bar: full size, or back.
      .on_click((e, cx) => { if (e?.click_count === 2) cx.spawn(async () => resizeTerminal(p.terminal, name, "toggle")); })
      .child(div().size(24).flex_none().rounded(7).flex().items_center().justify_center().bg(t.raised)
        .border(1).border_color(t.border).child(svg(icon("terminal")).size(13).text_color(t.muted)))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().id("term-name").min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground)
          .when(Boolean(full), (el) => el.tooltip(full)).child(name))
        .child(div().flex_none().text_size(12).text_color(t.muted).child("Terminal")))
      .child(h_flex().gap(2).items_center()
        .child(sizeBtn("term-reset", "↺", "reset", "Default size", termSizeFor("reset") === size))
        .child(sizeBtn("term-smaller", "−", "smaller", "Smaller (or drag an edge)", termSizeFor("smaller") === size))
        .child(sizeBtn("term-larger", "+", "larger", "Larger (or drag an edge)", termSizeFor("larger") === size))
        .child(sizeBtn("term-full", size === "full" ? "⤡" : "⤢", "toggle", size === "full" ? "Back to normal size (double-click the bar)" : "Full size (double-click the bar)", false)))
      .child(div().id("term-close").size(26).flex_none().flex().items_center().justify_center().rounded(13)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (⌃`)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setShared(KEY_TERM, null); closeOverlay(p.overlay); }).child(svg(icon("close")).size(14)));
  }
}
