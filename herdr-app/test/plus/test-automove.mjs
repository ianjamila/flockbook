// Tests for automove.js logProject/titleProject (which "~" sessions the auto-mover files into a project workspace).
// Rule: the project's folder must hold MORE THAN HALF of the log's folder lines (and >= 5, and 4x the other
// project's). Before, 5 lines were enough: one `cd ~/code/webshop && gh pr view 12` in a "~" session left 30 of its
// 618 folder lines there and moved it. The projects come from the "projects" setting (projectList), not from code.
import { MOD } from "./paths.mjs";
import { loadMod, fakeShared } from "./loadmod.mjs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const src = fs.readFileSync(MOD + "automove.js", "utf8");
const pa = src.indexOf("// <projects-pure>"), pb = src.indexOf("// </projects-pure>");
const pure = src.slice(pa, pb).replaceAll("export ", "");
const ex = src.indexOf("export const ALL"), ey = src.indexOf("async function loadDone");
const logic = src.slice(src.indexOf("export const TICK_MS"), ey).replaceAll("export ", "");
const expandHome = (p, h) => (typeof p === "string" && (p === "~" || p.startsWith("~/")) && h ? h + p.slice(1) : p);
const { projectList, escapeRe, logProject, titleProject, ALL } = new Function("expandHome", "projects", "spaces", "appHome", pure + logic + "; return { projectList, escapeRe, logProject, titleProject, ALL };")(expandHome, () => [], () => [], () => "");
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const name = (p) => p?.name ?? null;

// The "projects" setting, as the stand-in owner would write it.
const SETTING = [{ workspace: "webshop", folder: "~/code/webshop", title: "web\\s*shop" }, { workspace: "tools", folder: "~/code/tools/", title: "tools", suggest_only: true }];
const LIST = projectList(SETTING, "/Users/you");
eq("projectList: folders expanded, trailing slash dropped", LIST.map((p) => p.folder), ["/Users/you/code/webshop", "/Users/you/code/tools"]);
eq("projectList: names and suggest-only flags", LIST.map((p) => [p.name, p.suggestOnly]), [["webshop", false], ["tools", true]]);
eq("projectList: a title pattern is a case-insensitive regexp", [LIST[0].title.test("Fix Web Shop cart"), LIST[1].title.test("nothing")], [true, false]);
eq("projectList: not set → none", [projectList(null, "/Users/you"), projectList(undefined, "/Users/you"), projectList("x", "/Users/you")], [[], [], []]);
eq("projectList: no title → null pattern", projectList([{ workspace: "w", folder: "/w" }], "/h")[0].title, null);
eq("escapeRe: a folder name is matched literally", new RegExp(escapeRe("a.b+c(1)")).test("a.b+c(1)") && !new RegExp(escapeRe("a.b")).test("axb"), true);
const lp = (scores) => name(logProject(scores, LIST));

// The false move (counts measured on a real session).
eq("one cd to check a PR: 30 of 618 → stays", lp({ webshop: 30, tools: 0, [ALL]: 618 }), null);
// Real work in a project.
eq("most lines in webshop → webshop", lp({ webshop: 400, tools: 0, [ALL]: 618 }), "webshop");
eq("most lines in tools → tools", lp({ webshop: 2, tools: 90, [ALL]: 120 }), "tools");
// The majority edge.
eq("exactly half → stays", lp({ webshop: 50, tools: 0, [ALL]: 100 }), null);
eq("just over half → moves", lp({ webshop: 51, tools: 0, [ALL]: 100 }), "webshop");
// The older rules still hold.
eq("under 5 lines, even if all → stays", lp({ webshop: 4, tools: 0, [ALL]: 4 }), null);
eq("5 lines, all of them → moves", lp({ webshop: 5, tools: 0, [ALL]: 5 }), "webshop");
eq("both projects close → stays", lp({ webshop: 60, tools: 20, [ALL]: 90 }), null);
eq("other project 1/4 → moves", lp({ webshop: 60, tools: 15, [ALL]: 90 }), "webshop");
// Missing or odd totals.
eq("no total (grep failed) → stays", lp({ webshop: 40, tools: 0 }), null);
eq("zero total → stays", lp({ webshop: 40, tools: 0, [ALL]: 0 }), null);
eq("total below the project's (raced log) → counts as all", lp({ webshop: 40, tools: 0, [ALL]: 30 }), "webshop");
eq("nothing → stays", lp({ [ALL]: 300 }), null);
eq("no projects set → stays", name(logProject({ webshop: 400, [ALL]: 618 }, [])), null);
// Titles (unchanged rule).
eq("title names webshop", name(titleProject("Fix Web Shop cart", LIST)), "webshop");
eq("title names tools", name(titleProject("tools lint cleanup", LIST)), "tools");
eq("title names both → none", name(titleProject("webshop vs tools", LIST)), null);
eq("title names none → none", name(titleProject("something else", LIST)), null);
eq("no projects set → title names none", name(titleProject("webshop", [])), null);

// The wrong-workspace suggestion (automove.js suggestion(), <suggest> markers): never a move, only an offer.
const sa = src.indexOf("// <suggest>"), sb = src.indexOf("// </suggest>");
const { suggestion } = new Function("expandHome", "projects", "spaces", "appHome", pure + logic + src.slice(sa, sb).replaceAll("export ", "") + "; return { suggestion };")(expandHome, () => [], () => [], () => "");
const SP = [{ id: "s1", name: "~" }, { id: "s2", name: "webshop" }, { id: "s3", name: "tools" }];
const sgName = (x) => x?.name ?? null;
const sg = (s, topic, here, entry) => sgName(suggestion(s, topic, here, entry, SP, LIST));
const dr = { webshop: 2, tools: 40, [ALL]: 50 };
eq("webshop tab whose work is in tools → tools", sg(dr, "x", SP[1], null), "tools");
eq("already in tools → none", sg(dr, "x", SP[2], null), null);
eq("moved by hand → none", sg(dr, "x", SP[1], { manual: true }), null);
eq("owner said keep it here → none", sg(dr, "x", SP[1], { noSuggest: ["tools"] }), null);
eq("tools work in ~ → suggested (never auto-moved)", sg({ webshop: 0, tools: 30, [ALL]: 40 }, "x", SP[0], null), "tools");
eq("title alone, in ~ → suggested", sg(null, "tools wrap-up", SP[0], null), "tools");
eq("title alone, in a project space → none", sg(null, "tools wrap-up", SP[1], null), null);
eq("mixed work → none", sg({ webshop: 20, tools: 20, [ALL]: 60 }, "x", SP[0], null), null);
eq("other machine → none", sgName(suggestion(dr, "x", { ...SP[1], machine: "box" }, null, SP, LIST)), null);
eq("no projects set → none", sgName(suggestion(dr, "tools wrap-up", SP[0], null, SP, [])), null);

// The ticks do nothing without the settings: auto_move "on" and projects for the auto-mover, projects for suggestions.
async function ticks({ file = {} } = {}) {
  const st = fakeShared(), seen = [];
  const note = (n) => (...a) => { seen.push(n); return n === "spaces" || n === "agents" || n === "terminals" ? [] : undefined; };
  const herdr = { ...st, home: () => "/Users/you", appHome: () => "/x", spaces: note("spaces"), agents: note("agents"), terminals: note("terminals"), panes: note("panes"), readTextFile: async () => { seen.push("read"); return null; }, writeTextFile: async () => {}, hc: async () => ({ code: 1, stdout: "" }), run: note("run"), exec: async () => ({ code: 1, stdout: "" }), notify: () => {} };
  const setting = (k) => file[k] ?? { auto_move: "off" }[k];
  const m = await loadMod("automove.js", { herdr, "./config.js": { setting, expandHome }, "./state.js": { sessionTopic: () => "" } });
  return { m, seen, st };
}
{
  const t = await ticks({ file: { auto_move: "on" } });
  await t.m.autoMoveTick({ timer: { after: (_ms, f) => f() } });
  eq("autoMoveTick: on but no projects → touches nothing", t.seen, []);
}
{
  const t = await ticks({ file: { projects: SETTING } });
  await t.m.autoMoveTick({ timer: { after: (_ms, f) => f() } });
  eq("autoMoveTick: projects but auto_move off (the default) → touches nothing", t.seen, []);
}
{
  const t = await ticks();
  t.st.setShared("flockbook.move.suggest", { t1: { space: "s2", name: "webshop", why: "x" } });
  await t.m.suggestTick();
  eq("suggestTick: no projects → touches nothing, old suggestions cleared", [t.seen, t.st.data["flockbook.move.suggest"] ?? null], [[], {}]);
}
{
  const t = await ticks({ file: { projects: SETTING } });
  await t.m.suggestTick();
  eq("suggestTick: with projects it looks at the tabs", t.seen.includes("agents") || t.seen.includes("spaces"), true);
}

// Optional: a session log given as the first argument is scored with the mod's own patterns (prints the verdict).
const log = process.argv[2];
if (log && fs.existsSync(log)) {
  const count = (re) => { try { return parseInt(execFileSync("/usr/bin/grep", ["-c", "-E", re, log]).toString(), 10); } catch { return 0; } };
  const s = { webshop: count('"(cwd|file_path)":"/Users/you/code/webshop(/|")'),
              tools: count('"(cwd|file_path)":"/Users/you/code/tools(/|")'), [ALL]: count('"(cwd|file_path)":"/') };
  console.log("log", JSON.stringify(s), "→", name(logProject(s, LIST)) ?? "stays");
}
process.exit(bad ? 1 : 0);
