// Batch 1 items 1–5 + 7 (s13): ai.js's About tick and askHaiku run for real against fake shared state, terminals,
// exec and clock. Account routing from the screen being sent only; lock token + deadline; Rewrite on unsupported tabs;
// a second Rewrite asked during a run; a late success never lifts a newer pause; Summarize's account.
// Run: node test-aitick.mjs
import { MOD, WORK_DIR, CFG_ENV } from "./paths.mjs";
import { loadMod, fakeShared, realAccounts } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

let now = 1_800_000_000_000;
Date.now = () => now;
const R = "─".repeat(60);
const EMAIL = { WORK: "work@example.com", HOME: "me@example.com" };
const screen = (acct, body = "⏺ Working on the style guide.") => `${body}\n\n${R}\n❯ \n${R}\n  you:\\~/x | ${acct} ${EMAIL[acct]} | pipeline 0.1\n  Opus 5.5 | effort:high\n  ⏵⏵ auto mode on`;

// One world per case: its own store, tabs, screens and exec.
// accounts: the "accounts" setting (the default: WORK with its own config folder, and HOME without one).
const TWO = [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }, { mark: "HOME", name: "Personal account" }];
async function world({ tabs = [{ address: "t1", title: "Style guide" }], terms = [], screens = {}, store = {}, onExec = null, onRead = null, settings = {}, accounts = TWO } = {}) {
  const st = fakeShared(store), calls = [], argvs = [];
  const herdr = {
    ...st, home: () => "/Users/you", appHome: () => "/Users/you/.config/herdr-app",
    agents: () => tabs.map((t) => ({ status: "working", tab: "tb", ...t })), terminals: () => terms, spaces: () => [],
    hc: async (args) => { if (onRead) await onRead(args, st); const s = screens[args[1]]; return s == null ? { code: 1, stdout: "" } : { code: 0, stdout: s }; },
    exec: async (cmd, args) => {
      // The first env argument: the work account's own folder (its name ends "-work"), or "-u" (unset: the default folder).
      const acct = String(args[0]).includes("-work") ? "WORK" : args[0] === "-u" ? "HOME" : "?";
      calls.push(acct); argvs.push([cmd, args]);
      return onExec ? onExec(acct, st, ai) : { code: 0, stdout: "Line: Shoppers read the cart offline (#1838).\nMore: In review." };
    },
  };
  // The real config.js and accounts.js: the accounts come from the "accounts" setting like in the mod.
  const file = { about_cap: "none", ...settings, ...(accounts ? { accounts } : {}) };
  const { acc, cfg, set } = await realAccounts(herdr, file);
  const ai = await loadMod("ai.js", { herdr, "./config.js": cfg, "./accounts.js": acc, "./state.js": { sessionTopic: (a) => a.title } });
  return { ai, st, calls, argvs, herdr, setSetting: set };
}

// 1. Routing: only the account on the screen being sent counts.
{
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.ai.accounts": { t1: "HOME" } } });
  await w.ai.aboutTick({ soon: true });
  eq("routing: screen says WORK, cache said HOME → sent as WORK", w.calls, ["WORK"]);
  eq("routing: cache updated for display", w.st.data["flockbook.ai.accounts"].t1, "WORK");
}
{
  // Live 11-12: t10 remembered as HOME (paused till 1 am) while its screen shows WORK — must not stay "paused".
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.ai.accounts": { t1: "HOME" }, "flockbook.ai.cool": { HOME: { until: now + 3600_000, at: now - 1000, kind: "quota" } } } });
  await w.ai.aboutTick({ soon: true });
  eq("routing: remembered paused HOME never blocks a tab whose screen says WORK", w.calls, ["WORK"]);
}
{
  const quoted =screen("WORK", `⏺ The status line reads:\n  you:\\~ | HOME me@example.com | pipeline\n  and | HOME is the personal one.`);
  const w = await world({ screens: { t1: quoted } });
  await w.ai.aboutTick({ soon: true });
  eq("routing: quoted | HOME in output ignored", w.calls, ["WORK"]);
}
{
  const w = await world({ screens: { t1: "⏺ Bash(ls)\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No" }, store: { "flockbook.ai.accounts": { t1: "WORK" } } });
  await w.ai.aboutTick({ soon: true });
  eq("routing: no status line on screen → nothing sent (cache not used)", w.calls, []);
  eq("routing: says why", w.st.data["flockbook.about"]?.t1?.errorKind, "unknown-account");
}
{
  const w = await world();
  eq("accountOf: real WORK status line", w.ai.accountOf(screen("WORK")), "WORK");
  eq("accountOf: real HOME status line", w.ai.accountOf(screen("HOME")), "HOME");
  eq("accountOf: both on one line → null", w.ai.accountOf(`${R}\n❯ \n${R}\n  you:\\~ | WORK a@b | HOME c@d\n  Opus`), null);
  eq("accountOf: output only, no box → null", w.ai.accountOf("x | WORK a@b |\ny | HOME c@d"), null);
  eq("accountOf: box far above the bottom (a prompt below it) → null", w.ai.accountOf(screen("WORK") + "\n" + "  line\n".repeat(20)), null);
  eq("accountOf: typed | HOME in the box ignored", w.ai.accountOf(`${R}\n❯ check | HOME me@x\n${R}\n  you:\\~ | WORK a@b | p\n  Opus`), "WORK");
}

// 2. Lock: token + deadline.
{
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.about.busy": { at: now - 1000, token: "other" } } });
  await w.ai.aboutTick({ soon: true });
  eq("lock: another copy's fresh lock → no run", w.calls, []);
  eq("lock: its lock left alone", w.st.data["flockbook.about.busy"], { at: now - 1000, token: "other" });
}
{
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.about.busy": now - 1000 } });
  await w.ai.aboutTick({ soon: true });
  eq("lock: legacy number lock, fresh → no run", w.calls, []);
}
{
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.about.busy": { at: now - 151_000, token: "dead" } } });
  await w.ai.aboutTick({ soon: true });
  eq("lock: expired lock → runs", w.calls, ["WORK"]);
  eq("lock: released after", w.st.data["flockbook.about.busy"] ?? null, null);
}
{
  const w = await world({ screens: { t1: screen("WORK") }, onRead: async (_a, st) => { st.setShared("flockbook.about.busy", { at: now, token: "thief" }); } });
  await w.ai.aboutTick({ soon: true });
  eq("lock: taken over during the read → no call", w.calls, []);
  eq("lock: the other copy's lock kept", w.st.data["flockbook.about.busy"]?.token, "thief");
}
{
  const w = await world({ screens: { t1: screen("WORK") }, onRead: async () => { now += 101_000; } });
  await w.ai.aboutTick({ soon: true });
  eq("lock: read crossed the deadline → no call", w.calls, []);
  eq("lock: own lock released", w.st.data["flockbook.about.busy"] ?? null, null);
}
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = await world({ screens: { t1: screen("WORK") }, onRead: async () => { await gate; } });
  const a = w.ai.aboutTick({ soon: true });
  await w.ai.aboutTick({ soon: true });   // the 2 s timer firing while the first runs
  release(); await a;
  eq("lock: overlapping ticks → one call", w.calls, ["WORK"]);
}
{
  const w = await world();
  eq("lockFree: none", w.ai.lockFree(null, now), true);
  eq("lockFree: fresh", w.ai.lockFree({ at: now - 5000, token: "x" }, now), false);
  eq("lockFree: legacy fresh", w.ai.lockFree(now - 5000, now), false);
  eq("lockFree: expired", w.ai.lockFree({ at: now - 150_000, token: "x" }, now), true);
}

// 3. Rewrite on a tab the tick can't serve (another machine, a helper agent): dropped with a plain reason.
{
  const w = await world({ tabs: [{ address: "box/t7", title: "Remote" }, { address: "t9", title: "Helper" }], terms: [{ address: "t9", parent: "t1" }],
    screens: { "box/t7": screen("WORK"), t9: screen("WORK") }, store: { "flockbook.about.redo": { "box/t7": now - 10, t9: now - 10 } } });
  await w.ai.aboutTick({ soon: true });
  eq("unsupported: no call", w.calls, []);
  eq("unsupported: rewrite request dropped", w.st.data["flockbook.about.redo"] ?? {}, {});
  eq("unsupported: reason shown", /this Mac/.test(w.st.data["flockbook.about"]?.["box/t7"]?.error ?? ""), true);
  eq("aboutSupported", [w.ai.aboutSupported("t1"), w.ai.aboutSupported("box/t7"), w.ai.aboutSupported("t9"), w.ai.aboutSupported(null)], [true, false, false, false]);
}

// 4. A second Rewrite asked while the first runs is kept and served next.
{
  let once = true;
  const w = await world({ screens: { t1: screen("WORK") }, onExec: (_acct, _st, ai) => { if (once) { once = false; now += 5; ai.requestRewrite("t1"); } return { code: 0, stdout: "Line: A.\nMore: B." }; } });
  w.ai.requestRewrite("t1");
  await w.ai.aboutTick({ soon: true });
  eq("second rewrite: still queued after the first", Boolean(w.st.data["flockbook.about.redo"]?.t1), true);
  await w.ai.aboutTick({ soon: true });
  eq("second rewrite: served next", w.calls, ["WORK", "WORK"]);
  eq("second rewrite: then cleared", w.st.data["flockbook.about.redo"]?.t1 ?? null, null);
  const g1 = (w.ai.requestRewrite("t1"), w.st.data["flockbook.about.redo"].t1);
  w.ai.requestRewrite("t1");
  eq("requestRewrite: each request is newer", w.st.data["flockbook.about.redo"].t1 > g1, true);
}

// 5. A late success lifts only a pause older than its own start.
{
  const w = await world({ screens: { t1: screen("WORK") }, store: { "flockbook.ai.cool": { WORK: { until: now - 1, at: now - 3600_000, kind: "quota" } } } });
  await w.ai.aboutTick({ soon: true });
  eq("pause: expired older pause lifted by a success", w.st.data["flockbook.ai.cool"]?.WORK ?? null, null);
}
{
  const w = await world({ onExec: (_a, st) => { now += 1000; st.setShared("flockbook.ai.cool", { WORK: { until: now + 3600_000, at: now, kind: "quota" } }); return { code: 0, stdout: "ok" }; } });
  const r = await w.ai.askHaiku("s", "p", 1000, "WORK", "summary");
  eq("pause: call succeeded", r.text, "ok");
  eq("pause: newer pause kept", Boolean(w.st.data["flockbook.ai.cool"]?.WORK), true);
}

// Summarize: the account from the screen it sends; the remembered one never routes.
{
  const w = await world({ screens: { t1: "⏺ Bash(ls)\n  Do you want to proceed?" }, store: { "flockbook.ai.accounts": { t1: "WORK" } } });
  const sum = await loadMod("summary.js", { herdr: { ...w.herdr, props: () => ({ address: "t1" }), theme: () => ({}) }, "./ai.js": w.ai, "./state.js": { sessionTopic: (a) => a.title, agentName: () => "x", icon: () => "" } });
  const v = new sum.SummaryView(null);
  await v.ask({ notify() {} });
  eq("summary: no status line → nothing sent", w.calls, []);
  eq("summary: says why", /Couldn't tell which Claude account/.test(v.error ?? ""), true);
  w.herdr.hc = async () => ({ code: 0, stdout: screen("HOME") });
}
{
  const w = await world({ screens: { t1: screen("HOME") }, store: { "flockbook.ai.accounts": { t1: "WORK" } } });
  const sum = await loadMod("summary.js", { herdr: { ...w.herdr, props: () => ({ address: "t1" }), theme: () => ({}) }, "./ai.js": w.ai, "./state.js": { sessionTopic: (a) => a.title, agentName: () => "x", icon: () => "" } });
  const v = new sum.SummaryView(null);
  await v.ask({ notify() {} });
  eq("summary: sent as the screen's account (HOME), not the cache (WORK)", w.calls, ["HOME"]);
}
// s13 Codex R1 P2: tabs on an account at its daily cap must not eat every screen read, tick after tick.
{
  const tabs = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map((address) => ({ address, title: `Tab ${address}` }));
  const screens = Object.fromEntries(tabs.map((t) => [t.address, screen(t.address === "t7" ? "HOME" : "WORK")]));
  const w = await world({ tabs, screens, settings: { about_cap: "100" } });
  w.st.setShared("flockbook.ai.calls", { day: w.ai.callsToday().day, WORK: { about: 100 } });
  await w.ai.aboutTick({ soon: true });
  now += 61_000;
  await w.ai.aboutTick({ soon: true });
  eq("cap: a capped account's tabs don't starve the other account (HOME served by the 2nd tick)", w.calls, ["HOME"]);
}
// s13 Codex R1 P2: pausing automatic lines mid-tick stops the tick's later automatic calls; Rewrites go on.
{
  const w = await world({ tabs: [{ address: "t1", title: "One" }, { address: "t2", title: "Two" }], screens: { t1: screen("WORK"), t2: screen("WORK") },
    onExec: (acct, st, ai) => { ai.pauseAutoUntilTomorrow(); return { code: 0, stdout: "Line: Something.\nMore: x" }; } });
  await w.ai.aboutTick({ soon: true });
  eq("pause mid-tick: no further automatic call", w.calls, ["WORK"]);
}
{
  const w = await world({ tabs: [{ address: "t1", title: "One" }, { address: "t2", title: "Two" }], screens: { t1: screen("WORK"), t2: screen("WORK") },
    store: { "flockbook.about.redo": { t1: 1, t2: 1 } },
    onExec: (acct, st, ai) => { ai.pauseAutoUntilTomorrow(); return { code: 0, stdout: "Line: Something.\nMore: x" }; } });
  await w.ai.aboutTick({ soon: true });
  eq("pause mid-tick: Rewrites asked for still run", w.calls, ["WORK", "WORK"]);
}
// Accounts setting (plus build): one account, none, and a remembered account that is no longer set.
{
  const w = await world({ accounts: [{ mark: "WORK", name: "Work account", config_dir: WORK_DIR }], screens: { t1: "⏺ Bash(ls)\n  no status line here" } });
  await w.ai.aboutTick({ soon: true });
  eq("one account: sent without a status line, as that account", w.calls, ["WORK"]);
  eq("one account: remembered for display", w.st.data["flockbook.ai.accounts"].t1, "WORK");
  eq("one account: its config folder is expanded", w.argvs[0][1][0], CFG_ENV + "=/Users/you/" + WORK_DIR.slice(2));
}
{
  const w = await world({ accounts: null, screens: { t1: "⏺ Working\n  no status line here" } });
  await w.ai.aboutTick({ soon: true });
  eq("no accounts: the default account sends, default config folder", w.calls, ["HOME"]);
  eq("no accounts: remembered as default", w.st.data["flockbook.ai.accounts"].t1, "default");
  eq("no accounts: its name", w.ai.accountName("default"), "Your Claude account");
}
{
  const w = await world({ accounts: null, settings: { claude_path: "/opt/tools/claude" }, screens: { t1: "⏺ Working" } });
  await w.ai.aboutTick({ soon: true });
  eq("claude_path: the program is run by that path", w.argvs[0][1].includes("/opt/tools/claude"), true);
  eq("claude_path: no PATH search added", w.argvs[0][1].some((a) => a.startsWith("PATH=")), false);
}
{
  const w = await world({ accounts: null, screens: { t1: "⏺ Working" } });
  await w.ai.aboutTick({ soon: true });
  eq("no claude_path: env PATH carries the usual folders", w.argvs[0][1].some((a) => a.startsWith("PATH=/Users/you/.local/bin:")), true);
}
{
  const w = await world({ screens: {} });
  const r = await w.ai.askHaiku("s", "p", 1000, "GONE", "summary");
  eq("askHaiku: an id the accounts setting no longer has → unknown-account", r.kind, "unknown-account");
  eq("askHaiku: nothing run", w.calls, []);
}
{
  const w = await world({ screens: {} });
  const r = await w.ai.askHaiku("s", "p", 1000, "HOME", "summary");
  eq("askHaiku: personal account runs with the config folder cleared", [r.text.length > 0, w.argvs[0][1].slice(0, 2)], [true, ["-u", CFG_ENV]]);
}

// Wiring: the 2 s Rewrite timer uses the tick's lock test; Rewrite is offered only where the tick can serve it.
{
  const fs = await import("node:fs");
  const top = fs.readFileSync(MOD + "top.js", "utf8"), menu = fs.readFileSync(MOD + "menu.js", "utf8"), hover = fs.readFileSync(MOD + "hover.js", "utf8");
  eq("top.js: 2 s timer uses lockFree", /every\(2000[^\n]*lockFree\(shared\(KEY_BUSY\), Date\.now\(\)\)/.test(top), true);
  eq("menu.js: Rewrite row only when aboutSupported", /agent && aboutSupported\(agent\.address\) \? \{ label: "Rewrite About line"/.test(menu), true);
  eq("hover.js: Rewrite link only when aboutSupported", /!busy && aboutSupported\(addr\)/.test(hover), true);
}
process.exit(bad ? 1 : 0);
