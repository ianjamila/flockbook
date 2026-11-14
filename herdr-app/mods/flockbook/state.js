// What every view agrees on: the agent shown in the chat, and the screen in the stack.
// Kept in shared() so the copies of this mod (one per layout block) see the same value.
import { focused, shared, setShared, run, openOverlay, closeOverlay, appHome, readTextFile, panes } from "herdr";
import { agents, spaces } from "./parked.js";
import { loadConfig, updateSeen, setting, setSetting, setSettings } from "./config.js";
import { gripFrame, geom, fitTerm, termAt } from "./termresize.js";
import { askOf, prOf, bgOf, bgWords, askMark, handoffOf, nowWait } from "./asks.js";

export const KEY_AGENT = "flockbook.agent";
// The screen in the stack, as this mod last selected it (layout() is the file, not the live tree).
export const KEY_SCREEN = "flockbook.screen";
// The machine whose Flockbook helper the tab menu asked to remove (the chat asks first).
export const KEY_REMOVE = "flockbook.helper.remove";
// "box/t7" (or "hc:box/t7") → "box"; a local terminal → null. Only one level.
export function machineOf(address) {
  const p = String(address ?? "").replace(/^hc:/, "").split("/");
  return p.length === 2 && p[0] && p[1] ? p[0] : null;
}
// "settings" was a screen before the settings became a dialog; a saved one shows the chat.
export const shownScreen = () => { const s = shared(KEY_SCREEN); return s && s !== "settings" ? s : "chat"; };
// `to`: the terminal the new screen is for, when the caller knows it before Herdr shows that tab (a tab click); else
// the shown tab's. The terminal window steps aside / comes back in the same click (stepTerminal).
export function showScreen(child, to) {
  setShared(KEY_SCREEN, child);
  run("layout.select", { stack: "screen", child });
  stepTerminal(child, to);
}
const MOD = "mods/flockbook";
export const icon = (name) => `${MOD}/icons/${name}.svg`;

// One spinner speed everywhere (ms per turn). Herdr draws a spin at about 30 frames a second: at 900 ms
// the arc moves 13 degrees a frame (at 600 ms it was 20, and looked jerky). Herdr's own spinner turns at 900.
export const SPIN_MS = 900;

// Motion: a quick ease-out for fades and a soft spring for moves, as in the web app.
export const FADE = { duration: 180, easing: "ease-out" };
export const SPRING = { response: 320, damping: 0.82 };

// Whether the sidebar shows. layout() gives the file, not the live tree, so the mod keeps its own
// copy: read once from the app's saved layout state, then set by toggleSidebar().
export const KEY_SIDEBAR = "flockbook.sidebar";
export const sidebarShown = () => shared(KEY_SIDEBAR) === true;
export function toggleSidebar() {
  const show = !sidebarShown();
  endPeek();
  if (show) updateSeen();
  setShared(KEY_SIDEBAR, show);
  run(show ? "layout.show" : "layout.hide", { id: "sidebar" });
}
// Whether the tab list on the right shows (tabs.js), kept the same way; shown unless hidden by hand.
export const KEY_TABLIST = "flockbook.tablist";
export const tablistShown = () => shared(KEY_TABLIST) !== false;
export function toggleTablist() {
  const show = !tablistShown();
  setShared(KEY_TABLIST, show);
  run(show ? "layout.show" : "layout.hide", { id: "tablist" });
}
// The pointer at the window's left edge floats the sidebar over the content (a frameless popup that
// the side view draws as a panel), so the content does not move. It closes when the pointer leaves
// it, on Esc or on a click beside it. KEY_PEEK holds the popup's id while it is open.
export const KEY_PEEK = "flockbook.sidebar.peek";
export const EDGE_PX = 4;
export const PEEK_W = 260, PEEK_GAP = 8;
// A popup is as tall as its content unless given px, so the views note the window's height.
export const KEY_WIN_H = "flockbook.window.height";
export function noteWindowHeight(size) {
  const h = Math.round(size?.height ?? 0);
  if (h > 0 && shared(KEY_WIN_H) !== h) setShared(KEY_WIN_H, h);
}
export function peekAtEdge(e) {
  if (sidebarShown() || shared(KEY_PEEK) || (e?.position?.x ?? 99) > EDGE_PX) return;
  // A window, not a popup: a popup sizes to its content and ignores the height. The panel closes
  // itself when the pointer leaves it, and stops presses so they don't drag it.
  const id = openOverlay({ mod: "flockbook", props: { view: "side", peek: true }, kind: "window", frame: "none",
    at: { x: PEEK_GAP, y: PEEK_GAP }, width: PEEK_W, height: (shared(KEY_WIN_H) ?? 800) - PEEK_GAP * 2 });
  setShared(KEY_PEEK, id);
  updateSeen();
}
export function endPeek() {
  const id = shared(KEY_PEEK);
  if (!id) return;
  setShared(KEY_PEEK, null);
  closeOverlay(id);
}
// The panel went (Esc, a click beside it, or endPeek): forget it so the edge opens it again.
export function peekClosed(id) {
  if (shared(KEY_PEEK) === id) setShared(KEY_PEEK, null);
}
// Adds the edge watch to a view's root.
export const watchEdge = (el) => el.on_mouse_move((e) => peekAtEdge(e));

// Reads, once, whether layout node `id` shows (the app's saved clicks), into shared `key`; `hidden`: the
// file's default.
async function loadShown(id, key, hidden) {
  if (shared(key) !== undefined) return;
  try {
    const text = await readTextFile(`${appHome()}/layouts/.state/flockbook.json`);
    const v = text ? JSON.parse(text)?.nodes?.[id]?.hidden : undefined;
    if (typeof v === "boolean") hidden = v;
  } catch { /* no saved state: the file's default */ }
  if (shared(key) === undefined) setShared(key, !hidden);
}
export async function loadSidebar() {
  await loadShown("sidebar", KEY_SIDEBAR, true);
  await loadShown("tablist", KEY_TABLIST, false);
}

// The agents of the shown space, in herdr's order.
export function spaceAgents() {
  const space = spaces().find((s) => s.active);
  const all = agents();
  return space ? all.filter((a) => a.space === space.id) : all;
}

// The shown space, and its tabs that are not put away (tab.settle), in herdr's order.
export function activeSpace() { return spaces().find((s) => s.active) ?? null; }
export function spaceTabs() { return (activeSpace()?.tabs ?? []).filter((t) => !t.settled); }
export function activeTab() { return activeSpace()?.tabs?.find((t) => t.active) ?? null; }
export function tabAgents(id) { return agents().filter((a) => a.tab === id); }

// The agent the chat shows: an agent of the shown tab (the one picked here, else the focused one,
// else the first). Null when that tab has no agent. Without tab data, any agent of the space.
export function currentAgent() {
  const tab = activeTab();
  const list = tab ? tabAgents(tab.id) : spaceAgents();
  const picked = shared(KEY_AGENT);
  const f = focused();
  return list.find((a) => a.address === picked)
    ?? list.find((a) => f && (a.address === f.agent || a.address === f.terminal))
    ?? list[0] ?? null;
}

// What the Terminal button and ctrl-` open: the chat's agent; on a tab with no agent, the tab's focused terminal
// pane, else its first. An agent that stopped reporting its status (issue #11, item 5: Claude Code after a new
// session id) leaves its tab with no agent while it still runs there. Null for a tab with no terminal pane.
export function currentTerminal() {
  const a = currentAgent();
  if (a) return a;
  return paneTerminal(activeTab());
}
// A tab's terminal for the window: its agent, else its focused terminal pane, else its first; null for none.
export const tabTerminal = (tab) => (tab ? tabAgents(tab.id)[0] ?? paneTerminal(tab) : null);
function paneTerminal(tab) {
  if (!tab) return null;
  const list = (panes() ?? []).filter((p) => p.tab === tab.id && p.terminal);
  const f = focused();
  const p = list.find((x) => x.focused) ?? list.find((x) => f && x.terminal === f.terminal) ?? list[0];
  return p ? { address: p.terminal, tab: p.tab, tab_name: tab.named ? tab.name : null, program: p.program, app: p.app, title: p.title } : null;
}

// A tab's label: its name when someone named it, else its agent's name, else its number ("3").
// A tab named just like its program ("Claude Code") counts as unnamed, as in Herdr's agents list.
export function tabLabel(tab) {
  const a = tabAgents(tab.id)[0];
  if (!autoNamed(tab, a)) return tab.name;
  return a ? agentName(a) : tab.name;
}

// The screen for a tab: the chat when an agent runs in it, else the tab's own terminals.
// The chat for a tab with an agent in one pane; the tab's panes once it is split (or for a shell).
export const screenFor = (tab) => (tab && tabAgents(tab.id).length && (tab.panes ?? 1) <= 1 ? "chat" : "tab");

export function showTab(tab) {
  setShared(KEY_AGENT, null);
  run("tab.select", { id: tab.id });
  showScreen(screenFor(tab), tabTerminal(tab));
}

// Closes a tab (herdr asks first when it is the space's last tab).
export function closeTab(id) {
  run("tab.close", { id });
}
export const closeAgent = (a) => closeTab(a.tab);

// A label for people: the tab's name when someone named it, else what the session is about (the
// title the agent set, e.g. Claude Code's conversation summary, as VS Code's tabs show it), else
// the program ("Claude Code").
export function agentName(a) {
  if (!a) return "";
  const named = a.tab_name && !/^\d+$/.test(a.tab_name) && !/^tb\d+$/.test(a.tab_name);
  if (named && a.tab_name !== programName(a)) return a.tab_name;
  return sessionTitle(a) ?? programName(a);
}
const programName = (a) => a.program?.name ?? a.app ?? "Agent";

// Claude Code's own working/idle marker (✳, spinner frames, braille) and the VS Code tab hook's ▲
// (waiting on a prompt: tab-prompt.mjs; it can outlive the prompt). Flockbook draws that status
// itself, so drop them — but keep other leading emoji (🔍 🔀 ⏳ ✅ …: background-work overlays).
const AGENT_MARK = /^[\s✳✢✶✻✽·◐◑◒◓◴◵◶◷*▲⠀-⣿]+/u;
// The agent's title, or null when it says nothing the program name doesn't: empty, the program's
// own name, a folder path, user@host (the same rules as Herdr's shipped agents list).
export function sessionTitle(a) {
  const shown = (a?.title ?? "").replace(AGENT_MARK, "").trim();
  const words = shown.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const path = /^[~/]|^[A-Za-z]:\\/.test(shown.replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = words && words !== a?.program?.name && !path && !words.includes("@") && words.toLowerCase() !== a?.program?.key;
  return telling ? shown : null;
}
// The background-work symbols an optional tab-title hook (a Claude Code hook that sets the terminal title; the
// README's "Tab-title symbols") puts in front of a session's title, in its order: ⏳ 🔍 review dots, agent kinds, ✅, 🔀.
// Without such a hook a title has none of them and none of this applies.
// Each belongs to one sub-status; a tab with several sits under the first of SUB_GROUPS it has.
const OVERLAY = {
  "⏳": ["ci", "CI running", "a merge gate or CI watch is running"],
  "🔍": ["review", "Codex review", "a Codex review is running"],
  "🟣": ["review", "Fable review", "a Fable review agent is running"],
  "🟠": ["review", "Opus review", "an Opus review agent is running"],
  "🔵": ["review", "Sonnet review", "a Sonnet review agent is running"],
  "🟢": ["review", "Haiku review", "a Haiku review agent is running"],
  "⚪": ["review", "review agent", "a review agent is running"],
  "🛠": ["agents", "building", "a build agent is running"],
  "🧪": ["agents", "tests", "a test agent is running"],
  "📐": ["agents", "planning", "a planning agent is running"],
  "🧭": ["agents", "lookup", "a lookup agent is running"],
  "✅": ["results", "results waiting", "a review finished; its results wait for you (clears when you open the tab)"],
  "🔀": ["merge", "ready to merge", "it handed you a merge decision"],
};
// Sub-groups inside an Overview status group, most in need of the owner first.
export const SUB_GROUPS = [
  ["merge", "Ready to merge"],
  ["round", "Extra round asked"],
  ["migration", "Migration go asked"],
  ["reply", "Asks you to reply"],
  ["handoff", "Hand-off given"],
  ["merging", "Merging"],
  ["results", "Review results waiting"],
  ["ci", "Waiting on CI"],
  // A finished turn waiting on a Codex / Fable review it started (asks.js backgroundWork `review`; owner 11-12 s14:
  // its own heading, as CI waits have), apart from tabs where a review agent runs now ("In review").
  ["reviewwait", "Waiting on a review"],
  ["review", "In review"],
  ["agents", "Agents at work"],
  ["background", "Running in the background"],
];
// The symbols in front of an agent's title: [{ glyph, group, word, tip }], [] for none.
export function overlays(a) {
  const out = [];
  // What its reply ends asking for (asks.js) comes first, so a round or merge ask shows even with no symbol in
  // the title (11-12: an extra-round ask showed nowhere outside the terminal). `ask`: from the reply, not the title.
  const m = askMark(askOf(a?.address));
  if (m) out.push({ glyph: m.glyph, group: m.group, word: m.word, tip: m.tip, ask: true });
  // The turn ended but a background shell or agent still runs (asks.js reads it off the screen).
  const b = a && a.status !== "working" && a.status !== "blocked" ? bgOf(a.address) : null;
  for (const ch of (a?.title ?? "").replace(AGENT_MARK, "")) {
    if (ch === "️" || ch === "‍" || ch === " ") continue;   // 🛠️ carries a variation selector
    const o = OVERLAY[ch];
    if (!o) break;
    if (out.some((x) => x.glyph === ch)) continue;
    // 🔀 stays in the title after the owner said "merge" (the hook keeps it while the merge queue / gate runs).
    // It asks the owner only while the reply still ENDS with the hand-off (asks.js); otherwise it is merging.
    if (ch === "🔀" && askOf(a?.address)?.kind !== "merge") {
      // GitHub says the PR is merged (or closed): the work is over, and every symbol left is stale.
      const p = prOf(a?.address);
      if (p?.state === "MERGED") return [{ glyph: ch, group: "merged", word: `merged #${p.pr}`, tip: `#${p.pr} is merged` }];
      if (p?.state === "CLOSED") return [{ glyph: ch, group: "closed", word: `closed #${p.pr}`, tip: `#${p.pr} was closed without merging` }];
      // A shell still running behind the finished turn is the merge watch (owner 11-12 22:15: "its still merging"):
      // working, so the tab stays under "CI / Final Review / Merging", not Done, until the merge lands. Not after a
      // hand-off: that turn is over for good (the owner clears it), so its shells are leftovers (owner 11-12 16:45).
      out.push({ glyph: ch, group: "merging", word: "merging", tip: "it is merging (you said merge; the merge queue or gate runs)", ...(b?.shells && !handoffOf(a?.address) ? { wait: true } : {}) });
      continue;
    }
    // ⏳ / 🔍 / a review dot on a finished turn: the tab-title hook keeps them only while a CI / merge watch, a Codex
    // run or a review agent goes on (it re-checks them at every turn end), so they are live work, ahead of a leftover
    // ✅ or answered 🔀 (owner 11-14 20:00: "⏳✅ … PR #2049" sat in Done while its browser tests ran; its footer and
    // reply did not say CI).
    const live = (ch === "⏳" || o[0] === "review") && a.status !== "working" && a.status !== "blocked";
    out.push({ glyph: ch, group: o[0], word: o[1], tip: o[2], ...(live ? { wait: true } : {}) });
  }
  // The footer's CI / review wait below names the same wait as the title's ⏳ / 🔍: one symbol in the hint (s29).
  const drop = (glyph) => { for (let i = out.length - 1; i >= 0; i--) if (out[i].glyph === glyph && !out[i].ask) out.splice(i, 1); };
  if (b?.ci) drop("⏳");
  if (b?.review) drop("🔍");
  // Work still running behind the finished turn keeps the tab working: a background agent (it reports back and the
  // turn goes on) or a shell (owner 11-15 s36: "results waiting · 1 shell running" counts as running; it reverses the
  // 11-12 16:45 "shells alone → Done"). Shells are leftovers when the turn handed itself to the owner (a hand-off, or a
  // reply that ends with an ask such as "say merge") or when they watch a merge GitHub already finished.
  // A shell behind a reply that says it waits on CI (asks.js backgroundWork `ci`) is a CI watch: "Waiting on CI",
  // working, ahead of the title's ✅ / 🔀 (owner 11-12 16:49: it sat in Done while CI ran).
  if (b?.ci) out.unshift({ glyph: "⏳", group: "ci", word: "waiting on CI", tip: "its turn ended while it waits on CI (a CI watch runs in the background)", wait: true });
  // The same for a Codex review / recheck it waits on (owner 11-12 s14): "Waiting on a review", working.
  if (b?.review) out.unshift({ glyph: "🔍", group: "reviewwait", word: "waiting on a review", tip: "its turn ended while a Codex review runs in the background", wait: true });
  // A reply that says the PR goes through the merge queue, with no 🔀 in the title (the hook did not mark it): the same.
  if (b?.merge && !handoffOf(a?.address) && !out.some((o) => o.group === "merging")) {
    const p = prOf(a?.address);
    if (p?.state !== "MERGED" && p?.state !== "CLOSED") out.unshift({ glyph: "🔀", group: "merging", word: "merging", tip: "its turn ended while its PR goes through the merge queue (a merge watch runs in the background)", wait: true });
  }
  // A WORKING tab whose Now line waits on a Codex job or CI, with no ⏳ / 🔍 in its title (the pipeline's own Codex call
  // sets none): that wait, live (s29, owner 11-14: #2049 "Waiting for the round 10 Codex job" sat under ✅).
  const nw = a?.status === "working" && !out.some((o) => o.glyph === "⏳" || o.glyph === "🔍") ? nowWait(a.address) : null;
  if (nw === "review") out.unshift({ glyph: "🔍", group: "reviewwait", word: "waiting on a review", tip: "it waits on a Codex review job", wait: true });
  if (nw === "ci") out.unshift({ glyph: "⏳", group: "ci", word: "waiting on CI", tip: "it waits on CI", wait: true });
  // Its shells alone, read as that CI / review watch, are that watch: no "⚙ 1 shell running" next to it (s29).
  if (b && (b.agents || !(b.ci || b.review))) out.push({ glyph: "⚙", group: "background", word: bgWords(b), tip: `its turn ended, but ${bgWords(b)} in the background`, agents: b.agents ?? 0, live: (b.agents ?? 0) > 0 || ((b.shells ?? 0) > 0 && !leftoverShells(a, b)) });
  // Finished with a hand-off (asks.js handoffGiven), nothing running behind it: the Overview's "Hand-off given".
  if (a && a.status !== "working" && a.status !== "blocked" && !b?.agents && !out.some((o) => o.wait) && handoffOf(a.address)) out.push({ glyph: "🤝", group: "handoff", word: "hand-off given", tip: "it finished and gave a hand-off: start a fresh session with its re-entry prompt (or /clear there and paste it)" });
  return out;
}
// Whether the shells behind a finished turn are leftovers, not work (overlays): the turn was handed to the owner, or
// the merge they watch is over.
function leftoverShells(a, b) {
  if (handoffOf(a?.address) || askOf(a?.address)?.kind) return true;
  const st = b?.merge ? prOf(a?.address)?.state : null;
  return st === "MERGED" || st === "CLOSED";
}
// The status a tab's mark shows: working while a shell or agent still runs behind a finished turn.
export const tabStatus = (tab) => {
  // Blocked only past the grace (needReason): a permission check auto mode settles shows as working.
  if (tab.status === "blocked") return tabAgents(tab.id).some((a) => reallyBlocked(a)) ? "blocked" : "working";
  return tab.status !== "working" && subStatus(tab)?.background ? "working" : tab.status;
};
// A tab's sub-status: { key, title, glyphs, hint, tip } from its first agent's symbols, or null.
// hint is short ("🛠 building · ✅ results waiting"); tip says it in words.
export function subStatus(tab) {
  const list = overlays(tabAgents(tab.id)[0]);
  if (!list.length) return null;
  // A live CI wait leads (it is what the tab does now); else the first of SUB_GROUPS it has.
  const live = list.find((o) => o.wait);
  // Owner 11-14 s29 ("Live work wins"): ✅ means results wait for the owner only on a tab with nothing running (its
  // turn over, no live wait, no background agent). On a working tab it is a hint word: the tab sits under what it does
  // now (In review, Agents at work …), or with no other symbol, under its status with no sub-group.
  const busy = tab.status === "working" || tabAgents(tab.id)[0]?.status === "working" || list.some((o) => o.wait || (o.group === "background" && o.live));
  const has = (k) => list.some((o) => o.group === k) && !(busy && k === "results");
  const [key, title] = (live && SUB_GROUPS.find(([k]) => k === live.group)) ?? SUB_GROUPS.find(([k]) => has(k))
    ?? (busy && list.every((o) => o.group === "results") ? [null, ""] : [list[0].group, ""]);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    key, title,
    glyphs: list.map((o) => o.glyph).join(""),
    hint: list.map((o) => `${o.glyph} ${o.word}`).join(" · "),
    tip: list.map((o) => `${cap(o.tip)}.`).join(" "),
    owner: list.some((o) => o.group === "merge" || (o.group === "results" && !busy) || o.group === "handoff" || o.ask),
    // The ask's symbol (🔁 🔀 🗄 💬), for labels that show the title's own symbols but not this one.
    askGlyph: list.find((o) => o.ask)?.glyph ?? null,
    // Work still running behind a finished turn: the tab shows as working.
    background: list.some((o) => (o.group === "background" && o.live) || o.wait),
  };
}
// A label with the ask's symbol in front when the label doesn't show it yet (`ss`: subStatus): a title's own
// symbols (✅ …) are in the label, the ask's (🔁 extra round, 🔀 merge) come from the reply, not the title.
export const withAsk = (ss, label) => (ss?.askGlyph && !String(label).includes(ss.askGlyph) ? `${ss.askGlyph} ${label}` : label);
// A tab's label without the symbols in front (the Overview shows them as a hint of their own).
export function plainLabel(tab) {
  const label = tabLabel(tab);
  return label.replace(/^[^\p{L}\p{N}]+/u, "").trim() || label;
}

// The topic alone, for keeping as a tab's name: the title without the session-state emoji in
// front (🔍 🔀 … come and go; a kept name shouldn't carry one).
export function sessionTopic(a) {
  return sessionTitle(a)?.replace(/^[^\p{L}\p{N}]+/u, "").trim() || null;
}
// Whether the tab's label comes from its session (nobody named it, or it is named just like its
// program), so tabLabel follows the topic.
export function autoNamed(tab, a = tabAgents(tab.id)[0]) {
  return !tab.named || Boolean(a && tab.name === programName(a));
}
// Double-click on a tab: an auto-named tab keeps its current topic as its name; a tab someone
// named (or one without a topic) gets Herdr's rename box.
export function keepOrRename(tab) {
  const a = tabAgents(tab.id)[0];
  const topic = sessionTopic(a);
  if (autoNamed(tab, a) && topic) run("tab.rename", { id: tab.id, name: topic });
  else run("tab.rename", { id: tab.id });
}

export function showAgent(address) {
  setShared(KEY_AGENT, address);
  run("agent.focus", { terminal: address });
  showScreen("chat", agents().find((a) => a.address === address) ?? undefined);
}

export function showNeeds() { showScreen("needs"); }
export function showOverview() { showScreen("overview"); }
// The Flockbook settings: a dialog over the window, as Herdr's own Settings (dimmed behind it; Esc or a
// click beside it closes it). The file is read again, in case someone edited it. Opening it again
// replaces the open one, so there is never a second (closing an id that is gone does nothing).
export const KEY_SETTINGS = "flockbook.settings";   // the open settings dialog's overlay id
export const SETTINGS_W = 760, SETTINGS_H = 0.8;
export function showSettings() {
  loadConfig();
  const open = shared(KEY_SETTINGS);
  if (open) closeOverlay(open);
  setShared(KEY_SETTINGS, openOverlay({ mod: "flockbook", props: { view: "settings" }, kind: "dialog", width: SETTINGS_W, height: SETTINGS_H }));
}
// The dialog went (Esc, a click beside it, its close button).
export function settingsClosed(id) {
  if (id && shared(KEY_SETTINGS) === id) setShared(KEY_SETTINGS, null);
}
// The Resume sessions dialog (sessions.js): like the settings, one at a time (opening it again replaces the open one).
export const KEY_SESSIONS = "flockbook.sessions.open";   // the open dialog's overlay id
export const SESSIONS_W = 820, SESSIONS_H = 0.85;
export function showSessions() {
  const open = shared(KEY_SESSIONS);
  if (open) closeOverlay(open);
  setShared(KEY_SESSIONS, openOverlay({ mod: "flockbook", props: { view: "sessions" }, kind: "dialog", width: SESSIONS_W, height: SESSIONS_H }));
}
export function sessionsClosed(id) {
  if (id && shared(KEY_SESSIONS) === id) setShared(KEY_SESSIONS, null);
}

// Opens a tab of any space: that space, that tab, and its screen.
export function openTab(spaceId, tab) {
  setShared(KEY_AGENT, null);
  run("space.select", { id: spaceId });
  run("tab.select", { id: tab.id });
  showScreen(screenFor(tab), tabTerminal(tab));
}

// Agents that wait for the owner, in every space: a question or approval (blocked), an ask its reply ended
// with (asks.js: an extra review round, a merge hand-off), or a turn that ended handing over a merge (the
// tab-title hook's 🔀; a working session is busy again).
// <grace> A permission prompt that auto mode settles by itself ("Wants to use …" for a few seconds) also reports
// "blocked" (owner 11-12: "asked for a needs you but didn't actually need me"). Blocked counts only once it has
// lasted BLOCK_GRACE_MS. Herdr gives no time for a status, so each copy notes when it first saw it.
export const BLOCK_GRACE_MS = 10_000;
// `seen`: { [address]: first ms it was seen blocked }; `list`: agents. Updates `seen` (drops the unblocked) and
// says which addresses are past the grace at `now`.
export function blockedPast(seen, list, now, grace = BLOCK_GRACE_MS) {
  const past = new Set();
  for (const k of Object.keys(seen)) if (!list.some((a) => a.address === k && a.status === "blocked")) delete seen[k];
  for (const a of list) {
    if (a.status !== "blocked") continue;
    seen[a.address] ??= now;
    if (now - seen[a.address] >= grace) past.add(a.address);
  }
  return past;
}
// </grace>
const blockedSeen = {};
export const reallyBlocked = (a) => Boolean(a) && a.status === "blocked" && blockedPast(blockedSeen, agents(), Date.now()).has(a.address);
// Some agent is blocked but still inside its grace: views redraw each second meanwhile, so it shows once it lasts.
export const inGrace = () => agents().some((a) => a.status === "blocked" && !reallyBlocked(a));
// For a view's 1 s timer: redraw while some agent is in its grace, and once more when the grace ends.
export function graceRedraw(view) {
  const g = inGrace(), was = view.graceWas;
  view.graceWas = g;
  return g || Boolean(was);
}
export const watchGrace = (cx, view) => cx?.timer?.every(1000, (cx) => { if (graceRedraw(view)) cx.notify(); });

export function needReason(a) {
  if (!a) return null;
  if (a.status === "blocked") return reallyBlocked(a) ? "question" : null;
  const ask = askOf(a.address);
  if (ask) return ask.kind;
  return null;   // a 🔀 alone is merging (the hand-off was answered): the Overview's Merging group, not Needs you
}
export function needing() {
  return agents().filter((a) => needReason(a));
}

// Shows a space's chat. The pick is cleared, so the chat starts at the space's focused or first agent.
export function showSpace(id) {
  setShared(KEY_AGENT, null);
  run("space.select", { id });
  // The window comes back on that space's shown tab (Herdr shows it after this click).
  const sp = spaces().find((x) => x.id === id);
  showScreen("chat", sp ? tabTerminal(sp.tabs?.find((t) => t.active) ?? sp.tabs?.[0]) : undefined);
}

// The agent's own terminal in a floating window, for anything the chat cannot do. A title bar
// (view "termbar") closes it, because Esc goes to the terminal. Opening it again replaces it.
export const KEY_TERM = "flockbook.terminal";   // the open terminal window's overlay id
const KEY_TERM_FOR = "flockbook.terminal.for";  // { address, name }: whose terminal that window shows
// The terminal the open terminal window shows ({ address, name }), or null when none is open.
export const termShown = () => (shared(KEY_TERM) ? shared(KEY_TERM_FOR) ?? null : null);

// Herdr's windows have no resize edges of their own, so the window draws grips on its edges
// (termresize.js): a drag there saves the size as terminal_size "custom" + terminal_px. The title bar's
// buttons step through the preset sizes (shares of the main window); the window reopens in its place
// at the new size (same key).
export const TERM_SIZES = { small: 0.55, default: 0.7, large: 0.85, full: 0.97 };
export const TERM_ORDER = ["small", "default", "large", "full"];
const KEY_TERM_BACK = "flockbook.terminal.back";   // the size before ⤢ (full), for the way back
// The window's width and height: px for a dragged size, else a share of the main window.
export function termDims(size, px) {
  if (size === "custom" && px) return [px[0], px[1]];
  const s = TERM_SIZES[size] ?? TERM_SIZES.default;
  return [s, s];
}
// `at`: the top left. Herdr uses it only for a window it has no spot for yet (one never dropped);
// else the window opens where it was last put (tested 11-11).
function terminalWindow(address, name, at = null) {
  setShared(KEY_TERM_FOR, { address, name });
  setShared(KEY_TERM_TAB, activeTab()?.id ?? null);
  const [width, height] = termWindowDims();
  setShared(KEY_TERM_DIMS, [width, height]);
  // No remembered spot (never dropped): centered in the work column, not over the tab list.
  const room = termRoom();
  if (!at && !termPlace() && room && width > 1 && height > 1) at = termAt([width, height], room);
  const grip = (edge) => ({ mod: "flockbook", props: { view: "termgrip", edge, terminal: address, name } });
  const inner = { type: "column", resizable: false, children: [
    { type: "block", size: { px: 42 }, content: { mod: "flockbook", props: { view: "termbar", terminal: address, name } } },
    { type: "block", content: { terminal: address } },
  ] };
  return openOverlay({
    // Our own frame (rounder than Herdr's): the root paints the terminal's background, so the bar, the
    // terminal's square corners and the grips around them sit inside the rounded edge.
    kind: "window", key: "flockbook-terminal", width, height, frame: "none", ...(at ? { at } : {}),
    layout: { type: "column", resizable: false, background: "background", radius: 16, border: { width: 1, color: "border" }, shadow: "lg",
      children: gripFrame(inner, grip) },
  });
}

// The size the window opens at: the setting, fitted so it stays clear of the tab list (termresize.js fitTerm);
// "full" (⤢) covers the app on purpose.
const KEY_TERM_DIMS = "flockbook.terminal.dims";   // [w, h] the open window was opened at
const KEY_TERM_TAB = "flockbook.terminal.tab";     // the shown tab when it opened (or last followed)
export function termWindowDims() {
  const size = setting("terminal_size");
  const want = termDims(size, setting("terminal_px"));
  return size === "full" ? want : fitTerm(want, termRoom(), termApp(), termPlace());
}
// The work column between the sidebars, app-relative ({x, w, h}), once a screen measured it; null before.
// The sidebars are 250 px in the layout until their views measured them.
// The widths come from shared() (as the window height, KEY_WIN_H): each layout block's copy of the mod may run its
// own module, so the screens, the sidebar and the tab list note them there; written only when they change.
export const KEY_WORK_W = "flockbook.work.width", KEY_SIDE_W = "flockbook.side.width", KEY_LIST_W = "flockbook.list.width";
const KEY_TERM_PLACE = "flockbook.terminal.place";   // {x, y}: Herdr's remembered spot for the window, or null
export function noteWidth(key, size) {
  const w = Math.round(size?.width ?? 0);
  if (w > 0 && shared(key) !== w) setShared(key, w);
}
export function termRoom() {
  const h = shared(KEY_WIN_H), w = shared(KEY_WORK_W);
  if (!(w > 0 && h > 0)) return null;
  return { x: sidebarShown() ? shared(KEY_SIDE_W) ?? 250 : 0, w, h };
}
export function termApp() {
  const r = termRoom();
  return r ? { width: r.x + r.w + (tablistShown() ? shared(KEY_LIST_W) ?? 250 : 0), height: r.h } : null;
}
const termPlace = () => shared(KEY_TERM_PLACE) ?? null;
// Herdr's remembered spot for the window (windows.json "places"; its own file, read only), at most every 2 s.
let placeAt = 0;
export async function readTermPlace(now = Date.now()) {
  if (now - placeAt < 2000) return;
  placeAt = now;
  let p = null;
  try { p = JSON.parse((await readTextFile(`${appHome()}/windows.json`)) ?? "{}")?.places?.["flockbook-terminal"] ?? null; } catch { p = null; }
  const place = Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) ? { x: p[0], y: p[1] } : null;
  if (JSON.stringify(place) !== JSON.stringify(termPlace())) setShared(KEY_TERM_PLACE, place);
}
// Run by the screen sync (top.js, every 300 ms, each copy; the shared keys make the first copy act). While the
// terminal window is open: (1) the shown tab changed (a click on a tab or a workspace, a key): the window shows
// that tab's terminal, or closes when it has none (owner 11-13: clicking a tab changed nothing on screen);
// (2) the app or the sidebars changed size, or the window was moved: it reopens in place at the fitted size.
// (0) Needs you and Overview take the whole work column: switching TO one puts the open window away (owner 11-13: it
// covered Needs you, so a click there seemed to do nothing), switching back to a chat reopens it for the shown tab. A
// window opened while one of them shows ("Answer in terminal") stays: only the switch puts it away.
const KEY_TERM_AWAY = "flockbook.terminal.away";       // true while the window is put away for Needs you / Overview
const KEY_TERM_SCREEN = "flockbook.terminal.screen";   // the screen at the last sync, to see a switch
const AWAY_SCREENS = new Set(["needs", "overview"]);
// The switch to `screen`: puts the open window away (to Needs you / Overview) or brings it back (to anything else) for
// `to` (undefined: the shown tab's terminal). Run by showScreen in the click (owner 11-13: coming back on the next
// sync, a second later, was eye-straining) and by the sync for a switch made elsewhere. True when it opened or closed it.
function stepTerminal(screen, to) {
  const before = shared(KEY_TERM_SCREEN) ?? null;
  if (screen !== before) setShared(KEY_TERM_SCREEN, screen);
  if (AWAY_SCREENS.has(screen)) {
    const opened = shared(KEY_TERM);
    if (AWAY_SCREENS.has(before) || !opened) return false;
    setShared(KEY_TERM, null); closeOverlay(opened); setShared(KEY_TERM_AWAY, true);
    return true;
  }
  // The settings dialog opens over any screen: not "back to a chat" yet.
  if (!shared(KEY_TERM_AWAY) || screen === "settings") return false;
  setShared(KEY_TERM_AWAY, null);
  const cur = shared(KEY_TERM) ? null : to === undefined ? currentTerminal() : to;
  if (!cur) return false;
  setShared(KEY_TERM, terminalWindow(cur.address, agentName(cur)));
  return true;
}
export function keepTerminal() {
  const screen = shared(KEY_SCREEN) ?? null;
  if (stepTerminal(screen) || AWAY_SCREENS.has(screen)) return;
  const open = shared(KEY_TERM), shown = termShown();
  if (!open || !shown) return;
  const tab = activeTab()?.id ?? null;
  if (tab && tab !== shared(KEY_TERM_TAB)) {
    setShared(KEY_TERM_TAB, tab);
    const cur = currentTerminal();
    if (!cur) { setShared(KEY_TERM, null); closeOverlay(open); return; }
    if (cur.address !== shown.address) { setShared(KEY_TERM, terminalWindow(cur.address, agentName(cur))); return; }
  }
  const was = shared(KEY_TERM_DIMS), now = termWindowDims();
  if (!Array.isArray(was) || Math.abs(was[0] - now[0]) >= 2 || Math.abs(was[1] - now[1]) >= 2) setShared(KEY_TERM, terminalWindow(shown.address, shown.name));
}

// ctrl-` and the Terminal button: open the agent's terminal window, or close it when it is open.
export function openTerminal(a) {
  const open = shared(KEY_TERM);
  if (open) { setShared(KEY_TERM, null); closeOverlay(open); return; }
  if (!a) return;
  setShared(KEY_TERM, terminalWindow(a.address, agentName(a)));
}
// Opens `a`'s terminal window, never closes it (the sidebar's 🔌, s10): another agent's open window makes way.
export function answerInTerminal(a) {
  if (!a) return;
  const open = shared(KEY_TERM);
  if (open) { setShared(KEY_TERM, null); closeOverlay(open); }
  setShared(KEY_TERM, terminalWindow(a.address, agentName(a)));
}
// The size the title bar asks for: "smaller", "larger", or "toggle" (full ⇄ the size before; a
// double-click on the bar). `share`: how big a custom (dragged) size is, as a share of the main window
// (null when not known yet); `back`: the size before full.
export function nextTermSize(cur, how, share = null, back = null) {
  if (how === "reset") return "default";   // the title bar's ↺ (a dragged size stays saved for Settings)
  if (how === "toggle") return cur === "full" ? (back && back !== "full" ? back : "default") : "full";
  if (cur === "custom") {
    if (share == null) return how === "larger" ? "large" : "small";
    const bigger = TERM_ORDER.find((k) => TERM_SIZES[k] > share + 0.02);
    const smaller = [...TERM_ORDER].reverse().find((k) => TERM_SIZES[k] < share - 0.02);
    return (how === "larger" ? bigger : smaller) ?? cur;
  }
  const i = Math.max(0, TERM_ORDER.indexOf(cur));
  return TERM_ORDER[Math.max(0, Math.min(TERM_ORDER.length - 1, i + (how === "larger" ? 1 : -1)))];
}
// A custom size's share of the main window, once a drag has measured the main window.
export function termShare() {
  const px = setting("terminal_px");
  const app = geom.app;
  return px && app?.width > 0 && app?.height > 0 ? Math.max(px[0] / app.width, px[1] / app.height) : null;
}
// What the bar's buttons would pick (the same as now: that button is off).
export function termSizeFor(how) {
  const back = shared(KEY_TERM_BACK);
  return nextTermSize(setting("terminal_size"), how, termShare(), back === "custom" && !setting("terminal_px") ? null : back);
}
export async function resizeTerminal(address, name, how) {
  const cur = setting("terminal_size");
  const to = termSizeFor(how);
  if (to === cur) return;
  if (to === "full") setShared(KEY_TERM_BACK, cur);
  await setSetting("terminal_size", to);
  if (shared(KEY_TERM)) setShared(KEY_TERM, terminalWindow(address, name));
}
// A drag on the window's edge let go: save the size and reopen the window at it (`r` {x, y, w, h}),
// in its place (`at` keeps a window that was never dropped from re-centering). Only the window that was dragged is
// reopened: when it shows another terminal now (closed and opened for another agent meanwhile), the size is saved
// and that window is left alone.
export async function applyTermRect(r, address, name, moved) {
  await setSettings({ terminal_size: "custom", terminal_px: [r.w, r.h] });
  if (termShown()?.address === address) setShared(KEY_TERM, terminalWindow(address, name, moved ? { x: r.x, y: r.y } : null));
}
