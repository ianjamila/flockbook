// The "finished" view (owner 11-27: "a new tab after Needs you titled Finished … completed terminals with re-entry
// prompts"): the tabs the Overview files under "Hand-off given" on the left (state.js finished()), the picked one's
// re-entry prompt on the right with Clear & re-enter / Copy prompt / Copy full / Open tab. Clear & re-enter has the helper
// where the tab runs type /clear and then the prompt (sidecar.reenter: every check and key happens there); without it
// (an older helper, another agent) the owner types /clear in that tab and pastes. The tab's new turn takes it off the list.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, notify } from "herdr";
import { finished, agentName, showAgent, icon, watchEdge, reentering, reenterRuns } from "./state.js";
import { agents } from "./parked.js";
import * as sidecar from "./sidecar.js";
import { readHandoff, readFull } from "./handoff-read.js";
import { startTop, overBar, barOver, barRoom, noteScreenHeight } from "./top.js";
import { withSnapshot } from "./parked.js";

// A read that gave no prompt (the helper failed, or the reply was not logged yet) is tried again after this long.
export const RETRY_MS = 5000;
// After a run that sent, its row stays this long, then goes and the pick moves on.
export const DROP_MS = 5000;

const NO_ANSWER = "No answer from the helper: the tab may have been cleared and the prompt may or may not have gone. Check the tab.";
const SENT = "Re-entered: the new conversation has its prompt.";
const CHANGED = "The re-entry prompt changed. Check it, then press again.";
const COPY_FAILED = "Couldn't put the prompt on your clipboard: use Copy again.";
const TAIL_PASTE = "The prompt is on your clipboard: open the tab and paste.";
const TAIL_UNCONFIRMED = "The prompt may already be in the tab. Check it before pasting.";
const ON_CLIPBOARD = "It is on your clipboard.";
const TAIL_CLEAR = "Check the tab shows a new conversation before pasting; if it does not, type /clear first.";
const HINT = "Types /clear in this tab, then the prompt above. If the tab's box has text in it, nothing is typed.";

// What the helper's answer means (reenter.rs): its one `done` line (result, message, keys) or its `error` line; a
// `done` line wins, because a helper that answered but lost its end line comes back with both. `keys` says whether a key
// went to the tab: "none" (nothing typed), "yes", "maybe"; a line without it, no line at all, or a helper that was killed
// or never answered counts as "maybe". → { keys, result, lead, tail }: `tail` null when there is nothing to paste.
// The no-answer note and a forward's `maybe` error say what they can: the tab may have been cleared, so the owner is told
// to check that it shows a new conversation before pasting (TAIL_CLEAR), never just to paste.
export function readAnswer(answer) {
  const done = answer?.lines?.find((l) => l?.type === "done");
  const line = done ?? answer?.error ?? null;
  if (!line) return { keys: "maybe", result: "no_answer", lead: NO_ANSWER, tail: TAIL_CLEAR };
  const result = line.result ?? line.code ?? "failed";
  const keys = line.keys === "none" || line.keys === "yes" ? line.keys : "maybe";
  // An error that does not say what was typed (the helper's own failure, a kill by the exec timeout) is no answer.
  if (!done && (line.keys === undefined || line.keys === "maybe")) return { keys: "maybe", result: "no_answer", lead: NO_ANSWER, tail: TAIL_CLEAR };
  const message = String(line.message ?? "").trim();
  if (keys === "none") {
    // Some refusals already say it (cards::refused: "Nothing was sent."): one such sentence is enough.
    const lead = /nothing was (sent|typed)/i.test(message) ? message : `${message} Nothing was typed.`.trim();
    return { keys, result, lead, tail: null };
  }
  if (result === "sent") return { keys, result, lead: SENT, tail: null };
  const tail = result === "prompt_unconfirmed" ? TAIL_UNCONFIRMED
    : result === "clear_unknown" || result === "clear_unconfirmed" ? TAIL_CLEAR : TAIL_PASTE;
  return { keys, result, lead: message || "The tab may have been cleared.", tail };
}

// A lead and its tail as one note: a period between them when the message has no closing punctuation (a forward's
// "pc did not answer in 21 s"), and, for an unconfirmed prompt, that it is on the clipboard (only once it was copied).
export function joinNote(lead, tail, result) {
  const l = /[.!?]$/.test(lead) ? lead : `${lead}.`;
  return `${l} ${tail}${result === "prompt_unconfirmed" ? ` ${ON_CLIPBOARD}` : ""}`;
}

let runs = 0;   // run ids: only the run with the matching id may change or clear its record

export class FinishedView {
  constructor(cx) {
    this.picked = null;
    this.barOver = barOver();
    this.top = {}; if (this.barOver) startTop(cx, this.top);
    this.shown = null;          // the tab on the right, from the last tick
    this.runSig = "";           // the shown tab's run (id, state, result) at the last tick
    this.read = new Map();      // address → { prompt, file, problem }, read once when it is shown (not every tick)
    this.reading = new Set();   // addresses whose read is under way
    this.busy = null;           // "copy" | "full" while a copy runs
    this.copied = null;         // { address, what } for 2 s after a copy
    this.reader = readHandoff;  // how a tab's prompt is read (tests hand in a fake)
    this.fullReader = readFull;
    this.reenterer = sidecar.reenter;   // how Clear & re-enter runs (tests hand in a fake)
    this.hasCommand = sidecar.hasCommand;
    this.runs = reenterRuns;    // address → the tab's Clear & re-enter run (state.js; a rebuilt view keeps them)
    this.canReenter = null;     // whether the helper has `reenter`: null until asked; asked again after a failed ask
    this.asking = false; this.askedAt = 0;
    this.note = null;           // { address, text }: a click that typed nothing (the prompt changed)
    cx.spawn((cx2) => this.askHelper(cx2));
    cx.timer.every(500, (cx) => this.tick(cx));
  }

  // The helper's commands (sidecar.hasCommand asks once and keeps the answer; a failed ask is asked again next time).
  async askHelper(cx) {
    if (this.asking) return;
    this.asking = true; this.askedAt = Date.now();
    try { this.canReenter = Boolean(await this.hasCommand("reenter")); } catch { this.canReenter = null; } finally { this.asking = false; }
    cx.notify?.();
  }

  // The tabs on screen: those Finished lists, and the tabs whose run is on (or just ended), which stay until the owner picks
  // another (the /clear takes the tab off finished() within ~15 s, but its prompt and result should stay beside each other).
  listed() {
    const list = finished();
    for (const address of this.runs.keys()) {
      if (list.some((a) => a.address === address)) continue;
      const a = agents().find((x) => x.address === address);
      if (a) list.push(a);
    }
    return list;
  }

  // The tab on the right: the one the owner picked; else the tab of a run (the newest if several: a tab with a run stays
  // shown, also in a rebuilt view and when it was only the first row); else the first.
  current(list) {
    const picked = list.find((a) => a.address === this.picked);
    if (picked) return picked;
    let best = null, bestId = -1;
    for (const a of list) { const id = this.runs.get(a.address)?.id; if (id !== undefined && id > bestId) { best = a; bestId = id; } }
    return best ?? list[0] ?? null;
  }

  // Every half second: which tab shows on the right; its prompt is read the first time it shows.
  tick(cx) { withSnapshot(() => this.tickBody(cx)); }

  tickBody(cx) {
    const list = this.listed();
    const cur = this.current(list);
    // A view rebuilt while a run was on repaints when that run's state or result changes (the run started in another view).
    const run = cur ? this.runs.get(cur.address) : null;
    const sig = run ? `${run.id}|${run.state}|${run.result ?? ""}|${run.copyFailed ?? ""}` : "";
    if ((cur?.address ?? null) !== this.shown || sig !== this.runSig) cx.notify?.();
    this.runSig = sig;
    this.shown = cur?.address ?? null;
    // A tab that left the list is read afresh if it comes back (a new hand-off, a new prompt). A tab with a run is not
    // read again: after its /clear the feed shows the new conversation, not the prompt that was sent.
    for (const k of [...this.read.keys()]) if (!list.some((a) => a.address === k) && !this.runs.has(k)) this.read.delete(k);
    const r = cur ? this.read.get(cur.address) : null;
    const due = !r || (!r.prompt && Date.now() - (r.at ?? 0) >= RETRY_MS);
    if (cur && due && !this.runs.has(cur.address) && !this.reading.has(cur.address)) cx.spawn((cx) => this.load(cx, cur.address));
    if (this.canReenter !== true && !this.asking && Date.now() - this.askedAt >= RETRY_MS) cx.spawn((cx2) => this.askHelper(cx2));
  }

  async load(cx, address) {
    this.reading.add(address);
    try { this.read.set(address, { ...(await this.reader(address)), at: Date.now() }); } finally { this.reading.delete(address); }
    cx.notify?.();
  }

  // Copy prompt: the reply is read again at the click, so what is copied is the newest prompt, and the pane shows
  // that same text (never a stale one).
  async copy(cx, address) {
    if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't copy: no clipboard here. Open the tab and use Copy all.", level: "warning", timeout: 3000 }); return; }
    if (this.busy) return;
    // A tab whose run typed keys shows the new conversation now: a re-read finds no prompt, so its own prompt is copied.
    const run = this.runs.get(address);
    if (run?.state === "done" && run.keys !== "none" && run.prompt) {
      cx.write_to_clipboard(run.prompt);
      notify({ title: "Re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
      this.flashCopied(cx, address, "copy"); cx.notify?.();
      return;
    }
    this.busy = "copy"; cx.notify?.();
    let r;
    try { r = await this.reader(address); if (r.prompt) this.read.set(address, { ...r, at: Date.now() }); } finally { this.busy = null; }
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
      if (h.prompt) this.read.set(address, { ...h, at: Date.now() });
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

  // Clear & re-enter. The click's synchronous part: a run already on in this tab → nothing; else the prompt and log the
  // screen shows are taken, and the tab's run and its lock (which holds the chat's Send) are set before any await.
  begin(address) {
    if (this.runs.get(address)?.state === "running") return null;
    const r = this.read.get(address) ?? this.runPrompt(address);
    if (!r?.prompt || !r.seen?.path) return null;
    const id = ++runs;
    const shown = { prompt: r.prompt, path: r.seen.path };
    this.runs.set(address, { id, state: "running", prompt: shown.prompt, seen: r.seen, at: Date.now() });
    this.picked = address;
    reentering.add(address);
    this.note = null;
    return { id, shown, seen: r.seen };
  }

  // The prompt of a tab whose run is on or done, when this view has not read it (the view was rebuilt mid-run).
  runPrompt(address) {
    const run = this.runs.get(address);
    return run ? { prompt: run.prompt, file: null, seen: run.seen ?? null, problem: null } : null;
  }

  // Both end a run's hold on its tab, and only while the run still owns it: `release` also drops the record (nothing
  // was typed), `settle` keeps it with its result (the lock goes, the result stays on screen).
  release(address, id) {
    if (this.runs.get(address)?.id !== id) return;
    this.runs.delete(address); reentering.delete(address);
  }
  settle(address, id) {
    if (this.runs.get(address)?.id === id) reentering.delete(address);
  }

  async reenter(cx, address, started = this.begin(address), clip = cx) {
    if (!started) return;
    const { id, shown, seen } = started;
    const own = () => this.runs.get(address)?.id === id;
    try {
      // The reply is read again: a prompt or log other than the one the owner is looking at types nothing.
      let again;
      try { again = await this.reader(address); } catch (e) { again = { prompt: null, problem: String(e?.message ?? e) }; }
      if (!again.prompt || again.problem || again.prompt !== shown.prompt || again.seen?.path !== shown.path) {
        // The new read is shown (the button and the old prompt go with a reply that has none); a read that failed keeps the old one.
        if (!again.problem) this.read.set(address, { ...again, at: Date.now() });
        this.release(address, id);
        this.note = { address, text: CHANGED };
        notify({ title: CHANGED, level: "warning", timeout: 4000 });
        return;
      }
      let answer;
      try { answer = await this.reenterer(address, shown.prompt, seen); } catch { answer = null; }
      const a = readAnswer(answer);
      let text = a.lead, copyFailed = false;
      if (a.tail) {
        // A key may have gone: the prompt goes on the clipboard whatever else happens (the owner pastes it).
        try { clip.write_to_clipboard(shown.prompt); text = joinNote(a.lead, a.tail, a.result); }
        catch { copyFailed = true; text = `${a.lead} ${COPY_FAILED}`; }
      }
      const line = (answer?.lines ?? []).find((l) => l?.type === "done") ?? answer?.error ?? null;
      if (own()) Object.assign(this.runs.get(address), { state: "done", result: a.result, keys: a.keys, message: line?.message ?? null, at: Date.now(), lead: a.lead, tail: a.tail, note: text, bad: a.result !== "sent", copyFailed });
      notify({ title: text, level: a.result === "sent" ? "info" : "warning", timeout: a.result === "sent" ? 3000 : 8000 });
      if (a.result === "sent") cx.timer?.after?.(DROP_MS, (cx2) => this.drop(cx2, address, id));
    } finally { this.settle(address, id); cx.notify?.(); }
  }

  // 5 s after a run that sent: its row goes and the pick moves to the next tab.
  drop(cx, address, id) {
    if (this.runs.get(address)?.id !== id) return;
    this.runs.delete(address);
    if (this.picked === address || this.shown === address) this.picked = this.listed().find((a) => a.address !== address)?.address ?? null;
    cx?.notify?.();
  }

  // Copy again, after a clipboard that would not take the prompt: the run's own prompt, never a re-read (after the
  // /clear the feed shows the new conversation).
  copyAgain(cx, address) {
    const run = this.runs.get(address);
    if (!run?.prompt) return;
    try {
      cx.write_to_clipboard(run.prompt);
      notify({ title: "Re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
      run.note = joinNote(run.lead, run.tail, run.result); run.copyFailed = false;
      this.flashCopied(cx, address, "again");
    } catch { notify({ title: COPY_FAILED, level: "warning", timeout: 4000 }); }
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
    const list = this.listed();
    if (!list.length) {
      return v_flex().size_full().items_center().justify_center().gap(8).text_color(t.muted)
        .child(svg(icon("check")).size(28).text_color(t.done))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("Nothing finished"))
        .child(div().text_size(13).child("No session left a re-entry prompt."));
    }
    const cur = this.current(list);
    const item = (a) => {
      const on = a.address === cur.address;
      const p = a.program;
      return h_flex().id(`fin-${a.address}`).h(52).px(12).gap(10).items_center().rounded(8)
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.pick(a.address); cx.notify(); })
        .when(Boolean(p?.icon), (el) => el.child(p.tint ? svg(p.icon).size(18).text_color(t.muted) : image(p.icon).size(18)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13.5).text_color(t.foreground).child(agentName(a)))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${a.space_name} · hand-off given`)))
        .child(div().size(8).flex_none().rounded(4).bg(t.done));
    };
    const addr = cur.address;
    const r = this.read.get(addr) ?? this.runPrompt(addr);
    const run = this.runs.get(addr);
    // Not again after a run that may have typed (also "sent": its row stays 5 s): the pre-clear read is stale, the tab shows
    // a new conversation now. A refusal that typed nothing (keys "none") leaves the button, to press again.
    const typed = run?.state === "done" && run.keys !== "none";
    const canRe = Boolean(r?.prompt) && r.seen?.agent === "claude" && Boolean(r.seen?.path) && this.canReenter === true && !typed;
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
          .when(canRe, (el) => el.child(this.button("fin-reenter", run?.state === "running" ? "Re-entering…" : "Clear & re-enter", true, t,
            (_e, cx) => {
              if (typeof cx?.write_to_clipboard !== "function") { notify({ title: "Couldn't re-enter: no clipboard here. Open the tab and use Copy all.", level: "warning", timeout: 3000 }); return; }
              const s = this.begin(addr);
              if (s) cx.spawn((cx2) => this.reenter(cx2, addr, s, typeof cx2?.write_to_clipboard === "function" ? cx2 : cx));
            })))
          .when(hasPrompt, (el) => el.child(this.button("fin-copy", this.busy === "copy" ? "Copying…" : copied("copy") ? "Copied" : "Copy prompt", !canRe, t,
            (_e, cx) => { if (!this.busy) cx.spawn((cx2) => this.copy(cx2, addr)); })))
          .when(hasPrompt && Boolean(r?.file), (el) => el.child(this.button("fin-full", this.busy === "full" ? "Copying…" : copied("full") ? "Copied" : "Copy full", false, t,
            (_e, cx) => { if (!this.busy) cx.spawn((cx2) => this.copyFull(cx2, addr)); })))
          .when(run?.copyFailed, (el) => el.child(this.button("fin-copy-again", copied("again") ? "Copied" : "Copy again", false, t, (_e, cx2) => this.copyAgain(cx2, addr))))
          .child(this.button("fin-open", "Open tab", false, t, () => showAgent(addr))))
        .when(hasPrompt && !(typed && run.note), (el) => el.child(div().id("fin-hint").text_size(12).text_color(t.muted).child(canRe ? HINT : "Then type /clear in the tab and paste.")))
        .when(Boolean(run?.note), (el) => el.child(div().id("fin-note").whitespace_normal().text_size(13).text_color(run.bad ? t.blocked : t.foreground).child(run.note)))
        .when(this.note?.address === addr, (el) => el.child(div().id("fin-changed").whitespace_normal().text_size(13).text_color(t.blocked).child(this.note.text))));
  }

  // Picking another tab drops the finished runs of the others (a result stays only until the owner looks elsewhere).
  pick(address) {
    this.picked = address; this.note = null;
    for (const [k, run] of [...this.runs]) if (k !== address && run.state === "done") this.runs.delete(k);
  }
}
