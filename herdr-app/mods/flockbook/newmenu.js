// The "+" menu (New tab), Flockbook's own copy of Herdr's shipped new-menu (owner 11-16 s41: "what account for claude
// since i have 2 accounts … it should be like this: Claude Code (jamilaian21), Claude Code (eaglewatch9002), Codex").
// Herdr's menu lists one Claude Code, most used first; this one lists one Claude row per account in Flockbook's
// settings (the default account, without a config folder, first), named by the account's email before the "@" (from
// the weekly usage readings; else the account's name), then Herdr's other agents in its order. A Claude row starts
// claude as that account (accounts.js claudeRun: the account's config folder, on the space's machine). Without
// accounts set, or in a space on this Windows computer (claudeRun's command is Unix), Herdr's own rows are shown.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window as hostWindow, keys, shared, setShared, home, notify } from "herdr";
import { accounts, claudeRun } from "./accounts.js";
import { rows as usageRows, KEY_USAGE } from "./usage.js";
import { snapShared } from "./parked.js";

const KNOWN = "new-menu.agents";   // shared with Herdr's menu: the last agents each machine reported

// <newmenu-pure>
export const shortEmail = (e) => (e && String(e).includes("@") ? String(e).split("@")[0] : null);
// One row per Claude account: the default one (no config folder) first, then the settings' order. [{ mark, label }].
export function claudeAccounts(list, usage) {
  const ordered = [...list.filter((a) => !a.config_dir), ...list.filter((a) => a.config_dir)];
  return ordered.map((a) => {
    const r = (usage ?? []).find((x) => x.kind === "claude" && x.id === a.mark);
    return { mark: a.mark, label: `Claude Code (${shortEmail(r?.email) ?? a.name ?? a.mark})` };
  });
}
// Herdr's entries that start Claude Code (its own, and an s41 programs.json launcher): the account rows replace them.
export const CLAUDE_KEYS = new Set(["claude", "claude-work"]);
// The menu's agent rows: the account rows (installed when Herdr's Claude entry is), then Herdr's other installed
// agents, then up to two not installed. `failed`: the check failed (installed ones only, as Herdr's menu).
export function menuRows(known, accts, failed = false) {
  const list = known ?? [];
  const claude = list.find((a) => a.key === "claude");
  const own = accts.length ? accts.map((a) => ({ key: `claude-${a.mark}`, name: a.label, icon: claude?.icon ?? "icons/claude.svg", tint: Boolean(claude?.tint), installed: claude ? Boolean(claude.installed) : true, account: a.mark })) : [];
  const rest = accts.length ? list.filter((a) => !CLAUDE_KEYS.has(a.key)) : list;
  const installed = [...own.filter((a) => a.installed), ...rest.filter((a) => a.installed)];
  const missing = [...own.filter((a) => !a.installed), ...rest.filter((a) => !a.installed)];
  return { installed, choices: failed ? installed : [...installed, ...missing.slice(0, 2)] };
}
// </newmenu-pure>

function shortcut(name) {
  const k = keys().find((b) => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = hostWindow()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map((stroke) => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export class NewView {
  constructor(cx) {
    this.space = spaces().find((s) => s.active) ?? null;
    this.machine = this.space?.machine ?? null;
    const where = this.machine ?? "";
    this.known = shared(KNOWN)?.[where] ?? [];
    this.failed = false;
    this.handle = cx?.focus_handle?.() ?? null;
    this.handle?.focus?.();
    cx?.spawn?.(async (cx) => {
      try {
        this.known = await knownAgents({ on: this.machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.known });
      } catch { this.failed = true; }
      cx?.notify?.();
    });
  }
  accts() {
    // A space on this Windows computer: claudeRun's command is Unix, so Herdr's own Claude row stays.
    let windowsHere = false;
    try { windowsHere = !this.machine && hostWindow()?.platform === "windows"; } catch { /* not known */ }
    const list = accounts();
    if (!list.length || windowsHere) return [];
    return claudeAccounts(list, usageRows(snapShared(KEY_USAGE), list, home()));
  }
  start(a) {
    const space = this.space?.id;
    if (!a.account) { run("tab.new", { name: a.name, space, argv: a.run }); return; }
    // A Claude account row: claude as that account where the space is (its home learnt for a remote machine).
    claudeRun(a.account, [], this.machine).then((r) => {
      if (r?.cmd) run("tab.new", { name: a.name, space, argv: [r.cmd, ...r.args] });
      else notify({ title: "Couldn't start Claude Code", body: r?.unreachable ? `${r.unreachable} can't be reached.` : `No account "${a.account}" in Flockbook's settings.`, level: "error" });
    }).catch(() => notify({ title: "Couldn't start Claude Code", body: "Its command could not be built.", level: "error" }));
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.hover((s) => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props()?.overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = this.space;
    const { installed, choices } = menuRows(this.known, this.accts(), this.failed);
    const pick = (a) => { closeOverlay(props()?.overlay); this.start(a); };
    let root = v_flex().min_h(0).w_full().h(Math.min(491, 167 + Math.max(1, choices.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu");
    if (this.handle) root = root.track_focus(this.handle);
    return root
      .on_key_down((e) => {
        if (e.modifiers?.control || e.modifiers?.platform || e.modifiers?.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (agent) pick(agent);
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => this.start(a), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
        .when(this.failed || this.known.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find((p) => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find((p) => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
