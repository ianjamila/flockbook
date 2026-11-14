// sessions.js (s26, owner 11-14: "a resume session in herdr that lists all closed sessions … with a search function and
// can batch resume click multiple items"): the listing script and its parser, the search, the selection, the live
// filter (resume.js liveSids), where each pick opens, the unreachable / Windows cases.
// Run: node test-sessions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WORK_DIR, CFG_ENV } from "./paths.mjs";
import { loadMod, fakeShared, realConfig } from "./loadmod.mjs";
import * as ui from "../stub/ui.mjs";
import { fakeCx } from "../fake-cx.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
let now = 1_800_000_000_000;
const realNow = Date.now.bind(Date);   // the script test below ages real files by the real clock
Date.now = () => now;
const MAC = "/Users/you", WSL = "/home/you";
const NAME = ["cl", "aude"].join(""), DOT = String.fromCharCode(46);
const TWO = [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }];
const dflt = (home) => `${home}/${DOT}${NAME}`;
const LOG = (home, sid, proj = "-code-webshop") => `${dflt(home)}/projects/${proj}/${sid}.jsonl`;
const WLOG = (home, sid, proj = "-code-webshop") => `${home}${WORK_DIR.slice(1)}/projects/${proj}/${sid}.jsonl`;
const secs = (msAgo) => Math.floor((now - msAgo) / 1000);
const line = (...f) => f.join("\t");
const AGENT = (address, space, title) => ({ app: "claude-code", address, space, space_name: "~", title, tab_name: "1", tab_index: 0, program: { name: "Claude Code" } });

// One world: fake Herdr (platform, machines, exec by machine, files by machine), the real config/where/accounts/resume/
// automove/ai, and sessions.js over the stub kit. `listing`: { [machine or ""]: stdout of the listing script }.
async function world({ settings = {}, platform = "macos", ready = ["wsl"], homeOut = WSL, listing = {}, agents = [], spaces = [], files = {}, onRun = null } = {}) {
  const st = fakeShared(), execs = [], runs = [], notes = [], closed = [];
  const hooks = { machines: [{ name: null, layout: "ready" }, ...ready.map((n) => ({ name: n, layout: "ready" }))] };
  const herdr = {
    ...st, hooks, home: () => MAC, appHome: () => `${MAC}/.config/herdr-app`,
    window: () => ({ platform }), machines: () => hooks.machines,
    agents: () => agents, spaces: () => spaces, terminals: () => herdr.termsNow(), termsNow: () => [], panes: () => herdr.panesNow(), panesNow: () => [],
    theme: () => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${k}` : undefined) }),
    props: () => ({ view: "sessions", overlay: "ov1" }), closeOverlay: (id) => { closed.push(id); return null; },
    run: (name, args) => { runs.push([name, args]); onRun?.(name, args); return null; }, notify: (n) => { notes.push(n); return null; },
    exec: async (cmd, args, opts = {}) => {
      execs.push([cmd, args, opts]);
      if (cmd === "/bin/sh" && String(args[1]).startsWith("printf %s")) return homeOut == null ? { code: 1, stdout: "", stderr: "unreachable" } : { code: 0, stdout: opts.on ? homeOut : MAC };
      if (cmd === "/bin/sh" && args[2] === "sh") { const o = listing[opts.on ?? ""]; return typeof o === "function" ? o(args, opts) : { code: 0, stdout: o ?? "" }; }
      return { code: 127, stdout: "", stderr: "unexpected" };
    },
    readTextFile: async (p, opts = {}) => { const f = files[`${opts.on ?? ""}:${p}`]; return f == null ? null : JSON.stringify(f); },
  };
  const { cfg } = await realConfig({ about_cap: "none", accounts: TWO, ...settings });
  const sidecar = { cachePath: () => `${MAC}/.config/herdr-app/flockbook/cache.json`, status: async () => null };
  const where = await loadMod("where.js", { herdr, "./config.js": cfg, "./sidecar.js": sidecar });
  const acc = await loadMod("accounts.js", { herdr, "./config.js": cfg, "./where.js": where });
  const lists = { spaces: () => herdr.spaces(), agents: () => herdr.agents(), withSnapshot: (fn) => fn() };
  const res = await loadMod("resume.js", { herdr, "./accounts.js": acc, "./where.js": where, "./sidecar.js": sidecar, "./parked.js": lists });
  const move = await loadMod("automove.js", { herdr, "./config.js": cfg, "./where.js": where, "./sidecar.js": sidecar, "./state.js": { sessionTopic: (a) => a.title }, "./parked.js": lists });
  const ai = await loadMod("ai.js", { herdr, "./config.js": cfg, "./accounts.js": acc, "./where.js": where, "./state.js": { sessionTopic: (a) => a.title } });
  const ses = await loadMod("sessions.js", { herdr, "gpui-kit": ui, "gpui-base": ui, "./config.js": cfg, "./accounts.js": acc, "./where.js": where, "./resume.js": res,
    "./automove.js": move, "./ai.js": ai, "./parked.js": lists, "./state.js": { sessionsClosed: () => {}, icon: (n) => n } });
  return { st, herdr, cfg, where, acc, res, move, ses, execs, runs, notes, closed };
}
// The listing script's own line: mtime, path, cwd, title, first prompt (the last three as JSON strings, like grep -o gives them).
const row = (mtime, p, cwd, title, prompt) => line(String(mtime), p, cwd == null ? "" : JSON.stringify(cwd), title == null ? "" : JSON.stringify(title), prompt == null ? "" : JSON.stringify(prompt));

// 1. The script text has no values in it; its values are positional arguments.
{
  const w = await world();
  const S = w.ses.LIST_SCRIPT;
  eq("script: a fixed string with positional arguments", [typeof S, /\$1\b/.test(S), /\$2\b/.test(S), /"\$@"/.test(S)], ["string", true, true, true]);
  eq("script: no config folder, home or folder name in its text", [S.includes(MAC), S.includes(WSL), S.includes(DOT + NAME), S.includes("/Users/"), /\b30\b|\b300\b/.test(S)], [false, false, false, false, false]);
}

// 2. JSON decoding and the parser of the script's output.
{
  const w = await world();
  const { unJson, parseListing } = w.ses;
  eq("unJson: escapes, quotes, unicode", unJson(String.raw`"a\tb\n\"q\" é \\ x"`), "a\tb\n\"q\" é \\ x");
  eq("unJson: empty / missing / not a string → ''", [unJson(""), unJson(undefined), unJson("nope")], ["", "", ""]);
  eq("unJson: a cut-off literal keeps its text", unJson(String.raw`"half a thing\u12`), "half a thing\\u12");
  const list = w.acc.accountList(TWO);
  const out = [
    row(secs(3600_000), LOG(MAC, "s1"), "/Users/you/code/webshop", "Cart fix", "Fix the cart\tbug \"now\"\nplease"),
    row(secs(7200_000), WLOG(MAC, "s2"), "/Users/you/code/tools", null, "Second prompt"),
    row(secs(9000_000), LOG(MAC, "s3"), "/Users/you/code/webshop", null, null),
    row(secs(9500_000), LOG(MAC, "s4"), null, null, null),                                    // nothing known: dropped
    row(secs(9900_000), `${MAC}/elsewhere/projects/-x/s5.jsonl`, "/x", "Not an account", "x"), // no account owns that folder: dropped
    "garbage line without tabs",
    row(secs(99_999_000), LOG(MAC, "s1"), "/Users/you/code/webshop", "Cart fix (older copy)", "x"),   // same sid twice: the first (newest) stays
  ].join("\n");
  const rows = parseListing(out, { machine: null, list, homeDir: MAC });
  eq("parse: sids, accounts, newest first as given, junk and empties dropped", rows.map((r) => [r.sid, r.account]), [["s1", "HOME"], ["s2", "WORK"], ["s3", "HOME"]]);
  eq("parse: title, prompt (tabs/newlines folded), cwd, time", [rows[0].title, rows[0].prompt, rows[0].cwd, rows[0].at], ["Cart fix", "Fix the cart bug \"now\" please", "/Users/you/code/webshop", secs(3600_000) * 1000]);
  eq("parse: missing title → null, missing prompt → ''", [rows[1].title, rows[2].prompt], [null, ""]);
  eq("parse: machine on each row", rows.map((r) => r.machine), ["", "", ""]);
  eq("heading: title → first prompt → (no title)", [w.ses.headingOf(rows[0]), w.ses.headingOf(rows[1]), w.ses.headingOf(rows[2])], ["Cart fix", "Second prompt", "(no title)"]);
  const long = parseListing(row(secs(1000), LOG(MAC, "s6"), "/a", "T".repeat(500), "P".repeat(900)), { machine: null, list, homeDir: MAC });
  eq("parse: lengths capped", [long[0].title.length <= 120, long[0].prompt.length <= 160], [true, true]);
  const rem = parseListing(row(secs(1000), WLOG(WSL, "s7"), "/home/you/p", "On wsl", "hi"), { machine: "wsl", list, homeDir: WSL });
  eq("parse: a remote line is read with that machine's home, and says its machine", [rem[0]?.sid, rem[0]?.account, rem[0]?.machine], ["s7", "WORK", "wsl"]);
  const none = parseListing(row(secs(1000), LOG(MAC, "s8"), "/a", "x", "x"), { machine: "wsl", list, homeDir: WSL });
  eq("parse: a Mac path is not an account's log on wsl", none, []);
}

// 3. Search: case-insensitive, every word must match title, first prompt, folder, account or machine.
{
  const w = await world();
  const rows = [
    { sid: "a", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix", prompt: "Fix the cart bug", at: 3 },
    { sid: "b", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: null, prompt: "Write the Invoice export", at: 2 },
    { sid: "c", account: "WORK", machine: "wsl", cwd: "/home/you/notes", title: "Notes", prompt: "tidy", at: 1 },
  ];
  const names = (q) => w.ses.filterRows(rows, q, (r) => w.acc.accountName(r.account)).map((r) => r.sid);
  eq("search: empty → all", names("  "), ["a", "b", "c"]);
  eq("search: title, case-insensitive", names("CART"), ["a"]);
  eq("search: first prompt", names("invoice"), ["b"]);
  eq("search: folder", names("code/tools"), ["b"]);
  eq("search: account name", names("work account"), ["b", "c"]);
  eq("search: machine", names("wsl"), ["c"]);
  eq("search: all words must match (any order)", [names("fix cart"), names("cart invoice")], [["a"], []]);
}

// 4. The shortened folder and the time column.
{
  const w = await world();
  eq("folderText: ~ with that machine's home", [w.ses.folderText("/Users/you/code/x", MAC), w.ses.folderText(MAC, MAC), w.ses.folderText("/srv/x", MAC), w.ses.folderText("", MAC)], ["~/code/x", "~", "/srv/x", "?"]);
}

// 5. Placement: the project's workspace on that machine, else its "~", else a new workspace there / a tab here.
{
  const projs = (w) => w.move.projectList([{ workspace: "webshop", folder: "~/code/webshop" }, { workspace: "tools", folder: "~/code/tools", machine: "wsl" }, { workspace: "deep", folder: "~/code/webshop/deep" }], (m) => (m ? WSL : MAC));
  const w = await world();
  const spaces = [{ id: "sp1", name: "~", machine: null }, { id: "sp2", name: "webshop", machine: null }, { id: "sp3", name: "deep", machine: null },
    { id: "wsl/sp7", name: "~", machine: "wsl" }, { id: "wsl/sp8", name: "tools", machine: "wsl" }];
  const at = (cwd, machine, sp = spaces) => w.ses.placeOf({ cwd, machine }, projs(w), sp);
  eq("place: a folder inside a project → that workspace, tab.new", at("/Users/you/code/webshop/src", ""), { name: "tab.new", args: { space: "sp2", folder: "/Users/you/code/webshop/src" } });
  eq("place: the deepest project wins", at("/Users/you/code/webshop/deep/x", "")?.args.space, "sp3");
  eq("place: no project → the machine's ~ workspace", at("/Users/you/elsewhere", ""), { name: "tab.new", args: { space: "sp1", folder: "/Users/you/elsewhere" } });
  eq("place: a project on wsl → wsl's workspace, not the Mac one", at("/home/you/code/tools/a", "wsl"), { name: "tab.new", args: { space: "wsl/sp8", folder: "/home/you/code/tools/a" } });
  eq("place: a Mac project folder is no project for wsl", at("/Users/you/code/webshop", "wsl")?.args.space, "wsl/sp7");
  eq("place: no ~ on wsl → a new workspace on wsl", at("/home/you/x", "wsl", spaces.filter((s) => s.machine !== "wsl")), { name: "space.new", args: { machine: "wsl", folder: "/home/you/x" } });
  eq("place: no ~ here and none shown here → a new workspace on this computer, never another machine's", at("/Users/you/x", "", spaces.filter((s) => s.machine)), { name: "space.new", args: { machine: "", folder: "/Users/you/x" } });
  eq("place: project workspace missing → falls to ~", at("/Users/you/code/webshop", "", spaces.filter((s) => s.name !== "webshop" && s.name !== "deep"))?.args.space, "sp1");
}

// 6. Reading: ONE script per machine, run `on` it, args positional; remote listing runs with on: <machine>.
const LISTING = {
  "": [row(secs(3600_000), LOG(MAC, "s1"), "/Users/you/code/webshop", "Cart fix", "Fix the cart bug"), row(secs(7200_000), WLOG(MAC, "s2"), "/Users/you/code/tools", "Tools", "x"), row(secs(90_000_000), LOG(MAC, "s3"), "/Users/you/code/webshop", null, "Old one")].join("\n"),
  wsl: [row(secs(1800_000), WLOG(WSL, "w1", "-home-you-notes"), "/home/you/notes", "WSL notes", "tidy"), row(secs(2000_000), LOG(WSL, "w2", "-home-you-notes"), "/home/you/notes", null, "other")].join("\n"),
};
{
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING });
  const cx = fakeCx();
  const view = new w.ses.SessionsView(cx);
  await cx.settle();
  const lists = w.execs.filter(([c, a]) => c === "/bin/sh" && a[2] === "sh");
  eq("read: one listing per machine (this computer + wsl)", lists.map(([, , o]) => o.on ?? null).sort(), [null, "wsl"]);
  const [, args] = lists.find(([, , o]) => o.on === "wsl");
  eq("read: /bin/sh -c SCRIPT sh days max dirs…", [args[0], args[1] === w.ses.LIST_SCRIPT, args[2], args[3], args[4]], ["-c", true, "sh", "30", "300"]);
  eq("read: wsl's folders are under the WSL home (work account + default)", args.slice(5), [`${WSL}${WORK_DIR.slice(1)}`, `${WSL}/${DOT}${NAME}`]);
  const here = lists.find(([, , o]) => !o.on);
  eq("read: this computer's folders are under the Mac home", here[1].slice(5), [`${MAC}${WORK_DIR.slice(1)}`, `${MAC}/${DOT}${NAME}`]);
  eq("read: the script text is the same constant on both (no values interpolated)", lists.map(([, a]) => a[1] === w.ses.LIST_SCRIPT), [true, true]);
  const shown = view.shown().map((r) => `${r.machine || "here"}:${r.sid}`);
  eq("view: both machines' sessions, newest first", shown, ["wsl:w1", "wsl:w2", "here:s1", "here:s2", "here:s3"]);
  eq("view: cached with its time in the shared store", [w.st.data["flockbook.sessions.list"]?.at, Object.keys(w.st.data["flockbook.sessions.list"]?.by ?? {}).sort()], [now, ["", "wsl"]]);
  // Reopened: instant from the cache, no new listing.
  const n = w.execs.length;
  const again = new w.ses.SessionsView(fakeCx());
  eq("view: reopened → the cached rows at once, nothing run", [again.shown().length, w.execs.length], [5, n]);
  // Rendered: a row per session with its pieces.
  const el = view.render(cx);
  const r1 = ui.byId(el, "ses-row-here-s1");
  eq("render: title, first prompt, folder, account, time in a row", [/Cart fix/.test(ui.textOf(r1)), /Fix the cart bug/.test(ui.textOf(r1)), /~\/code\/webshop/.test(ui.textOf(r1)), /Personal account/.test(ui.textOf(r1)), /1 h ago/.test(ui.textOf(r1))], [true, true, true, true, true]);
  eq("render: a wsl row names its machine, a local one does not", [/wsl/.test(ui.textOf(ui.byId(el, "ses-row-wsl-w1"))), /\bwsl\b/.test(ui.textOf(r1))], [true, false]);
}
{
  const w = await world({ listing: LISTING });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("read: no claude_machine on a Mac → only this computer", [w.execs.filter(([, a]) => a[2] === "sh").length, view.shown().length], [1, 3]);
  eq("read: no accounts set → the one default folder", (await (async () => { const x = await world({ settings: { accounts: [] }, listing: LISTING }); const c = fakeCx(); new x.ses.SessionsView(c); await c.settle(); return x.execs.find(([, a]) => a[2] === "sh")[1].slice(5); })()), [`${MAC}/${DOT}${NAME}`]);
}

// 7. Selection: tick, Select all shown, Clear, the button's count.
{
  const w = await world({ listing: LISTING });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  const click = (id) => { ui.byId(view.render(cx), id)._h.on_click({}, cx); };
  const btn = () => ui.textOf(ui.byId(view.render(cx), "ses-resume"));
  eq("select: none → the button says (0)", btn(), "Resume selected (0)");
  click("ses-row-here-s1"); click("ses-row-here-s2");
  eq("select: two ticked", btn(), "Resume selected (2)");
  click("ses-row-here-s2");
  eq("select: a second click unticks", btn(), "Resume selected (1)");
  click("ses-clear");
  eq("select: Clear", btn(), "Resume selected (0)");
  click("ses-all");
  eq("select: all shown", btn(), "Resume selected (3)");
  view.search.set_value("cart");
  click("ses-clear"); click("ses-all");
  eq("select: all shown follows the search", [view.shown().map((r) => r.sid), btn()], [["s1"], "Resume selected (1)"]);
}

// 8. Live sessions are not listed, and a session that became live since the list was read is skipped.
{
  const agents = [AGENT("t1", "sp1", "Cart fix")];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: { t1: { path: LOG(MAC, "s1"), cwd: "/Users/you/code/webshop", pids: [11] } } } };
  const w = await world({ listing: LISTING, agents, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("live: s1 runs in a tab → not listed", view.shown().map((r) => r.sid), ["s2", "s3"]);
  const r = await w.ses.resumeSessions([{ sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix" }]);
  eq("live: a pick that is live now is skipped, nothing opened", [r.opened, r.skipped.map((s) => s.why), w.runs.length], [0, ["already open"], 0]);
}
{
  // Became live after the list was read: the dialog's list was made while nothing ran.
  const agents = [];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ listing: LISTING, agents, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("live: nothing runs → s1 listed", view.shown().some((r) => r.sid === "s1"), true);
  agents.push(AGENT("t1", "sp1", "Cart fix"));
  files[`:${MAC}/.config/herdr-app/flockbook/cache.json`] = { entries: { t1: { path: LOG(MAC, "s1"), cwd: "/Users/you/code/webshop", pids: [11] } } };
  ui.byId(view.render(cx), "ses-row-here-s1")._h.on_click({}, cx);
  ui.byId(view.render(cx), "ses-row-here-s2")._h.on_click({}, cx);
  await ui.byId(view.render(cx), "ses-resume")._h.on_click({}, cx); await cx.settle();
  eq("live: s1 became live → skipped; s2 opened as WORK in the ~ workspace", [w.runs.map(([n]) => n), w.runs[0]?.[1]?.space, w.runs[0]?.[1]?.argv?.slice(-2)], [["tab.new"], "sp1", ["--resume", "s2"]]);
  eq("live: the notice says what happened; the dialog closes", [w.notes.at(-1), w.closed], ["Resumed 1 session. Skipped 1: already open.", ["ov1"]]);
}

// 9. Resuming: argv as the account on its machine; placement per machine; unreachable skipped; never crossing machines.
{
  const spaces = [{ id: "sp1", name: "~", machine: null }, { id: "sp2", name: "webshop", machine: null }, { id: "wsl/sp7", name: "~", machine: "wsl" }];
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl", projects: [{ workspace: "webshop", folder: "~/code/webshop" }] }, listing: LISTING, spaces, files });
  await w.where.machineHome("wsl");
  const picks = [
    { sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix" },
    { sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" },
    { sid: "w1", account: "WORK", machine: "wsl", cwd: "/home/you/notes", title: "WSL notes" },
    { sid: "w2", account: "HOME", machine: "wsl", cwd: "/home/you/notes", title: "x" },
    { sid: "nf", account: "GONE", machine: "", cwd: "/Users/you", title: "Old account" },
    { sid: "nc", account: "HOME", machine: "", cwd: "", title: "No folder" },
  ];
  const r = await w.ses.resumeSessions(picks);
  const by = Object.fromEntries(w.runs.map(([n, a]) => [a.argv.at(-1), [n, a]]));
  eq("resume: 4 opened, the rest skipped with their reasons", [r.opened, r.skipped.map((s) => [s.row.sid, s.why])], [4, [["nf", "its account isn't set any more"], ["nc", "its folder is unknown"]]]);
  eq("resume: s1 → the webshop workspace, as the default account (config folder cleared), Mac folder", [by.s1[0], by.s1[1].space, by.s1[1].folder, by.s1[1].argv.slice(0, 3)], ["tab.new", "sp2", "/Users/you/code/webshop", ["/usr/bin/env", "-u", CFG_ENV]]);
  eq("resume: s2 → this computer's ~, as WORK with the Mac config folder", [by.s2[1].space, by.s2[1].argv[1]], ["sp1", `${CFG_ENV}=${MAC}${WORK_DIR.slice(1)}`]);
  eq("resume: w1 → wsl's ~ workspace (a wsl space id), as WORK with the WSL config folder", [by.w1[0], by.w1[1].space, by.w1[1].argv[1]], ["tab.new", "wsl/sp7", `${CFG_ENV}=${WSL}${WORK_DIR.slice(1)}`]);
  eq("resume: never a wsl session in a Mac workspace or the reverse", [by.w1[1].space.startsWith("wsl/"), by.w2[1].space.startsWith("wsl/"), by.s1[1].space.startsWith("wsl/"), by.s2[1].space.startsWith("wsl/")], [true, true, false, false]);
  eq("resume: each argv ends with --resume <sid>", w.runs.map(([, a]) => a.argv.slice(-2)).sort(), [["--resume", "s1"], ["--resume", "s2"], ["--resume", "w1"], ["--resume", "w2"]]);
}
{
  // No workspace on wsl at all → space.new on wsl; none here → space.new here (s28: machine "", never the shown one elsewhere).
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces: [], files });
  await w.where.machineHome("wsl");
  await w.ses.resumeSessions([{ sid: "w1", account: "HOME", machine: "wsl", cwd: "/home/you/notes", title: "n" }, { sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/x", title: "m" }]);
  const [a, b] = w.runs;
  eq("resume: space.new on wsl with its folder and argv", [a[0], a[1].machine, a[1].folder, a[1].argv.slice(-2), "space" in a[1]], ["space.new", "wsl", "/home/you/notes", ["--resume", "w1"], false]);
  eq("resume: space.new on this computer, named ~", [b[0], b[1].machine, b[1].name, b[1].folder], ["space.new", "", "~", "/Users/you/x"]);
}
{
  // wsl unreachable (home unknown): its rows are skipped with a notice, the Mac's open.
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} }, [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces: [{ id: "sp1", name: "~", machine: null }], files, homeOut: null });
  const r = await w.ses.resumeSessions([{ sid: "w1", account: "WORK", machine: "wsl", cwd: "/home/you/n", title: "n" }, { sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/x", title: "m" }]);
  eq("unreachable: the wsl row is skipped, the Mac's opens", [r.opened, r.skipped.map((s) => s.why), w.runs.map(([, a]) => a.argv.at(-1))], [1, ["couldn't reach wsl"], ["s1"]]);
}
{
  // wsl not connected now: it can't be checked for live sessions → not opened, and not read.
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces: [], files, ready: [] });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("not connected: only this computer is read", [w.execs.filter(([, a]) => a[2] === "sh").map(([, , o]) => o.on ?? null), view.shown().map((r) => r.machine)], [[null], ["", "", ""]]);
  const r = await w.ses.resumeSessions([{ sid: "w1", account: "WORK", machine: "wsl", cwd: "/home/you/n", title: "n" }]);
  eq("not connected: a wsl pick is skipped", [r.opened, r.skipped.map((s) => s.why), w.runs.length], [0, ["wsl isn't connected now"], 0]);
}

// 10. Windows: without claude_machine the dialog says so and lists nothing; with it, only that machine.
{
  const w = await world({ platform: "windows", listing: LISTING });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  const el = view.render(cx);
  eq("windows, no claude_machine: the message, no list, nothing run", [ui.textOf(el).includes(w.where.NEEDS_MACHINE), view.shown().length, w.execs.length], [true, 0, 0]);
  eq("windows, no claude_machine: the Resume button is not there", ui.byId(el, "ses-resume"), null);
  const r = await w.ses.resumeSessions([{ sid: "s1", account: "HOME", machine: "", cwd: "/x", title: "t" }]);
  eq("windows, no claude_machine: a pick is never run on this computer", [r.opened, w.runs.length], [0, 0]);
}
{
  const w = await world({ platform: "windows", settings: { claude_machine: "wsl" }, listing: LISTING });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("windows with claude_machine: wsl's sessions only", [view.shown().map((r) => r.machine), w.execs.filter(([, a]) => a[2] === "sh").map(([, , o]) => o.on)], [["wsl", "wsl"], ["wsl"]]);
}

// 11. A listing that fails shows its error and keeps going with the other machine.
{
  const w = await world({ settings: { claude_machine: "wsl" }, listing: { "": LISTING[""], wsl: () => ({ code: 255, stdout: "", stderr: "ssh: connect refused" }) } });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("failed listing: that machine's error is shown, the other's rows stay", [view.shown().length, /wsl/.test(ui.textOf(view.render(cx))) && /couldn't read/i.test(ui.textOf(view.render(cx)))], [3, true]);
}

// 12. The script itself, for real, over fake logs in a temp folder (not any real config folder): find depth/age, stat on this OS,
// the last custom title, the summary fallback, the first user prompt, the cap and newest-first order.
{
  const w = await world();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-sessions-"));
  try {
    const cfg = path.join(tmp, "cfg"), proj = path.join(cfg, "projects", "-code-webshop"), other = path.join(cfg, "projects", "-code-tools");
    fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(other, { recursive: true }); fs.mkdirSync(path.join(proj, "sub", "subagents"), { recursive: true });
    const J = (o) => JSON.stringify(o);
    const age = (f, days) => { const t = new Date(realNow() - days * 86_400_000); fs.utimesSync(f, t, t); };
    const real = realNow;
    const put = (dir, sid, lines, days) => { const f = path.join(dir, `${sid}.jsonl`); fs.writeFileSync(f, lines.join("\n") + "\n"); age(f, days); return f; };
    put(proj, "aaaa-1", [J({ type: "summary", summary: "Old summary", leafUuid: "x" }),
      J({ parentUuid: null, cwd: "/work/webshop", sessionId: "aaaa-1", type: "user", message: { role: "user", content: "Fix the cart\tbug \"now\"" } }),
      J({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      J({ type: "custom-title", customTitle: "First name", sessionId: "aaaa-1" }),
      J({ type: "custom-title", customTitle: "Cart fix", sessionId: "aaaa-1" })], 1);
    put(proj, "bbbb-2", [J({ type: "summary", summary: "Checkout flow", leafUuid: "x" }),
      J({ cwd: "/work/webshop", type: "user", isMeta: true, message: { role: "user", content: "Caveat: generated while running local commands" } }),
      J({ cwd: "/work/webshop", type: "user", message: { role: "user", content: [{ type: "text", text: "Build the checkout é" }] } })], 2);
    put(other, "cccc-3", [J({ cwd: "/work/tools", type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }),
      J({ cwd: "/work/tools", type: "user", message: { role: "user", content: "Real first prompt" } })], 3);
    put(other, "dddd-4", [""], 4);                                                  // empty log
    put(other, "eeee-5", [J({ cwd: "/work/old", type: "user", message: { role: "user", content: "Too old" } })], 40);   // outside 30 days
    fs.writeFileSync(path.join(proj, "sub", "subagents", "ffff-6.jsonl"), J({ cwd: "/x", type: "user", message: { role: "user", content: "sub" } }) + "\n");   // too deep
    fs.writeFileSync(path.join(proj, "notes.txt"), "not a log");
    const run = (days, max) => execFileSync("/bin/sh", ["-c", w.ses.LIST_SCRIPT, "sh", String(days), String(max), cfg, path.join(tmp, "missing")], { encoding: "utf8" });
    const list = [{ mark: "T", name: "Temp", config_dir: cfg }];
    const rows = w.ses.parseListing(run(30, 300), { machine: null, list, homeDir: tmp });
    eq("script: newest first; empty log, too old, too deep and non-logs left out", rows.map((r) => r.sid), ["aaaa-1", "bbbb-2", "cccc-3"]);
    eq("script: the LAST custom title wins", rows[0].title, "Cart fix");
    eq("script: cwd and the first prompt (tab folded)", [rows[0].cwd, rows[0].prompt], ["/work/webshop", "Fix the cart bug \"now\""]);
    eq("script: no custom title → the summary; array content and the meta line skipped", [rows[1].title, rows[1].prompt], ["Checkout flow", "Build the checkout é"]);
    eq("script: no title at all → null; a command wrapper line skipped for the real prompt", [rows[2].title, rows[2].prompt], [null, "Real first prompt"]);
    eq("script: the account from the path (the temp config folder)", rows.map((r) => r.account), ["T", "T", "T"]);
    eq("script: the cap keeps the newest", w.ses.parseListing(run(30, 2), { machine: null, list, homeDir: tmp }).map((r) => r.sid), ["aaaa-1", "bbbb-2"]);
    eq("script: a wider window brings the old one", w.ses.parseListing(run(60, 300), { machine: null, list, homeDir: tmp }).map((r) => r.sid), ["aaaa-1", "bbbb-2", "cccc-3", "eeee-5"]);
    eq("script: mtime is epoch seconds", Math.abs(rows[0].at - (real() - 86_400_000)) < 120_000, true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

{
  // s27 (hand-off item 11): several picks on a machine with no "~" or project workspace share ONE new workspace, named
  // "~" (that machine's home workspace, so the auto-mover files them as usual), not one workspace each.
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const spaces = [];
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces, files,
    onRun: (name, args) => { if (name === "space.new") spaces.push({ id: "wsl/sp9", name: args.name ?? "1", machine: args.machine, folder: args.folder, tabs: [] }); } });
  await w.where.machineHome("wsl");
  const waits = [];
  const r = await w.ses.resumeSessions([1, 2, 3].map((n) => ({ sid: `w${n}`, account: "HOME", machine: "wsl", cwd: `/home/you/n${n}`, title: `t${n}` })),
    { wait: async (ms) => { waits.push(ms); } });
  eq("pile-up: one space.new named ~ on wsl, then tabs in it", w.runs.map(([n, a]) => [n, a.name ?? null, a.space ?? null, a.machine ?? null, a.argv.at(-1)]),
    [["space.new", "~", null, "wsl", "w1"], ["tab.new", null, "wsl/sp9", null, "w2"], ["tab.new", null, "wsl/sp9", null, "w3"]]);
  eq("pile-up: 3 opened", r.opened, 3);
  eq("pile-up: no wait when the new workspace is there at the first look", waits.length, 0);
}
{
  // The new workspace shows up only after a few looks: the batch waits for it (short steps, capped).
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const spaces = [];
  let pending = null;
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces, files, onRun: (name, args) => { if (name === "space.new") pending = { id: "wsl/sp9", name: args.name ?? "1", machine: args.machine, tabs: [] }; } });
  await w.where.machineHome("wsl");
  const waits = [];
  await w.ses.resumeSessions([1, 2].map((n) => ({ sid: `w${n}`, account: "HOME", machine: "wsl", cwd: "/home/you/n", title: "t" })),
    { wait: async (ms) => { waits.push(ms); if (waits.length === 3 && pending) spaces.push(pending); } });
  eq("pile-up (late): the second pick goes into it", w.runs.map(([n, a]) => [n, a.space ?? null]), [["space.new", null], ["tab.new", "wsl/sp9"]]);
  eq("pile-up (late): three short waits", waits, [150, 150, 150]);
}
{
  // It never shows up (the app refused it?): the rest open as before, one new workspace each, none named ~ again; the
  // wait is capped.
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces: [], files });
  await w.where.machineHome("wsl");
  let waited = 0;
  await w.ses.resumeSessions([1, 2, 3].map((n) => ({ sid: `w${n}`, account: "HOME", machine: "wsl", cwd: "/home/you/n", title: "t" })), { wait: async (ms) => { waited += ms; } });
  eq("pile-up (never): space.new each, only the first named ~", w.runs.map(([n, a]) => [n, a.name ?? null]), [["space.new", "~"], ["space.new", null], ["space.new", null]]);
  eq("pile-up (never): waited at most 3 s, once", waited <= 3000 && waited >= 2000, true);
}
{
  // One pick only: named ~, no wait (nothing else to place).
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, spaces: [], files });
  await w.where.machineHome("wsl");
  let waited = 0;
  await w.ses.resumeSessions([{ sid: "w1", account: "HOME", machine: "wsl", cwd: "/home/you/n", title: "t" }], { wait: async (ms) => { waited += ms; } });
  eq("pile-up (one pick): named ~, no wait", [w.runs[0][1].name, waited], ["~", 0]);
}
// 13. s28 (Codex R1 P2): the folder is the exact path the log names (no whitespace folded, no cut); a cut-off one is unknown.
{
  const w = await world();
  const list = w.acc.accountList(TWO);
  const rows = w.ses.parseListing([
    row(secs(1000), LOG(MAC, "x1"), "/work/client  archive", "Spaces", "p"),
    line(String(secs(2000)), LOG(MAC, "x2"), String.raw`"/work/cut\u00`, JSON.stringify("Cut path"), JSON.stringify("p")),
  ].join("\n"), { machine: null, list, homeDir: MAC });
  eq("parse: cwd kept exactly (two spaces)", rows.find((r) => r.sid === "x1")?.cwd, "/work/client  archive");
  eq("parse: a cut-off cwd → unknown folder, the row kept", [rows.find((r) => r.sid === "x2")?.cwd, rows.find((r) => r.sid === "x2")?.title], ["", "Cut path"]);
  eq("script: the cwd cut is long enough for any path", /cwd=[^\n]*cut -c 1-4[0-9]{3}/.test(w.ses.LIST_SCRIPT), true);
}
// 14. s28 (Codex R1 P2): a local session with no project or "~" workspace never opens in another machine's workspace:
// the shown workspace when it is this computer's, else a new one here.
{
  const w = await world();
  const projs = w.move.projectList([], () => MAC);
  const sp = [{ id: "wsl/sp7", name: "work", machine: "wsl", active: true }, { id: "sp4", name: "misc", machine: null }];
  eq("place: shown workspace is on wsl → space.new on this computer", w.ses.placeOf({ cwd: "/Users/you/x", machine: "" }, projs, sp), { name: "space.new", args: { machine: "", folder: "/Users/you/x" } });
  const sp2 = [{ id: "wsl/sp7", name: "work", machine: "wsl" }, { id: "sp4", name: "misc", machine: null, active: true }];
  eq("place: shown workspace is this computer's → a tab in it, named", w.ses.placeOf({ cwd: "/Users/you/x", machine: "" }, projs, sp2), { name: "tab.new", args: { space: "sp4", folder: "/Users/you/x" } });
}
// 15. s28 (Codex R1 + R2 P2): a Claude tab not identified yet may be any session (a folder or title that differs proves
// nothing): every resume on its machine waits until it is identified; another machine's open.
{
  const agents = [AGENT("t5", "sp1", "Something else")];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ listing: LISTING, agents, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  w.herdr.panesNow = () => [{ terminal: "t5", cwd: "/Users/you/code/webshop" }];
  const r = await w.ses.resumeSessions([
    { sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix" },
    { sid: "s3", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: null },
    { sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" },
  ]);
  eq("unidentified tab here: every pick here skipped, whatever its folder or title", [r.opened, r.skipped.map((s) => [s.row.sid, s.why]), w.runs.length],
    [0, [["s1", "may be open already"], ["s3", "may be open already"], ["s2", "may be open already"]], 0]);
}
{
  const agents = [AGENT("t5", "sp1", "")];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ listing: LISTING, agents, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  const r = await w.ses.resumeSessions([{ sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" }]);
  eq("unidentified tab, folder unknown: every pick on that machine skipped", [r.opened, r.skipped.map((s) => s.why)], [0, ["may be open already"]]);
}
// s31 (owner 11-14: precise identity): an unidentified tab holds back only the sessions its command line may hold.
{
  const S1 = "51515151-0000-4000-8000-000000000051", S2 = "52525252-0000-4000-8000-000000000052";
  const picks = [
    { sid: S1, account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix" },
    { sid: S2, account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" },
  ];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const looked = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: { t5: { kind: "claude", cwd: "/Users/you", pids: [55] } } } };
  const mk = async (argv, cwd = "/Users/you/code/webshop") => {
    const w = await world({ listing: LISTING, agents: [AGENT("t5", "sp1", "")], files: looked, spaces: [{ id: "sp1", name: "~", machine: null, tabs: [] }] });
    w.herdr.termsNow = () => [{ address: "t5", foreground: { argv, cwd, pid: 55 } }];
    return w;
  };
  let w = await mk(["claude"]);
  let r = await w.ses.resumeSessions(picks);
  eq("s31: a plain `claude` tab not identified yet holds nothing back", [r.opened, r.skipped.length], [2, 0]);
  w = await mk(["claude", "--resume", S1]);
  r = await w.ses.resumeSessions(picks);
  eq("s31: a tab resuming S1 holds back only S1", [r.opened, r.skipped.map((s) => [s.row.sid, s.why])], [1, [[S1, "may be open already"]]]);
  w = await mk(["claude", "--continue"], "/Users/you/code/tools");
  r = await w.ses.resumeSessions(picks);
  eq("s31: a --continue tab holds back only its folder's sessions", [r.opened, r.skipped.map((s) => s.row.sid)], [1, [S2]]);
  w = await mk(["claude"]);
  const L = await w.res.liveSids();
  eq("s31: a tab that can only be new is not 'unidentified' (no banner)", L.unknown, false);
  // Review P2: the helper hasn't looked at that tab yet (no cache entry) → its command line proves nothing.
  const w2 = await world({ listing: LISTING, agents: [AGENT("t5", "sp1", "")], files, spaces: [{ id: "sp1", name: "~", machine: null, tabs: [] }] });
  w2.herdr.termsNow = () => [{ address: "t5", foreground: { argv: ["claude"], cwd: "/Users/you", pid: 55 } }];
  const r2 = await w2.ses.resumeSessions(picks);
  eq("review P2: not looked at yet → every pick here waits", [r2.opened, r2.skipped.length], [0, 2]);
}
// s31 (from herdr-sessions, owner 11-14): after Resume selected, the workspace and tab shown before are shown again.
{
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const sp = [{ id: "sp1", name: "~", machine: null, active: true, tabs: [{ id: "tb1", active: true }] }, { id: "sp2", name: "webshop", machine: null, folder: "/Users/you/code/webshop", tabs: [{ id: "tb2" }] }];
  const w = await world({ listing: LISTING, files, spaces: sp });
  w.herdr.spaces = () => sp;
  const onRun = (name) => { if (name === "tab.new") { sp[0].active = false; sp[0].tabs[0].active = false; sp[1].active = true; sp[1].tabs.push({ id: `new${sp[1].tabs.length}`, active: true }); } };
  const runWas = w.herdr.run;
  w.herdr.run = (n, a) => { const out = runWas(n, a); onRun(n); return out; };
  const r = await w.ses.resumeSessions([{ sid: "s1", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: "Cart fix" }], { wait: async () => {} });
  eq("s31: back where you were after Resume selected", [r.opened, w.runs.map(([n, a]) => [n, a.id ?? null])], [1, [["tab.new", null], ["space.select", "sp1"], ["tab.select", "tb1"]]]);
}
{
  // An unidentified tab on this computer does not hold back wsl's picks.
  const agents = [AGENT("t5", "sp1", "")];
  const files = { [`wsl:${WSL}/.cache/flockbook/cache.json`]: { entries: {} }, [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ settings: { claude_machine: "wsl" }, listing: LISTING, agents, files, spaces: [{ id: "wsl/sp7", name: "~", machine: "wsl" }] });
  await w.where.machineHome("wsl");
  const r = await w.ses.resumeSessions([{ sid: "w1", account: "HOME", machine: "wsl", cwd: "/home/you/n", title: "t" }]);
  eq("unidentified tab here: a wsl pick opens", [r.opened, w.runs.map(([, a]) => a.argv.at(-1))], [1, ["w1"]]);
}
// 16. s28 (Codex R1 P2): the dialog and the restart offer share "being opened" claims: one never opens what the other
// is opening or just opened.
{
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ listing: LISTING, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  const OFFER = "flockbook.resume.offer";
  w.st.setShared(OFFER, { at: now, tabs: [{ sid: "s3", account: "HOME", cwd: "/Users/you/code/webshop", claimAt: Date.now() }, { sid: "s2", account: "WORK", cwd: "/Users/you/code/tools", space: "sp1" }] });
  const r = await w.ses.resumeSessions([{ sid: "s3", account: "HOME", machine: "", cwd: "/Users/you/code/webshop", title: null }, { sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" }]);
  eq("claims: s3 claimed by the offer → skipped; s2 opened", [r.opened, r.skipped.map((s) => [s.row.sid, s.why])], [1, [["s3", "being opened already"]]]);
  eq("claims: s2 left the offer", (w.res.offer()?.tabs ?? []).map((x) => x.sid), ["s3"]);
  const again = await w.ses.resumeSessions([{ sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" }]);
  eq("claims: s2 again right after → skipped (its tab may not be identified yet)", [again.opened, again.skipped.map((s) => s.why)], [0, ["being opened already"]]);
  w.st.setShared(OFFER, { at: now, tabs: [{ sid: "s2", account: "WORK", cwd: "/Users/you/code/tools", space: "sp1" }] });
  const n = w.runs.length;
  await w.res.resumeOne("s2");
  eq("claims: the offer's Resume opens nothing the dialog just opened", [w.runs.length - n, w.res.offer()], [0, null]);
}
{
  // s28 (Codex R2 P2): two resumes at once (two dialogs, a double press) claim before any wait: one tab, not two.
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: {} } };
  const w = await world({ listing: LISTING, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  const pick = () => [{ sid: "s2", account: "WORK", machine: "", cwd: "/Users/you/code/tools", title: "Tools" }];
  const [a, b] = await Promise.all([w.ses.resumeSessions(pick()), w.ses.resumeSessions(pick())]);
  eq("overlap: one tab", [w.runs.length, a.opened + b.opened, [...a.skipped, ...b.skipped].map((s) => s.why)], [1, 1, ["being opened already"]]);
  // A claim given up (the pick couldn't open) does not hold the session back.
  const w2 = await world({ listing: LISTING, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  await w2.ses.resumeSessions([{ sid: "s2", account: "GONE", machine: "", cwd: "/Users/you/code/tools", title: "Tools" }]);
  const r2 = await w2.ses.resumeSessions(pick());
  eq("overlap: a failed pick's claim is released", r2.opened, 1);
}
// 17. s28 (Fable 3): a session whose log changed in the last minutes may run in a terminal outside Herdr (VS Code, …):
// marked, left out of Select all shown; ticked by hand it still opens. A session in a sub-agent tab counts as open.
{
  const listing = { "": [row(secs(60_000), LOG(MAC, "r1"), "/Users/you/code/webshop", "Busy one", "x"), row(secs(3600_000), LOG(MAC, "s2"), "/Users/you/code/tools", "Tools", "x")].join("\n") };
  const w = await world({ listing });
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("recent: marked as maybe open elsewhere", /may be open in another terminal/.test(ui.textOf(ui.byId(view.render(cx), "ses-row-here-r1"))), true);
  ui.byId(view.render(cx), "ses-all")._h.on_click({}, cx);
  eq("recent: left out of Select all shown", [...view.picked].map((k) => k.split("\t")[2]), ["s2"]);
  ui.byId(view.render(cx), "ses-row-here-r1")._h.on_click({}, cx);
  eq("recent: ticked by hand", view.picked.size, 2);
}
{
  const agents = [{ ...AGENT("t9", "sp1", "Helper"), address: "t9" }];
  const files = { [`:${MAC}/.config/herdr-app/flockbook/cache.json`]: { entries: { t9: { path: LOG(MAC, "s1"), cwd: "/Users/you/code/webshop", pids: [91] } } } };
  const w = await world({ listing: LISTING, agents, files, spaces: [{ id: "sp1", name: "~", machine: null }] });
  w.herdr.termsNow = () => [{ address: "t9", parent: "t1" }];
  const cx = fakeCx(); const view = new w.ses.SessionsView(cx); await cx.settle();
  eq("sub-agent tab: its session is not listed", view.shown().some((r) => r.sid === "s1"), false);
}
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
