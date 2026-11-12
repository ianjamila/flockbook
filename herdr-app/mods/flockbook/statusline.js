// The owner's Claude Code status line in the chat header, as the terminal draws it: its own colours, its first
// lines. The flockbook-statusline wrapper (flockbook/bin) saves each session's output, with its colour codes, as
// flockbook/statusline/<session id>.out; the session id is the chat's log file name.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, readTextFile, settings } from "herdr";

export const STATUS_LINES = 2;

// The saved output of the session whose log is `logPath`, or null.
export async function readStatusLine(logPath) {
  const sid = String(logPath ?? "").split("/").pop()?.replace(/\.jsonl$/, "");
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) return null;
  try { return await readTextFile(`${appHome()}/flockbook/statusline/${sid}.out`); } catch { return null; }
}

// The 16 colours the line is drawn in: VS Code's terminal defaults, as the owner sees the line there. Since
// 2026-11-11 the Flockbook themes (themes/flockbook.json, flockbook-light.json) use these same 16 too (owner's pick),
// so the line matches Herdr's own terminal; they used to be all greys.
const VSCODE_DARK = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"];
const VSCODE_LIGHT = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
  "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"];
export const palette = () => (settings()?.dark === false ? VSCODE_LIGHT : VSCODE_DARK);

// xterm's 256 colours: 0-15 the palette's, then the 6x6x6 cube and the grey ramp.
function color256(n, t) {
  if (n < 16) return t[`ansi${n}`];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return hex(v, v, v); }
  const c = n - 16, step = (x) => (x ? 55 + x * 40 : 0);
  return hex(step(Math.floor(c / 36)), step(Math.floor(c / 6) % 6), step(c % 6));
}
const hex = (r, g, b) => "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");

// Text with SGR colour codes → lines of runs { text, fg, bg, bold, dim, italic, underline }. Other escapes go.
// `pal`: the 16 colours (default: the palette above), read as `t.ansiN` below.
export function parseAnsi(text, pal = palette()) {
  const t = Object.fromEntries(pal.map((c, i) => [`ansi${i}`, c]));
  const lines = [];
  let runs = [], st = {};
  const push = (s) => { if (s) runs.push({ text: s, ...st }); };
  const src = String(text ?? "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\r/g, "");
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let at = 0, m;
  const flush = (s) => { const parts = s.split("\n"); parts.forEach((p, i) => { if (i) { lines.push(runs); runs = []; } push(p); }); };
  while ((m = re.exec(src))) {
    flush(src.slice(at, m.index)); at = re.lastIndex;
    if (m[2] !== "m") continue;
    const c = (m[1] === "" ? "0" : m[1]).split(";").map(Number);
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n === 0) st = {};
      else if (n === 1) st = { ...st, bold: true };
      else if (n === 2) st = { ...st, dim: true };
      else if (n === 3) st = { ...st, italic: true };
      else if (n === 4) st = { ...st, underline: true };
      else if (n === 22) st = { ...st, bold: false, dim: false };
      else if (n === 23) st = { ...st, italic: false };
      else if (n === 24) st = { ...st, underline: false };
      else if (n >= 30 && n <= 37) st = { ...st, fg: t[`ansi${n - 30}`] };
      else if (n >= 90 && n <= 97) st = { ...st, fg: t[`ansi${n - 82}`] };
      else if (n === 39) st = { ...st, fg: undefined };
      else if (n >= 40 && n <= 47) st = { ...st, bg: t[`ansi${n - 40}`] };
      else if (n >= 100 && n <= 107) st = { ...st, bg: t[`ansi${n - 92}`] };
      else if (n === 49) st = { ...st, bg: undefined };
      else if ((n === 38 || n === 48) && c[i + 1] === 5) { st = { ...st, [n === 38 ? "fg" : "bg"]: color256(c[i + 2] ?? 0, t) }; i += 2; }
      else if ((n === 38 || n === 48) && c[i + 1] === 2) { st = { ...st, [n === 38 ? "fg" : "bg"]: hex(c[i + 2] ?? 0, c[i + 3] ?? 0, c[i + 4] ?? 0) }; i += 4; }
    }
  }
  flush(src.slice(at));
  lines.push(runs);
  while (lines.length && !lines[lines.length - 1].some((r) => r.text.trim())) lines.pop();
  return lines;
}

// The first `count` lines, in the terminal's font, one row each; a long line is cut at the edge.
export function statusLineView(text, t, count = STATUS_LINES) {
  const lines = parseAnsi(text).slice(0, count);
  if (!lines.length) return null;
  const font = settings()?.font_family || "JetBrains Mono";
  return v_flex().id("statusline").w_full().max_w(800).px(4).gap(2).children(lines.map((runs, i) =>
    h_flex().id(`statusline-${i}`).w_full().overflow_hidden().whitespace_nowrap().font_family(font).text_size(12)
      .children(runs.map((r) => {
        let el = div().flex_none().whitespace_nowrap().text_color(r.fg ?? t.foreground).child(r.text);
        if (r.bg) el = el.bg(r.bg);
        if (r.bold) el = el.font_bold();
        if (r.dim) el = el.opacity(0.6);
        if (r.italic) el = el.italic();
        if (r.underline) el = el.underline();
        return el;
      }))));
}
