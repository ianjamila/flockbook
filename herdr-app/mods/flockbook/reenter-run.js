// Clear & re-enter, the run itself (owner 11-27/28): shared by the Finished screen, the Overview's hand-off cards and a tab's
// chat. A run is one record per tab in state.js `reenterRuns` (and the tab's lock in `reentering`, which holds the chat's
// Send), so a run started in one place shows as "Re-entering…" in the others and cannot be started twice. Every check and
// key happens in the helper where the tab runs (sidecar.reenter); this file takes the prompt and log the owner was shown,
// reads the reply again, refuses when it changed, calls the helper once and turns its answer into notes.
import { notify } from "herdr";
import { reentering, reenterRuns } from "./state.js";
import * as sidecar from "./sidecar.js";

// A helper ask that failed (or said no) is asked again after this long.
export const ASK_RETRY_MS = 5000;
// After a run that sent, its record stays this long, then goes.
export const DROP_MS = 5000;

const NO_ANSWER = "No answer from the helper: the tab may have been cleared and the prompt may or may not have gone. Check the tab.";
const SENT = "Re-entered: the new conversation has its prompt.";
export const CHANGED = "The re-entry prompt changed. Check it, then press again.";
export const COPY_FAILED = "Couldn't put the prompt on your clipboard: use Copy again.";
const TAIL_PASTE = "The prompt is on your clipboard: open the tab and paste.";
const TAIL_UNCONFIRMED = "The prompt may already be in the tab. Check it before pasting.";
const ON_CLIPBOARD = "It is on your clipboard.";
const TAIL_CLEAR = "Check the tab shows a new conversation before pasting; if it does not, type /clear first.";

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

export const isRunning = (address) => reenterRuns.get(address)?.state === "running";

// Whether the button shows: the read has a prompt, the agent is Claude, its log path is known, the helper has `reenter`,
// and no run already typed into the tab (also "sent": its row stays 5 s: the pre-clear read is stale, the tab shows a new
// conversation now). A refusal that typed nothing (keys "none") leaves the button, to press again.
export function canReenterRead(r, run, helperHas) {
  const typed = run?.state === "done" && run.keys !== "none";
  return Boolean(r?.prompt) && r.seen?.agent === "claude" && Boolean(r.seen?.path) && helperHas === true && !typed;
}

// The prompt of a tab whose run is on or done, for a view that has not read it (the view was rebuilt mid-run).
export function runPrompt(address) {
  const run = reenterRuns.get(address);
  return run ? { prompt: run.prompt, file: null, seen: run.seen ?? null, problem: null } : null;
}

// The click's synchronous part: a run already on in this tab → nothing; else the prompt and log the screen shows (`read`,
// else the run's own) are taken, and the tab's run and its lock (which holds the chat's Send) are set before any await.
export function begin(address, read) {
  if (isRunning(address)) return null;
  const r = read ?? runPrompt(address);
  if (!r?.prompt || !r.seen?.path) return null;
  const id = ++runs;
  const shown = { prompt: r.prompt, path: r.seen.path };
  reenterRuns.set(address, { id, state: "running", prompt: shown.prompt, seen: r.seen, at: Date.now() });
  reentering.add(address);
  return { id, shown, seen: r.seen };
}

// Both end a run's hold on its tab, and only while the run still owns it: `release` also drops the record (nothing
// was typed), `settle` keeps it with its result (the lock goes, the result stays on screen).
export function release(address, id) {
  if (reenterRuns.get(address)?.id !== id) return;
  reenterRuns.delete(address); reentering.delete(address);
}
export function settle(address, id) {
  if (reenterRuns.get(address)?.id === id) reentering.delete(address);
}

// 5 s after a run that sent: its record goes (the Finished screen passes its own, which also moves the pick on).
export function dropRun(cx, address, id) {
  if (reenterRuns.get(address)?.id !== id) return;
  reenterRuns.delete(address);
  cx?.notify?.();
}

// The run. `started` is begin()'s result, `clip` a cx that can write to the clipboard. `o`: reader(address) the reply is
// read again with, reenterer(address, prompt, seen) the helper call; optional startRead(address) → token before that
// read, changed(again, token) when the reply changed (the view shows the new read and its note), drop(cx, address, id).
export async function reenter(cx, address, started, clip, o) {
  if (!started) return;
  const { id, shown, seen } = started;
  const own = () => reenterRuns.get(address)?.id === id;
  try {
    // The reply is read again: a prompt or log other than the one the owner is looking at types nothing.
    let again;
    const token = o.startRead?.(address);
    try { again = await o.reader(address); } catch (e) { again = { prompt: null, problem: String(e?.message ?? e) }; }
    if (!again.prompt || again.problem || again.prompt !== shown.prompt || again.seen?.path !== shown.path) {
      o.changed?.(again, token);
      release(address, id);
      notify({ title: CHANGED, level: "warning", timeout: 4000 });
      return;
    }
    let answer;
    try { answer = await o.reenterer(address, shown.prompt, seen); } catch { answer = null; }
    const a = readAnswer(answer);
    let text = a.lead, copyFailed = false;
    if (a.tail) {
      // A key may have gone: the prompt goes on the clipboard whatever else happens (the owner pastes it).
      try { clip.write_to_clipboard(shown.prompt); text = joinNote(a.lead, a.tail, a.result); }
      catch { copyFailed = true; text = `${a.lead} ${COPY_FAILED}`; }
    }
    const line = (answer?.lines ?? []).find((l) => l?.type === "done") ?? answer?.error ?? null;
    if (own()) Object.assign(reenterRuns.get(address), { state: "done", result: a.result, keys: a.keys, message: line?.message ?? null, at: Date.now(), lead: a.lead, tail: a.tail, note: text, bad: a.result !== "sent", copyFailed });
    notify({ title: text, level: a.result === "sent" ? "info" : "warning", timeout: a.result === "sent" ? 3000 : 8000 });
    if (a.result === "sent") cx.timer?.after?.(DROP_MS, (cx2) => (o.drop ?? dropRun)(cx2, address, id));
  } finally { settle(address, id); cx.notify?.(); }
}

// Whether the helper has `reenter` (sidecar.hasCommand asks once and keeps the answer; a failed ask is asked again).
// `value`: null until asked; `has` is what tests replace.
export class HelperCan {
  constructor() { this.has = sidecar.hasCommand; this.value = null; this.asking = false; this.at = 0; }
  async ask(cx) {
    if (this.asking) return;
    this.asking = true; this.at = Date.now();
    try { this.value = Boolean(await this.has("reenter")); } catch { this.value = null; } finally { this.asking = false; }
    cx?.notify?.();
  }
  // Ask when the answer is not a yes and the last ask is old enough; returns at once.
  poke(cx) {
    if (this.value !== true && !this.asking && Date.now() - this.at >= ASK_RETRY_MS) cx.spawn((cx2) => this.ask(cx2));
  }
}
