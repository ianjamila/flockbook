// Tests for asks.js handoffGiven (a finished session whose last reply gave a hand-off / re-entry prompt) and the
// Overview's "Hand-off given" sub-group (state.js overlays/subStatus). Run: node test-handoff.mjs
import { MOD, FIXDIR } from "./paths.mjs";
import fs from "node:fs";
const FIX = FIXDIR;
const src = fs.readFileSync(MOD + "asks.js", "utf8");
const a = src.indexOf("const RULE"), b = src.indexOf("const CHECK_MS");
const { handoffGiven, pendingAsk } = new Function("shared", src.slice(a, b).replaceAll("export ", "") + "; return { handoffGiven, pendingAsk };")(() => null);
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)}`); };
const R = "─".repeat(60), stat = "  you:\\~ | HOME x\n  Opus 5.5";
const box = (typed = "") => `${R}\n❯ ${typed}\n${R}\n${stat}`;

// Real screens (11-12): "yes, clear" + "Re-entry prompt:"; a compacted tab whose recap names the re-entry prompt;
// a tab with no hand-off.
eq("real: yes, clear + re-entry prompt", handoffGiven(fs.readFileSync(FIX + "handoff-yes-clear.txt", "utf8")), true);
eq("real: recap after compaction", handoffGiven(fs.readFileSync(FIX + "handoff-recap.txt", "utf8")), true);
eq("real: no hand-off", handoffGiven(fs.readFileSync(FIX + "handoff-none.txt", "utf8")), false);
eq("real hand-off is not an ask", pendingAsk(fs.readFileSync(FIX + "handoff-yes-clear.txt", "utf8")), null);

eq("Yes, clear. (capital, wrapped)", handoffGiven(`  Done.\n\n  Yes,\n  clear. The next phase is long.\n\n${box()}`), true);
eq("safe to /clear", handoffGiven(`  It's safe to /clear now. Paste this into the fresh session:\n  ▎ continue X\n\n${box()}`), true);
eq("start a fresh session with", handoffGiven(`  Next: start a fresh session with my re-entry prompt.\n\n${box()}`), true);
eq("typed /handoff in the box is not a hand-off", handoffGiven(`  All done, merged.\n\n${box("/handoff")}`), false);
eq("plain finished reply", handoffGiven(`  Fixed the bug; tests pass.\n\n${box()}`), false);
eq("an older turn's hand-off above a newer prompt does not count", handoffGiven(`  yes, clear. Re-entry prompt:\n  ▎ x\n❯ keep going here\n\n  Sure, done.\n\n${box()}`), false);
eq("no input box on screen", handoffGiven("  yes, clear. Re-entry prompt:"), false);
eq("'in a fresh session' alone is not enough", handoffGiven(`  In a fresh session, combine main into the branch.\n\n${box()}`), false);

// The Overview sub-group: state.js overlays with a stubbed handoffOf.
const st = fs.readFileSync(MOD + "state.js", "utf8");
eq("state imports handoffOf", /import \{[^}]*\bhandoffOf\b[^}]*\} from "\.\/asks\.js"/.test(st), true);
eq("Hand-off given sub-group ranks above Merging and results", (() => {
  const i = st.indexOf('["handoff", "Hand-off given"]'), m = st.indexOf('["merging", "Merging"]'), r = st.indexOf('["results", "Review results waiting"]');
  return i > 0 && i < m && i < r;
})(), true);
eq("hand-off only when no agent or wait (CI, review, merge) runs behind the turn", /if \(a && a\.status !== "working" && a\.status !== "blocked" && !b\?\.agents && !out\.some\(\(o\) => o\.wait\) && handoffOf\(a\.address\)\)/.test(st), true);
eq("hand-off waits on the owner", /o\.group === "handoff"/.test(st.slice(st.indexOf("owner:"), st.indexOf("owner:") + 200)), true);
process.exit(bad ? 1 : 0);
