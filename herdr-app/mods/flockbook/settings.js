// The "settings" view: the Flockbook settings dialog (sidebar row "Flockbook", ⌘⇧, or the tab menu),
// over the window as Herdr's own Settings, and laid out like it: sections in a sidebar on the left,
// UPPERCASE headings on the right, a row's title and line on the left and its control on the right.
// Esc, a click beside it or its close button closes it. Four settings of two or three choices, saved in
// <appHome>/flockbook/config.json (config.js), and the Phone page (phone.js). Tab moves through the
// sections, then the choices; Enter or Space picks one. Also the update line, which the sidebar shows too.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { setting, setSetting, loadConfig, configBad, configPath, updateShown, dismissUpdate } from "./config.js";
import { icon, settingsClosed } from "./state.js";
import { usageLines, cooledAccounts, accountName, clockText, localOffset, autoPausedUntil, pauseAutoUntilTomorrow, resumeAuto } from "./ai.js";
import { ghCounts } from "./asks.js";
import { accounts } from "./accounts.js";
import { projects } from "./automove.js";
// The accounts in use (the "accounts" setting) and the project workspaces (the "projects" setting), in words.
export function accountsLine() {
  const list = accounts();
  const which = list.length ? list.map((a) => accountName(a.mark)).join(" · ") : "One account: the default one (~/.claude).";
  return `${which} The About lines and Summarize run as each tab's own account. Several accounts: list them in config.json ("accounts", see the README); each one's status line must show its mark.`;
}
export function projectsLine() {
  const list = projects();
  return list.length ? `Projects: ${list.map((p) => p.name).join(", ")} (config.json "projects").` : "No projects are set yet (config.json \"projects\", see the README), so nothing moves.";
}
// "Today: Work account (WORK): automatic 14 of 200 · Rewrite 2 · Summarize 1 requests (…)", the GitHub checks per hour
// (s13 F5) and any account on pause (ai.js). Requests, not tokens.
export function callsLine() {
  const now = Date.now(), parts = usageLines(), gh = ghCounts();
  const paused = cooledAccounts().map((x) => `${accountName(x.account)} paused until ${clockText(x.until, now, localOffset())}.`);
  return [`Today: ${parts.length ? parts.join(" · ") : "no requests yet"}.`, `GitHub checks (merged-PR lookups): ${gh.now} this hour, ${gh.last} the hour before.`, ...paused].join(" ");
}
import { pollPhone, phoneTick, PHONE_TICK_MS, phoneOn, phoneBlocked, phoneChoose, phoneUser, phoneBody, setPhoneOption } from "./phone.js";

const PHONE = { title: "Phone page", about: "Read your agents on your phone, through Tailscale." };

export const SETTINGS = [
  { key: "check_updates", title: "Check for updates", choices: [[true, "On", "on"], [false, "Off", "off"]],
    about: "Once a day, Flockbook asks GitHub (api.github.com) for its latest release and shows a line when a newer one is out." },
  { key: "text_size", title: "Text size", choices: [["small", "Small", "small"], ["default", "Default", "default"], ["large", "Large", "large"]],
    about: "The size of the messages, code and tables in the chat. ⌥⌘- and ⌥⌘= step it, ⌥⌘0 resets it; Herdr's zoom (⌘- and ⌘=) scales the whole window." },
  { key: "status_row", title: "Status row", choices: [["show", "Show", "show"], ["hide", "Hide", "hide"]],
    about: "The model, context, cost, folder and branch above the reply box." },
  { key: "remote_helper", title: "Helper on other machines", choices: [["ask", "Ask", "ask"], ["never", "Never", "never"]],
    about: "For a tab on another machine, the chat asks before it installs the Flockbook helper there. Never: it does not ask, and nothing runs there. To remove a helper that is already there, choose Ask first." },
  { key: "auto_move", title: "Move sessions to their project", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: () => `A session started in a "~" workspace moves once to a project's workspace when its title names that project or its work happens in that project's folder. Your view stays where it is; a session you move back stays put. ${projectsLine()}` },
  // The plus build's workflow switches: each reads a way of ending a reply that a particular setup uses (the README's
  // "Settings"); off unless turned on here or in config.json.
  { key: "pipeline_asks", title: "Review-pipeline asks", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: "A reply ending with “🔁 Extra review round needed #N: round K · … · repo …”, “🔀 Ready to merge #N — say \"merge\"” or 'reply \"go migration N\"' is listed under Needs you, with Extra round and Merge buttons, and a tab whose title shows 🔀 is checked on GitHub (gh) until its pull request is merged." },
  { key: "handoff_marks", title: "Hand-off marks", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: "A finished tab whose last reply hands the work to a fresh session (“yes, clear”, a “re-entry prompt”, “safe to /clear”) gets 🤝 and goes under Done → Hand-off given." },
  { key: "worth_considering", title: "“Also worth considering” lists", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: "A reply that ends with an “Also worth considering” list of optional ideas is not taken as asking you something, even when an idea ends with a question or a “say …”." },
  // Set in config.json only (lists): shown here so the dialog says what is in use.
  { key: "accounts_info", title: "Claude accounts", info: () => accountsLine() },
  { key: "about_line", title: "About lines", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: "Each Overview card gets one plain-English line on what the tab's work is for, written by Haiku (Claude's smallest model) from the tab's screen, as the tab's own Claude account: once per tab, again when its title changes, never for a tab idle for hours. It uses that account's usage; an account that runs out is paused until its reset. The \"Now\" line under it costs nothing." },
  // One click stops automatic About lines until midnight (s13 F6). Not a config.json setting: kept in the shared store
  // with its end time (`current` / `act` replace the usual setting).
  { key: "about_pause", title: "Pause automatic About lines",
    choices: () => [["run", "Running", "run"], ["tomorrow", autoPausedUntil() ? `Paused until ${clockText(autoPausedUntil(), Date.now(), localOffset())}` : "Until tomorrow", "tomorrow"]],
    current: () => (autoPausedUntil() ? "tomorrow" : "run"),
    act: (v) => (v === "tomorrow" ? pauseAutoUntilTomorrow() : resumeAuto()),
    about: "Stops the automatic About lines until midnight, then they go on by themselves. \"Rewrite\" and \"Summarize this tab\" still work." },
  // Today's count (ai.js callsToday) under the cap's own words (B3, owner 11-12).
  { key: "about_cap", title: "About daily cap", choices: [["100", "100", "100"], ["200", "200", "200"], ["400", "400", "400"], ["none", "No cap", "none"]],
    about: () => `At most this many automatic About lines a day per Claude account. "Rewrite" and "Summarize this tab" always go. ${callsLine()}` },
  // A dragged size shows as a fourth choice, "Custom W × H", while there is one.
  { key: "terminal_size", title: "Terminal window size", choices: () => {
      const px = setting("terminal_px");
      return [["small", "Small", "small"], ["default", "Default", "default"], ["large", "Large", "large"], ["full", "Full", "full"],
        ...(px ? [["custom", `${px[0]} × ${px[1]}`, "custom"]] : [])];
    },
    about: "How big the agent's terminal window (⌃`) opens. Drag its edges or corners to any size (kept as the last choice), or use the − + buttons and the full-size button on its title bar (or double-click the bar)." },
  // Owner 11-13: "can the claude icon be dancing when its working" (tabs.js dances).
  { key: "dance", title: "Dancing agent icons", choices: [["on", "On", "on"], ["off", "Off", "off"]],
    about: "In the tab list, a working agent's icon hops and sways until its work stops. Off: it stays still; the spinner beside it still turns." },
];

// The sidebar's sections; `parts`: [heading, setting keys] in order.
export const SECTIONS = [
  { id: "general", label: "General", icon: "sliders", parts: [["CHAT", ["text_size", "status_row"]], ["TERMINAL", ["terminal_size"]], ["TAB LIST", ["dance"]], ["OVERVIEW", ["about_line", "about_pause", "about_cap", "accounts_info"]], ["OTHER MACHINES", ["remote_helper"]]] },
  { id: "workflow", label: "Workflow", icon: "tool", parts: [["NEEDS YOU", ["pipeline_asks", "worth_considering"]], ["DONE", ["handoff_marks"]], ["WORKSPACES", ["auto_move"]]] },
  { id: "phone", label: "Phone page", icon: "phone" },
  { id: "updates", label: "Updates", icon: "refresh", parts: [["UPDATES", ["check_updates"]]] },
];

const picks = (e) => e?.key === "enter" || e?.key === "space" || e?.key === " ";

// "Flockbook X is out" with Copy (the one-line install) and Not now. Null when there is nothing to say.
// `full`: the command is written out too (the settings dialog; the sidebar is narrow).
const smallButton = (t) => (id, label, act) => div().id(id).h(24).px(9).flex().items_center().rounded(6).text_size(12)
  .text_color(t.foreground).bg(t.chrome).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => act(cx)).child(label);

// The plus build updates from its own git folder: the official install command would put the official mod back
// over it. So the line offers this build's update command instead, and says why.
export const PLUS_UPDATE = "git pull && ./install.sh";
export function updateLine(t, owner, full = false) {
  const u = updateShown();
  if (!u) return null;
  const small = smallButton(t);
  const copy = (cx) => { cx.write_to_clipboard?.(PLUS_UPDATE); owner.copied = u.latest; cx.notify?.(); };
  return v_flex().id("update-line").w_full().px(10).py(8).gap(6).rounded(8).bg(t.raised).border(1).border_color(t.border)
    .child(div().text_size(12.5).text_color(t.foreground).child(`Flockbook ${u.latest} is out upstream`))
    .child(div().text_size(11.5).text_color(t.muted).child("This is the plus build: update it in its folder once it has the new release (the official installer would replace it)."))
    .when(full, (el) => el.child(div().id("update-command").text_size(11.5).font_family("Menlo").text_color(t.muted).child(PLUS_UPDATE)))
    .child(h_flex().gap(6).items_center()
      .child(small("update-copy", owner.copied === u.latest ? "Copied" : "Copy update command", copy))
      .child(small("update-dismiss", "Not now", (cx) => cx.spawn(async (cx) => { await dismissUpdate(); cx.notify(); }))));
}

export class SettingsView {
  constructor(cx) {
    this.copied = null;
    this.section = "general";
    this.overlay = props()?.overlay ?? null;
    // The Phone page's login: saved on Enter or when the field loses the keys.
    this.login = InputState.new({ placeholder: "Default: this machine's Tailscale login" });
    const save = (_e, cx) => {
      const v = this.login.value().trim();
      if (v === phoneUser()) return;
      cx.spawn(async (cx) => { await setPhoneOption("phone_user", v); cx.notify(); });
    };
    this.login.on("submit", save);
    this.login.on("blur", save);
    cx?.spawn?.(async (cx) => { await loadConfig(); this.login.set_value(phoneUser()); cx.notify(); });
    cx?.spawn?.(async (cx) => { await pollPhone(false); cx.notify(); });
    // Every 10 s; every 3 s while On waits for Serve (phone.js).
    cx?.timer?.every(PHONE_TICK_MS, (cx) => cx.spawn(async (cx) => { await phoneTick(); cx.notify(); }));
  }

  close(_cx) { settingsClosed(this.overlay); }

  loginInput() { return Input.new(this.login).w_full(); }

  choose(key, value, cx) { cx.spawn(async (cx) => { await setSetting(key, value); cx.notify(); }); }

  render(cx) {
    const t = theme();
    const close = div().id("settings-close").size(28).flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => { settingsClosed(this.overlay); if (this.overlay) closeOverlay(this.overlay); })
      .child(svg(icon("close")).size(14));
    return h_flex().id("settings-screen").size_full().items_start()
      .child(this.nav(t))
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(h_flex().w_full().flex_none().px(16).pt(12).justify_end().child(close))
        .child(div().flex_1().min_h(0).w_full().child(this.content(t, cx))));
  }

  // The sections, as Herdr's Settings: the title, a row a section with its icon (the chosen one filled), and
  // where the settings are saved at the bottom.
  nav(t) {
    const go = (id, cx) => { this.section = id; cx?.notify?.(); };
    return v_flex().id("set-nav").w(196).h_full().flex_none().px(12).pt(18).pb(14).gap(2).border_r(1).border_color(t.border)
      .child(div().px(10).pb(14).text_size(18).font_semibold().text_color(t.foreground).child("Flockbook"))
      .children(SECTIONS.map((s, i) => {
        const on = this.section === s.id;
        return h_flex().id(`set-nav-${s.id}`).h(34).px(10).gap(10).items_center().rounded(8).text_size(13.5)
          .tab_index(i + 1).text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((x) => x.bg(t.hover)))
          .focus((x) => x.border(1).border_color(t.accent))
          .on_click((_e, cx) => go(s.id, cx))
          .on_key_down((e, cx) => { if (picks(e)) { cx.stop_propagation?.(); go(s.id, cx); } })
          .child(svg(icon(s.icon)).size(15).flex_none())
          .child(div().truncate().child(s.label));
      }))
      .child(div().flex_1())
      .child(div().px(10).text_size(11).text_color(t.dim).child(`Saved in ${configPath()}. Changes apply at once.`));
  }

  content(t, _cx) {
    const bad = configBad();
    let stop = SECTIONS.length;
    // The choices: `current` is the chosen value, `pick(value, cx)` acts, `off`: nothing can be picked.
    const seg = (key, choices, pick, current = setting(key), off = bad) => h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.chrome).border(1).border_color(t.border)
      .children(choices.map(([value, label, slug]) => {
        const on = current === value;
        return div().id(`set-${key}-${slug}`).h(26).px(12).flex().items_center().rounded(6).text_size(12.5)
          .tab_index(++stop).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : off ? t.dim : t.muted)
          .when(on, (el) => el.font_semibold())
          .when(!off, (el) => el.hover((x) => x.bg(on ? t.selected : t.hover)))
          .focus((x) => x.border(1).border_color(t.accent))
          .on_click((_e, cx) => { if (!off) pick(value, cx); })
          .on_key_down((e, cx) => { if (picks(e) && !off) { cx.stop_propagation?.(); pick(value, cx); } })
          .child(label);
      }));
    const heading = (text) => div().pt(18).pb(2).text_size(11.5).text_color(t.muted).child(text);
    const about = (title, line) => v_flex().flex_1().min_w(0).gap(3)
      .child(div().text_size(13.5).text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(line));
    const row = (s) => s.info
      ? h_flex().id(`set-${s.key}`).w_full().py(14).gap(24).items_center().border_b(1).border_color(t.border).child(about(s.title, s.info()))
      : h_flex().id(`set-${s.key}`).w_full().py(14).gap(24).items_center().border_b(1).border_color(t.border)
      .child(about(s.title, typeof s.about === "function" ? s.about() : s.about))
      .child(s.act
        ? seg(s.key, s.choices(), (v, cx) => { s.act(v); cx?.notify?.(); }, s.current(), false)
        : seg(s.key, typeof s.choices === "function" ? s.choices() : s.choices, (v, cx) => this.choose(s.key, v, cx)));
    const sec = SECTIONS.find((x) => x.id === this.section) ?? SECTIONS[0];
    const body = v_flex().w_full().gap(0);
    if (bad) body.child(div().id("set-bad").mt(12).p(10).rounded(8).bg(t.raised).border(1).border_color(t.blocked)
      .text_size(12.5).text_color(t.foreground)
      .child("config.json could not be read (it is not valid JSON), so the defaults apply. Fix the file or remove it to change these here."));
    for (const [h, keys] of sec.parts ?? []) {
      body.child(heading(h));
      for (const k of keys) body.child(row(SETTINGS.find((x) => x.key === k)));
    }
    if (sec.id === "phone") {
      body.child(heading("PHONE PAGE"))
        .child(v_flex().id("set-phone").w_full().py(14).gap(12).border_b(1).border_color(t.border)
          .child(h_flex().w_full().gap(24).items_center()
            .child(about(PHONE.title, PHONE.about))
            .child(seg("phone", [[false, "Off", "off"], [true, "On", "on"]], (v, cx) => phoneChoose(v, cx), phoneOn(), phoneBlocked())))
          .child(phoneBody(t, this, { seg, small: smallButton(t), heading })));
    }
    if (sec.id === "updates" && updateShown()) body.child(div().pt(16).child(updateLine(t, this, true)));
    return v_flex().id("settings-root").size_full().overflow_y_scrollbar().px(32).pb(24).child(body);
  }
}
