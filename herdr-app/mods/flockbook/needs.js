// The "needs" view: the agents that wait for the owner on the left, the one picked on the right.
// The right side shows what the picked agent waits for (an approval or a question card) and opens its chat.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";
import { needing, needReason, agentName, showAgent, icon, watchEdge, noteWindowHeight, sessionTopic } from "./state.js";
import { aboutEntry, isStale, agoText } from "./ai.js";
import { askOf, askLine, askDetail, stillAsks, prList, answered, elicitOf } from "./asks.js";
import { hc } from "herdr";
// How long each has waited on you ("waiting 2 h"; s13 C2, from history.js; age only, the order is unchanged).
import { waitingFor } from "./history.js";
import * as sidecar from "./sidecar.js";
import { Cards } from "./cards.js";
import { startTop, overBar, barOver, barRoom, noteScreenHeight } from "./top.js";

export class NeedsView {
  constructor(cx) {
    this.picked = null;
    this.cards = new Cards(cx);
    this.barOver = barOver();
    this.top = {}; if (this.barOver) startTop(cx, this.top);
    this.shown = null;   // the agent on the right, from the last render
    this.granting = null;   // the address an "Extra round" press is sending to
    this.notes = new Map();   // address → { text, bad } after a press
    this.flash = null;   // { text, until }: the last sent answer, shown after its row left the list (s10)
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  tick(cx) {
    const list = needing();
    const cur = list.find((a) => a.address === this.picked) ?? list[0] ?? null;
    this.shown = cur?.address ?? null;
    // Cards only for questions and approvals; an ask in the reply's text has none.
    if (cur && needReason(cur) === "question") cx.spawn((cx) => this.cards.poll(cx, cur.address, true));
  }

  // The screen with the bar drawn over it, where presses on the content don't drag the window; or, with
  // the bar outside (props.bar), the content alone, with no stop, so its text can be selected.
  render(cx) {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    return v_flex().id("needs-screen").relative().size_full().bg(t.background).on_size_change((size) => noteScreenHeight(size, this.barOver))
      .child(div().size_full().pt(barRoom(this.barOver)).when(this.barOver, (el) => el.on_mouse_down("left", stop)).child(this.content(t)))
      .when(this.barOver, (el) => el.child(overBar(t)));
  }

  // One-click answers (owner 11-12: "can extra round become a button in the needs you tab", then a Merge button too):
  // the owner's own words ("extra round", "merge") go to the session exactly as the chat's reply box sends them,
  // only after its screen is read again and still ends with that same ask (kind, PR, round): a round already
  // granted, a newer one, or a merge hand-off replaced since, gets nothing.
  async sendAsk(cx, address, ask, words) {
    if (this.granting) return;
    this.granting = address; this.notes.delete(address); cx.notify();
    let note = null;
    try {
      const r = await hc(["read", address]).catch(() => null);
      if (!(r?.code === 0 && stillAsks(r.stdout, ask))) note = { text: `Not sent: its screen no longer ends with this ask (${askLine(ask)}). Open the chat to see where it is.`, bad: true };
      else {
        const res = await sidecar.send(address, words);
        const done = res.lines?.find((l) => l.type === "done");
        if (res.error || !done || (done.result !== "sent" && done.result !== "unconfirmed")) note = { text: (res.error?.message ?? done?.message) || `Not sent. Type “${words}” in its chat.`, bad: true };
        else {
          note = { text: done.result === "sent" ? `Sent “${words}”.` : `Sent “${words}”. The agent did not confirm it yet.`, bad: false };
          // Answered: it leaves the list now (asks.js answered), so the note shows above the list for a while.
          const who = agentName(needing().find((x) => x.address === address) ?? { address });
          answered(address);
          this.flash = { text: `${note.text.replace(/\.$/, "")} to ${who}.`, until: Date.now() + 8000 };
          cx.timer?.after?.(8100, () => cx.notify());
        }
      }
    } finally { this.granting = null; }
    this.notes.set(address, note); cx.notify();
  }

  content(t) {
    const list = needing();
    const flash = this.flash && Date.now() < this.flash.until ? div().id("needs-flash").text_size(12).text_color(t.done).child(this.flash.text) : null;
    if (!list.length) {
      return v_flex().size_full().items_center().justify_center().gap(8).text_color(t.muted)
        .child(svg(icon("check")).size(28).text_color(t.done))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("All clear"))
        .child(div().text_size(13).child("No agent waits for you."))
        .when(Boolean(flash), (el) => el.child(flash));
    }
    const cur = list.find((a) => a.address === this.picked) ?? list[0];
    const item = (a) => {
      const on = a.address === cur.address;
      const p = a.program;
      return h_flex().id(`need-${a.address}`).h(52).px(12).gap(10).items_center().rounded(8)
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.picked = a.address; cx.notify(); })
        .when(Boolean(p?.icon), (el) => el.child(p.tint ? svg(p.icon).size(18).text_color(t.muted) : image(p.icon).size(18)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13.5).text_color(t.foreground).child(agentName(a)))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${a.space_name} · ${needReason(a) === "question" ? ((this.cards.card(a.address)?.kind === "elicitation" || elicitOf(a.address)) ? `MCP “${this.cards.card(a.address)?.server ?? elicitOf(a.address).server}” asks for input` : "waits for you") : askOf(a.address) ? askLine(askOf(a.address)) : "ready to merge"}${waitingFor(a.address) ? ` · ${waitingFor(a.address)}` : ""}`)))
        .child(div().size(8).flex_none().rounded(4).bg(t.blocked));
    };
    // Both columns start at the top (h_flex centres its children by default).
    return watchEdge(h_flex().id("needs-root").size_full().min_h(0).items_start())
      .child(v_flex().id("needs-list").w(340).flex_none().h_full().p(10).gap(2).border_r(1).border_color(t.border)
        .overflow_y_scrollbar()
        .child(div().px(4).pb(6).text_size(15).font_semibold().text_color(t.foreground).child(`Needs you · ${list.length}`))
        .when(Boolean(flash), (el) => el.child(div().px(4).pb(4).child(flash)))
        .children(list.map(item)))
      .child(v_flex().id("needs-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(24).gap(12)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(agentName(cur)))
        .child(div().text_size(13).text_color(t.muted).child(cur.title || `${cur.space_name} · ${cur.tab_name}`))
        // What the work is for (M3, owner 11-12): context beside the decision, labelled as a Haiku guess with its age;
        // the decision itself still comes from the screen (sendAsk reads it again before anything is sent).
        .when(Boolean(aboutEntry(cur.address)?.text), (el) => {
          const e = aboutEntry(cur.address);
          const stale = isStale(e, sessionTopic(cur) ?? cur.title ?? "");
          return el.child(v_flex().id("needs-about").gap(3).p(12).rounded(8).bg(t.raised).border(1).border_color(t.border)
            .child(div().text_size(11.5).font_semibold().text_color(t.muted)
              .child(`What it's about · auto-written${e.wroteAt ? ` ${agoText(e.wroteAt, Date.now())}` : ""}${stale ? " · may be out of date" : ""}`))
            .child(div().whitespace_normal().text_size(13).line_height("19px").text_color(t.foreground).child(e.more || e.text)));
        })
        .child(needReason(cur) !== "question"
          ? div().id("needs-ask").text_size(13.5).text_color(t.foreground).child(askDetail(askOf(cur.address)) ?? "Its turn ended handing you a merge decision. Say “merge” in its chat when you're happy with it.")
          : this.cards.view(cur.address, t, "needs-card") ?? div().text_size(13).text_color(t.muted)
          .child(this.cards.byAgent.get(cur.address)?.read ? "It waits for you in its terminal. Open the chat to see why." : "Reading what it waits for…"))
        .child(h_flex().gap(8).items_center()
          // Each its own colour (owner 11-12): extra round = the working colour, merge = the done colour, Open chat plain.
          .when(needReason(cur) === "round" || needReason(cur) === "merge", (el) => {
            const ask = askOf(cur.address), busy = this.granting === cur.address, round = ask.kind === "round";
            const words = round ? "extra round" : "merge";
            const label = round ? `🔁 Extra round · #${ask.pr} round ${ask.round}` : `🔀 Merge · ${prList(ask)}`;
            return el.child(div().id(round ? "needs-round" : "needs-merge").px(14).h(32).flex().items_center().rounded(8).text_size(13).font_semibold()
              .bg(busy ? t.chrome : round ? t.working : t.done).text_color(busy ? t.dim : t.background)
              .when(!busy, (b) => b.hover((x) => x.opacity(0.9)).on_click((_e, cx) => cx.spawn((cx) => this.sendAsk(cx, cur.address, ask, words))))
              .child(busy ? "Sending…" : label));
          })
          .child(div().id("needs-open").px(14).h(32).flex().items_center().rounded(8).text_size(13)
            .bg(t.chrome).text_color(t.foreground).border(1).border_color(t.border).hover((x) => x.bg(t.hover))
            .on_click(() => showAgent(cur.address)).child("Open chat")))
        .when(Boolean(this.notes.get(cur.address)), (el) => el.child(div().id("needs-note").text_size(12)
          .text_color(this.notes.get(cur.address).bad ? t.blocked : t.muted).child(this.notes.get(cur.address).text))));
  }
}
