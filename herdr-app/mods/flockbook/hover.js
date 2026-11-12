// The tab hover (owner 11-12: "hovering should give a summary of what the current PR is about"; then: the plain
// tooltip ran off the window and blended into the page): a HoverCard — fixed width so the text wraps, the raised
// surface with a border and shadow, bold section heads. One body for the Overview cards, the vertical tab list rows
// and the top bar's tab pills (s11, after a Codex + Fable review):
//   title · extra lines (shortcut, background work) · Needs you (bold) · What it's about (auto-written) · Now/Last ·
//   Last steps · Helpers (plain words) · a pause notice · footer: "Written 12 min ago · Work account (WORK)", Summarize,
//   Rewrite.
// The links run on click only (Summarize = summary.js dialog, Rewrite = ai.js queue); a hover itself costs nothing.
import { div } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { run } from "herdr";
import { tabLabel, tabAgents, needReason } from "./state.js";
import { nowOf, askOf, askLine, elicitOf } from "./asks.js";
import { aboutEntry, isStale, rewriting, accountName, accountFor, agoText, coolOf, clockText, localOffset, aboutSupported } from "./ai.js";
import { act } from "./menu.js";
import { sessionTopic } from "./state.js";

// <hover-pure>
// Sub-agent kinds in plain words (M2, free: no model call).
const ROLES = { implementer: "builder", verifier: "checker", judge: "review judge", arbiter: "senior reviewer", "arbiter-fix": "senior reviewer",
  "general-purpose": "helper", claude: "helper", explore: "searcher", plan: "planner", "code-reviewer": "reviewer", "code-explorer": "searcher",
  "code-architect": "planner", reviewer: "reviewer", "statusline-setup": "setup helper", "claude-code-guide": "guide" };
const FILE = /\b[\w@./-]*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|sql|md|json|ya?ml|toml|css|scss|html|rs|py|sh|go|rb|swift|kt|java|lock|env)\b/gi;
// "implementer: Wiring editor state into TerritoryClient.tsx" → "Builder: wiring editor state into the code".
export function plainHelper(h) {
  const m = /^(\S+?):\s+(.*)$/.exec(String(h ?? ""));   // the kind has no spaces but may hold a colon (plugin:agent)
  if (!m) return String(h ?? "");
  const kind = m[1].trim().replace(/^[\w-]+:/, "").toLowerCase();
  const who = ROLES[kind] ?? kind.replace(/[-_]/g, " ");
  const what = m[2].replace(FILE, "the code").replace(/\bthe code(?:\s*(?:,|and)\s*the code)+/g, "the code").trim();
  return `${who[0].toUpperCase()}${who.slice(1)}${what ? `: ${what[0].toLowerCase()}${what.slice(1)}` : ""}`;
}
// "2 helpers working (builder, reviewer)".
export function helpersHead(helpers) {
  const n = helpers?.length ?? 0;
  if (!n) return null;
  const roles = [...new Set(helpers.map((h) => plainHelper(h).split(":")[0].toLowerCase()))];
  return `${n} helper${n === 1 ? "" : "s"} working (${roles.join(", ")})`;
}
// What a tab waits on, in words (Q3): the Needs you page's reason — a question or approval (an MCP request named),
// an extra round or a merge (`askText`: askLine of the ask).
export function needText(reason, askText, mcpServer) {
  if (!reason) return null;
  if (reason === "question") return mcpServer ? `MCP “${mcpServer}” asks for input. Answer it in the tab's terminal.` : "It waits for your answer or approval.";
  return askText ? `${askText}.` : "It waits for you.";
}
// </hover-pure>

// The tab's first need and the agent it belongs to (all agents of a split tab are checked).
function tabNeed(agents) {
  for (const a of agents) {
    const r = needReason(a);
    if (r) { const ask = askOf(a.address); return { a, text: needText(r, ask ? askLine(ask) : null, r === "question" ? elicitOf(a.address)?.server : null) }; }
  }
  return null;
}

// The hover's body for a tab, or null when it has nothing to add. `title`: the head line (default: the tab's label);
// `extra`: muted lines under it (the ⌘ key, background work); `always`: show even with only the title.
// `onOpen`: what a click on the box does — the same as a click on what it covers (owner 11-12: near the window's
// bottom the box is pushed up over its own card, so the card could not be clicked).
export function hoverBody(tab, t, { title = null, extra = [], always = false, onOpen = null } = {}) {
  const agents = tabAgents(tab.id);
  const a = agents[0] ?? null;
  const addr = a?.address ?? null;
  const need = tabNeed(agents);
  const nw = nowOf(addr);
  const e = aboutEntry(addr);
  const about = e?.more || e?.text || null;
  const now = Date.now(), off = localOffset();
  const acct = addr ? (e?.account ?? accountFor(addr)) : null;
  const cool = coolOf(acct);
  const failed = e?.error && (!e.wroteAt || (e.triedAt ?? 0) > e.wroteAt) ? e.error : null;
  const lines = (extra ?? []).filter(Boolean);
  if (!always && !need && !about && !nw && !lines.length && !failed && !cool) return null;
  const id = (k) => `hv-${k}-${tab.id}`;
  const text = (k, s, color = t.foreground, size = 12.5) => div().id(id(k)).w_full().whitespace_normal().text_size(size).line_height("18px").text_color(color).child(s);
  const section = (k, head, body, color = t.muted) => v_flex().id(id(`s-${k}`)).gap(3)
    .child(div().text_size(11.5).font_semibold().text_color(color).child(head))
    .children((Array.isArray(body) ? body : [body]).map((x, i) => text(`${k}-${i}`, Array.isArray(body) ? `• ${x}` : x)));
  const label = tab.status === "working" || nw?.helpers.length ? "Now" : "Last";
  const stale = isStale(e, a ? sessionTopic(a) ?? a.title ?? "" : "");
  const fresh = e?.text ? `${e.wroteAt ? `Written ${agoText(e.wroteAt, now)}` : "Written earlier"}${e.account ? ` · ${accountName(e.account)}` : ""}${stale ? " · may be out of date" : ""}` : null;
  const stop = (_e, cx) => cx.stop_propagation();
  const link = (k, s, on) => div().id(id(k)).text_size(12).text_color(t.accent).hover((x) => x.opacity(0.8)).on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation?.(); on(); }).child(s);
  const busy = rewriting(addr);
  // Last steps without the one the Now/Last line already says (keeps the box short enough to fit below its card).
  const steps = (nw?.steps ?? []).filter((x) => x !== nw?.now);
  return v_flex().id(id("body")).w(420).max_w_full().p(14).gap(10).rounded(10).bg(t.raised).border(1).border_color(t.border).shadow_lg()
    .when(Boolean(onOpen), (el) => el.cursor_pointer().on_click(() => onOpen()))
    .child(text("title", title ?? tabLabel(tab), t.foreground, 13.5).font_semibold())
    .when(lines.length > 0, (el) => el.child(v_flex().gap(2).children(lines.map((x, i) => text(`x-${i}`, x, t.muted, 12)))))
    .when(Boolean(need), (el) => el.child(section("need", "Needs you", need.text, t.blocked)))
    .when(Boolean(about), (el) => el.child(section("about", "What it's about (auto-written)", about)))
    .when(Boolean(nw), (el) => el.child(section("now", label, nw.now)))
    .when(steps.length > 0, (el) => el.child(section("steps", "Last steps", steps)))
    .when(Boolean(nw?.helpers.length), (el) => el.child(section("helpers", helpersHead(nw.helpers), nw.helpers.map(plainHelper))))
    // The tab's account is out of usage: its own session is likely stopped too (Fable 11-12).
    .when(Boolean(cool), (el) => el.child(text("cool", `⏸ ${accountName(acct)} is out of its Claude usage until ${clockText(cool.until, now, off)}: this tab is likely paused too.`, t.blocked, 12)))
    .when(Boolean(failed) && !cool, (el) => el.child(text("err", failed, t.muted, 12)))
    .when(Boolean(addr), (el) => el.child(h_flex().id(id("foot")).gap(12).items_center().pt(2).border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(11.5).text_color(t.dim).child(busy ? "Rewriting the About line…" : fresh ?? "No About line yet"))
      .when(Boolean(onOpen), (f) => f.child(link("open", "Open", () => onOpen())))
      .child(link("sum", "Summarize", () => act({ act: "summarize", args: { address: addr } })))
      .when(!busy && aboutSupported(addr), (f) => f.child(link("redo", e?.text ? "Rewrite" : "Write now", () => run(`flockbook.about-redo:${addr}`))))));
}

// `trigger` with the tab's hover, or `trigger` alone when there is nothing to show. `key`: unique per place.
export function withHover(key, trigger, tab, t, opts = {}) {
  const body = hoverBody(tab, t, opts);
  if (!body) return trigger;
  return HoverCard.new(`hc-${key}-${tab.id}`).anchor(opts.anchor ?? "top_left").open_delay(900).close_delay(200).trigger(trigger).content(body);
}
