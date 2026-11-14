// s26 (owner 11-14 "Full: run via Ubuntu"): the PC's Flockbook runs Claude and reads logs on its WSL machine.
// where.js (machine of an address, a machine's home, the helper's cache there), accounts.js claudeRun, ai.js askHaiku
// with "claude_machine", resume.js for tabs on that machine, automove.js projects with a "machine".
// Run: node test-claudemachine.mjs
import { WORK_DIR, CFG_ENV } from "./paths.mjs";
import { loadMod, fakeShared, realConfig } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
let now = 1_800_000_000_000;
Date.now = () => now;
const MAC = "/Users/you", WSL = "/home/you";
const NAME = ["cl", "aude"].join(""), DOT = String.fromCharCode(46);
const TWO = [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }];
const R = "─".repeat(60);
const screen = (acct) => `⏺ Working.\n\n${R}\n❯ \n${R}\n  you:/tmp | ${acct} x@example.com | pipeline 0.1\n  Haiku 5.5`;

// One world: fake Herdr (platform, machines, exec by machine, files by machine), the real config/where/accounts.
async function world({ settings = {}, platform = "macos", ready = ["wsl"], homeOut = WSL, files = {}, agents = [], spaces = [], terms = [], onExec = null, store = {} } = {}) {
  const st = fakeShared(store), execs = [], reads = [], runs = [], statuses = [], notes = [];
  // Modules keep the functions they imported, so a test changes behaviour through `hooks`, not by replacing them.
  const hooks = { machines: [{ name: null, layout: "ready" }, ...ready.map((n) => ({ name: n, layout: "ready" }))], panes: () => [], onRun: null, hc: null };
  const herdr = {
    ...st, hooks, home: () => MAC, appHome: () => `${MAC}/.config/herdr-app`,
    window: () => ({ platform }), machines: () => hooks.machines,
    agents: () => agents, spaces: () => spaces, terminals: () => terms, panes: () => hooks.panes(),
    run: (name, args) => { runs.push([name, args]); hooks.onRun?.(name, args); return null; }, notify: (n) => { notes.push(n); return null; },
    exec: async (cmd, args, opts = {}) => {
      execs.push([cmd, args, opts]);
      if (cmd === "/bin/sh" && opts.on) return homeOut == null ? { code: 1, stdout: "", stderr: "unreachable" } : { code: 0, stdout: homeOut };
      return onExec ? onExec(cmd, args, opts) : { code: 0, stdout: "Line: ok.\nMore: fine." };
    },
    readTextFile: async (p, opts = {}) => { reads.push([p, opts.on ?? null]); const f = files[`${opts.on ?? ""}:${p}`]; return f == null ? null : JSON.stringify(f); },
    hc: async (args) => (hooks.hc ? hooks.hc(args) : { code: 0, stdout: screen("WORK") }),
  };
  const { cfg } = await realConfig({ about_cap: "none", accounts: TWO, ...settings });
  const sidecar = { cachePath: () => `${MAC}/.config/herdr-app/flockbook/cache.json`, status: async (a) => { statuses.push(a); return null; } };
  const where = await loadMod("where.js", { herdr, "./config.js": cfg, "./sidecar.js": sidecar });
  const acc = await loadMod("accounts.js", { herdr, "./config.js": cfg, "./where.js": where });
  return { st, herdr, cfg, where, acc, sidecar, execs, reads, runs, statuses, notes };
}

// 1. where.js pure parts.
{
  const w = await world();
  eq("machineOf: remote / local", [w.where.machineOf("wsl/t3"), w.where.machineOf("t3"), w.where.machineOf("")], ["wsl", null, null]);
  eq("terminalOf: remote / local", [w.where.terminalOf("wsl/t3"), w.where.terminalOf("t3")], ["t3", "t3"]);
  eq("bareId: a remote space id loses its machine", [w.where.bareId("wsl/sp1"), w.where.bareId("sp1")], ["sp1", "sp1"]);
  eq("sameMachine: null and undefined are this computer", [w.where.sameMachine(null, undefined), w.where.sameMachine("wsl", "wsl"), w.where.sameMachine("wsl", null)], [true, true, false]);
}
// 2. machineHome: asked once with a fixed command on that machine, remembered; a failure is retried 5 min on.
{
  const w = await world();
  eq("machineHome(null) = this computer's home, no exec", [await w.where.machineHome(null), w.execs.length], [MAC, 0]);
  eq("machineHome(wsl) asks wsl", await w.where.machineHome("wsl"), WSL);
  eq("the ask: /bin/sh -c printf HOME, on wsl", [w.execs[0][0], w.execs[0][1][0], w.execs[0][2].on], ["/bin/sh", "-c", "wsl"]);
  await w.where.machineHome("wsl");
  eq("remembered: no second ask", w.execs.length, 1);
  eq("knownHome(wsl) after", w.where.knownHome("wsl"), WSL);
}
{
  const w = await world({ homeOut: null });
  eq("unreachable machine: null", await w.where.machineHome("wsl"), null);
  await w.where.machineHome("wsl");
  eq("unreachable: not asked again within 5 min", w.execs.length, 1);
  now += 5 * 60_000 + 1;
  await w.where.machineHome("wsl");
  eq("unreachable: asked again after 5 min", w.execs.length, 2);
}
// 3. logEntry: a remote tab's entry comes from the helper's cache on that machine; none yet → one status call, re-read.
{
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: { t3: { path: `${WSL}/.${NAME}/projects/-home-you/abc.jsonl`, cwd: WSL, pids: [7] } } } };
  const w = await world({ files });
  const e = await w.where.logEntry("wsl/t3");
  eq("logEntry(wsl/t3): read on wsl from its cache", [e?.path?.endsWith("abc.jsonl"), w.reads.some(([p, on]) => on === "wsl" && p === `${WSL}/.cache/flockbook/cache.json`)], [true, true]);
  eq("logEntry: no status call when the entry is there", w.statuses, []);
  const none = await w.where.logEntry("wsl/t9");
  eq("logEntry(wsl/t9): not there → one status call, still none", [none, w.statuses], [null, ["wsl/t9"]]);
}
// 4. accounts.js claudeRun: on a machine, its home and PATH; config folders under that home; claude_path not used there.
{
  const w = await world({ settings: { claude_path: "~/.npm-global/bin/claude" } });
  const r = await w.acc.claudeRun("WORK", ["-p", "hi"], "wsl");
  eq("claudeRun(WORK, wsl): /usr/bin/env on wsl", [r.cmd, r.on], ["/usr/bin/env", "wsl"]);
  eq("claudeRun(WORK, wsl): the work folder under the WSL home", r.args[0], `${CFG_ENV}=${WSL}${WORK_DIR.slice(1)}`);
  const pathArg = r.args.find((x) => x.startsWith("PATH="));
  eq("claudeRun(WORK, wsl): PATH = WSL folders + /usr/local/bin, /usr/bin, /bin; no Mac folder", [pathArg?.startsWith(`PATH=${WSL}/.local/bin:`), pathArg?.includes(":/usr/local/bin:"), pathArg?.endsWith(":/usr/bin:/bin"), pathArg?.includes(MAC)], [true, true, true, false]);
  eq("claudeRun(WORK, wsl): runs `claude` (no Mac claude_path)", r.args.slice(r.args.indexOf("claude")), ["claude", "-p", "hi"]);
  const h = await w.acc.claudeRun("HOME", ["x"], "wsl");
  eq("claudeRun(HOME, wsl): default folder → unset", h.args.slice(0, 2), ["-u", CFG_ENV]);
  const local = await w.acc.claudeRun("WORK", ["x"], null);
  eq("claudeRun(WORK, this computer): as before (claude_path, no on)", [local.on, local.args.includes(`${MAC}/.npm-global/bin/claude`)], [null, true]);
  eq("claudeRun(unknown account) → null", await w.acc.claudeRun("NOPE", ["x"], "wsl"), null);
}
{
  const w = await world({ homeOut: null });
  eq("claudeRun on an unreachable machine → { unreachable }", await w.acc.claudeRun("WORK", ["x"], "wsl"), { unreachable: "wsl" });
}
// 5. ai.js askHaiku: claude_machine set → the call runs on it; Windows without it → a plain message, nothing run.
async function aiWorld(opts) {
  const w = await world(opts);
  const ai = await loadMod("ai.js", { herdr: w.herdr, "./config.js": w.cfg, "./accounts.js": w.acc, "./where.js": w.where, "./state.js": { sessionTopic: (a) => a.title } });
  return { ...w, ai };
}
{
  const w = await aiWorld({ settings: { claude_machine: "wsl" } });
  const r = await w.ai.askHaiku("sys", "prompt", 60_000, "WORK", "about");
  const call = w.execs.find(([c]) => c === "/usr/bin/env");
  eq("askHaiku with claude_machine: worked", r.text?.startsWith("Line:"), true);
  eq("askHaiku with claude_machine: exec on wsl, no Mac cwd", [call?.[2]?.on, call?.[2]?.cwd ?? null], ["wsl", null]);
}
{
  const w = await aiWorld({ platform: "windows" });
  const r = await w.ai.askHaiku("sys", "prompt", 60_000, "WORK", "about");
  eq("Windows, no claude_machine: kind needs-machine, nothing run, no pause", [r.kind, w.execs.length, w.st.data["flockbook.ai.cool"] ?? null], ["needs-machine", 0, null]);
  eq("Windows, no claude_machine: the message names claude_machine", /claude_machine/.test(r.error), true);
}
{
  const w = await aiWorld({ settings: { claude_machine: "wsl" }, homeOut: null });
  const r = await w.ai.askHaiku("sys", "prompt", 60_000, "WORK", "about");
  eq("claude_machine unreachable: kind unreachable, no pause set", [r.kind, w.st.data["flockbook.ai.cool"] ?? null], ["unreachable", null]);
}
{
  const w = await aiWorld({ platform: "windows", settings: { claude_machine: "wsl" } });
  const r = await w.ai.askHaiku("sys", "prompt", 60_000, "HOME", "about");
  eq("Windows with claude_machine: runs on wsl", [Boolean(r.text), w.execs.find(([c]) => c === "/usr/bin/env")?.[2]?.on], [true, "wsl"]);
}

// 6. resume.js: tabs on the Claude machine are remembered with their machine; a disconnected machine's are neither
// live nor lost; Resume opens in that machine's workspace (or a new one there) as the account, on that machine.
const LOGW = (sid) => `${WSL}/.${NAME}/projects/-home-you/${sid}.jsonl`;
const WORKLOG = (sid) => `${WSL}${WORK_DIR.slice(1)}/projects/-home-you/${sid}.jsonl`;
async function resumeWorld(opts) {
  const w = await world(opts);
  const r = await loadMod("resume.js", { herdr: w.herdr, "./accounts.js": w.acc, "./where.js": w.where, "./sidecar.js": w.sidecar });
  return { ...w, r };
}
{
  const cacheW = { entries: { t3: { path: WORKLOG("s-work"), cwd: `${WSL}/projects/webshop`, pids: [30] }, t4: { path: LOGW("s-home"), cwd: WSL, pids: [40] } } };
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: cacheW, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const agents = [
    { app: "claude-code", address: "wsl/t3", space: "wsl/sp1", space_name: "webshop", title: "Shop work", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
    { app: "claude-code", address: "wsl/t4", space: "wsl/sp2", space_name: "~", title: "Notes", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
    { app: "claude-code", address: "pc/t9", space: "pc/sp9", space_name: "~", title: "Other machine", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
  ];
  const spaces = [{ id: "wsl/sp1", name: "webshop", machine: "wsl", tabs: [] }, { id: "wsl/sp2", name: "~", machine: "wsl", tabs: [] }];
  const w = await resumeWorld({ settings: { claude_machine: "wsl" }, platform: "windows", files, agents, spaces, ready: ["wsl", "pc"] });
  await w.r.resumeTick();
  const tabs = w.r.remembered().tabs;
  eq("resume: both WSL tabs remembered, the other machine's not", Object.keys(tabs).sort(), ["s-home", "s-work"]);
  eq("resume: account from the WSL log path (WORK folder / default)", [tabs["s-work"].account, tabs["s-home"].account], ["WORK", "HOME"]);
  eq("resume: machine kept on each record", [tabs["s-work"].machine, tabs["s-home"].machine], ["wsl", "wsl"]);
  // wsl drops off (disconnected): its sessions are neither live nor lost.
  w.herdr.hooks.machines = [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }];
  const ag = agents.slice(); agents.length = 0;
  now += 10 * 60_000;
  await w.r.resumeTick();
  eq("resume: wsl unavailable → nothing offered", w.r.offer(), null);
  eq("resume: wsl unavailable → its records kept", Object.keys(w.r.remembered().tabs).sort(), ["s-home", "s-work"]);
  // wsl back, but its sessions are gone (WSL restarted): offered.
  w.herdr.hooks.machines = [{ name: null, layout: "ready" }, { name: "wsl", layout: "ready" }];
  files[`wsl:${WSL}/.cache/flockbook/cache.json`] = { entries: {} };
  now += 60_000;
  await w.r.resumeTick();
  eq("resume: wsl back with its sessions gone → both offered", (w.r.offer()?.tabs ?? []).map((x) => x.sid).sort(), ["s-home", "s-work"]);
  // Resume one: its space is still there → tab.new in it, argv runs claude on… the space's machine (tab.new starts there).
  const ok = await w.r.resumeOne("s-work");
  const [name, args] = w.runs.at(-1) ?? [];
  eq("resumeOne(s-work): tab.new in wsl/sp1", [ok, name, args?.space], [true, "tab.new", "wsl/sp1"]);
  eq("resumeOne(s-work): argv as WORK with the WSL folder, --resume s-work", [args?.argv?.[0], args?.argv?.[1], args?.argv?.slice(-2)], ["/usr/bin/env", `${CFG_ENV}=${WSL}${WORK_DIR.slice(1)}`, ["--resume", "s-work"]]);
  eq("resumeOne(s-work): folder is the WSL one", args?.folder, `${WSL}/projects/webshop`);
  // Its space is gone → a new space on wsl (never a tab on this computer).
  spaces.splice(0, spaces.length);
  await w.r.resumeOne("s-home");
  const [n2, a2] = w.runs.at(-1) ?? [];
  eq("resumeOne(s-home), space gone: space.new on wsl, named ~", [n2, a2?.machine, a2?.name, a2?.argv?.slice(-2)], ["space.new", "wsl", "~", ["--resume", "s-home"]]);
  void ag;
}
{
  // s27 (hand-off item 11): Resume all after wsl lost its sessions AND its workspaces: one new workspace on wsl, named
  // "~", for all of them (the first makes it, the rest wait for it and open as tabs there), never one workspace each.
  const cacheW = { entries: { t3: { path: WORKLOG("s-work"), cwd: `${WSL}/projects/webshop`, pids: [30] }, t4: { path: LOGW("s-home"), cwd: WSL, pids: [40] } } };
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: cacheW, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const agents = [
    { app: "claude-code", address: "wsl/t3", space: "wsl/sp1", space_name: "webshop", title: "Shop work", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
    { app: "claude-code", address: "wsl/t4", space: "wsl/sp2", space_name: "~", title: "Notes", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
  ];
  const spaces = [{ id: "wsl/sp1", name: "webshop", machine: "wsl", tabs: [] }, { id: "wsl/sp2", name: "~", machine: "wsl", tabs: [] }];
  const w = await resumeWorld({ settings: { claude_machine: "wsl" }, platform: "windows", files, agents, spaces, ready: ["wsl"] });
  await w.r.resumeTick();
  agents.length = 0; spaces.length = 0;
  files[`wsl:${WSL}/.cache/flockbook/cache.json`] = { entries: {} };
  now += 60_000;
  await w.r.resumeTick();
  eq("resume all (pile-up): both offered", (w.r.offer()?.tabs ?? []).map((x) => x.sid).sort(), ["s-home", "s-work"]);
  let made = null;
  w.herdr.hooks.onRun = (name, args) => { if (name === "space.new") made = { id: "wsl/sp9", name: args.name ?? "1", machine: args.machine, tabs: [] }; };
  const waits = [];
  const n0 = w.runs.length;
  await w.r.resumeAll({ wait: async (ms) => { waits.push(ms); if (made && !spaces.includes(made)) spaces.push(made); } });
  eq("resume all (pile-up): one space.new named ~ on wsl, then a tab in it", w.runs.slice(n0).map(([n, a]) => [n, a.name ?? null, a.space ?? null, a.machine ?? null]),
    [["space.new", "~", null, "wsl"], ["tab.new", null, "wsl/sp9", null]]);
  eq("resume all (pile-up): waited for it", waits.length >= 1, true);
}
{
  // s28 (Codex R1 P2): wsl away 10 minutes; back with one of its three sessions gone and a new Claude tab that stays
  // unidentified for two polls. The downtime still counts once the tab is identified: the lost one is offered (not
  // taken for a tab closed on purpose and forgotten).
  const tab = (t, sid) => ({ path: WORKLOG(sid), cwd: WSL, pids: [Number(t.slice(1)) * 10] });
  const cacheW = { entries: { t1: tab("t1", "s-a"), t2: tab("t2", "s-b"), t3: tab("t3", "s-c") } };
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: cacheW, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const ag = (t) => ({ app: "claude-code", address: `wsl/${t}`, space: "wsl/sp1", space_name: "~", title: `Tab ${t}`, tab_name: "1", tab_index: 0, program: { name: "Claude Code" } });
  const agents = [ag("t1"), ag("t2"), ag("t3")];
  const spaces = [{ id: "wsl/sp1", name: "~", machine: "wsl", tabs: [] }];
  const w = await resumeWorld({ settings: { claude_machine: "wsl" }, platform: "windows", files, agents, spaces, ready: ["wsl"] });
  await w.r.resumeTick();
  w.herdr.hooks.machines = [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }];
  for (let i = 0; i < 20; i++) { now += 30_000; await w.r.resumeTick(); }
  w.herdr.hooks.machines = [{ name: null, layout: "ready" }, { name: "wsl", layout: "ready" }];
  agents.splice(0, agents.length, ag("t1"), ag("t2"), ag("t5"));
  files[`wsl:${WSL}/.cache/flockbook/cache.json`] = { entries: { t1: tab("t1", "s-a"), t2: tab("t2", "s-b") } };
  now += 30_000; await w.r.resumeTick();
  now += 30_000; await w.r.resumeTick();
  files[`wsl:${WSL}/.cache/flockbook/cache.json`] = { entries: { t1: tab("t1", "s-a"), t2: tab("t2", "s-b"), t5: tab("t5", "s-new") } };
  now += 30_000; await w.r.resumeTick();
  eq("downtime kept across unidentified polls: the lost session is offered", (w.r.offer()?.tabs ?? []).map((x) => x.sid), ["s-c"]);
}
{
  // s28 (Fable 5): an unidentified tab on wsl does not hold back resuming a session of this computer; its status call
  // (to get it identified) goes once a minute at most, not on every poll.
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const agents = [{ app: "claude-code", address: "wsl/t5", space: "wsl/sp1", space_name: "~", title: "New", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } }];
  const spaces = [{ id: "sp1", name: "~", machine: null, tabs: [] }];
  const w = await resumeWorld({ settings: { claude_machine: "wsl" }, files, agents, spaces, ready: ["wsl"] });
  w.st.setShared("flockbook.resume.offer", { at: now, tabs: [{ sid: "s-mac", account: "HOME", cwd: MAC, pids: [5], space: "sp1" }] });
  const n0 = w.runs.length;
  const ok = await w.r.resumeOne("s-mac");
  eq("unidentified wsl tab: a Mac session still resumes", [ok, w.runs.length - n0], [true, 1]);
  const s0 = w.statuses.length;
  await w.r.resumeTick(); now += 30_000; await w.r.resumeTick();
  eq("status call for an unidentified remote tab: once a minute at most", w.statuses.length - s0, 1);
}
{
  // The Mac (no claude_machine): remote tabs are never remembered (the PC that names wsl resumes them, not both).
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: { t1: { path: `${MAC}/.${NAME}/projects/-Users-you/s-mac.jsonl`, cwd: MAC, pids: [1] } } } };
  const agents = [
    { app: "claude-code", address: "t1", space: "sp1", space_name: "~", title: "Mac", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
    { app: "claude-code", address: "wsl/t3", space: "wsl/sp1", space_name: "~", title: "PC", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } },
  ];
  const w = await resumeWorld({ files, agents });
  await w.r.resumeTick();
  eq("resume on the Mac: only its own tab", Object.keys(w.r.remembered().tabs), ["s-mac"]);
}
{
  // Windows without claude_machine: its own (Windows) tabs can't be resumed (no /usr/bin/env): not remembered.
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: { t1: { path: `${MAC}/.${NAME}/projects/-Users-you/s-win.jsonl`, cwd: MAC, pids: [1] } } } };
  const agents = [{ app: "claude-code", address: "t1", space: "sp1", space_name: "~", title: "Win", tab_name: "1", tab_index: 0, program: { name: "Claude Code" } }];
  const w = await resumeWorld({ files, agents, platform: "windows" });
  await w.r.resumeTick();
  eq("resume on Windows: its own tabs not remembered", Object.keys(w.r.remembered().tabs), []);
}

// 7. automove.js: projects on a machine; a WSL tab in WSL's "~" moves to WSL's project workspace, a Mac tab never does.
const PROJ = [
  { workspace: "webshop", folder: "~/projects/webshop", title: "web\\s*shop", machine: "wsl" },
  { workspace: "webshop", folder: "~/code/webshop", title: "web\\s*shop" },
];
async function moveWorld(opts) {
  const w = await world(opts);
  const m = await loadMod("automove.js", { herdr: w.herdr, "./config.js": w.cfg, "./where.js": w.where, "./sidecar.js": w.sidecar,
    "./state.js": { sessionTopic: (a) => a.title }, "./parked.js": { spaces: () => w.herdr.spaces(), agents: () => w.herdr.agents() } });
  return { ...w, m };
}
{
  const w = await moveWorld({ settings: { projects: PROJ } });
  await w.where.machineHome("wsl");
  const list = w.m.projects();
  eq("projects(): the wsl one's folder under the WSL home, the Mac one under the Mac home", list.map((p) => [p.machine, p.folder]), [["wsl", `${WSL}/projects/webshop`], [null, `${MAC}/code/webshop`]]);
  const sp = [{ id: "sp5", name: "webshop", machine: null }, { id: "wsl/sp7", name: "webshop", machine: "wsl" }];
  eq("projectSpace: each project's workspace on its own machine", [w.m.projectSpace(list[0], sp)?.id, w.m.projectSpace(list[1], sp)?.id], ["wsl/sp7", "sp5"]);
}
{
  const w = await moveWorld({ settings: { projects: [PROJ[0]] } });
  eq("projects(): wsl home not known yet → that folder unset (no log score), title still there", [w.m.projects()[0].folder, Boolean(w.m.projects()[0].title)], [null, true]);
}
{
  // The tick: wsl/t3 sits in wsl's "~" with a title naming webshop → parked and labelled for wsl/sp7 (bare id).
  const spaces = [
    { id: "wsl/sp6", name: "~", machine: "wsl", active: false, tabs: [{ id: "wsl/tb1", panes: 1, active: false }] },
    { id: "wsl/sp7", name: "webshop", machine: "wsl", active: false, tabs: [] },
    { id: "sp1", name: "~", machine: null, active: true, tabs: [{ id: "tb9", panes: 1, active: false }] },
    { id: "sp5", name: "webshop", machine: null, active: false, tabs: [] },
  ];
  const agents = [
    { address: "wsl/t3", space: "wsl/sp6", tab: "wsl/tb1", title: "webshop cart fix" },
    { address: "t9", space: "sp1", tab: "tb9", title: "notes" },
  ];
  const terms = [{ address: "wsl/t3", created_ms: now - 10 * 60_000 }, { address: "t9", created_ms: now - 10 * 60_000 }];
  const hcCalls = [];
  const w = await moveWorld({ settings: { projects: [PROJ[0]], auto_move: "on" }, spaces, agents, terms });
  // Parked: no pane; labelled: adopted into a new tab of wsl/sp7.
  w.herdr.hooks.panes = () => [{ terminal: "wsl/t3", tab: "wsl/tb1" }];
  w.herdr.hooks.onRun = (name) => { if (name === "terminal.park") w.herdr.hooks.panes = () => []; };
  w.herdr.hooks.hc = async (args) => { hcCalls.push(args); spaces[1].tabs.push({ id: "wsl/tb2", panes: 1 }); w.herdr.hooks.panes = () => [{ terminal: "wsl/t3", tab: "wsl/tb2" }]; return { code: 0, stdout: "" }; };
  const cx = { timer: { after: (ms, f) => setTimeout(f, 0) } };
  await w.m.autoMoveTick(cx);
  eq("automove: wsl/t3 parked", w.runs.some(([n, a]) => n === "terminal.park" && a.terminal === "wsl/t3"), true);
  eq("automove: labelled for sp7 with the machine left out", hcCalls[0]?.slice(0, 3), ["label", "wsl/t3", "herdr.space=sp7"]);
  eq("automove: the Mac tab t9 untouched (no Mac project; never a WSL one)", w.runs.some(([, a]) => a?.terminal === "t9"), false);
}
{
  // moveTargets: a remote tab's choices are its own machine's workspaces; a local tab's are this computer's.
  const spaces = [{ id: "wsl/sp6", name: "~", machine: "wsl", index: 1 }, { id: "wsl/sp7", name: "webshop", machine: "wsl", index: 2 }, { id: "sp1", name: "~", machine: null, index: 3 }, { id: "sp5", name: "tools", machine: null, index: 4 }];
  const w = await moveWorld({ settings: { projects: [PROJ[0]] }, spaces });
  eq("moveTargets(wsl/t3): only wsl's other workspaces", w.m.moveTargets({ panes: 1 }, { address: "wsl/t3", space: "wsl/sp6" }).map((s) => s.id), ["wsl/sp7"]);
  eq("moveTargets(t9): only this computer's", w.m.moveTargets({ panes: 1 }, { address: "t9", space: "sp1" }).map((s) => s.id), ["sp5"]);
}

// 8. config: claude_machine and a project's machine are checked.
{
  const { cfg, set } = await realConfig({ claude_machine: "wsl" });
  eq("claude_machine: a machine name is kept", cfg.setting("claude_machine"), "wsl");
  set("claude_machine", "rm -rf /");
  eq("claude_machine: not a name → none", cfg.setting("claude_machine"), null);
  set("projects", [{ workspace: "x", folder: "~/x", machine: "a b" }]);
  eq("projects: a bad machine name → setting ignored", cfg.setting("projects"), null);
  set("projects", [{ workspace: "x", folder: "~/x", machine: "wsl" }]);
  eq("projects: machine wsl kept", cfg.setting("projects")[0].machine, "wsl");
}

console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
