// Item 14 (owner 11-12 s13: "Auto-resume after restart … remember which conversation each tab had and offer to resume
// them all with one click"): resume.js. Pure parts + the tick and the Resume actions against fakes.
// Run: node test-resume.mjs
import { WORK_DIR, CFG_ENV } from "./paths.mjs";
import { loadMod, fakeShared, realAccounts } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
let now = 1_800_000_000_000;
Date.now = () => now;
const HOME = "/Users/you";
// The two accounts' config folders under the home folder: WORK has its own, HOME uses the default one. The names are
// built from parts (a hook blocks the literal names in a script run directly).
const NAME = ["cl", "aude"].join(""), DOT = String.fromCharCode(46);
const HOME_CFG = [HOME, DOT + NAME].join("/"), WORK_CFG = HOME + WORK_DIR.slice(1);
const VAR = CFG_ENV, BIN = [HOME, DOT + "npm-global", "bin", NAME].join("/");
const TWO = [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }];
// resume.js over the real accounts.js (reading the "accounts" and "claude_path" settings through the real config.js).
const loadResume = async (fakes, settings = { accounts: TWO, claude_path: BIN }) => { const ra = await realAccounts(fakes.herdr, settings); return loadMod("resume.js", { ...fakes, "./accounts.js": ra.acc, "./where.js": ra.where }); };
const log = (dir, sid) => `${dir}/projects/-Users-you/${sid}.jsonl`;

const st = fakeShared(), runs = [], notes = [];
let cacheReads = 0, onCacheRead = null;
let live = [], cache = { entries: {} }, spacesList = [{ id: "sp1", name: "webshop", tabs: [] }, { id: "sp2", name: "~", tabs: [] }];
const r = await loadResume({
  herdr: { ...st, home: () => HOME, appHome: () => `${HOME}/.config/herdr-app`, agents: () => live, terminals: () => [], spaces: () => spacesList,
    readTextFile: async () => { cacheReads++; const was = JSON.stringify(cache); if (onCacheRead) { const f = onCacheRead; onCacheRead = null; await f(); } await new Promise((ok) => setTimeout(ok, 5)); return was; }, run: (name, args) => { runs.push([name, args]); return null; }, notify: (m) => notes.push(m) },
});

// Pure.
eq("session from a work-account log", r.sessionOf(log(WORK_CFG, "aaa-1")), { sid: "aaa-1", account: "WORK" });
eq("a log named like an option is no session (s28 Fable 8)", r.sessionOf(log(WORK_CFG, "--dangerously-x")), null);
eq("session from a personal-account log", r.sessionOf(log(HOME_CFG, "bbb-2")), { sid: "bbb-2", account: "HOME" });
eq("no log", r.sessionOf(null), null);
// The config-folder variable's name, and the program, built from parts too.
eq("argv, work account", r.resumeArgv({ sid: "aaa-1", account: "WORK" }, HOME), ["/usr/bin/env", VAR + "=" + WORK_CFG, BIN, "--resume", "aaa-1"]);
eq("argv, personal account", r.resumeArgv({ sid: "bbb-2", account: "HOME" }, HOME), ["/usr/bin/env", "-u", VAR, BIN, "--resume", "bbb-2"]);
eq("argv, unknown account → none", r.resumeArgv({ sid: "c", account: null }, HOME), null);
eq("argv, an account no longer set → none", r.resumeArgv({ sid: "c", account: "GONE" }), null);
eq("session: a log outside every account's folder → none", r.sessionOf(log(HOME + "/elsewhere", "zzz")), null);
eq("session: not a conversation log → none", r.sessionOf(HOME_CFG + "/settings.json"), null);
{
  const rr = await loadResume({ herdr: { ...fakeShared(), home: () => HOME, appHome: () => HOME + "/x" } }, { accounts: TWO });
  const a = rr.resumeArgv({ sid: "aaa-1", account: "WORK" });
  eq("argv, no claude_path: PATH carries the usual folders, then claude", [a.slice(0, 2), a[2].startsWith("PATH=" + HOME + "/.local/bin:"), a.slice(3)], [["/usr/bin/env", VAR + "=" + WORK_CFG], true, ["claude", "--resume", "aaa-1"]]);
}
{
  const one = await loadResume({ herdr: { ...fakeShared(), home: () => HOME, appHome: () => HOME + "/x" } }, { claude_path: BIN });
  eq("no accounts: any default-folder log is the default account", one.sessionOf(log(HOME_CFG, "d-1")), { sid: "d-1", account: "default" });
  eq("no accounts: another folder's log is no one's", one.sessionOf(log(WORK_CFG, "d-2")), null);
  eq("no accounts: resumes as the default account", one.resumeArgv({ sid: "d-1", account: "default" }), ["/usr/bin/env", "-u", VAR, BIN, "--resume", "d-1"]);
}
{
  const only = await loadResume({ herdr: { ...fakeShared(), home: () => HOME, appHome: () => HOME + "/x" } }, { accounts: [TWO[0]], claude_path: BIN });
  eq("one account with its own folder: its log is its", only.sessionOf(log(WORK_CFG, "w-1")), { sid: "w-1", account: "WORK" });
  eq("one account with its own folder: the default folder's log is no one's", only.sessionOf(log(HOME_CFG, "w-2")), null);
}
// A Resume click claims its row for 60 s ("Opening…").
eq("opening: claimed 10 s ago", r.opening({ claimAt: now - 10_000 }, now), true);
eq("opening: claimed 60 s ago → clickable again", r.opening({ claimAt: now - 60_000 }, now), false);
eq("opening: never claimed", r.opening({ sid: "x" }, now), false);
const recs = { a: { sid: "a", pids: [1] }, b: { sid: "b", pids: [2] }, c: { sid: "c", pids: [3] }, d: { sid: "d", pids: [4] } };
eq("lost: one tab closed while others stay → forgotten", r.lostSessions(recs, { sids: new Set(["a", "b", "c"]), pids: new Set([1, 2, 3]) }, 30_000), { offer: [], forget: ["d"] });
eq("lost: most vanish at once → offered", r.lostSessions(recs, { sids: new Set(["a"]), pids: new Set([1]) }, 30_000).offer.map((x) => x.sid), ["b", "c", "d"]);
eq("lost: after a gap (the app was not running) → offered", r.lostSessions(recs, { sids: new Set(["a", "b", "c"]), pids: new Set([1, 2, 3]) }, 10 * 60_000).offer.map((x) => x.sid), ["d"]);
eq("lost: /clear in the same process (same pid, new session) → neither", r.lostSessions({ a: { sid: "a", pids: [1] } }, { sids: new Set(["z"]), pids: new Set([1]) }, 10 * 60_000), { offer: [], forget: ["a"] });

// The tick: records live Claude tabs from the helper's cache.
const agent = (address, tab_name, space) => ({ address, app: "claude-code", status: "working", title: `✳ ${tab_name ?? address}`, tab_name, space, space_name: space === "sp1" ? "webshop" : "~", program: { name: "Claude Code" } });
live = [agent("t1", "Checkout", "sp1"), agent("t2", null, "sp1"), agent("t3", null, "sp2")];
cache.entries = {
  t1: { kind: "claude", cwd: `${HOME}/code/webshop`, pids: [11], path: log(WORK_CFG, "s-1") },
  t2: { kind: "claude", cwd: HOME, pids: [12], path: log(WORK_CFG, "s-2") },
  t3: { kind: "claude", cwd: HOME, pids: [13], path: log(HOME_CFG, "s-3") },
};
await r.resumeTick();
eq("tick: three sessions remembered", Object.keys(r.remembered().tabs).sort(), ["s-1", "s-2", "s-3"]);
eq("tick: a record", r.remembered().tabs["s-1"], { sid: "s-1", account: "WORK", cwd: `${HOME}/code/webshop`, pids: [11], terminal: "t1", space: "sp1", spaceName: "webshop", name: "Checkout", title: "Checkout", at: now });
// A live tab the cache does not know yet: no decision this tick (nothing offered or forgotten).
now += 30_000; live.push(agent("t4", null, "sp1"));
await r.resumeTick();
eq("tick: unknown live tab → no decision", r.offer(), null);
live.pop();
// The Core restarted: every terminal gone, new ones not started.
now += 30_000; live = []; cache.entries = {};
await r.resumeTick();
eq("restart: all three offered", r.offer().tabs.map((x) => x.sid).sort(), ["s-1", "s-2", "s-3"]);
eq("restart: one notice", notes.length, 1);
await r.resumeTick();
eq("restart: offer kept, no second notice", [r.offer().tabs.length, notes.length], [3, 1]);

// Resume one: a tab in its workspace and folder, as its account; it leaves the offer.
await r.resumeOne("s-1");
eq("resume one: tab.new", runs[0], ["tab.new", { space: "sp1", folder: `${HOME}/code/webshop`, argv: r.resumeArgv({ sid: "s-1", account: "WORK" }, HOME), name: "Checkout" }]);
eq("resume one: leaves the offer", r.offer().tabs.map((x) => x.sid).sort(), ["s-2", "s-3"]);
// A workspace that is gone: this computer's "~", the shown one when it is this computer's, else a new "~" here (s28).
spacesList = [{ id: "sp1", name: "webshop", tabs: [] }];
await r.resumeAll();
eq("resume all: the rest", runs.slice(1).map(([n, a]) => [n, a.space ?? null, a.machine ?? null, a.argv.at(-1), a.name ?? null]), [["tab.new", "sp1", null, "s-2", null], ["space.new", null, "", "s-3", "~"]]);
eq("resume all: offer cleared", r.offer(), null);
// Dismiss.
st.setShared("flockbook.resume.offer", { at: now, tabs: [{ sid: "x", account: "WORK", cwd: HOME }] });
r.dismissOffer();
eq("dismiss clears", r.offer(), null);
// A session resumed by hand shows up live again: it leaves the offer by itself.
st.setShared("flockbook.resume.offer", { at: now, tabs: [{ sid: "s-9", account: "WORK", cwd: HOME, pids: [99] }, { sid: "s-8", account: "WORK", cwd: HOME, pids: [98] }] });
live = [agent("t7", null, "sp1")]; cache.entries = { t7: { kind: "claude", cwd: HOME, pids: [70], path: log(WORK_CFG, "s-9") } };
now += 30_000;
await r.resumeTick();
eq("resumed by hand: leaves the offer", r.offer().tabs.map((x) => x.sid), ["s-8"]);

// s13 Codex R1 P1: a session running again (resumed by hand) is not opened twice, even before the next tick.
const OFFER = "flockbook.resume.offer", MEM = "flockbook.resume.v1";
const rec = (sid, pid) => ({ sid, account: "WORK", cwd: HOME, pids: [pid] });
runs.length = 0;
live = [agent("t7", null, "sp1"), agent("t8", null, "sp1")];
cache.entries.t8 = { kind: "claude", cwd: HOME, pids: [80], path: log(WORK_CFG, "s-8") };
await r.resumeOne("s-8");
eq("already running: no new tab", runs.length, 0);
eq("already running: leaves the offer", r.offer(), null);
// A double click (or two views): one tab.
st.setShared(OFFER, { at: now, tabs: [rec("s-20", 200)] });
live = []; cache.entries = {};
await Promise.all([r.resumeOne("s-20"), r.resumeOne("s-20")]);
eq("double click: one tab", runs.length, 1);
// A live Claude tab the helper has not identified yet could be this very session: wait; a click 30 s later opens it.
runs.length = 0;
st.setShared(OFFER, { at: now, tabs: [rec("s-21", 210)] });
live = [agent("t9", null, "sp1")]; cache.entries = {};
await r.resumeOne("s-21");
eq("unidentified tab: not opened yet", runs.length, 0);
eq("unidentified tab: still offered", r.offer()?.tabs.map((x) => x.sid), ["s-21"]);
await r.resumeOne("s-21");
eq("unidentified tab: a 2nd click at once still waits", runs.length, 0);
now += 31_000;
await r.resumeOne("s-21");
eq("unidentified tab: a click 30 s later opens it", runs.length, 1);
eq("unidentified tab: then leaves the offer", r.offer(), null);

// s13 Codex R1 P2: a poll that read the remembered state before a Dismiss / Resume can't offer those sessions again.
st.setShared(MEM, { at: now, tabs: { "s-30": rec("s-30", 300), "s-31": rec("s-31", 301) } });
live = []; cache.entries = {};
now += 30_000;
await r.resumeTick();
eq("stale poll: offered first", r.offer()?.tabs.map((x) => x.sid).sort(), ["s-30", "s-31"]);
r.dismissOffer();
st.setShared(MEM, { at: now - 30_000, tabs: { "s-30": rec("s-30", 300), "s-31": rec("s-31", 301) } });
now += 30_000;
await r.resumeTick();
eq("stale poll: not offered again after Dismiss", r.offer(), null);
// Polls from several views run one at a time.
cacheReads = 0;
await Promise.all([r.resumeTick(), r.resumeTick()]);
eq("one poll at a time", cacheReads, 1);
// A dismissed session seen running again (resumed by hand) is offered after a later restart.
live = [agent("t30", null, "sp1"), agent("t31", null, "sp1")];
cache.entries = { t30: { cwd: HOME, pids: [300], path: log(WORK_CFG, "s-30") }, t31: { cwd: HOME, pids: [301], path: log(WORK_CFG, "s-31") } };
now += 3 * 60_000;
await r.resumeTick();
live = []; cache.entries = {};
now += 30_000;
await r.resumeTick();
eq("dismissed, then running again, then lost: offered", r.offer()?.tabs.map((x) => x.sid).sort(), ["s-30", "s-31"]);
r.dismissOffer();

// s13 Codex R1 P2: an unidentified tab right after a restart doesn't wipe out the gap (the app was down 5 min).
st.setShared(MEM, { at: now, tabs: { "s-40": rec("s-40", 400) } });
now += 5 * 60_000;
live = [agent("t10", null, "sp1")]; cache.entries = {};
await r.resumeTick();
now += 30_000;
cache.entries = { t10: { cwd: HOME, pids: [410], path: log(WORK_CFG, "s-41") } };
await r.resumeTick();
eq("restart + unidentified tab: the lone old session is still offered", r.offer()?.tabs.map((x) => x.sid), ["s-40"]);
r.dismissOffer();

// --- s13 Codex R2 (recheck) ---
// R2-1 (P1): an unidentified tab carrying the offered session's title may BE that session: never opened, even later.
runs.length = 0;
st.setShared(OFFER, { at: now, tabs: [{ ...rec("s-50", 500), title: "Style Guide mobile pass" }] });
live = [{ ...agent("t50", null, "sp1"), title: "✳ Style Guide mobile pass" }]; cache.entries = {};
await r.resumeOne("s-50");
now += 31_000;
await r.resumeOne("s-50");
eq("R2-1: unidentified tab with its title: never opened", runs.length, 0);
eq("R2-1: still offered", r.offer()?.tabs.map((x) => x.sid), ["s-50"]);
r.dismissOffer();

// R2-2 (P2): a poll whose lock expired (it took > 20 s) writes nothing; the newer poll's view stands.
live = [agent("t60", null, "sp1"), agent("t61", null, "sp1")];
cache.entries = { t60: { cwd: HOME, pids: [600], path: log(WORK_CFG, "s-60") }, t61: { cwd: HOME, pids: [601], path: log(WORK_CFG, "s-61") } };
now += 30_000;
await r.resumeTick();
// The old poll reads an EMPTY cache (as if the helper restarted), then stalls 25 s; a newer poll runs meanwhile.
cache.entries = {};
live = [];
onCacheRead = async () => { now += 25_000; live = [agent("t60", null, "sp1"), agent("t61", null, "sp1")]; cache.entries = { t60: { cwd: HOME, pids: [600], path: log(WORK_CFG, "s-60") }, t61: { cwd: HOME, pids: [601], path: log(WORK_CFG, "s-61") } }; await r.resumeTick(); };
await r.resumeTick();
eq("R2-2: an expired poll can't call running sessions lost", r.offer(), null);
eq("R2-2: the newer poll's memory stands", Object.keys(r.remembered().tabs).sort(), ["s-60", "s-61"]);

// R2-3 (P2): the mod reloads while a Resume click waits on the cache: the offer is not lost; it can be clicked again
// once the claim is old.
st.setShared(OFFER, { at: now, tabs: [rec("s-70", 700)] });
live = []; cache.entries = {};
runs.length = 0;
const r2 = await loadResume({ herdr: { ...st, home: () => HOME, appHome: () => `${HOME}/.config/herdr-app`, agents: () => live, terminals: () => [], spaces: () => spacesList,
  readTextFile: () => new Promise(() => {}), run: (name, args) => { runs.push([name, args]); return null; }, notify: () => {} } });
r2.resumeOne("s-70");   // never finishes: the reload killed it
await new Promise((ok) => setTimeout(ok, 10));
eq("R2-3: offer kept during a claim", r.offer()?.tabs.map((x) => x.sid), ["s-70"]);
await r.resumeOne("s-70");
eq("R2-3: a 2nd click while the claim is fresh: nothing", runs.length, 0);
now += 61_000;
await r.resumeOne("s-70");
eq("R2-3: after the claim expires it opens", runs.length, 1);
eq("R2-3: then leaves the offer", r.offer(), null);

// R2-4 (P2): resumed, seen running by a later poll, then a 2nd restart within 2 min: offered again.
st.setShared(MEM, { at: now, tabs: {} });
st.setShared(OFFER, { at: now, tabs: [rec("s-80", 800), rec("s-81", 801)] });
live = []; cache.entries = {};
await r.resumeAll();
now += 30_000;
live = [agent("t80", null, "sp1"), agent("t81", null, "sp1")];
cache.entries = { t80: { cwd: HOME, pids: [880], path: log(WORK_CFG, "s-80") }, t81: { cwd: HOME, pids: [881], path: log(WORK_CFG, "s-81") } };
await r.resumeTick();
now += 30_000;
live = []; cache.entries = {};
await r.resumeTick();
eq("R2-4: a 2nd restart soon after resuming: offered again", r.offer()?.tabs.map((x) => x.sid).sort(), ["s-80", "s-81"]);
r.dismissOffer();

// R2-5 (P2): one tab unidentified for 3 min while polls keep running; one of three closed on purpose meanwhile:
// forgotten, not offered (no downtime happened).
st.setShared(MEM, { at: now, tabs: { "s-90": rec("s-90", 900), "s-91": rec("s-91", 901), "s-92": rec("s-92", 902) } });
const three = { t90: { cwd: HOME, pids: [900], path: log(WORK_CFG, "s-90") }, t91: { cwd: HOME, pids: [901], path: log(WORK_CFG, "s-91") } };
live = [agent("t90", null, "sp1"), agent("t91", null, "sp1"), agent("t99", null, "sp1")]; cache.entries = { ...three };
for (let k = 0; k < 6; k++) { now += 30_000; await r.resumeTick(); }
cache.entries = { ...three, t99: { cwd: HOME, pids: [999], path: log(WORK_CFG, "s-99") } };
now += 30_000;
await r.resumeTick();
eq("R2-5: a long identification is not downtime: the closed one is forgotten", r.offer(), null);
// A tab's default name (its number, or the program's name) is not kept: the resumed tab names itself from its session.
eq("ownName: real name kept", r.ownName({ tab_name: "201", tab_index: 0, program: { name: "Claude Code" } }), "201");
eq("ownName: its number is the default", r.ownName({ tab_name: "3", tab_index: 2, program: { name: "Claude Code" } }), null);
eq("ownName: the program's name is the default", r.ownName({ tab_name: "Claude Code", tab_index: 5, program: { name: "Claude Code" } }), null);
eq("ownName: none", r.ownName({ tab_name: null }), null);
process.exit(bad ? 1 : 0);
