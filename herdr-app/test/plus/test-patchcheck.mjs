// Tests for patchcheck.js due/verdict (the "update replaced the patched helper" warning).
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "patchcheck.js", "utf8");
const a = src.indexOf("const EVERY_MS"), b = src.indexOf("export async function checkHelperPatch");
const { due, verdict, patchedFrom, missingFrom, MARKS } = new Function(src.slice(a, b).replaceAll("export ", "") + "; return { due, verdict, patchedFrom, missingFrom, MARKS };")();
let bad = 0;
const eq = (n, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${got}`); };
const now = 1_000_000_000;
eq("first check due", due(undefined, now), true);
eq("5 min later not due", due({ at: now - 5 * 60_000 }, now), false);
eq("10 min later due", due({ at: now - 10 * 60_000 }, now), true);
eq("patched: no warning", verdict({}, "4946512 1762850100", true), null);
eq("official: warn", verdict({}, "4800000 1762900000", false), "warn");
eq("same file warned once", verdict({ warned: "4800000 1762900000" }, "4800000 1762900000", false), null);
eq("another official file warns again", verdict({ warned: "4800000 1762900000" }, "4900000 1763000000", false), "warn");
eq("unreadable: no verdict", verdict({}, "1 2", null), null);
eq("no stat: no warning", verdict({}, null, false), null);
eq("two marks", MARKS.length, 2);
eq("both marks found → patched", patchedFrom([0, 0]), true);
eq("PR 2 mark missing (PR #12-only build) → not patched", patchedFrom([0, 1]), false);
eq("both missing (official) → not patched", patchedFrom([1, 1]), false);
eq("one unreadable → no verdict", patchedFrom([0, 2]), null);
eq("no codes → no verdict", patchedFrom([]), null);
eq("missing names the PR 2 fix", missingFrom([0, 1]).join("|"), MARKS[1].fix);
eq("missing names both", missingFrom([1, 1]).length, 2);
eq("PR #12-only helper warns", verdict({}, "4800000 1762900000", patchedFrom([0, 1])), "warn");

// s15: the whole check against fakes — it warns only once this machine has run a patched helper (everPatched), so
// someone who kept the official helper is never told to rebuild it.
const { loadMod, fakeShared } = await import("./loadmod.mjs");
const st = fakeShared(), notes = [];
let helper = { size: "4800000 1762900000", grep: [1, 1] };   // official
const exec = async (cmd) => (cmd.endsWith("stat") ? { code: 0, stdout: helper.size } : { code: helper.grep.shift() ?? 2 });
const run = async (h, at) => { helper = { ...h, grep: [...h.grep] }; await pc.checkHelperPatch(at); };
const pc = await loadMod("patchcheck.js", {
  herdr: { ...st, exec, notify: (n) => notes.push(n) },
  "./sidecar.js": { sidecarPath: () => "/x/flockbook-modfeed" },
  "./config.js": { setting: () => null },
});
const OFFICIAL = { size: "4800000 1762900000", grep: [1, 1] }, PATCHED = { size: "4946512 1762850100", grep: [0, 0] }, NEWER = { size: "4900000 1763000000", grep: [1, 1] };
let t = now;
await run(OFFICIAL, t);
eq("gate: official helper, never patched → no warning", notes.length, 0);
eq("gate: state notes not patched", st.data["flockbook.patchcheck"].everPatched, false);
t += 11 * 60_000; await run(PATCHED, t);
eq("gate: patched helper seen → no warning", notes.length, 0);
eq("gate: everPatched kept", st.data["flockbook.patchcheck"].everPatched, true);
t += 11 * 60_000; await run(NEWER, t);
eq("gate: official over a patched one → warns", notes.length, 1);
eq("gate: warning names the default rebuild command", notes[0]?.body.includes(pc.REBUILD), true);
t += 11 * 60_000; await run(NEWER, t);
eq("gate: same file not warned twice", notes.length, 1);
t += 60_000; await run({ size: "1 1", grep: [1, 1] }, t);
eq("gate: not due within 10 min", st.data["flockbook.patchcheck"].file, NEWER.size);
process.exit(bad ? 1 : 0);
