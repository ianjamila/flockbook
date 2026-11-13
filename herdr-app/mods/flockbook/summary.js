// The "summary" dialog (tab menu → "Summarize this tab", owner 11-12): what a tab's work is about, what it did, what
// it does now and whether it waits for the owner, in plain English, written by Haiku from the tab's screen and
// 400 lines of history (ai.js). Each open asks once; "Again" asks again. Esc, a click beside it or Close closes it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { agents } from "./parked.js";
import { agentName, icon, SPIN_MS, sessionTopic, needReason } from "./state.js";
import { askHaiku, screenOf, aiInput, sendAccount, SUMMARY_SYSTEM, aboutEntry, isStale, agoText, accountName } from "./ai.js";
import { nowOf, askOf, askLine, elicitOf } from "./asks.js";

// C5 (owner 11-12): it still asks Haiku on each open, but the free facts — the About line with its age, Now/Last,
// the last steps, whether it waits on the owner — show at once at the top while Haiku writes below.
export const SUMMARY_W = 560, SUMMARY_H = 520;

export class SummaryView {
  constructor(cx) {
    this.address = props()?.address ?? null;
    this.busy = false;
    this.text = null;
    this.error = null;
    cx?.spawn?.((cx) => this.ask(cx));
  }

  agent() { return agents().find((a) => a.address === this.address) ?? null; }

  // What is already known, free: [{ label, text }] (`text` an array = bullets). The same facts the hover shows.
  freeInfo() {
    const a = this.agent(), addr = this.address, now = Date.now(), out = [];
    const e = aboutEntry(addr);
    if (e?.text) {
      const stale = a ? isStale(e, sessionTopic(a) ?? a.title ?? "") : false;
      const meta = [e.wroteAt ? `auto-written ${agoText(e.wroteAt, now)}` : "auto-written earlier", e.account ? accountName(e.account) : null, stale ? "may be out of date" : null].filter(Boolean).join(" · ");
      out.push({ label: "About", text: `${e.text} (${meta})` });
    }
    const nw = nowOf(addr);
    if (nw?.now) out.push({ label: a?.status === "working" || nw.helpers?.length ? "Now" : "Last", text: nw.now });
    const steps = (nw?.steps ?? []).filter((x) => x !== nw?.now).slice(0, 5);
    if (steps.length) out.push({ label: "Last steps", text: steps });
    const r = a ? needReason(a) : null, ask = askOf(addr);
    const mcp = r === "question" ? elicitOf(addr)?.server : null;
    out.push({ label: "Needs you", text: !r ? "Nothing right now." : r === "question" ? (mcp ? `MCP “${mcp}” asks for input. Answer it in the tab's terminal.` : "It waits for your answer or approval.") : ask ? `${askLine(ask)}.` : "It waits for you." });
    return out;
  }

  async ask(cx) {
    if (this.busy || !this.address) return;
    this.busy = true; this.error = null; cx.notify();
    try {
      const a = this.agent();
      const screen = await screenOf(this.address, 400);
      if (!screen) { this.error = "Couldn't read this tab's terminal."; return; }
      // As the account on the screen being sent (accounts.js: with several accounts, the mark its status line shows); none on screen = not sent (s13 P1: the
      // remembered account never routes a call).
      const r = await askHaiku(SUMMARY_SYSTEM, aiInput(a ? sessionTopic(a) ?? a.title : "", screen, 16_000), 60_000, sendAccount(this.address, screen), "summary");
      if (r.error) this.error = `Couldn't summarize. ${r.error}`;
      else this.text = r.text.trim();
    } finally { this.busy = false; cx.notify(); }
  }

  render(_cx) {
    const t = theme();
    const a = this.agent();
    const stop = (_e, cx) => cx.stop_propagation();
    // "About: …" lines get their label in bold; "- " lines are bullets.
    const line = (l, i) => {
      const m = /^(About|Done so far|Now|Needs you)\s*:\s*(.*)$/i.exec(l);
      if (m) return h_flex().id(`sum-${i}`).gap(6).items_start().pt(i ? 8 : 0)
        .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(`${m[1]}:`))
        .when(Boolean(m[2]), (el) => el.child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(m[2])));
      const b = /^\s*[-•]\s+(.*)$/.exec(l);
      return div().id(`sum-${i}`).pl(b ? 12 : 0).text_size(13).text_color(t.foreground).child(b ? `• ${b[1]}` : l);
    };
    const lines = (this.text ?? "").split("\n").map((x) => x.trimEnd()).filter((x) => x.trim());
    const button = (id, label, on, primary = false) => div().id(id).px(14).h(30).flex().items_center().rounded(8).text_size(13)
      .bg(primary ? t.accent : t.chrome).text_color(primary ? t.background : t.foreground).border(1).border_color(primary ? t.accent : t.border)
      .hover((s) => s.opacity(0.9)).on_mouse_down("left", stop).on_click(on).child(label);
    // The free facts first (C5), each with its label in bold; steps as bullets.
    const fact = (f, i) => h_flex().id(`sum-f-${i}`).gap(6).items_start().pt(i ? 6 : 0)
      .child(div().flex_none().text_size(13).font_semibold().text_color(f.label === "Needs you" && f.text !== "Nothing right now." ? t.blocked : t.foreground).child(`${f.label}:`))
      .child(Array.isArray(f.text)
        ? v_flex().flex_1().min_w(0).gap(2).children(f.text.map((s, k) => div().id(`sum-f-${i}-${k}`).text_size(13).text_color(t.foreground).child(`• ${s}`)))
        : div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(f.text));
    const head = (id, s) => div().id(id).text_size(11.5).font_semibold().text_color(t.muted).child(s);
    return v_flex().id("summary").size_full().p(20).gap(12).bg(t.raised)
      .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(a ? agentName(a) : "This tab"))
      .child(v_flex().id("summary-body").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .child(head("sum-free-head", "AT A GLANCE (from what Flockbook already knows)"))
        .children(this.freeInfo().map(fact))
        .child(div().h(1).my(10).bg(t.border))
        .child(head("sum-ai-head", "HAIKU'S SUMMARY"))
        .when(this.busy, (el) => el.child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted)
          .child(svg(icon("spinner")).size(13).spin(SPIN_MS)).child("Reading the tab and writing a summary…")))
        .when(!this.busy && Boolean(this.error), (el) => el.child(div().text_size(13).text_color(t.blocked).child(this.error)))
        .when(!this.busy && !this.error, (el) => el.children(lines.map(line))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Written by Haiku from the tab's screen: a quick read, not a record."))
        .child(button("summary-again", "Again", (_e, cx) => cx.spawn((cx) => this.ask(cx))))
        .child(button("summary-close", "Close", () => { const id = props()?.overlay; if (id) closeOverlay(id); }, true)));
  }
}
