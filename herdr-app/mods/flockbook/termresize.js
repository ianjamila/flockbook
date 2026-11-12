// Drag-resize for the agent's terminal window (state.openTerminal). Herdr's windows have no resize edges,
// and a mod hears the pointer only while the pointer is over it, so:
// - a thin frame of grips round the window (view "termgrip", one block per edge and corner), drawn in
//   the terminal's background, so it reads as a margin. Only the right edge, the bottom edge and the
//   bottom-right corner resize (ACTIVE): Herdr reopens a keyed window at the spot it remembers and
//   ignores `at` (tested 11-11), so the top left cannot move and the left and top edges cannot work.
//   The other grips are plain margin: a press there drags the window, like the title bar;
// - a press on a grip opens a "catcher" (view "termresize"): a frameless modal dialog over the whole app.
//   It follows the pointer wherever it goes and draws the window's new outline. It hears the pointer only
//   while the button is down (no release ever reaches it), so once the pointer rests IDLE_MS it reopens the
//   terminal window at that size, in its place (a press with no drag cancels). Esc cancels.
// The size is saved (terminal_size "custom" + terminal_px), so the window opens that big next time.
// The − + ⤢ buttons on the title bar still step through the preset sizes.
import { div } from "gpui-kit";
import { theme, props, run, openOverlay, closeOverlay } from "herdr";

// <pure> (tests: test/plus/test-termresize.mjs)
export const TERM_EDGE = 6;                // px: how thick each grip is
export const TERM_BORDER = 1;              // px: the window's border, outside the grips
export const TERM_CORNER = 14;             // px: the end of an edge grip that resizes the corner instead
export const TERM_MIN = { w: 420, h: 220 };
export const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const ACTIVE = ["e", "s", "se"];   // the grips that resize (see the top)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The window's box while `edge` is dragged: `start` {x, y, w, h} is its box at the press (window-relative
// px), (dx, dy) how far the pointer has gone since, `app` {width, height} the whole app's size (or null).
// The far edges stay put; the box keeps TERM_MIN and stays inside the app.
export function dragRect(start, edge, dx, dy, app) {
  let { x, y, w, h } = start;
  const right = start.x + start.w, bottom = start.y + start.h;
  const maxW = app?.width > 0 ? app.width : Infinity, maxH = app?.height > 0 ? app.height : Infinity;
  if (edge.includes("e")) w = clamp(start.w + dx, TERM_MIN.w, Math.max(TERM_MIN.w, maxW - start.x));
  if (edge.includes("s")) h = clamp(start.h + dy, TERM_MIN.h, Math.max(TERM_MIN.h, maxH - start.y));
  if (edge.includes("w")) { x = clamp(start.x + dx, 0, right - TERM_MIN.w); w = right - x; }
  if (edge.includes("n")) { y = clamp(start.y + dy, 0, bottom - TERM_MIN.h); h = bottom - y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Which way a press on grip `grip` resizes: the first and last TERM_CORNER px of an edge grip are its
// corners. `at` is the press inside the grip, `size` the grip's size.
// A way that is not ACTIVE is the grip's own edge.
export function zoneEdge(grip, at, size) {
  const z = zoneOf(grip, at, size);
  return ACTIVE.includes(z) ? z : grip;
}
function zoneOf(grip, at, size) {
  if (!at || !size || grip.length === 2) return grip;
  const along = grip === "e" || grip === "w" ? at.y : at.x;
  const len = grip === "e" || grip === "w" ? size.height : size.width;
  const lo = along < TERM_CORNER, hi = along > len - TERM_CORNER;
  if (!lo && !hi) return grip;
  if (grip === "e" || grip === "w") return (lo ? "n" : "s") + grip;
  return grip + (lo ? "w" : "e");
}

// The window's box from a grip's bounds (window-relative) and the window's outer size {w, h}. The grips
// sit inside the border: a row of three along the top (nw n ne) and the bottom (sw s se), and w / e
// between them beside the title bar and terminal.
export function boxFromGrip(grip, b, size) {
  const E = TERM_EDGE, B = TERM_BORDER;
  const x = grip.includes("e") ? b.x + b.width + B - size.w : grip.includes("w") ? b.x - B : b.x - B - E;
  const y = grip.includes("s") ? b.y + b.height + B - size.h : grip.includes("n") ? b.y - B : b.y - B - E;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(size.w), h: Math.round(size.h) };
}

// The window's outer size from what a grip measured: the side grips (w, e) know the height, the top and
// bottom ones (n, s) the width.
// A grip's hover colour: the accent at a quarter strength (a #rrggbb accent), else the theme's hover.
export const gripTint = (t) => (/^#[0-9a-f]{6}$/i.test(t?.accent ?? "") ? `${t.accent}40` : t?.hover);

export function sizeFromGrip(grip, size, was) {
  const extra = 2 * TERM_EDGE + 2 * TERM_BORDER;
  if (grip === "w" || grip === "e") return { ...was, h: Math.round(size.height + extra) };
  if (grip === "n" || grip === "s") return { ...was, w: Math.round(size.width + extra) };
  return was;
}

// Whether the outline `r` differs from the window's box `start` enough to resize (2 px either way).
export function movedEnough(start, r) {
  if (!start || !r) return false;
  return Math.abs(r.w - start.w) >= 2 || Math.abs(r.h - start.h) >= 2;
}
// What the catcher does with a press (`kind` "down") or a release ("up") while it follows the pointer, the
// outline at `r`: "apply" once the outline has moved, else a release "wait"s (the button went up before
// any move: keep following) and a press "cancel"s (a click on the edge without dragging).
export function catcherAction(kind, start, r) {
  if (movedEnough(start, r)) return "apply";
  return kind === "up" ? "wait" : "cancel";
}
// The catcher hears the pointer only while the button that pressed the grip is down: no release, no later
// click (11-12 try 5: moves, then silence). So the pointer at rest for IDLE_MS ends the drag: "apply" the
// outline if it moved, else "cancel" (a press with no drag); null while moves still come. `now`, `last`: ms.
export const IDLE_MS = 550;
export function idleAction(now, last, start, r, idle = IDLE_MS) {
  if (now - last < idle) return null;
  return movedEnough(start, r) ? "apply" : "cancel";
}
// </pure>

// What the grips measured (module state is shared by every copy of the mod): the open window's outer
// size, and the app's size from the last catcher (state.js uses it to place a custom size among the presets).
export const geom = { w: 0, h: 0, app: null };

const CURSOR = {
  n: (el) => el.cursor_ns_resize(), s: (el) => el.cursor_ns_resize(),
  e: (el) => el.cursor_ew_resize(), w: (el) => el.cursor_ew_resize(),
  nw: (el) => el.cursor_nwse_resize(), se: (el) => el.cursor_nwse_resize(),
  ne: (el) => el.cursor_nesw_resize(), sw: (el) => el.cursor_nesw_resize(),
};
const cursor = (el, edge) => (CURSOR[edge] ?? ((x) => x))(el);

// The layout around the title bar and terminal: the grips in a frame of TERM_EDGE px. `inner` is the
// column the window shows; `grip(edge)` makes a grip block.
export function gripFrame(inner, grip) {
  const band = (edges) => ({ type: "row", size: { px: TERM_EDGE }, resizable: false, children: [
    { type: "block", size: { px: TERM_EDGE }, content: grip(edges[0]) },
    { type: "block", content: grip(edges[1]) },
    { type: "block", size: { px: TERM_EDGE }, content: grip(edges[2]) },
  ] });
  return [
    band(["nw", "n", "ne"]),
    { type: "row", resizable: false, children: [
      { type: "block", size: { px: TERM_EDGE }, content: grip("w") },
      inner,
      { type: "block", size: { px: TERM_EDGE }, content: grip("e") },
    ] },
    band(["sw", "s", "se"]),
  ];
}

// One grip (props: edge, terminal, name). Its ends show the corner's cursor and resize the corner.
export class TermGrip {
  constructor(_cx) { this.size = null; }

  render(_cx) {
    const p = props() ?? {};
    const grip = EDGES.includes(p.edge) ? p.edge : "se";
    // A margin that does not resize: nothing to hear (a press drags the window).
    if (!ACTIVE.includes(grip)) return div().id(`term-grip-${grip}`).size_full();
    const side = grip.length === 1;
    const along = grip === "e" || grip === "w" ? "column" : "row";
    const end = (e) => cursor(div().flex_none().when(along === "column", (el) => el.w_full().h(TERM_CORNER)).when(along === "row", (el) => el.h_full().w(TERM_CORNER)), e);
    // Hovered, a grip that resizes shows a faint accent band, so the edge can be found.
    const root = div().id(`term-grip-${grip}`).size_full().flex().when(along === "column", (el) => el.flex_col())
      .hover((s) => s.bg(gripTint(theme())))
      .on_size_change((size) => { this.size = size; const g = sizeFromGrip(grip, size, geom); geom.w = g.w; geom.h = g.h; })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();   // not a window drag
        const edge = zoneEdge(grip, e.local_position, this.size);
        startResize(grip, edge, e, p);
      });
    if (!side) return cursor(root, grip);
    // A side: corner, edge, corner.
    const zone = (z) => (ACTIVE.includes(z) ? z : grip);
    const [a, b] = (grip === "e" || grip === "w" ? ["n" + grip, "s" + grip] : [grip + "w", grip + "e"]).map(zone);
    return root.child(end(a)).child(cursor(div().flex_1(), grip)).child(end(b));
  }
}

// The open catcher's overlay id (one at a time; module state is shared by every copy). A grip press while one is
// open means it is gone (it covers the app), so the old id is closed and replaced.
let catcher = null;
function openCatcher(props) {
  if (catcher) closeOverlay(catcher);
  // A modal dialog, not a window: a frameless "window" catcher heard no pointer at all unless it opened mid-press,
  // and Herdr dragged it around instead (11-12 tries 3–4). A dialog takes the pointer (Settings is one), a
  // click beside it can't close it (it covers the app anyway), and Esc closes it (= cancel).
  catcher = openOverlay({ kind: "dialog", modal: true, frame: "none", width: 1, height: 1, mod: "flockbook", props: { view: "termresize", ...props } });
  return catcher;
}
const measured = (b, p) => Boolean(b) && geom.w > 0 && geom.h > 0 && Boolean(p.terminal);

// A press on an active grip: open the catcher with the button down.
function startResize(grip, edge, e, p) {
  if (!measured(e?.bounds, p)) return;
  const start = boxFromGrip(grip, e.bounds, geom);
  openCatcher({ edge, start, px: e.position.x, py: e.position.y, terminal: p.terminal, name: p.name });
}

// The catcher: covers the app and draws the window's new outline with its size wherever the pointer goes. It
// hears the pointer only while the button is down (try 5), so the pointer at rest for IDLE_MS applies the
// outline (or cancels with no drag); a release or click that does reach it applies at once. Esc cancels.
export class TermResize {
  constructor(cx) {
    const p = props() ?? {};
    this.p = p;
    this.start = p.start ?? null;
    this.edge = p.edge ?? null;
    this.px = p.px; this.py = p.py;
    this.rect = this.start;
    this.over = false;
    this.last = Date.now();
    cx?.timer?.every(100, (cx) => this.tick(cx));
  }

  tick(cx) {
    if (this.over) return;
    const act = idleAction(Date.now(), this.last, this.start, this.rect);
    if (!act) return;
    this.finish(act === "apply" ? this.rect : null, cx);
  }

  async close(_cx) {
    if (catcher === this.p.overlay) catcher = null;
  }

  // Close; with `r`, save it and reopen the terminal window at that size.
  finish(r, cx) {
    if (this.over) return;
    this.over = true;
    const p = this.p;
    if (catcher === p.overlay) catcher = null;
    // The size goes to the top bar's command loop ("flockbook.term-rect:…", top.js command), which outlives this
    // overlay: work spawned here dies when it closes (11-12 tries 5–6: "up → apply" logged, config unchanged;
    // the same box through the command saved at once).
    // "|<terminal>": the window this grip belongs to, so the command resizes that one, not whichever agent is selected.
    if (r) run(`flockbook.term-rect:${r.x},${r.y},${r.w},${r.h}${p.terminal ? `|${p.terminal}` : ""}`);
    if (p.overlay) closeOverlay(p.overlay);
  }

  // The outline for the pointer at `pos`.
  follow(pos) {
    return pos && this.start && this.edge ? dragRect(this.start, this.edge, pos.x - this.px, pos.y - this.py, geom.app) : this.rect;
  }

  // A press ("down") or release ("up") at `pos`.
  button(kind, pos, cx) {
    if (this.over) return;
    this.rect = this.follow(pos);
    const act = catcherAction(kind, this.start, this.rect);
    if (act === "apply") this.finish(this.rect, cx);
    else if (act === "cancel") this.finish(null, cx);
    else cx.notify();
  }

  render(_cx) {
    const t = theme();
    const r = this.rect;
    const root = cursor(div().id("term-resize").size_full().relative(), this.edge ?? "se")
      .on_size_change((size) => { geom.app = size; })
      .on_mouse_move((e, cx) => {
        if (this.over || !this.start) return;
        this.last = Date.now();
        this.rect = this.follow(e.position);
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.button("down", e.position, cx); })
      .on_mouse_up("left", (e, cx) => this.button("up", e.position, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.finish(null, cx); });
    if (!r) return root;
    return root.child(div().id("term-resize-outline").absolute().left(r.x).top(r.y).w(r.w).h(r.h)
      .rounded(16).border(2).border_color(t.accent).flex().items_center().justify_center()
      .child(div().flex().flex_col().items_center().gap(2).px(10).py(4).rounded(8).bg(t.popover).border(1).border_color(t.border)
        .child(div().text_size(12.5).text_color(t.foreground).child(`${r.w} × ${r.h}`))
        .child(div().text_size(11).text_color(t.muted).child("Hold still to set · Esc cancels"))));
  }
}
