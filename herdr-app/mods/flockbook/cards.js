// What an agent waits for: an approval ("Do you want to run …?") or a question, as a card with
// buttons. Read with the sidecar's `card`; answered with `approve` and `answer` (docs/protocol.md).
// Keys go out only on a button press or a key, never on a timer: that includes "Show all", which
// walks the picker's tabs (`card --all`).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { shared, setShared, hc } from "herdr";
import { agents } from "./parked.js";
import { icon, openTerminal, KEY_TERM } from "./state.js";
import * as sidecar from "./sidecar.js";
import { elicitation, elicitFocus, noteElicit, captureElicit } from "./asks.js";

export const CARD_MS = 1500;
// An answer's "another agent is in this pane": the sidecar's check before each key failed, and for a question that
// check also wants the exact question on screen (herdr-core question::answer_question), so an agent still drawing
// (a busy machine) fails it the same way. The check runs before each key, the first one too, and the sidecar does
// not say which one failed: nothing went in when it failed at the first key, some picks may be in otherwise.
export const STOPPED_ANSWER = "Flockbook stopped: the screen no longer matched this question (still drawing, or another agent in the pane). Nothing went in if it stopped before the first key; otherwise your first picks may be in. Check the terminal (ctrl-`) before trying again.";
// Typed answers go to the agent key by key through Herdr (hc keys), which has key names only for these: letters,
// digits, space and the unshifted symbols. The sidecar refuses any other character before the first key ("the typed
// answer has characters Herdr cannot type yet … answer in the terminal": flockbook-helper-fixes.patch, can_type).
const TYPEABLE = /^[A-Za-z0-9 ',.;\/\-=[\]\\`]$/;
// The characters of the own answers Herdr can't type, each once ("!?é"), or "" when all can go. Only a picker's
// answers are typed key by key: a question answered by a message (`q.delivery` "message", Codex) goes as text, so
// any character goes (herdr-core question::answer_question sends it before the key check).
export function untypeable(others = new Map(), q = null) {
  if (q?.delivery === "message") return "";
  const bad = new Set();
  for (const v of others.values()) for (const ch of String(v ?? "").trim()) if (!TYPEABLE.test(ch)) bad.add(ch);
  return [...bad].join("");
}
export const UNTYPEABLE = (chars) => `Herdr can't type ${[...chars].map((c) => c === " " ? "space" : c === "\n" ? "a new line" : `“${c}”`).join(" ")} yet, so this answer can't go from here. Reword it (letters, digits, spaces and ' , . ; / - = [ ] \\ \` only), or answer in the terminal.`;
// The sidecar's own refusal of such an answer, for a card that was sent anyway (an older check here, a race).
export const cannotType = (note) => /cannot type/i.test(String(note ?? ""));
// The sidecar's review check (herdr-core question/claude_exact.rs review_ambiguous): a Claude question asked through
// its tool (not on screen only) with 2+ questions, or a multi-choice last one, ends on Claude's review screen, which
// lists the picks joined by commas. An option name with a comma or a review mark (● →), two names alike (spaces
// dropped), a question text with a review mark, or an own answer with a comma, a review mark or alike an option:
// the sidecar refuses before any key ("the review screen could not show which options were picked"). Checked here
// first, so the card says so before Send. "option": no answer can go from here; "own": the own answer can't.
const reviewMark = (s) => /[●→]/.test(s);
export function reviewBlocked(q, others = new Map()) {
  const qs = q?.questions ?? [];
  const hooked = (q?.agent ?? "claude") === "claude" && !String(q?.toolUseId ?? "").startsWith("screen-");
  if (!hooked || q?.delivery === "message" || !(qs.length > 1 || qs[qs.length - 1]?.multi)) return null;
  for (const [k, x] of qs.entries()) {
    // A comma counts only in a multi-choice question: a single-choice one's review line shows one answer, not
    // picks joined by commas (11-12: every "Yes, …" / "No / not yet" card was sent to the terminal).
    const comma = (s) => Boolean(x.multi) && s.includes(",");
    const names = (x.options ?? []).map((o) => String(o.label ?? "").replace(/\s+/g, ""));
    if (reviewMark(x.text ?? "") || names.some((n) => comma(n) || reviewMark(n)) || new Set(names).size !== names.length) return "option";
    const own = String(others.get(k) ?? "").replace(/\s+/g, "");
    if (own && (comma(own) || reviewMark(own) || names.includes(own))) return "own";
  }
  return null;
}
export const REVIEW_OPTION = "Answer this one in the terminal: an option's name has a comma (or ● →), so Flockbook can't check your picks on Claude's review screen and won't send them.";
export const REVIEW_OWN = "Your own answer has a comma (or ● →, or matches an option), so Flockbook can't check it on Claude's review screen. Reword it, or answer in the terminal.";
const KEY_FULL = "flockbook.card.full"; // { address, card }: that full card

// The MCP-prompt reader (elicitation) lives in asks.js now, so the asks tick reads it too (s10).
export { elicitation };

// Whether to read the card: herdr-app shows the agent as blocked, or the log ends with a call that
// waits (a pending perm or question row).
export function wanted(agent, rows) {
  if (!agent) return false;
  if (agent.status === "blocked") return true;
  const last = (rows || []).filter((r) => r.k === "perm" || r.k === "question").at(-1);
  return Boolean(last && (last.perm?.state === "pending" || last.question?.state === "pending"));
}

// The answers `answer --answers` takes, from the picks and "other" texts. Null while one is empty.
export function answersFor(question, picks, others) {
  const out = [];
  for (let i = 0; i < (question?.questions ?? []).length; i++) {
    const p = [...(picks.get(i) ?? [])].sort((a, b) => a - b);
    const other = (others.get(i) ?? "").trim();
    if (!p.length && !other) return null;
    out.push(other ? { picks: p, other } : { picks: p });
  }
  return out.length ? out : null;
}

// The answers so far, for `card --answers` (the sidecar checks the own answers against the review rule). Null
// while no own answer is typed: then the card's labels alone decide.
export function draftFor(question, picks, others) {
  const qs = question?.questions ?? [];
  if (!qs.some((_q, i) => (others.get(i) ?? "").trim())) return null;
  return qs.map((_q, i) => {
    const p = [...(picks.get(i) ?? [])].sort((a, b) => a - b);
    const other = (others.get(i) ?? "").trim();
    return other ? { picks: p, other } : { picks: p };
  });
}

export const MAX_QUESTIONS = 4;

// Whether question `qi` has a pick or an own answer.
const answered = (en, qi) => Boolean(en.picks.get(qi)?.size || (en.others.get(qi) ?? "").trim());

// A digit key's number (1-9), or null.
// An own answer stays on one line: Enter in the box (or a pasted line break) would put a new line in it,
// and a new line can't be typed into Claude's question. Line breaks and the spaces around them → one space.
export function oneLine(v) {
  return String(v ?? "").replace(/[ \t]*\r?\n[ \t]*/g, " ").trim();
}

export function digit(e) {
  const m = e?.modifiers ?? {};
  if (m.platform || m.cmd || m.control || m.alt) return null;
  return /^[1-9]$/.test(e?.key ?? "") ? Number(e.key) : null;
}

export class Cards {
  // The "other answer" boxes are made here, once: a view may not make input state while it draws.
  // `cx`: for the card's own focus, so 1-9 and Enter reach it and not the reply box.
  constructor(cx) {
    this.focus = cx?.focus_handle?.() ?? null;
    this.canFocus = () => true;   // the chat says no while you type a reply
    this.byAgent = new Map();
    // A pause between a key and the next screen read (tests make it instant).
    this.wait = (cx, ms) => new Promise((res) => (cx?.timer?.after ? cx.timer.after(ms, () => res()) : setTimeout(res, ms)));
    this.address = null;   // whose card the boxes belong to now
    // Which own-answer box has the keyboard (its question), or null. While one has it, the card's own key
    // handler leaves 1-9 and Enter alone so they type into the box. (The row used to stop every key
    // instead, and a stopped key never reaches a text box as typed text: nothing could be typed, s12.)
    this.typingIn = null;
    this.others = Array.from({ length: MAX_QUESTIONS }, (_v, qi) => {
      const input = TextareaState.new({ placeholder: "Or type your own answer", rows: 1 });
      input.on("focus", () => { this.typingIn = qi; });
      input.on("blur", () => { if (this.typingIn === qi) this.typingIn = null; });
      input.on("change", (_e, cx) => {
        // A new line (Enter, Shift+Enter, a paste) becomes a space (a repeat change from set_value is harmless).
        let v = input.value();
        if (/\n/.test(v)) { v = oneLine(v); input.set_value(v); }
        const e = this.byAgent.get(this.address); if (!e) return;
        const was = Boolean((e.others.get(qi) ?? "").trim());
        e.others.set(qi, v);
        // The card's `blocked` (the helper's review check) may change with it: the next poll reads it again at once.
        if (e.card?.kind === "question") e.at = 0;
        if (was !== Boolean(v.trim())) cx.notify();
      });
      // Enter in the box does what Enter on the card does: the next question, or send.
      input.on("submit", (e, cx) => { if (!e?.shift) this.enter(cx, this.address); });
      return input;
    });
  }

  entry(address) {
    let e = this.byAgent.get(address);
    if (!e) { e = { card: null, at: 0, busy: false, sending: false, note: null, picks: new Map(), others: new Map() }; this.byAgent.set(address, e); }
    return e;
  }

  card(address) { return this.byAgent.get(address)?.card ?? null; }

  // What the card asks, as a short key: a new request gets a new key (and fades in again).
  key(address) {
    const c = this.card(address);
    return c ? `${c.kind}:${c.command ?? c.title ?? c.questions?.[0]?.question ?? ""}` : "";
  }

  // Reads the card when `want`, at most every CARD_MS unless `force`. Drops it when not wanted.
  async poll(cx, address, want, force = false) {
    if (!address) return;
    const e = this.entry(address);
    if (!want) { if (e.card) { e.card = null; e.note = null; cx.notify(); } return; }
    if (e.busy || e.sending || (!force && Date.now() - e.at < CARD_MS)) return;
    e.busy = true; e.at = Date.now();
    try {
      const r = await sidecar.card(address, false, e.card?.kind === "question" ? draftFor(e.card.question, e.picks, e.others) : null);
      const line = r.error ? null : r.lines.find((l) => l.type === "card");
      let card = line && line.kind ? line : null;
      // No card from the helper: an MCP server's input request on screen (elicitation) gets one of its own.
      if (!card && !r.error) {
        const scr = await hc(["read", address]).catch(() => null);
        const el = scr?.code === 0 ? elicitation(scr.stdout) : null;
        // The card shows (and a press compares) the whole request, not the 1200-char cut (s28 Codex R1).
        if (el) card = { kind: "elicitation", server: el.server, text: el.full, answerable: el.answerable, request: `elicit:${el.server}:${el.full.length}:${el.full.slice(0, 80)}:${el.full.slice(-80)}` };
        // The sidebar's 🔌 sees it now, not at the next asks tick.
        if (scr?.code === 0) noteElicit(address, el);
        // The first real one is saved for the layout check (s29), read only.
        if (scr?.code === 0) void captureElicit(address, scr.stdout);
      } else if (card) noteElicit(address, null);
      // The screen shows one question at a time; keep the full set read with "Show all".
      if (card && e.card && card.request === e.card.request && card.unread > 0 && !e.card.unread) card = e.card;
      // Another view read it in full already.
      const full = shared(KEY_FULL);
      if (card?.unread > 0 && full?.address === address && full.card?.request === card.request) card = full.card;
      const fresh = card && card.request !== e.card?.request;
      if (JSON.stringify(card) !== JSON.stringify(e.card)) {
        if (card?.request !== e.card?.request) { e.picks = new Map(); e.others = new Map(); e.note = null; e.step = 0; if (this.address === address) this.others.forEach((i) => i.set_value("")); }
        e.card = card; cx.notify();
      }
      // A new card takes the keyboard (1-9, Enter), unless you are typing a reply.
      if (fresh && address === this.shown && this.focus && this.canFocus()) this.focus.focus();
      if (!e.read) { e.read = true; cx.notify(); }
    } finally { e.busy = false; }
  }

  // "Show all N questions": walks the picker's tabs (keys go out, on this click only) and keeps the
  // full card, shared so the other views show it too.
  async loadAll(cx, address) {
    const e = this.entry(address);
    if (e.sending || !e.card?.unread) return;
    e.sending = true; e.note = null; cx.notify();
    try {
      const r = await sidecar.card(address, true);
      const line = r.error ? null : r.lines.find((l) => l.type === "card");
      if (line?.kind === "question" && line.request === e.card.request && !line.unread) { e.card = line; setShared(KEY_FULL, { address, card: line }); }
      else e.note = r.error?.message || "Could not read the other questions. Answer them in the agent's terminal.";
    } finally { e.sending = false; cx.notify(); }
  }

  // 1-9 picks an option of the first question without a pick (a multi-choice one: toggles);
  // on an approval 1 allows once and 2 denies. Enter sends the answer. True when it took the key.
  key_down(e, cx, address) {
    // A key that reaches the card while the card itself lacks the keyboard comes from its own-answer box (s13 F2:
    // the card's focus decides, so a missed blur can't leave the shortcuts dead). Escape there hands the keyboard
    // back to the card, nothing sent or cleared (F3); every other key types into the box.
    if (this.focus ? !this.focus.is_focused() : this.typingIn !== null) {
      if (e?.key === "escape" && this.focus) { this.typingIn = null; this.focus.focus(); cx.notify?.(); return true; }
      return false;
    }
    const en = this.byAgent.get(address), c = en?.card;
    if (!c || en.sending || c.kind === "elicitation") return false;
    const n = digit(e);
    if (c.kind === "approval") {
      // Answered already (the sidecar keeps one answer per prompt): the keys stay with whoever has the focus.
      if (c.answered) return false;
      if (n === 1 || n === 2) { cx.spawn((cx) => this.approve(cx, address, n === 1)); return true; }
      return false;
    }
    if (e?.key === "enter") return this.enter(cx, address);
    const qs = c.question?.questions ?? [];
    if (n === null) return false;
    const qi = Math.min(en.step ?? 0, qs.length - 1);
    // The number after the options moves the keyboard into the own-answer box.
    if (n - 1 === (qs[qi]?.options ?? []).length && this.others[qi]) { this.others[qi].focus?.(); return true; }
    if (!this.pick(en, qs, qi, n - 1)) return false;
    cx.notify();
    return true;
  }

  // Enter, on the card or in an own-answer box: the next question once this one is answered, else send
  // when the answers can go. Moving on from a box gives the keyboard back to the card (its box is gone),
  // so 1-9 pick on the next question. True when it did something.
  enter(cx, address) {
    const en = this.byAgent.get(address), c = en?.card;
    if (!c || en.sending || c.kind === "approval" || c.kind === "elicitation" || c.unread > 0) return false;
    const qs = c.question?.questions ?? [];
    const step = en.step ?? 0;
    if (step < qs.length - 1) {
      if (!answered(en, step)) return false;
      en.step = step + 1;
      if (this.typingIn !== null) { this.typingIn = null; this.focus?.focus(); }
      cx.notify(); return true;
    }
    if (!c.blocked && answersFor(c.question, en.picks, en.others) && !reviewBlocked(c.question, en.others) && !untypeable(en.others, c.question)) { cx.spawn((cx) => this.answer(cx, address)); return true; }
    return false;
  }

  // The own-answer boxes are shared by every card: fill them with `address`'s text when its card is shown. The
  // address is set FIRST: set_value fires "change", which stores the box's text for `this.address` (s13: it used
  // to write the new card's text into the previous tab's answer).
  hydrate(address) {
    if (this.address === address) return;
    this.address = address;
    const e = this.byAgent.get(address);
    this.others.forEach((b, k) => b.set_value(e?.others.get(k) ?? ""));
  }

  // Picks option `oi` of question `qi`. A one-choice pick moves on to the next question.
  pick(en, qs, qi, oi) {
    const q = qs[qi];
    if (!q || oi >= (q.options ?? []).length) return false;
    const s = new Set(q.multi ? en.picks.get(qi) ?? [] : []);
    if (s.has(oi)) s.delete(oi); else s.add(oi);
    en.picks.set(qi, s);
    if (!q.multi && s.size && qi < qs.length - 1) en.step = qi + 1;
    return true;
  }

  async act(cx, address, run, stopped = sidecar.AGENT_CHANGED) {
    const e = this.entry(address);
    if (e.sending || !e.card) return;
    e.sending = true; e.note = null; cx.notify();
    let note = null;
    try {
      const r = await run(e.card);
      const done = r.lines.find((l) => l.type === "done");
      if (r.error) note = r.error.message;
      else if (done?.result === "sent") e.card = null;
      else if (sidecar.agentChanged(done)) note = stopped;
      else if (done?.result === "changed") note = "It changed on screen. Here is what it shows now.";
      else note = done?.message || "The keys did not go out.";
    } finally { e.sending = false; }
    await this.poll(cx, address, true, true);
    e.note = note;  // after the read: a new card would clear it
    cx.notify();
  }

  approve(cx, address, allow) { return this.act(cx, address, (c) => sidecar.approve(address, c.request, allow)); }

  // s27 (owner 11-14 "one-click MCP Supabase migrations"): Accept / Decline on an MCP server's input request. Only on a
  // press, never by itself, and every key is checked first: the screen is read again and the key goes only while the
  // SAME request (server and text) is still there with the terminal's selection on the button pressed. Decline moves
  // the selection down and checks it reached Decline before Enter; when it didn't, Esc (cancel: nothing runs).
  async elicitAnswer(cx, address, accept) {
    const e = this.entry(address), c = e.card;
    if (e.sending || c?.kind !== "elicitation" || !c.answerable) return;
    e.sending = true; e.note = null; cx.notify?.();
    let note = null;
    const read = async () => { const r = await hc(["read", address]).catch(() => null); return r?.code === 0 ? String(r.stdout ?? "") : null; };
    const same = (scr) => { const el = scr == null ? null : elicitation(scr); return Boolean(el && el.server === c.server && el.full === c.text); };
    const key = async (...k) => (await hc(["keys", address, ...k]).catch(() => null))?.code === 0;
    try {
      let scr = await read();
      if (scr == null) note = "Not sent: its screen could not be read. Answer in the terminal.";
      else if (!same(scr)) note = elicitation(scr) ? "Not sent: the request on screen changed. Here is what it shows now." : null;
      else if (accept) {
        if (elicitFocus(scr) !== "accept") note = "Not sent: the terminal's selection is not on Accept. Answer in the terminal.";
        else if (!(await key("enter"))) note = "The key did not go out. Answer in the terminal.";
        else note = await this.elicitAfter(cx, read, same);
      } else {
        if (elicitFocus(scr) !== "decline") {
          if (!(await key("down"))) { note = "The key did not go out. Answer in the terminal."; return; }
          await this.wait(cx, 300);
          scr = await read();
          if (!same(scr)) { note = "Not sent: the request on screen changed. Here is what it shows now."; return; }
          if (elicitFocus(scr) !== "decline") {
            // Never Enter here: cancel instead, which runs nothing either.
            note = (await key("esc")) ? await this.elicitAfter(cx, read, same, "Cancelled (Esc): the selection did not reach Decline.") : "The key did not go out. Answer in the terminal.";
            return;
          }
        }
        if (!(await key("enter"))) note = "The key did not go out. Answer in the terminal.";
        else note = await this.elicitAfter(cx, read, same);
      }
    } finally {
      e.sending = false;
      await this.poll(cx, address, true, true);
      e.note = note;   // after the read: a new card would clear it
      cx.notify?.();
    }
  }
  // After a key: null when the request left the screen, else a note (or `gone`'s text when it went but says more).
  async elicitAfter(cx, read, same, gone = null) {
    await this.wait(cx, 800);
    return same(await read()) ? "Sent, but the request still shows. Check its terminal." : gone;
  }

  answer(cx, address) {
    const e = this.entry(address);
    const answers = answersFor(e.card?.question, e.picks, e.others);
    if (!answers || e.card?.blocked || reviewBlocked(e.card?.question, e.others) || untypeable(e.others, e.card?.question)) return;
    return this.act(cx, address, (c) => sidecar.answer(address, c.request, answers), STOPPED_ANSWER);
  }

  // The card for `address`, or null. `id` makes the ids unique when two views show one.
  view(address, t, id = "card") {
    const e = this.byAgent.get(address);
    const c = e?.card;
    if (!c) return null;
    const button = (bid, label, primary, action, off = false) => div().id(`${id}-${bid}`).h(30).px(14).flex().items_center().rounded(8).text_size(13)
      .bg(off ? t.chrome : primary ? t.accent : t.chrome).text_color(off ? t.dim : primary ? t.background : t.foreground)
      .border(1).border_color(primary && !off ? t.accent : t.border)
      .when(!off, (el) => el.hover((s) => s.opacity(0.9)).on_click((_e, cx) => cx.spawn((cx) => action(cx))))
      .child(label);
    const box = v_flex().id(id).w_full().max_w(800).p(14).gap(10).rounded(14).bg(t.raised);
    if (this.focus) box.track_focus(this.focus)
      .on_mouse_down("left", () => { this.typingIn = null; this.focus.focus(); })
      .on_key_down((ev, cx) => { if (this.key_down(ev, cx, address)) cx.stop_propagation(); });
    const hint = (n) => div().size(18).flex_none().rounded(5).border(1).border_color(t.border).flex().items_center().justify_center()
      .text_size(10.5).text_color(t.muted).child(String(n));
    const head = (text) => h_flex().gap(8).items_center()
      .child(div().size(8).flex_none().rounded(4).bg(t.blocked))
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(text));
    // The terminal window for this agent (one at a time: an open one closes first).
    const toTerminal = async () => {
      const a = (agents() ?? []).find((x) => x.address === address) ?? { address };
      if (shared(KEY_TERM)) openTerminal(null);
      openTerminal(a);
    };
    // The note of the last press; the sidecar refusing a typed answer it can't type also gets the terminal button.
    const tail = () => !e.note ? null : cannotType(e.note)
      ? h_flex().id(`${id}-note`).gap(10).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked).child(e.note))
        .child(button("note-terminal", "Answer in terminal", true, toTerminal))
      : div().id(`${id}-note`).text_size(12).text_color(t.blocked).child(e.note);

    if (c.kind === "elicitation") {
      // s27 (owner 11-14): Accept / Decline here, each checked against the screen first (elicitAnswer); the server and
      // its whole request are shown so you know what Accept runs.
      box.child(head(`MCP server “${c.server}” asks for your input`));
      if (c.text) box.child(div().id(`${id}-elicit`).max_h(220).overflow_y_scrollbar().px(10).py(8).rounded(8).bg(t.background)
        .text_size(13).text_color(t.foreground).child(c.text));
      if (!c.answerable) {
        // s28 (Fable): the screen can't vouch for the dialog's buttons (more than one title-like line, or text under them).
        box.child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child("Answer it in its terminal: its screen can't be checked well enough for a one-click answer."))
          .child(button("elicit-terminal", "Answer in terminal", true, toTerminal)));
        const n0 = tail(); if (n0) box.child(n0);
        return box;
      }
      box.child(h_flex().gap(8).items_center()
        .child(button("elicit-accept", e.sending ? "Sending…" : "Accept", true, (cx) => this.elicitAnswer(cx, address, true), e.sending))
        .child(button("elicit-decline", "Decline", false, (cx) => this.elicitAnswer(cx, address, false), e.sending))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child("Checked against its screen before any key goes."))
        .child(button("elicit-terminal", "Answer in terminal", false, toTerminal)));
      const n = tail(); if (n) box.child(n);
      return box;
    }
    if (c.kind === "approval") {
      box.child(head(c.title || (c.tool ? `${c.tool} wants to run` : "Approval needed")));
      if (c.command) box.child(div().id(`${id}-command`).max_h(140).overflow_y_scrollbar().px(10).py(8).rounded(8).bg(t.background)
        .text_size(12.5).font_family("Menlo").text_color(t.foreground).child(c.command));
      // Answered and still drawn (the agent has not moved on, or hc still holds the key): no second answer.
      const off = e.sending || c.answered === true;
      box.child(h_flex().gap(8).items_center()
        .child(button("allow", e.sending ? "Sending…" : "1  Allow once", true, (cx) => this.approve(cx, address, true), off))
        .child(button("deny", "2  Deny", false, (cx) => this.approve(cx, address, false), off))
        .when(c.answered === true, (el) => el.child(div().text_size(12).text_color(t.muted).child("Answer sent. Waiting for the agent."))));
      const n = tail(); if (n) box.child(n);
      return box;
    }

    const q = c.question ?? { questions: [] };
    // One question at a time, as in Flockbook: "Question 1 of 2", Back and Next, Send on the last.
    const count = q.questions.length, step = Math.min(e.step ?? 0, Math.max(0, count - 1));
    box.child(h_flex().gap(10).items_center()
      .child(head(count > 1 ? `The agent asks · question ${step + 1} of ${count}` : "The agent asks"))
      .when(count > 1, (el) => el.child(div().flex_1()).child(h_flex().gap(5).children(q.questions.map((_x, i) =>
        div().id(`${id}-dot-${i}`).size(7).rounded(4).bg(i === step ? t.accent : answered(e, i) ? t.muted : t.border)
          .on_click((_ev, cx) => { e.step = i; cx.notify(); }))))));
    q.questions.forEach((qq, qi) => {
      if (qi !== step) return;
      const picks = e.picks.get(qi) ?? new Set();
      const sec = v_flex().gap(6);
      if (qq.header) sec.child(div().text_size(11.5).text_color(t.muted).child(qq.header));
      sec.child(div().text_size(13.5).text_color(t.foreground).child(qq.text || ""));
      (qq.options ?? []).forEach((o, oi) => {
        const on = picks.has(oi);
        sec.child(h_flex().id(`${id}-q${qi}-o${oi}`).px(10).py(7).gap(10).items_center().rounded(8)
          .bg(on ? t.selected : t.background).border(1).border_color(on ? t.accent : t.border).hover((s) => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => { this.pick(e, q.questions, qi, oi); cx.notify(); })
          .child(div().size(14).flex_none().rounded(qq.multi ? 3 : 7).border(1).border_color(on ? t.accent : t.muted).bg(on ? t.accent : t.background))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(6).child(div().text_size(13).text_color(t.foreground).child(o.label || ""))
              .when(Boolean(o.recommended), (el) => el.child(div().text_size(11).text_color(t.accent).child("Recommended"))))
            .when(Boolean(o.detail), (el) => el.child(div().text_size(12).text_color(t.muted).child(o.detail))))
          .when(oi < 9, (el) => el.child(hint(oi + 1))));
      });
      // The boxes are shared by every card; fill them with this card's text when it is shown.
      const input = this.others[qi];
      this.hydrate(address);
      // Own answer: a row like the options. A press stays in the text box (the card would take the
      // focus). Keys must NOT be stopped here: a stopped key never reaches the box as typed text. The
      // card's key handler skips them instead while the box has the keyboard (`typingIn`).
      const own = Boolean((e.others.get(qi) ?? "").trim());
      const keep = (_ev, cx) => cx.stop_propagation();
      if (input) sec.child(h_flex().id(`${id}-q${qi}-other`).px(10).py(7).gap(10).items_center().rounded(8)
        .bg(own ? t.selected : t.background).border(1).border_color(own ? t.accent : t.border)
        .on_mouse_down("left", keep)
        .child(div().size(14).flex_none().rounded(qq.multi ? 3 : 7).border(1).border_color(own ? t.accent : t.muted).bg(own ? t.accent : t.background))
        .child(div().flex_1().min_w(0).child(Textarea.new(input).w_full().text_size(13)))
        .when((qq.options ?? []).length < 9, (el) => el.child(hint((qq.options ?? []).length + 1))));
      box.child(sec);
    });
    // The terminal's review screen could not show these answers: `answer` would refuse, so Send is off from the start.
    // (The plus build's own check below says it before the helper's poll answers; this line, when there, wins.)
    if (c.blocked && !(c.unread > 0)) box.child(h_flex().id(`${id}-blocked`).gap(10).items_center()
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked).child(c.blocked))
      .child(button("terminal", "Answer in terminal", false, toTerminal)));
    if (c.unread > 0) {
      const total = q.questions.length + c.unread;
      box.child(h_flex().gap(10).items_center()
        .child(button("all", e.sending ? "Reading…" : `Show all ${total} questions`, true, (cx) => this.loadAll(cx, address), e.sending))
        .child(div().text_size(12.5).text_color(t.muted)
          .child(`${c.unread} more question${c.unread === 1 ? " follows" : "s follow"}. Answer them all here, then send.`)));
    } else {
      const cant = untypeable(e.others, q);
      // An own answer Herdr can't type blocks like an own answer the review screen can't show; the helper's own
      // review check (`c.blocked`, upstream) blocks first ("helper": its line above says why, with its terminal button).
      const blocked = (c.blocked ? "helper" : null) ?? reviewBlocked(q, e.others) ?? (cant ? "type" : null);
      const ready = Boolean(answersFor(q, e.picks, e.others)) && !blocked;
      const last = step >= count - 1;
      // The hint on the left; Back, then Next or Send answer at the right end.
      box.child(h_flex().gap(10).items_center()
        .child(div().text_size(12).text_color(t.dim).child(count ? `1-9 picks · Enter ${last ? "sends" : "goes on"}` : ""))
        .child(div().flex_1())
        .when(blocked !== null && blocked !== "helper", (el) => el.child(button("terminal", "Answer in terminal", blocked === "option", toTerminal)))
        .when(step > 0, (el) => el.child(button("back", "Back", false, async (cx) => { e.step = step - 1; cx.notify(); })))
        .child(last
          ? button("answer", e.sending ? "Sending…" : "Send answer", blocked === null, (cx) => this.answer(cx, address), !ready || e.sending)
          : button("next", "Next", blocked !== "option", async (cx) => { e.step = step + 1; cx.notify(); }, !answered(e, step))));
      if (blocked && blocked !== "helper") box.child(div().id(`${id}-review`).text_size(12).text_color(t.blocked).child(blocked === "option" ? REVIEW_OPTION : blocked === "type" ? UNTYPEABLE(cant) : REVIEW_OWN));
    }
    const n = tail(); if (n) box.child(n);
    return box;
  }
}
