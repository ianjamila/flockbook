// Other machines in the sidebar (owner 11-14: "why cant i see my PC here i already connected it to herdr"). Herdr's
// own sidebar (mods/spaces) groups the workspaces under a header per machine once one other than this computer is
// known; Flockbook's did not, so a connected PC with no workspace yet showed nowhere. This module keeps what is known
// about the machines and draws the parts side.js puts around its workspace rows, as Herdr's sidebar does:
// a header per machine (icon, name, its state when not connected, "+" for a new workspace there, a dot, a fold
// chevron), a row for a machine with no workspace ("New workspace there", or "Loading…" while its layout loads),
// the login command for one that needs a login, and Connect for one that was rebuilt or replaced.
//
// What is known: `hc machine ls --json` (every 15 s, one copy of the sidebar asks for all), Herdr's machines() (each
// machine's layout: loading / ready / unavailable) and the spaces' own `machine`. Folded machines and a reconnect
// under way are kept in shared state (the docked and the floating sidebar agree) and in localStorage (they outlast a
// restart, as in Herdr's sidebar).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, run, shared, setShared, machines as herdrMachines } from "herdr";
import { icon } from "./state.js";

export const KEY_MACHINES = "flockbook.machines";            // { at, list }: `hc machine ls`, temporary ones left out
const KEY_MACHINES_BUSY = "flockbook.machines.busy";
export const KEY_FOLDED = "flockbook.machines.folded";        // machine names folded (null: this computer)
export const KEY_RECONNECT = "flockbook.machines.reconnecting"; // name → { machine, removed, busy, error }
export const MACHINES_MS = 15_000;
const BUSY_MS = 30_000;

// localStorage when the runtime has it (Herdr's mods do; node tests may not).
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const loadStored = (key, fallback) => { try { const v = store()?.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const keep = (key, value) => { setShared(key, value); try { store()?.setItem(key, JSON.stringify(value)); } catch { /* not kept past a restart */ } };
// The shared copy, first filled from localStorage (the folds and a half-done reconnect outlast a restart).
const kept = (key, fallback) => {
  const v = shared(key);
  if (v !== undefined && v !== null) return v;
  const s = loadStored(key, fallback);
  setShared(key, s);
  return s;
};

// Herdr's machines(): each machine's layout (loading / ready / unavailable); null names this computer.
export const layouts = () => herdrMachines() ?? [];
// The machines `hc machine ls` listed last.
export const knownMachines = () => shared(KEY_MACHINES)?.list ?? [];

// Asks hc for the machines, at most once per MACHINES_MS across every copy of the sidebar; a failed ask keeps the
// last list. `now`: for tests.
export async function machinesTick(now = Date.now()) {
  const was = shared(KEY_MACHINES), busy = shared(KEY_MACHINES_BUSY);
  if (was?.at && now - was.at < MACHINES_MS - 500) return;
  if (busy && now - busy < BUSY_MS) return;
  setShared(KEY_MACHINES_BUSY, now);
  try {
    const r = await hc(["machine", "ls", "--json"]);
    if (r?.code !== 0) return;
    const list = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
    setShared(KEY_MACHINES, { at: now, list });
  } catch { /* hc away: keep the last list */ } finally { setShared(KEY_MACHINES_BUSY, null); }
}

// A machine whose address now answers with another core (reinstalled or replaced): Connect re-adds it.
export const rebuilt = (m) => m?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(m.why ?? "");

// The groups to draw, this computer first then the others by name: [{ name, machine, spaces, connected, state,
// rebuilt, login, loading, repair }], or null while only this computer is known (the list stays flat).
export function machineGroups(list, known = knownMachines(), lay = layouts(), repairing = kept(KEY_RECONNECT, {})) {
  const names = [...new Set([...(list ?? []).map((s) => s.machine).filter(Boolean), ...(known ?? []).map((m) => m.name),
    ...(lay ?? []).map((m) => m.name).filter(Boolean), ...Object.keys(repairing ?? {})])].sort();
  if (!names.length) return null;
  return [null, ...names].map((name) => {
    const repair = name ? repairing?.[name] ?? null : null;
    const machine = (known ?? []).find((m) => m.name === name) ?? repair?.machine ?? null;
    const layout = (lay ?? []).find((m) => (m.name ?? null) === name)?.layout ?? null;
    const connected = !name || machine?.state === "connected";
    return {
      name, machine, repair, connected,
      spaces: (list ?? []).filter((s) => (s.machine ?? null) === name),
      state: name ? (machine?.state ?? "asleep").replace(/_/g, " ") : null,
      rebuilt: Boolean(name) && (rebuilt(machine) || Boolean(repair)),
      login: machine?.state === "needs_login" ? `hc machine login ${name}` : null,
      loading: layout === "loading" || (!layout && Boolean(name) && machine?.state === "connected"),
    };
  });
}

// "api on pc-wsl" for a workspace on another machine, else its name (Overview by workspace, the tab list's head).
export const spaceTitle = (s) => (s?.machine ? `${s.name} on ${s.machine}` : s?.name);

export const folded = () => new Set(kept(KEY_FOLDED, []));
export function toggleFold(name) {
  const f = folded();
  if (f.has(name)) f.delete(name); else f.add(name);
  keep(KEY_FOLDED, [...f]);
}

// Connect a rebuilt machine again: remove it, then add it back under its name (as Herdr's sidebar does). A failure
// is kept on the header and Connect tries again; a remove that went through is not repeated.
export async function reconnect(machine) {
  const name = machine?.name;
  if (!name) return;
  const all = { ...kept(KEY_RECONNECT, {}) };
  if (all[name]?.busy) return;
  const state = { machine, removed: false, ...all[name], busy: true, error: null };
  const save = () => keep(KEY_RECONNECT, { ...(shared(KEY_RECONNECT) ?? {}), [name]: { ...state } });
  save();
  const ask = async (args) => {
    const r = await hc([...args, "--json"]);
    if (r?.code !== 0) {
      let error;
      try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch { /* plain text */ }
      throw new Error(error || r?.stderr || r?.stdout || "Couldn't connect.");
    }
  };
  try {
    if (!state.removed) { await ask(["machine", "rm", name]); state.removed = true; save(); }
    const args = ["machine", "add"];
    if (machine.via) args.push("--via", machine.target); else args.push(machine.target);
    args.push("--name", name);
    if (machine.session) args.push("--session", machine.session);
    if (machine.temporary) args.push("--temp");
    await ask(args);
    const f = folded(); if (f.delete(name)) keep(KEY_FOLDED, [...f]);
    const rest = { ...(shared(KEY_RECONNECT) ?? {}) };
    delete rest[name];
    keep(KEY_RECONNECT, rest);
  } catch (e) {
    state.error = String(e?.message ?? e);
    state.busy = false;
    save();
  }
  setShared(KEY_MACHINES, { ...(shared(KEY_MACHINES) ?? {}), at: 0 });   // look again now
  await machinesTick();
}

// The header for group `g`. `view.copiedLogin`: the login command copied last (its button says "Copied").
export function machineHeader(g, t, view) {
  const id = g.name ?? "local";
  const isFolded = folded().has(g.name);
  const stop = (_e, cx) => cx.stop_propagation?.();
  const tip = g.login ? `${g.name} needs a login: run ${g.login}` : g.name ? `${g.name}${g.machine?.host ? ` (${g.machine.host})` : ""} · ${g.connected ? "connected" : g.state}` : "This computer";
  const head = h_flex().id(`machine-${id}`).h(26).flex_none().px(10).gap(9).items_center().rounded(7).mt(g.name ? 8 : 2)
    .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { toggleFold(g.name); cx?.notify?.(); })
    .child(h_flex().w(22).flex_none().justify_center().child(svg(icon(g.name ? "server" : "monitor")).size(13)))
    .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name ?? "This computer"))
    .when(!g.connected && !g.rebuilt && !g.login, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(g.state)))
    .when(g.rebuilt, (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11)
      .child(div().max_w(140).truncate().text_color(g.repair?.error ? t.blocked : t.dim).child(g.repair?.error || "rebuilt ·"))
      .child(div().id(`machine-connect-${g.name}`).text_color(g.repair?.error ? t.blocked : t.muted).hover((s) => s.text_color(t.foreground))
        .tooltip(g.repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation?.(); cx.spawn(async (c2) => { await reconnect(g.machine); c2?.notify?.(); }); cx.notify?.(); })
        .child(g.repair?.busy ? "Connecting…" : "Connect"))))
    .when(g.connected, (el) => el.child(div().id(`machine-add-${id}`).size(20).flex_none().rounded(5).flex().items_center().justify_center()
      .tooltip(`New workspace on ${g.name ?? "this computer"}`).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx?.stop_propagation?.(); run("space.new", { machine: g.name ?? "" }); })
      .child(svg(icon("plus")).size(12))))
    .child(div().size(6).rounded(3).flex_none().bg(g.connected ? t.ansi2 : t.dim))
    .child(div().id(`machine-${id}-chevron`).flex_none().child(svg(icon(isFolded ? "chevron-right" : "chevron-down")).size(11)));
  if (!g.login) return [head];
  const guide = v_flex().id(`machine-login-${g.name}`).px(10).pl(41).pb(6).gap(3).flex_none()
    .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
    .child(h_flex().gap(5).items_center()
      .child(div().flex_1().min_w(0).truncate().tooltip(g.login).text_size(11).text_color(t.muted).child(g.login))
      .child(div().id(`machine-login-copy-${g.name}`).flex_none().px(5).py(2).rounded(4).text_size(11).text_color(t.foreground)
        .bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx?.stop_propagation?.(); cx?.write_to_clipboard?.(g.login); view.copiedLogin = g.login; cx?.notify?.(); })
        .child(view.copiedLogin === g.login ? "Copied" : "Copy")));
  return [head, guide];
}

// The row under a machine with no workspace: "Loading…" while its layout loads, else "New workspace there".
export function machineEmpty(g, t) {
  const id = g.name ?? "local";
  if (g.loading) return h_flex().id(`machine-loading-${id}`).h(28).flex_none().px(10).pl(41).items_center().text_size(12).text_color(t.dim).child("Loading…");
  return h_flex().id(`machine-new-${id}`).h(28).flex_none().px(10).gap(9).items_center().rounded(7).text_size(12).text_color(t.dim)
    .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation?.())
    .on_click(() => run("space.new", { machine: g.name ?? "" }))
    .child(h_flex().w(22).flex_none().justify_center().child(svg(icon("plus")).size(12)))
    .child("New workspace there");
}
