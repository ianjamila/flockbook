// The "chat" view: the shown agent's conversation, from the sidecar's `feed` (docs/protocol.md).
// The list is a virtual list with guessed heights (estimate.js): `list` measures rows itself, but it
// cannot be scrolled from code, and the chat must open at the newest message. Every row shows in full.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, run, shared, settings, notify } from "herdr";
import { currentAgent, machineOf, icon, SPIN_MS, FADE, shownScreen, watchEdge, noteWindowHeight, KEY_WIN_H } from "./state.js";
import { Appear } from "./motion.js";
import { now, record, flush, loadTiming } from "./timing.js";
import * as sidecar from "./sidecar.js";
import { emptyFeed, applyFeed, applyOlder, olderFrom } from "./feedstate.js";
import { GUTTER, columnWidth, rowHeight } from "./estimate.js";
import { ROW_PAD_Y, BUBBLE_PAD_X, BUBBLE_PAD_Y, BUBBLE_GAP, IMAGES_FS, bubbleWidth, bubbleTextWidth, CHIP_H, CHIP_PAD_Y, CHIP_GAP, OPEN_INDENT,
  CALL_H, SEP_H, FOOTER_H, STATUS_H, CARD_ROW_H, OTHER_H } from "./metrics.js";
import { Composer } from "./composer.js";
import { markdownView, codeBlockAt } from "./mdblocks.js";
import { reentryPrompt, replyHandoff, handoffFile, askBefore } from "./blocks.js";
import { readFullPrompt } from "./where.js";
import { textScale } from "./config.js";

// Herdr's zoom: line heights round in zoomed px (estimate.js lineHeight).
const appZoom = () => { const z = Number(settings?.()?.zoom); return z > 0 ? z : 1; };
import { openMenu } from "./menu.js";
import { Cards, wanted } from "./cards.js";
import { startTop, overBar, BAR_H, barOver, barRoom, noteScreenHeight } from "./top.js";
import { HelperUI, isRemoteProblem, installedSince } from "./helpercard.js";
import { askOf, askMark, askWords, grantAsk } from "./asks.js";

export const POLL_MS = 2000;
const CHECK_MS = 400;
// Older rows load by themselves while all rows fit on screen (with FILL_PX to spare), at most AUTO_OLDER
// times a chat is opened: a log whose last 2 MB is only tool output can hold no rows for a long way back.
const AUTO_OLDER = 5, FILL_PX = 400;

// A chat chip: a tool chip, a note from another agent, a running call. The caller adds what it shows.
function chip(t) {
  return h_flex().h(CHIP_H).px(10).gap(6).items_center().rounded(14).bg(t.chrome).border(1).border_color(t.border)
    .text_size(12.5).text_color(t.muted);
}

// The chip's SF Symbols name, mapped to one of this mod's icons.
export function chipIcon(symbol) {
  const s = String(symbol || "");
  if (s.startsWith("terminal")) return icon("terminal");
  if (s.startsWith("doc") || s.includes("pencil")) return icon("doc");
  if (s.includes("magnifyingglass")) return icon("search");
  return icon("tool");
}

// ⌘⌥↑ / ⌘⌥↓ (any order of the modifiers): the previous or next space.
export function spaceKey(e) {
  const m = e?.modifiers ?? {};
  if (!(m.platform || m.cmd) || !m.alt || m.shift || m.control) return null;
  return e.key === "up" ? "space.prev" : e.key === "down" ? "space.next" : null;
}

// A tool's input or a label in one line: its first line with text, and " …" when more lines follow.
// A one-line row draws every line of a multi-line text (a heredoc) over the rows around it.
export function oneLine(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/).map((l) => l.replace(/\t/g, " ").trim());
  const i = lines.findIndex(Boolean);
  if (i < 0) return "";
  return lines.slice(i + 1).some(Boolean) ? `${lines[i]} …` : lines[i];
}

// Who sent a note (a user row with `from`, hc's "t2 docs-worker"): its name, else its terminal.
export function noteSender(from) {
  const [id, ...name] = String(from ?? "").trim().split(/\s+/);
  return name.join(" ") || id || "agent";
}

const FULL_RETRY_MS = 60_000; // a hand-off file that could not be read is read again this much later
const PRESS_MS = 1500;       // a press older than this does not say which half of a footer was clicked
const FULL_ZONE_W = 180;     // s28 (Fable): only this much of the footer's right end is "Copy full prompt" (about its button)

export class ChatView {
  constructor(cx) {
    this.scroll = VirtualListScrollHandle.new();
    this.feeds = new Map();      // address → feed state (emptyFeed)
    this.address = null;         // the agent shown
    this.width = 0;              // the pane's width, from on_size_change
    this.follow = true;          // keep the newest row on screen
    this.open = new Set();       // tool rows that show their calls
    this.copied = null;          // the footer row whose "Copy all" was just clicked (says "Copied" for 2 s)
    this.copiedFull = null;      // the footer row whose "Copy full prompt" was just clicked
    this.fullBusy = null;        // the footer row whose full prompt is being read for a click
    this.fullPrompts = new Map(); // "address\nfile" → { text } | { problem, at } | { pending }: hand-off files read
    this.wantFull = new Map();   // the same keys → { address, file }: named by a drawn footer, read on the next tick
    this.pressed = null;         // the last left press on the list: { x, w, at } (which half of a footer line)
    this.granting = null;        // the agent whose ask strip button is sending (Extra round / Merge)
    this.askNotes = new Map();   // address → { text, bad, ask } of its last strip send that did not go out
    this.heights = new WeakMap(); // row → { w, open, k, zoom, h }
    this.busy = false;
    this.lastPoll = 0;
    this.composer = new Composer(cx);
    this.composer.seen = (address) => { const f = this.feeds.get(address); return f ? { agent: f.agent ?? null, path: f.path ?? null } : null; };
    // After `send` refused a new conversation and its log was marked for a new look: read it now. True when the
    // chat follows another log than before.
    this.composer.onNewConversation = async (address, cx) => {
      const f = this.feeds.get(address);
      if (!f || address !== this.address) return false;
      const before = f.path;
      // A poll already running (with the old log) would make this one skip: wait for it, at most a second.
      for (let i = 0; i < 10 && this.busy; i++) await new Promise((r) => cx.timer.after(100, () => r()));
      this.lastPoll = 0; await this.poll(cx);
      return f.path !== before;
    };
    this.barOver = barOver();
    this.top = {}; if (this.barOver) startTop(cx, this.top);
    this.appear = new Appear();
    this.cards = new Cards(cx);
    this.helper = new HelperUI();
    this.refresh = (cx) => { this.lastPoll = 0; return this.poll(cx); };
    this.cards.canFocus = () => this.composer?.empty !== false;
    this.switchTo(currentAgent()?.address ?? null);
    cx.spawn((cx) => this.poll(cx));
    cx.timer.every(CHECK_MS, (cx) => this.tick(cx));
    cx.spawn(async () => { if (await loadTiming()) cx.timer.every(1000, () => flush()); });
  }

  feed() { return this.address ? this.feeds.get(this.address) : null; }

  // Every chat opens at its newest message, also one read before.
  switchTo(address) {
    this.address = address; this.cards.shown = address;
    if (address && !this.feeds.has(address)) this.feeds.set(address, emptyFeed(address));
    this.follow = true; this.open = new Set(); this.autoOlder = 0;
    this.toNewest();
  }

  tick(cx) {
    const a = currentAgent()?.address ?? null;
    if (a !== this.address) { this.switchTo(a); this.lastPoll = 0; cx.notify(); }
    // Coming back to the chat screen (from Overview, Needs you, a shell tab) also opens at the end.
    const screen = shownScreen();
    if (screen === "chat" && this.screen !== "chat") { this.follow = true; this.toNewest(); cx.notify(); }
    this.screen = screen;
    if (this.helper.changed()) cx.notify();
    cx.spawn((cx) => this.composer.pollStatus(cx));
    const agent = currentAgent();
    cx.spawn((cx) => this.cards.poll(cx, this.address, wanted(agent, this.feed()?.rows)));
    if (this.wantOlder) { this.wantOlder = false; cx.spawn((cx) => this.loadOlder(cx)); }
    this.readAhead(cx);
    if (Date.now() - this.lastPoll >= POLL_MS) return this.poll(cx);
  }

  // The first row is on screen and the log goes back further: read the 2 MB before and put it on
  // top, keeping the same row where it was.
  async loadOlder(cx) {
    const f = this.feed();
    const before = f ? olderFrom(f) : null;
    if (before === null || this.olderBusy) return;
    this.olderBusy = true; cx.notify();
    try {
      const t0 = now();
      const answer = await sidecar.older(f.address, before, f.path);
      record("feed.older", now() - t0);
      const added = applyOlder(f, answer, before);
      // Following the end: rows added on top keep the end in view. Reading: the same row stays where it was.
      if (added && f === this.feed()) { if (this.follow) this.toNewest(); else this.scroll.scroll_to_item(added, "top"); }
      // Only tool output in that range: go on back, within the same cap.
      const back = olderFrom(f);
      if (!added && f === this.feed() && back !== null && back < before && this.autoOlder < AUTO_OLDER) { this.autoOlder++; this.wantOlder = true; }
    } finally { this.olderBusy = false; cx.notify(); }
  }

  // One `feed` for the shown agent. Notifies only when rows or the error changed.
  async poll(cx) {
    const f = this.feed();
    if (!f || this.busy) return;
    this.busy = true; this.lastPoll = Date.now();
    try {
      const t0 = now();
      const answer = await sidecar.feed(f.address, f.cursor);
      const t1 = now();
      const at = applyFeed(f, answer);
      // s36: a good read proves the helper there is this version now, also when it was fixed without this card (by
      // hand, from another computer): a plain send's ask and its note go. An ask for an ability it lacks stays.
      const ask = this.composer?.helperAsk;
      if (!answer.error && ask && ask.address === f.address && !(ask.err?.remote?.missing?.length)) {
        this.composer.helperAsk = null;
        if (this.composer.note?.helper) this.composer.note = null;
        cx.notify();
      }
      record("feed.exec", t1 - t0);
      record("feed.apply", now() - t1, at >= 0 ? 1 : 0);
      if (at >= 0 && f === this.feed()) {
        if (this.follow) this.toNewest();
        cx.notify();
      }
    } finally { this.busy = false; }
  }

  toNewest() {
    const n = this.feed()?.rows.length ?? 0;
    if (n) this.scroll.scroll_to_item(n - 1, "top");
  }

  colWidth() { return columnWidth(this.width); }

  height(row) {
    const w = this.colWidth(), open = this.open.has(row.id), k = textScale(), zoom = appZoom();
    const c = this.heights.get(row);
    if (c && c.w === w && c.open === open && c.k === k && c.zoom === zoom) return c.h;
    const h = rowHeight(row, w, open, k, zoom);
    this.heights.set(row, { w, open, k, zoom, h });
    return h;
  }

  // A row's content, without the list's fixed height. No handlers: list rows cannot have any.
  body(row, t) {
    const md = (text, w = this.colWidth()) => markdownView(row.id, text || "", t, w, textScale());
    switch (row.k) {
      case "user":
        if (row.from != null) return this.agentNote(row, t, md);
        return h_flex().w_full().justify_end().py(ROW_PAD_Y)
          .child(v_flex().max_w(bubbleWidth(this.colWidth())).px(BUBBLE_PAD_X).py(BUBBLE_PAD_Y).gap(BUBBLE_GAP).rounded(16).bg(t.raised).text_color(t.foreground)
            .child(md(row.text, bubbleTextWidth(this.colWidth())))
            .when(Boolean(row.images), (el) => el.child(div().text_size(IMAGES_FS).text_color(t.muted).child(row.images === 1 ? "1 image" : `${row.images} images`))));
      case "assistant":
        return div().w_full().py(ROW_PAD_Y).text_color(t.foreground).child(md(row.text));
      case "tools": return this.tools(row, t);
      case "sep":
        return h_flex().w_full().h(SEP_H).items_center().justify_center().text_size(11.5).text_color(t.dim).child(row.text || "");
      case "footer": {
        // A reply that hands over to a fresh session (blocks.js reentryPrompt): "Copy all" beside its time, one click
        // puts the whole prompt on the clipboard (click below; the list gives a whole row, so the line is the button).
        // s27: a prompt naming its hand-off file also gets "Copy full prompt" at the right end (the right half of the
        // line copies the file; click() tells the halves apart).
        const h = this.handoffBefore(row);
        if (!h) return div().w_full().h(FOOTER_H).pt(2).text_size(11.5).text_color(t.dim).child(row.text || "");
        if (h.file && !this.fullPrompts.has(this.fullKey(h.file))) this.wantFull.set(this.fullKey(h.file), { address: this.address, file: h.file });
        const done = this.copied === row.id;
        const button = (id, on, label) => h_flex().id(id).flex_none().gap(5).items_center().px(8).py(2).rounded(8).border(1)
          .border_color(on ? t.done : t.border).text_color(on ? t.done : t.foreground)
          .child(svg(icon(on ? "check" : "copy")).size(12)).child(label);
        const fullDone = this.copiedFull === row.id, fullBusy = this.fullBusy === row.id;
        return h_flex().w_full().h(FOOTER_H).gap(10).items_center().text_size(11.5).text_color(t.dim).cursor_pointer()
          .child(div().flex_none().child(row.text || ""))
          .child(button(`copy-prompt-${row.id}`, done, done ? "Copied" : "Copy all"))
          .when(Boolean(h.file), (el) => el.child(div().flex_1())
            .child(button(`copy-full-${row.id}`, fullDone, fullDone ? "Copied" : fullBusy ? "Copying…" : "Copy full prompt")));
      }
      case "status":
        return h_flex().w_full().h(STATUS_H).items_center().justify_center().text_size(12).text_color(t.muted).child(row.text || "");
      case "perm": {
        // A call without a result yet. Whether it waits for an approval is the card's job (cards.js).
        const what = oneLine(row.text || row.perm?.title || row.perm?.tool) || "a tool";
        const pending = row.perm?.state === "pending";
        return h_flex().w_full().h(CARD_ROW_H).items_center().child(chip(t)
          .child(pending ? svg(icon("spinner")).size(11).text_color(t.working).spin(SPIN_MS) : svg(icon("check")).size(12).text_color(t.done))
          .child(div().max_w(Math.floor(this.colWidth() * 0.8)).truncate().child(pending ? `Running · ${what}` : what)));
      }
      case "question":
        return this.note(t, row.question?.state === "pending" ? "The agent asks a question" : "Question answered");
      default:
        return div().h(OTHER_H);
    }
  }

  note(t, text) {
    return h_flex().w_full().h(CARD_ROW_H).items_center().child(div().px(12).py(6).rounded(10).border(1).border_color(t.border)
      .text_size(12.5).text_color(t.muted).truncate().child(oneLine(text)));
  }

  // A note from another agent: one line, "↳ name: first line", like a tool chip; open, the whole note under it.
  agentNote(row, t, md) {
    const open = this.open.has(row.id);
    const box = v_flex().w_full().py(CHIP_PAD_Y).gap(CHIP_GAP)
      .child(h_flex().child(chip(t)
        .child(div().max_w(this.colWidth() - 40).truncate().child(`↳ ${noteSender(row.from)}: ${oneLine(row.text)}`))
        .child(div().flex_none().text_color(t.dim).child(open ? "▴" : "▾"))));
    if (!open) return box;
    return box.child(div().pl(OPEN_INDENT).text_color(t.muted).child(md(row.text, this.colWidth() - OPEN_INDENT)));
  }

  tools(row, t) {
    const open = this.open.has(row.id);
    const chips = row.chips || [];
    const running = chips.some((c) => (c.calls || []).some((k) => !k.done));
    const box = v_flex().w_full().py(CHIP_PAD_Y).gap(CHIP_GAP)
      .child(h_flex().gap(6).flex_wrap().children(chips.map((c) =>
        chip(t)
          .child(svg(chipIcon(c.symbol)).size(13).flex_none())
          .child(oneLine(c.text))
          .when(running, (el) => el.child(svg(icon("spinner")).size(11).text_color(t.working).spin(SPIN_MS)))
          .child(div().text_color(t.dim).child(open ? "▴" : "▾")))));
    if (!open) return box;
    const calls = chips.flatMap((c) => c.calls || []);
    // One line a call: a row is CALL_H tall (estimate.js counts it so), and clips whatever does not fit.
    return box.child(v_flex().pl(OPEN_INDENT).gap(0).children(calls.map((k) => h_flex().h(CALL_H).overflow_hidden().gap(8).items_center().text_size(12)
      .child(div().flex_none().text_color(t.foreground).child(oneLine(k.name) || "tool"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(oneLine(k.summary)))
      .child(k.error ? div().flex_none().text_color(t.blocked).child("failed")
        : k.done ? svg(icon("check")).size(12).flex_none().text_color(t.done)
        : svg(icon("spinner")).size(11).flex_none().text_color(t.working).spin(SPIN_MS)))));
  }

  // One list row: the guessed height and the reading column.
  item(row, t) {
    const pad = Math.max(GUTTER, Math.floor((this.width - this.colWidth()) / 2));
    return div().h(this.height(row)).w_full().px(pad).overflow_hidden().child(this.body(row, t));
  }

  // Right-click on a message (the user's, the agent's, a note from another agent): "Copy message", its markdown
  // as written; on a code box "Copy code" for that box first. Other rows: no menu. The list gives the press
  // against the row's box; the row's padding (and the first row's bar) is taken off to get the text's y.
  // Copy message works whatever the selection: a drag across two text views, or a redraw while the agent
  // writes, can leave ⌘C with nothing to copy.
  rowMenu(key, e, cx) {
    const rows = this.feed()?.rows ?? [];
    const i = rows.findIndex((r) => r.id === key);
    const row = rows[i], y0 = e?.local_position?.y;
    if (!row || !(row.k === "assistant" || row.k === "user")) return null;
    const items = [];
    const w = this.colWidth();
    const at = typeof y0 !== "number" ? null : row.k === "assistant" ? { y: y0 - ROW_PAD_Y, w }
      : row.from == null ? { y: y0 - ROW_PAD_Y - BUBBLE_PAD_Y, w: bubbleTextWidth(w) } : null;
    const code = at ? codeBlockAt(row.text || "", at.w, at.y - (i === 0 ? barRoom(this.barOver) : 0), textScale(), appZoom()) : null;
    if (code !== null) items.push({ label: "Copy code", act: "copy", args: { text: code } });
    const prompt = row.k === "assistant" ? reentryPrompt(row.text, this.askBefore(rows, i)) : null;
    // s27: the hand-off file it names, once read (the tick reads it ahead; a menu opened before that starts the read).
    const file = prompt ? handoffFile(prompt) ?? handoffFile(row.text) : null;
    const full = file ? this.fullPrompts.get(this.fullKey(file)) : null;
    if (full?.text) items.push({ label: "Copy full re-entry prompt", act: "copy", args: { text: full.text } });
    else if (file && !full && cx?.spawn) cx.spawn(() => this.loadFull(this.address, file));
    if (prompt) items.push({ label: "Copy re-entry prompt", act: "copy", args: { text: prompt } });
    items.push({ label: "Copy message", act: "copy", args: { text: row.text || "" } });
    return openMenu(items);
  }

  // The re-entry prompt of the reply this footer ends: its last assistant text with one, back to the user's message.
  // The owner's message the reply ending before row `i` answers (blocks.js askBefore).
  askBefore(rows, i) { return askBefore(rows, i); }

  // The re-entry prompt of the reply this footer ends (blocks.js replyHandoff, which the Overview shares).
  promptBefore(footer) { return this.handoffBefore(footer)?.prompt ?? null; }
  // The same with the hand-off file it names: { prompt, file } or null (blocks.js replyHandoff).
  handoffBefore(footer) {
    const rows = this.feed()?.rows ?? [];
    return replyHandoff(rows, rows.findIndex((r) => r.id === footer.id));
  }

  // s27 "Copy full prompt": hand-off files, read once per chat on the tab's machine (where.js readFullPrompt).
  fullKey(file, address = this.address) { return `${address}\n${file}`; }
  // `fresh`: never the read already under way (a press, s28 Codex R2: it may have read the file before a rewrite). Each
  // read is numbered per file; only the newest one started may store its result (an older one finishing late is dropped).
  async loadFull(address, file, fresh = false) {
    const key = this.fullKey(file, address);
    const had = this.fullPrompts.get(key);
    if (had?.pending && !fresh) return had.pending;
    this.fullSeq = (this.fullSeq ?? 0) + 1;
    const seq = this.fullSeq;
    (this.fullLatest ??= new Map()).set(key, seq);
    const pending = readFullPrompt(address, file).catch((e) => ({ problem: String(e?.message ?? e) }));
    this.fullPrompts.set(key, { pending });
    const r = await pending;
    if (this.fullLatest.get(key) === seq) this.fullPrompts.set(key, r.text ? { text: r.text } : { problem: r.problem, at: Date.now() });
    return r;
  }
  // From the tick: the newest reply's file and those drawn footers named; a failed read is tried again a minute on.
  // s28 (Codex R1 P2): a reply that ends (a new footer row) may have rewritten a hand-off file read before, so what was
  // read is dropped then and read again (the right-click menu copies it as read).
  readAhead(cx) {
    const f = this.feed();
    const lastFooter = f?.rows ? [...f.rows].reverse().find((r) => r.k === "footer")?.id ?? null : null;
    if (this.fullSig !== undefined && lastFooter !== this.fullSig) {
      // Reads still under way read the file before this reply ended: their results are dropped too (R2).
      for (const k of [...this.fullPrompts.keys()]) { this.fullPrompts.delete(k); this.fullSeq = (this.fullSeq ?? 0) + 1; (this.fullLatest ??= new Map()).set(k, this.fullSeq); }
    }
    this.fullSig = lastFooter;
    const want = new Map(this.wantFull);
    this.wantFull.clear();
    const newest = f?.loaded ? replyHandoff(f.rows ?? []) : null;
    if (newest?.file) want.set(this.fullKey(newest.file), { address: this.address, file: newest.file });
    for (const [key, w] of want) {
      const had = this.fullPrompts.get(key);
      if (had && !(had.problem && Date.now() - had.at >= FULL_RETRY_MS)) continue;
      cx.spawn(() => this.loadFull(w.address, w.file));
    }
  }
  // Which half of a footer line the click was on: the press the list box saw just before (a list row has no handlers
  // of its own, RECIPE.md). No press seen: not the right half, so a click never guesses at the file.
  rightHalf() {
    const p = this.pressed;
    this.pressed = null;
    return Boolean(p && Date.now() - p.at < PRESS_MS && p.w > 0 && p.x >= Math.max(p.w / 2, p.w - FULL_ZONE_W));
  }
  // "Copy full prompt": the hand-off file on the clipboard, a notice, "Copied" for 2 s. Not readable: a warning.
  async copyFull(row, cx) {
    const h = this.handoffBefore(row);
    if (!h?.file) return this.copyPrompt(row, cx);
    if (typeof cx?.write_to_clipboard !== "function") {
      notify({ title: "Couldn't copy the full prompt: no clipboard here. Right-click the reply → Copy full re-entry prompt.", level: "warning", timeout: 3000 });
      return;
    }
    // Read again on every press (s28 Codex R1 P2: a newer reply may have rewritten the file since it was read).
    const address = this.address;
    if (this.fullBusy) return;
    this.fullBusy = row.id; cx.notify?.();
    let got;
    try { got = await this.loadFull(address, h.file, true); } finally { this.fullBusy = null; }
    if (!got?.text) {
      notify({ title: `Couldn't read the full prompt (${h.file}): ${got?.problem ?? "unknown error"}. Copy all copies the short one.`, level: "warning", timeout: 5000 });
      cx.notify?.();
      return;
    }
    cx.write_to_clipboard(got.text);
    notify({ title: "Full re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
    this.copiedFull = row.id;
    cx.notify?.();
    cx.timer?.after?.(2000, (cx2) => { if (this.copiedFull === row.id) { this.copiedFull = null; cx2?.notify?.(); } });
  }

  // The ask strip's Extra round / Merge button (owner 11-13: "theres no button here"): the same checked send as Needs
  // you's buttons (asks.js grantAsk). Sent → the ask is answered and the strip goes, so a notice says it; not sent →
  // the reason shows in the strip.
  async grant(cx, address, ask) {
    if (this.granting) return;
    this.granting = address; this.askNotes.delete(address); cx.notify?.();
    let note;
    try { note = await grantAsk(address, ask); } catch { note = { text: `Not sent. Type “${askWords(ask)}” below.`, bad: true, sent: false }; } finally { this.granting = null; }
    if (note.sent) notify({ title: note.text, level: "info", timeout: 3000 });
    else this.askNotes.set(address, { ...note, ask: JSON.stringify(ask) });
    cx.notify?.();
  }

  // "Copy all": the prompt on the clipboard, a short notice, and the button says "Copied" for 2 s.
  copyPrompt(row, cx) {
    const p = this.promptBefore(row);
    if (!p) return;
    if (typeof cx?.write_to_clipboard !== "function") {
      notify({ title: "Couldn't copy the re-entry prompt: no clipboard here. Right-click the reply → Copy re-entry prompt.", level: "warning", timeout: 3000 });
      return;
    }
    cx.write_to_clipboard(p);
    notify({ title: "Re-entry prompt copied to the clipboard", level: "info", timeout: 2000 });
    this.copied = row.id;
    cx.notify?.();
    cx.timer?.after?.(2000, (cx2) => { if (this.copied === row.id) { this.copied = null; cx2?.notify?.(); } });
  }

  click(key, cx) {
    const row = this.feed()?.rows.find((r) => r.id === key);
    if (!row) return;
    if (row.k === "footer") {
      const file = this.rightHalf() ? this.handoffBefore(row)?.file : null;
      if (file) {
        // Read now (never an earlier read: the file may have changed), then copied, as the Overview's copy does.
        if (typeof cx?.spawn !== "function") { this.copyFull(row, cx); return; }
        cx.spawn((cx2) => this.copyFull(row, typeof cx2?.write_to_clipboard === "function" ? cx2 : cx));
        return;
      }
      return this.copyPrompt(row, cx);
    }
    if (row.k === "tools" || (row.k === "user" && row.from != null)) {
      if (this.open.has(row.id)) this.open.delete(row.id); else this.open.add(row.id);
      cx.notify();
    }
  }

  // s32: the helper card a Send anyway asked for (composer.helperAsk: the helper there is older), for this tab only;
  // installed → the ask goes and the chat reloads.
  // s34: not while the chat's own card shows (a feed that failed for the same reason: no second card).
  sendHelperCard(t) {
    const ask = this.composer?.helperAsk;
    if (!ask || ask.address !== this.address || isRemoteProblem(this.feed()?.error)) return null;
    // Installed since, from any card (the chat's own, Needs you's): the ask goes; a plain send's note with it (a Send
    // anyway's note keeps its button, to press again).
    if (installedSince(ask.err.install.machine, ask.at)) {
      this.composer.helperAsk = null;
      if (this.composer.note?.helper) this.composer.note = null;
      return null;
    }
    return this.helper.sendCard(t, ask.err, async (cx) => { this.composer.helperAsk = null; await this.refresh(cx); });
  }

  // A failed `feed` in words people can act on; the sidecar's own message small below.
  problem(t, err) {
    if (isRemoteProblem(err)) return this.helper.problem(t, err, machineOf(this.address), this.refresh);
    // Helper on other machines: Never. One plain line: it is off, and where to turn it on.
    if (err.code === "remote-off") return this.center(t, err.message || "Flockbook does not run its helper on other machines. To change it: Flockbook settings.");
    const say = {
      "not-agent": "This terminal runs no agent.",
      "no-terminal": "This agent's terminal is gone.",
      "no-core": "herdr-core is not running.",
      core: "herdr-core did not answer. Trying again.",
      locate: "This agent's conversation was not found yet.",
      read: "This agent's conversation could not be read.",
      "no-sidecar": "The Flockbook helper is missing. Get it from github.com/minchenlee/flockbook/releases.",
      protocol: "The Flockbook helper does not match this version. Install both again.",
    }[err.code] ?? "The conversation could not be loaded.";
    return v_flex().size_full().items_center().justify_center().gap(6).px(32)
      .child(div().text_size(13.5).text_color(t.foreground).child(say))
      .child(div().max_w(560).text_size(11.5).text_color(t.dim).truncate().child(err.message || ""));
  }

  center(t, text) {
    return v_flex().size_full().items_center().justify_center().px(24).text_size(13).text_color(t.muted).child(text);
  }

  list(t, f) {
    const rows = f.rows, n = rows.length;
    // The first row starts below the bar; the rest scroll up under it (no room when the bar is outside).
    const sizes = rows.map((r, i) => this.height(r) + (i === 0 ? barRoom(this.barOver) : 0));
    const box = v_flex().id("chat-list").relative().flex_1().min_h(0)
      .on_mouse_down("left", (e) => {
        const w = e?.bounds?.size?.width ?? this.listSize?.w ?? 0;
        this.pressed = typeof e?.local_position?.x === "number" ? { x: e.local_position.x, w, at: Date.now() } : null;
      })
      // The list keeps its scroll when its room changes: the status rows, an ask strip or a card under it, or a
      // narrower pane (rows re-wrap taller). While following, that left the newest row half under the reply box
      // (owner 11-13: a footer and its Copy all cut off), so a size change scrolls back to it.
      .on_size_change((size, cx) => {
        const was = this.listSize;
        this.listSize = { w: size?.width ?? 0, h: size?.height ?? 0 };
        if (was && Math.abs(was.w - this.listSize.w) < 1 && Math.abs(was.h - this.listSize.h) < 1) return;
        if (this.follow) { this.toNewest(); cx?.notify?.(); }
      })
      .on_scroll_wheel((e, cx) => {
        const up = e?.delta?.y > 0;
        if (this.follow && up) { this.follow = false; cx.notify(); }
        // Older rows load only when you scroll up while the first row is on screen.
        if (up && this.topSeen && f.start) this.wantOlder = true;
      })
      .child(v_virtual_list("chat", n, sizes, (i) => rows[i].id, (range) => {
        const t0 = now();
        if (range.end >= n) this.follow = true;
        this.topSeen = range.start === 0;
        // All rows fit on screen: a list that does not scroll gets no wheel to load older rows, so load them here.
        const fits = range.end >= n || sizes.reduce((a, b) => a + b, 0) < (shared(KEY_WIN_H) ?? 800) + FILL_PX;
        if (this.topSeen && fits && !this.wantOlder && !this.olderBusy && this.autoOlder < AUTO_OLDER && olderFrom(f) !== null) {
          this.autoOlder++; this.wantOlder = true;
        }
        const out = [];
        for (let i = range.start; i < range.end; i++) out.push(i === 0 ? div().w_full().pt(barRoom(this.barOver)).child(this.item(rows[i], t)) : this.item(rows[i], t));
        record("chat.rows", now() - t0, range.end - range.start);
        return out;
      }).track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx))
        .on_item_secondary_click((key, e, cx) => this.rowMenu(key, e, cx)))
      .child(Scrollbar.vertical("chat").absolute().inset_0());
    // A round ↓ that fades in while you read older messages and out when you are back at the end.
    if (n) {
      box.child(h_flex().absolute().bottom(12).left(0).right(0).justify_center()
        .child(div().id("jump").size(34).flex().items_center().justify_center().rounded(17)
          .bg(t.raised).border(1).border_color(t.border).shadow_sm().text_color(t.foreground)
          .opacity(this.follow ? 0 : 1).transition("opacity", FADE)
          .when(!this.follow, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { if (this.follow) return; this.follow = true; this.toNewest(); cx.notify(); })
          .child(svg(icon("arrow-down")).size(15))));
    }
    // While older rows load: a small note under the bar's tabs. Drawn only then: a hidden spinner still costs frames.
    if (this.olderBusy) box.child(h_flex().absolute().top(barRoom(this.barOver) + 6).left(0).right(0).justify_center()
      .child(h_flex().id("older").h(26).px(12).gap(6).items_center().rounded(13).bg(t.raised).border(1).border_color(t.border)
        .text_size(12).text_color(t.muted)
        .child(svg(icon("spinner")).size(11).spin(SPIN_MS)).child("Loading earlier messages")));
    return box;
  }

  render(cx) {
    const t0 = now();
    try { return this.draw(cx); } finally { record("chat.render", now() - t0); }
  }

  draw(cx) {
    const t = theme();
    const f = this.feed();
    let main;
    if (!f) main = this.center(t, "No agent to show. Start one with +.");
    else if (f.error && !f.rows.length) main = this.problem(t, f.error);
    else if (!f.loaded) main = this.center(t, "Loading…");
    else if (!f.rows.length) main = this.center(t, f.path ? "No messages yet." : "No conversation yet. Send the first message.");
    else main = this.list(t, f);
    const stop = (_e, cx) => cx.stop_propagation();
    return watchEdge(v_flex().id("root").relative().size_full().min_w(0).bg(t.background))
      .on_size_change((size, cx) => { noteScreenHeight(size, this.barOver); if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .on_drop((e, cx) => this.composer.addFiles(e?.paths, cx))
      // The chat input keeps ⌘⌥↑/↓ from the app's keys, so the chat switches spaces itself.
      .on_key_down((e, cx) => { const go = spaceKey(e); if (go) { cx.stop_propagation?.(); run(go); } })
      // Another agent's chat fades in; a new card fades in and rises into place.
      // No press stop on the content: under Herdr 0.1.13 an ancestor's stop_propagation on the left press
      // makes TextView text unselectable. So with the bar drawn over the chat (its block has window_drag),
      // a drag on the text moves the window. The layout puts the bar outside (props.bar) so it does not.
      // The reply box and the cards keep their stops.
      .child(v_flex().flex_1().min_h(0)
        .child(this.appear.wrap(main, "chat-body", this.address, cx).flex_1().min_h(0).flex().flex_col()))
      .when(Boolean(this.sendHelperCard(t)), (el) => el.child(h_flex().w_full().px(16).pt(8).justify_center()
        .on_mouse_down("left", stop).child(this.sendHelperCard(t))))
      .when(Boolean(this.helper.removeCard(t, this.refresh)), (el) => el.child(h_flex().w_full().px(16).pt(8).justify_center()
        .on_mouse_down("left", stop).child(this.helper.removeCard(t, this.refresh))))
      .when(Boolean(f) && f.error?.code !== "not-agent" && !isRemoteProblem(f.error), (el) => {
        const card = this.cards.view(this.address, t, "chat-card");
        // What the reply ends asking for (an extra round, a merge, a migration go), as a strip over the reply box: the
        // ask's line is easy to miss at the end of a long reply (owner 11-12). Not while a question card shows.
        const ask = card ? null : askOf(this.address), mark = askMark(ask);
        if (mark) {
          // Extra round / Merge as a button here too (owner 11-13), coloured as on Needs you: round = working, merge = done.
          const address = this.address, words = askWords(ask), busy = this.granting === address, round = ask.kind === "round";
          // A note is about the ask it was sent for: a later, different ask starts clean.
          const note = this.askNotes.get(address)?.ask === JSON.stringify(ask) ? this.askNotes.get(address) : null;
          el.child(h_flex().w_full().px(16).pt(8).justify_center().on_mouse_down("left", stop)
            .child(h_flex().id("chat-ask").w_full().max_w(800).px(14).py(8).gap(10).items_center().rounded(12)
              .bg(t.raised).border(1).border_color(t.accent)
              .child(div().flex_none().text_size(18).child(mark.glyph))
              .child(v_flex().flex_1().min_w(0)
                .child(div().truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(mark.title))
                .child(div().text_size(12).text_color(t.muted).child(mark.hint))
                .when(Boolean(note), (n) => n.child(div().id("chat-ask-note").text_size(12).text_color(note.bad ? t.blocked : t.muted).child(note.text))))
              .when(Boolean(words), (b) => b.child(div().id(round ? "chat-ask-round" : "chat-ask-merge").flex_none().px(14).h(32).flex().items_center()
                .rounded(8).text_size(13).font_semibold()
                .bg(busy ? t.chrome : round ? t.working : t.done).text_color(busy ? t.dim : t.background)
                .when(!busy, (x) => x.hover((y) => y.opacity(0.9)).on_click((_e, cx) => cx.spawn((cx) => this.grant(cx, address, ask))))
                .child(busy ? "Sending…" : round ? "🔁 Extra round" : "🔀 Merge")))));
        }
        if (card) el.child(this.appear.wrap(h_flex().w_full().px(16).pt(8).justify_center().on_mouse_down("left", stop).child(card), "chat-card-in", `${this.address}:${this.cards.key?.(this.address) ?? ""}`, cx, 10));
        return el.child(div().w_full().on_mouse_down("left", stop).child(this.composer.render(currentAgent(), t)));
      })
      .when(this.barOver, (el) => el.child(overBar(t)));
  }
}
