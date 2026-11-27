// The "finished" view (owner 11-27: "a new tab after Needs you titled Finished … completed terminals with re-entry
// prompts"): the tabs the Overview files under "Hand-off given" on the left (state.js finished()), the picked one's
// re-entry prompt on the right with Copy prompt / Copy full / Open tab. The owner then types /clear in that tab and
// pastes; its new turn takes it off the list. Nothing here types into a terminal.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, notify } from "herdr";
import { finished, agentName, showAgent, icon, watchEdge } from "./state.js";
import { readHandoff, readFull } from "./handoff-read.js";
import { startTop, overBar, barOver, barRoom, noteScreenHeight } from "./top.js";
import { withSnapshot } from "./parked.js";

export class FinishedView {
  constructor(cx) {
    this.picked = null;
    this.barOver = barOver();
    this.top = {}; if (this.barOver) startTop(cx, this.top);
    this.shown = null;          // the tab on the right, from the last tick
    this.read = new Map();      // address → { prompt, file, problem }, read once when it is shown (not every tick)
    this.reading = new Set();   // addresses whose read is under way
    this.busy = null;           // "copy" | "full" while a copy runs
    this.copied = null;         // { address, what } for 2 s after a copy
    this.reader = readHandoff;  // how a tab's prompt is read (tests hand in a fake)
    this.fullReader = readFull;
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  // Every half second: which tab shows on the right; its prompt is read the first time it shows.
  tick(cx) { withSnapshot(() => this.tickBody(cx)); }

  tickBody(cx) {
    const list = finished();
    const cur = list.find((a) => a.address === this.picked) ?? list[0] ?? null;
    if ((cur?.address ?? null) !== this.shown) cx.notify?.();
    this.shown = cur?.address ?? null;
    // A tab that left the list is read afresh if it comes back (a new hand-off, a new prompt).
    for (const k of [...this.read.keys()]) if (!list.some((a) => a.address === k)) this.read.delete(k);
    if (cur && !this.read.has(cur.address) && !this.reading.has(cur.address)) cx.spawn((cx) => this.load(cx, cur.address));
  }

  async load(cx, address) {
    this.reading.add(address);
    try { this.read.set(address, await this.reader(address)); } finally { this.reading.delete(address); }
    cx.notify?.();
  }

  // Copy prompt: the reply is read again at the click, so what is copied is the newest prompt, and the pane shows
  // that same text (never a stale one).
  async copy(cx, address) {
    if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't copy: no clipboard here. Open the tab and use Copy all.", level: "warning", timeout: 3000 }); return; }
    if (this.busy) return;
    this.busy = "copy"; cx.notify?.();
    let r;
    try { r = await this.reader(address); this.read.set(address, r); } finally { this.busy = null; }
    if (!r.prompt) notify({ title: r.problem ? `Couldn't read its chat: ${r.problem}` : "No re-entry prompt in its last reply. Open the tab to see it.", level: "warning", timeout: 4000 });
    else {
      cx.write_to_clipboard(r.prompt);
      notify({ title: "Re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
      this.flashCopied(cx, address, "copy");
    }
    cx.notify?.();
  }

  // Copy full: the hand-off file the newest prompt names, read on the tab's own machine.
  async copyFull(cx, address) {
    if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't copy: no clipboard here. Open the tab and use Copy full prompt.", level: "warning", timeout: 3000 }); return; }
    if (this.busy) return;
    this.busy = "full"; cx.notify?.();
    let text = null, problem = null;
    try {
      const h = await this.reader(address);
      this.read.set(address, h);
      if (h.problem) problem = `Couldn't read its chat: ${h.problem}`;
      else if (!h.prompt) problem = "No re-entry prompt in its last reply. Open the tab to see it.";
      else if (!h.file) problem = "Its re-entry prompt names no full-prompt file (~/claude-notes/handoffs/…). Copy prompt copies it.";
      else {
        const r = await this.fullReader(address, h.file);
        if (r.text) text = r.text; else problem = `Couldn't read the full prompt (${h.file}): ${r.problem}`;
      }
    } catch (e) { problem = String(e?.message ?? e); } finally { this.busy = null; }
    if (!text) notify({ title: problem, level: "warning", timeout: 5000 });
    else {
      cx.write_to_clipboard(text);
      notify({ title: "Full re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
      this.flashCopied(cx, address, "full");
    }
    cx.notify?.();
  }

  flashCopied(cx, address, what) {
    const mark = { address, what };
    this.copied = mark;
    cx.timer?.after?.(2000, (cx2) => { if (this.copied === mark) { this.copied = null; cx2?.notify?.(); } });
  }

  render(cx) {
    return withSnapshot(() => this.renderBody(cx));
  }

  renderBody(cx) {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    return v_flex().id("finished-screen").relative().size_full().bg(t.background).on_size_change((size) => noteScreenHeight(size, this.barOver))
      .child(div().size_full().pt(barRoom(this.barOver)).when(this.barOver, (el) => el.on_mouse_down("left", stop)).child(this.content(t)))
      .when(this.barOver, (el) => el.child(overBar(t)));
  }

  button(id, label, primary, t, onClick) {
    return div().id(id).px(14).h(32).flex().items_center().rounded(8).text_size(13)
      .when(primary, (el) => el.font_semibold().bg(t.done).text_color(t.background).hover((x) => x.opacity(0.9)))
      .when(!primary, (el) => el.bg(t.chrome).text_color(t.foreground).border(1).border_color(t.border).hover((x) => x.bg(t.hover)))
      .on_click(onClick).child(label);
  }

  content(t) {
    const list = finished();
    if (!list.length) {
      return v_flex().size_full().items_center().justify_center().gap(8).text_color(t.muted)
        .child(svg(icon("check")).size(28).text_color(t.done))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("Nothing finished"))
        .child(div().text_size(13).child("No session left a re-entry prompt."));
    }
    const cur = list.find((a) => a.address === this.picked) ?? list[0];
    const item = (a) => {
      const on = a.address === cur.address;
      const p = a.program;
      return h_flex().id(`fin-${a.address}`).h(52).px(12).gap(10).items_center().rounded(8)
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.picked = a.address; cx.notify(); })
        .when(Boolean(p?.icon), (el) => el.child(p.tint ? svg(p.icon).size(18).text_color(t.muted) : image(p.icon).size(18)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13.5).text_color(t.foreground).child(agentName(a)))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${a.space_name} · hand-off given`)))
        .child(div().size(8).flex_none().rounded(4).bg(t.done));
    };
    const r = this.read.get(cur.address);
    const addr = cur.address;
    const copied = (what) => this.copied?.address === addr && this.copied.what === what;
    let body;
    if (!r) body = div().text_size(13).text_color(t.muted).child("Reading its re-entry prompt…");
    else if (r.problem) body = div().id("fin-problem").text_size(13).text_color(t.blocked).child(`Couldn't read its chat: ${r.problem}`);
    else if (!r.prompt) body = div().id("fin-none").text_size(13).text_color(t.muted).child("No re-entry prompt in its last reply.");
    else body = div().id("fin-prompt").whitespace_normal().p(12).rounded(8).bg(t.raised).border(1).border_color(t.border)
      .text_size(13).line_height("19px").text_color(t.foreground).child(r.prompt);
    const hasPrompt = Boolean(r?.prompt);
    return watchEdge(h_flex().id("finished-root").size_full().min_h(0).items_start())
      .child(v_flex().id("finished-list").w(340).flex_none().h_full().p(10).gap(2).border_r(1).border_color(t.border)
        .overflow_y_scrollbar()
        .child(div().px(4).pb(6).text_size(15).font_semibold().text_color(t.foreground).child(`Finished · ${list.length}`))
        .children(list.map(item)))
      .child(v_flex().id("finished-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(24).gap(12)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(agentName(cur)))
        .child(div().text_size(13).text_color(t.muted).child(cur.title || `${cur.space_name} · ${cur.tab_name}`))
        .child(body)
        .child(h_flex().gap(8).items_center()
          .when(hasPrompt, (el) => el.child(this.button("fin-copy", this.busy === "copy" ? "Copying…" : copied("copy") ? "Copied" : "Copy prompt", true, t,
            (_e, cx) => { if (!this.busy) cx.spawn((cx2) => this.copy(cx2, addr)); })))
          .when(hasPrompt && Boolean(r?.file), (el) => el.child(this.button("fin-full", this.busy === "full" ? "Copying…" : copied("full") ? "Copied" : "Copy full", false, t,
            (_e, cx) => { if (!this.busy) cx.spawn((cx2) => this.copyFull(cx2, addr)); })))
          .child(this.button("fin-open", "Open tab", false, t, () => showAgent(addr))))
        .when(hasPrompt, (el) => el.child(div().text_size(12).text_color(t.muted).child("Then type /clear in the tab and paste."))));
  }
}
