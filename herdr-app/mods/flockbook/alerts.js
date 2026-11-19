// Alerts (owner 11-19: "it should only ping when I'm needed … add settings to turn off each", and "notifications don't
// clearly say what task completed / needs me"). Two switches in the Flockbook settings dialog (Alerts section):
//   finished — an agent finished while you weren't looking
//   needed   — an agent needs you (an approval, a question, a plan)
// One switch covers every ping of its kind:
//   - Herdr's sound: settings.json sounds.done / sounds.blocked point at a silent file while the kind is off (Herdr has
//     only one sound switch for both); a sound file of the person's own is kept aside and put back when it comes on;
//   - Herdr's corner note: the toast view (below) drops the note of a kind that is off;
//   - Claude Code's Mac pop-up: ~/.claude/notify-<kind> ("off" / "on"), read by the notify hook
//     (~/.claude/hooks/notify.mjs) and written by `cnotify finished|needed on|off` too.
// The ~/.claude file is the one truth, so the dialog and cnotify always agree; Flockbook reads it every minute (top.js)
// and brings Herdr's sounds in line.
// The toast view also names the task: Herdr's own note says only "Claude Code finished"; Flockbook's says
// "Finished · <the tab's session title>" with the workspace under it, and clicking it still goes there.
import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, appHome, readTextFile, writeTextFile, shared, setShared, agents, spaces, props, closeOverlay, run, theme } from "herdr";
import { agentName } from "./state.js";

export const KINDS = ["finished", "needed"];
// Herdr's sound for each kind (settings.json sounds.<name>, playSound(name)).
export const SOUND = { finished: "done", needed: "blocked" };
// A short silent MP3 shipped with the mod, relative to Herdr's folder (as settings.json takes it).
export const SILENT = "mods/flockbook/sounds/silent.mp3";
const KEY = "flockbook.alerts";              // { finished: bool, needed: bool }: the ~/.claude files as last read
const KEY_SAVED = "flockbook.alerts.sounds"; // { done?: "<file>", blocked?: "<file>" }: the person's own sounds, kept aside
export const KEY_LAST = "flockbook.toast.last"; // the last few notes Herdr handed the toast view (what Herdr sends, for checks)

export const flagPath = (kind) => `${home()}/.claude/notify-${kind}`;
const settingsPath = () => `${appHome()}/settings.json`;
// Only a file reading exactly "off" turns a kind off (the notify hook's rule); missing = on.
const onFromText = (text) => (text ?? "").trim() !== "off";
export const alertOn = (kind) => shared(KEY)?.[kind] !== false;

// Reads both switches from ~/.claude, then brings Herdr's sounds in line. Never throws.
export async function loadAlerts() {
  try {
    const next = {};
    for (const k of KINDS) next[k] = onFromText(await readTextFile(flagPath(k)));
    const cur = shared(KEY) ?? {};
    if (KINDS.some((k) => cur[k] !== next[k])) setShared(KEY, next);
    await syncSounds();
  } catch {}
}

// Turns one kind on or off: the ~/.claude file (the notify hook and cnotify read it), then Herdr's sound.
export async function setAlert(kind, on) {
  if (!KINDS.includes(kind)) return false;
  try {
    const before = await readTextFile(flagPath(kind));
    await writeTextFile(flagPath(kind), on ? "on\n" : "off\n", before);
  } catch {
    return false;
  }
  setShared(KEY, { ...(shared(KEY) ?? {}), [kind]: !!on });
  await syncSounds();
  return true;
}

// Herdr's settings.json sounds to match the switches. Leaves a file it can't read or parse alone; keeps every other key.
export async function syncSounds() {
  let text;
  try { text = await readTextFile(settingsPath()); } catch { return false; }
  let s;
  try { s = text == null ? {} : JSON.parse(text); } catch { return false; }
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const sounds = s.sounds && typeof s.sounds === "object" ? { ...s.sounds } : {};
  const saved = { ...(shared(KEY_SAVED) ?? {}) };
  let changed = false, savedChanged = false;
  for (const k of KINDS) {
    const name = SOUND[k], cur = sounds[name];
    if (!alertOn(k) && cur !== SILENT) {
      if (typeof cur === "string" && cur) { saved[name] = cur; savedChanged = true; }
      sounds[name] = SILENT; changed = true;
    } else if (alertOn(k) && cur === SILENT) {
      if (saved[name]) sounds[name] = saved[name]; else delete sounds[name];
      delete saved[name]; savedChanged = true; changed = true;
    }
  }
  if (savedChanged) setShared(KEY_SAVED, saved);
  if (!changed) return false;
  try {
    await writeTextFile(settingsPath(), JSON.stringify({ ...s, sounds }, null, 2) + "\n", text ?? null);
    return true;
  } catch {
    return false; // changed under us: the next minute's check tries again
  }
}

// --- the toast view: every note Herdr shows (its own and every notify()), when the layout's root names this mod -------

// Herdr's own agent note → { kind, agent } (agent may be null when the terminal is gone), else null (any other note).
// Herdr words them "<program> finished" / "<program> needs you" and clicking goes to the agent (agent.focus).
export function agentNote(p) {
  const terminal = p?.action?.name === "agent.focus" ? p.action.args?.terminal : null;
  const m = /\b(finished|needs you)\s*$/i.exec(String(p?.title ?? ""));
  if (!terminal && !m) return null;
  const agent = terminal ? agents().find((a) => a.address === terminal) ?? null : null;
  const kind = m ? (m[1].toLowerCase() === "finished" ? "finished" : "needed")
    : agent?.status === "blocked" ? "needed" : agent?.status === "done" ? "finished" : null;
  return kind ? { kind, agent } : null;
}

// The words for an agent note: "Needs you · <task>", "<workspace>" (or Herdr's own body when the agent is gone).
export function noteWords(note, p) {
  const head = note.kind === "needed" ? "Needs you" : "Finished";
  const a = note.agent;
  if (!a) return { title: p?.title ?? head, body: p?.body ?? "" };
  const task = agentName(a) || p?.title || "";
  const where = spaces().find((s) => s.id === a.space)?.name ?? a.space_name ?? "";
  return { title: task ? `${head} · ${task}` : head, body: [where, p?.body && p.body !== where ? p.body : null].filter(Boolean).join(" · ") };
}

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export class ToastView {
  constructor(_cx) {
    const p = props() ?? {};
    this.p = p;
    this.note = agentNote(p);
    // What Herdr sent (the last 5), so its wording can be checked against agentNote's.
    try {
      const last = Array.isArray(shared(KEY_LAST)) ? shared(KEY_LAST) : [];
      setShared(KEY_LAST, [...last, { at: Date.now(), title: p.title ?? null, body: p.body ?? null, level: p.level ?? null, action: p.action ?? null, kind: this.note?.kind ?? null }].slice(-5));
    } catch {}
    // A kind that is off: no note (Herdr's sound is silent then too). Closed at once, as the README's system-toast mod does.
    this.dropped = !!(this.note && !alertOn(this.note.kind));
    if (this.dropped && p.overlay) closeOverlay(p.overlay);
  }

  render(_cx) {
    const t = theme();
    const p = this.p;
    if (this.dropped) return div().id("toast").size_full();
    // Herdr's own login note keeps the shipped toast's Copy button.
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const words = this.note ? noteWords(this.note, p) : { title: p.title ?? "", body: p.body ?? "" };
    const level = this.note ? (this.note.kind === "needed" ? "error" : "success") : p.level;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon && !this.note ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .child(div().id("toast-title").truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : words.title))
          .when(!login && Boolean(words.body), (el) => el.child(div().id("toast-body").truncate().text_size(12).text_color(t.muted).child(words.body)))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
