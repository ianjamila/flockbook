// Tests for the Overview sub-statuses (state.js overlays/subStatus/plainLabel, overview.js subGroups/groups).
// Loads the pure parts of the mod's source with stubs for Herdr. Run: node test-substatus.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const st = fs.readFileSync(MOD + "state.js", "utf8");
const ov = fs.readFileSync(MOD + "overview.js", "utf8");
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("cut " + a); return src.slice(i, j); };
const AGENTS = {};
const stateCode = cut(st, "const AGENT_MARK", "// The topic alone")
  + "\nconst programName = (a) => a.program?.name ?? a.app ?? 'Agent';"
  + "\nfunction autoNamed(tab, a) { return !tab.named || Boolean(a && tab.name === programName(a)); }"
  + "\n" + cut(st, "export function tabLabel", "// The screen for a tab")
  + "\n" + cut(st, "export function agentName", "const programName");
const ASKS = {};
const PRS = {}, BG = {}, HO = {}, NOWW = {};
const bgWords = (b) => [b?.shells ? `${b.shells} ${b.shells === 1 ? "shell" : "shells"} running` : null, b?.agents ? `${b.agents} ${b.agents === 1 ? "agent" : "agents"} running` : null].filter(Boolean).join(" · ");
const asksSrc = fs.readFileSync(MOD + "asks.js", "utf8");
const askMark = new Function(cut(asksSrc, "export function askMark", "export function askDetail").replaceAll("export ", "") + "; return askMark;")();
const S = new Function("AGENTS", "askMark", "askOf", "prOf", "bgOf", "bgWords", "handoffOf", "nowWait", stateCode.replaceAll("export ", "")
  + "; function tabAgents(id) { return AGENTS[id] ? [{ ...AGENTS[id], address: id }] : []; }"
  + "; return { overlays, subStatus, plainLabel, tabLabel, withAsk, SUB_GROUPS };")(AGENTS, askMark, (addr) => ASKS[addr] ?? null, (addr) => PRS[addr] ?? null, (addr) => BG[addr] ?? null, bgWords, (addr) => Boolean(HO[addr]), (addr) => NOWW[addr] ?? null);
const ovCode = cut(ov, "// Grouped by status", "export class OverviewView");
// machines.js spaceTitle ("api on pc-wsl"), as the Overview names a workspace by it (owner 11-14).
const spaceTitle = new Function(/^export const spaceTitle = .*$/m.exec(fs.readFileSync(MOD + "machines.js", "utf8"))[0].replace("export ", "") + "; return spaceTitle;")();
const O = new Function("subStatus", "SUB_GROUPS", "tabAgents", "askOf", "spaceTitle", ovCode.replaceAll("export ", "") + "; return { groups, subGroups, waitingOn, waitingLabel, statusOf };")(
  S.subStatus, S.SUB_GROUPS, (id) => (AGENTS[id] ? [{ ...AGENTS[id], address: id }] : []), (addr) => ASKS[addr] ?? null, spaceTitle);

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const ag = (title) => ({ title, program: { name: "Claude Code", key: "claude-code" } });

eq("no symbols", S.overlays(ag("✳ Fix login")), []);
eq("spinner + ⏳🔵", S.overlays(ag("✳ ⏳🔵 Fix login")).map((o) => o.glyph), ["⏳", "🔵"]);
eq("🛠️ with FE0F + ✅", S.overlays(ag("🛠️✅ Sidebar")).map((o) => o.group), ["agents", "results"]);
eq("▲ stripped then 🔀", S.overlays(ag("▲ 🔀 PR 5")).map((o) => o.glyph), ["🔀"]);
eq("stops at first word", S.overlays(ag("🔍 Review ✅ later")).map((o) => o.glyph), ["🔍"]);
eq("null agent", S.overlays(null), []);

AGENTS.a = ag("✅🔀 Deployment Statistics PR 5");
AGENTS.b = ag("🛠 Auto tab renaming");
AGENTS.c = ag("Herdr handoff");
AGENTS.d = { ...ag("🟣✅ Tools repo move"), status: "working" };   // while the turn runs
AGENTS.e = ag("⏳ Merge gate");
const tab = (id, status, extra = {}) => ({ id, status, name: "1", named: false, ...extra });
ASKS.a = { kind: "merge", pr: 1818 };   // the reply still ends with the hand-off
eq("merge outranks results", S.subStatus(tab("a"))?.key, "merge");
// s9: the reply's ask comes first, with its PR (askMark).
eq("hint words", S.subStatus(tab("a"))?.hint, "🔀 ready to merge #1818 · ✅ results waiting");
eq("owner flag", [S.subStatus(tab("a"))?.owner, S.subStatus(tab("b"))?.owner], [true, false]);
delete ASKS.a;                           // owner said "merge": 🔀 stays in the title, the ask is gone
eq("🔀 without an open ask = merging", S.subStatus(tab("a"))?.key, "merging");
eq("merging hint", S.subStatus(tab("a"))?.hint, "✅ results waiting · 🔀 merging");
AGENTS.m = ag("🔀 Employee search #1801");
eq("🔀 alone without an ask → Merging group", S.subStatus(tab("m"))?.key, "merging");
// Owner 11-14 s29 ("Live work wins"): what a working tab does now leads; ✅ is only a hint word on it.
eq("live work wins: working 🟣✅ → In review", S.subStatus(tab("d", "working"))?.key, "review");
eq("live work wins: its ✅ is not waiting on you", S.subStatus(tab("d", "working"))?.owner, false);
eq("live work wins: ✅ stays in the hint", S.subStatus(tab("d", "working"))?.hint, "🟣 Fable review · ✅ results waiting");
// Owner 11-14 s29: a review dot on a FINISHED turn is a review agent still running (the hook re-checks the dots at
// every turn end), as ⏳ / 🔍 are: In review, working, ahead of the ✅.
AGENTS.d.status = "done";
eq("finished 🟣✅: In review", S.subStatus(tab("d", "done"))?.key, "review");
eq("finished 🟣✅: working", S.subStatus(tab("d", "done"))?.background, true);
eq("finished 🟣✅ → pipeline, In review", O.groups([tab("d", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["In review"]]]);
for (const dot of ["🟠", "🔵", "🟢", "⚪"]) {
  AGENTS.dd = { ...ag(dot + "✅ X"), status: "idle" };
  eq(`finished ${dot}✅: In review, working`, [S.subStatus(tab("dd", "idle"))?.key, S.subStatus(tab("dd", "idle"))?.background], ["review", true]);
}
delete AGENTS.dd;
// The groups below: a finished tab with only its ✅ left (the review agent is over, so its dot is gone).
AGENTS.d = { ...ag("✅ Tools repo move"), status: "idle" };
eq("plain tab", S.subStatus(tab("c")), null);
eq("plainLabel strips symbols", S.plainLabel(tab("a")), "Deployment Statistics PR 5");
eq("plainLabel of a named tab", S.plainLabel(tab("b", "working", { named: true, name: "Renamer" })), "Renamer");

const items = [tab("a", "done"), tab("b", "working"), tab("c", "working"), tab("d", "idle"), tab("e", "done"), tab("c", "blocked")]
  .map((t) => ({ space: { id: "s", name: "S" }, tab: t }));
const g = O.groups(items, "status");
// Owner 11-12: a finished turn (done/idle) with only a leftover ✅ or answered 🔀 goes by status (Done/Resting), not CI.
eq("sections, no Needs you", g.map((x) => x.title), ["Working", "CI / Final Review / Merging", "Done", "Resting"]);
eq("pipeline subs: only running work", g[1].subs.map((s) => [s.title, s.items.map((i) => i.tab.id)]), [["Waiting on CI", ["e"]]]);
eq("done + answered 🔀 → Done, under Merging", g[2].subs.map((s) => [s.title, s.items.map((i) => i.tab.id)]), [["Merging", ["a"]]]);
eq("idle + ✅ → Resting, under results", g[3].subs.map((s) => [s.title, s.items.map((i) => i.tab.id)]), [["Review results waiting", ["d"]]]);
AGENTS.r = ag("✅ Webshop PRs #1448 and #1533 review and merge");
eq("owner's case: done + ✅ only → Done", O.groups([tab("r", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.items.map((i) => i.tab.id)]), [["Done", ["r"]]]);
eq("live work wins: working + ✅ only → Working (results wait only on idle tabs)", O.groups([tab("r", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Working", [""]]]);
eq("live work wins: working + ✅ only is not waiting on you", O.waitingOn([{ space: { id: "s", name: "S" }, tab: tab("r", "working") }]), 0);
eq("idle + ✅ only still waits on you", O.waitingOn([{ space: { id: "s", name: "S" }, tab: tab("r", "idle") }]), 1);
// Owner 11-14 20:23 screenshot: five working "🛠 building · ✅ results waiting" tabs sat under Review results waiting.
AGENTS.bw = { ...ag("🛠✅ EW #2058 round-2 fixes"), status: "working" };
eq("live work wins: working 🛠✅ → Agents at work", O.groups([tab("bw", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Working", ["Agents at work"]]]);
eq("live work wins: 🛠✅ hint keeps both", S.subStatus(tab("bw", "working"))?.hint, "🛠 building · ✅ results waiting");
// #2049: "Now: Waiting for the round 10 Codex job" with no 🔍 in its title (the pipeline's own Codex call).
AGENTS.cx = { ...ag("✅ EagleWatch PR #2049"), status: "working" };
NOWW.cx = "review";
eq("working, Now line waits on a Codex job → Waiting on a review (pipeline section)", O.groups([tab("cx", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["Waiting on a review"]]]);
eq("…its hint", S.subStatus(tab("cx", "working"))?.hint, "🔍 waiting on a review · ✅ results waiting");
NOWW.cx = "ci";
eq("working, Now line waits on CI → Waiting on CI", S.subStatus(tab("cx", "working"))?.key, "ci");
AGENTS.cx.status = "done"; NOWW.cx = "review";
eq("a finished turn's old Now line is not live work", S.subStatus(tab("cx", "done"))?.key, "results");
delete AGENTS.bw; delete AGENTS.cx; delete NOWW.cx;
eq("finished merging tab: Done, Merging sub-group", O.groups([tab("m", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((s) => [s.title, s.items.map((i) => i.tab.id)])]), [["Done", [["Merging", ["m"]]]]]);
eq("Working keeps build agents + plain", g[0].subs.map((s) => [s.title, s.items.map((i) => i.tab.id)]), [["Agents at work", ["b"]], ["Other", ["c"]]]);
eq("blocked tab left out", g.flatMap((x) => x.items).some((i) => i.tab.status === "blocked"), false);
const g2 = O.groups([tab("a", "working"), tab("c", "blocked")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status");
eq("working 🔀 goes to the pipeline section", g2.map((x) => [x.title, x.items.map((i) => i.tab.id)]), [["CI / Final Review / Merging", ["a"]]]);
AGENTS.f = ag("🔍🛠 Codex + build");
eq("Codex review → pipeline", O.groups([tab("f", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => x.title), ["CI / Final Review / Merging"]);
eq("blocked + 🔀 left to the Needs you page", O.groups([tab("a", "blocked")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status"), []);
eq("no background work → one untitled sub", O.subGroups([items[2]]).map((s) => s.title), [""]);
ASKS.b = { kind: "round", pr: 1803, round: 6 };
eq("extra-round ask leaves the Overview (Needs you page)", O.groups([tab("b", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status"), []);
ASKS.b = { kind: "merge", pr: 1818 };
// s9: a merge ask with no 🔀 in the title now shows as one (owner 11-12: make merge and round asks obvious),
// so the tab sits under Ready to merge like a titled one.
eq("merge ask → Ready to merge", O.groups([tab("b", "working")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["Ready to merge"]]]);
delete ASKS.b;
eq("by space has no subs", O.groups(items, "space").every((x) => !x.subs), true);

// Waiting on you: a 🔀 hand-off (ask open) or ✅ results, counted on the section and its sub-groups.
const ON = (ids) => ids.map(([id, st]) => ({ space: { id: "s", name: "S" }, tab: tab(id, st) }));
ASKS.a = { kind: "merge", pr: 5 };
const gw = O.groups(ON([["a", "done"], ["d", "idle"], ["e", "done"], ["m", "done"]]), "status");
eq("section waiting count", gw.map((x) => [x.title, x.waiting]), [["CI / Final Review / Merging", 1], ["Done", 0], ["Resting", 1]]);
eq("sub-group waiting counts", gw[0].subs.map((x) => [x.title, x.items.length, x.waiting]), [["Ready to merge", 1, 1], ["Waiting on CI", 1, 0]]);
eq("section label", O.waitingLabel(gw[0], false), "1 waiting on you");
eq("all-waiting sub-group: no label", O.waitingLabel(gw[0].subs[0], true), null);
eq("none waiting: no label", O.waitingLabel(gw[0].subs[1], true), null);
delete ASKS.a;                                     // said "merge": a is merging, but its ✅ results still wait
const gm = O.groups(ON([["a", "done"], ["m", "done"]]), "status");
eq("mixed sub-group", gm[0].subs.map((x) => [x.title, x.items.length, x.waiting]), [["Merging", 2, 1]]);
eq("mixed sub-group label", O.waitingLabel(gm[0].subs[0], true), "1 waiting");
eq("waitingOn plain tabs", O.waitingOn(ON([["c", "working"]])), 0);

// A 🔀 left in the title after a merge GitHub confirmed (owner 18:15): "merged", in Done, no stale ✅.
AGENTS.g = ag("✅🔀 Webshop sidebar");
eq("🔀 + ✅, not known merged → Merging", S.subStatus(tab("g"))?.key, "merging");
PRS.g = { pr: 1821, repo: "o/r", state: "MERGED" };
eq("merged PR → merged, stale ✅ dropped", [S.subStatus(tab("g"))?.key, S.subStatus(tab("g"))?.hint, S.subStatus(tab("g"))?.owner], ["merged", "🔀 merged #1821", false]);
eq("merged tab sits in Done", O.groups(ON([["g", "done"]]), "status").map((x) => x.title), ["Done"]);
PRS.g = { pr: 1821, repo: "o/r", state: "CLOSED" };
eq("closed PR", S.subStatus(tab("g"))?.hint, "🔀 closed #1821");
PRS.g = { pr: 1821, repo: "o/r", state: "OPEN" };
eq("open PR stays merging", S.subStatus(tab("g"))?.key, "merging");
ASKS.g = { kind: "merge", pr: 1830 };
PRS.g = { pr: 1821, state: "MERGED" };
eq("a new hand-off wins over an old merged PR", S.subStatus(tab("g"))?.key, "merge");
delete ASKS.g; delete PRS.g;

// Any other ask leaves the Overview for the Needs you page (owner 18:17).
AGENTS.h = ag("✅ Tools repo move");
ASKS.h = { kind: "reply", words: ["OK, run both", "watchdog only"], text: "…" };
eq("reply ask → Needs you", O.groups(ON([["h", "done"]]), "status"), []);
ASKS.h = { kind: "question", text: "Should I?" };
eq("question ask → Needs you", O.groups(ON([["h", "done"]]), "status"), []);
delete ASKS.h;

// A turn that ended with a shell still running: owner 11-11 18:18 said working; owner 11-12 16:45 changed it —
// leftover shells alone go by status (Done) with the ⚙ hint; a background AGENT still keeps it working.
AGENTS.k = ag("Doc 201 follow-ups");
BG.k = { shells: 1, agents: 0 };
eq("background shell → hint", S.subStatus(tab("k", "done"))?.hint, "⚙ 1 shell running");
eq("background shell alone → Done, under Running in the background", O.groups(ON([["k", "done"]]), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Done", ["Running in the background"]]]);
eq("statusOf: shell alone stays done", O.statusOf(tab("k", "done")), "done");
BG.k = { shells: 0, agents: 1 };
eq("background agent → Working", O.groups(ON([["k", "done"]]), "status").map((x) => x.title), ["Working"]);
eq("statusOf: agent → working", O.statusOf(tab("k", "done")), "working");
BG.k = { shells: 2, agents: 1 };
eq("shells and agents words", S.subStatus(tab("k", "idle"))?.hint, "⚙ 2 shells running · 1 agent running");
AGENTS.k = { ...ag("Doc 201 follow-ups"), status: "blocked" };
eq("blocked stays blocked", O.statusOf(tab("k", "blocked")), "blocked");
delete BG.k;
eq("no background → done", O.statusOf(tab("k", "done")), "done");

// 11-12 s9: an extra-round / merge ask from the reply shows as a symbol even when the title has none.
AGENTS.r = ag("✅ Style Guide Part A (PR #1838)");
ASKS.r = { kind: "round", pr: 1838, round: 5 };
eq("round ask first", S.overlays(AGENTS.r && { ...AGENTS.r, address: "r" }).map((o) => o.glyph), ["🔁", "✅"]);
const ssr = S.subStatus(tab("r", "done"));
eq("round ask → askGlyph", ssr?.askGlyph, "🔁");
eq("round ask → owner", ssr?.owner, true);
eq("round ask → key round", ssr?.key, "round");
eq("round hint", ssr?.hint, "🔁 extra round #1838 · ✅ results waiting");
eq("withAsk adds 🔁", S.withAsk(ssr, "✅ Style Guide"), "🔁 ✅ Style Guide");
eq("withAsk keeps a label that has it", S.withAsk(ssr, "🔁 x"), "🔁 x");
eq("withAsk no ask", S.withAsk(null, "plain"), "plain");
// A merge ask with 🔀 already in the title: one 🔀, not two.
AGENTS.m = ag("🔀 PR 5");
ASKS.m = { kind: "merge", pr: 5 };
eq("merge ask + title 🔀 → one", S.overlays({ ...AGENTS.m, address: "m" }).map((o) => o.glyph), ["🔀"]);
eq("merge ask, no title glyph", S.overlays({ ...ag("PR 5"), address: "m" }).map((o) => o.glyph), ["🔀"]);
// A question ask gets no symbol.
ASKS.q = { kind: "question", text: "Which one?" };
eq("question ask → none", S.overlays({ ...ag("Topic"), address: "q" }), []);
delete ASKS.r; delete ASKS.m; delete ASKS.q;
eq("round group listed", S.SUB_GROUPS.map((g) => g[0]).slice(0, 4), ["merge", "round", "migration", "reply"]);
// Owner 11-12 (4:33 pm): finished tabs that gave a hand-off sit under "Hand-off given" in Done, not Merging / results.
AGENTS.h = ag("✅🔀 Webshop sidebar cleanup #1853");
HO.h = true;
eq("done + ✅🔀 + hand-off → Done, Hand-off given", O.groups([tab("h", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Done", ["Hand-off given"]]]);
eq("hand-off hint keeps the title's symbols", S.subStatus(tab("h", "done"))?.hint, "✅ results waiting · 🔀 merging · 🤝 hand-off given");
eq("hand-off waits on you", S.subStatus(tab("h", "done"))?.owner, true);
eq("idle + hand-off → Resting, Hand-off given", O.groups([tab("h", "idle")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Resting", ["Hand-off given"]]]);
AGENTS.h.status = "working";
eq("working agent: no hand-off group", S.subStatus(tab("h", "working"))?.key, "merging");
AGENTS.h.status = "done";
BG.h = { shells: 2, agents: 1 };
eq("still running behind the turn: no hand-off group", O.groups([tab("h", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["Merging"]]]);
BG.h = { shells: 1, agents: 0 };
eq("hand-off + leftover shell → Done, Hand-off given", O.groups([tab("h", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["Done", ["Hand-off given"]]]);
delete BG.h; delete HO.h;
// Owner 11-14 20:00: a finished ⏳✅ tab (CI runs, review results wait) is not Done: Waiting on CI in the pipeline section.
AGENTS.ci = { ...ag("⏳✅ EagleWatch PR #2049 signed-out redirect"), status: "done" };
eq("owner 11-14: done + ⏳✅ → pipeline, Waiting on CI", O.groups([tab("ci", "done")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["Waiting on CI"]]]);
AGENTS.cv = { ...ag("🔍✅ Tools repo move"), status: "idle" };
eq("idle + 🔍✅ (Codex still running) → pipeline, In review", O.groups([tab("cv", "idle")].map((t) => ({ space: { id: "s", name: "S" }, tab: t })), "status").map((x) => [x.title, x.subs.map((y) => y.title)]), [["CI / Final Review / Merging", ["In review"]]]);
delete AGENTS.ci; delete AGENTS.cv;
process.exit(bad ? 1 : 0);
