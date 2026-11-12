// Owner 11-12 17:28 ("this should be done already it finished merging"): a reply's "Also worth considering" list is
// optional suggestions — a 'say "merge #12" when you want it in' there is not an ask. asks.js pendingAsk.
// Run: node test-worthconsidering.mjs
import { FIXDIR } from "./paths.mjs";
import fs from "node:fs";
import { loadMod, fakeShared } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const asks = await loadMod("asks.js", { herdr: { ...fakeShared(), agents: () => [], home: () => "/Users/you", appHome: () => "/x" } });
const R = "─".repeat(60), box = `${R}\n❯ \n${R}\n  you:\\~ | WORK e@x | p\n  Opus`;
eq("real t24: suggestion under Also worth considering is no ask", asks.pendingAsk(fs.readFileSync(FIXDIR + "reply-worth-considering-t24.txt", "utf8")), null);
eq("worth-considering question is no ask", asks.pendingAsk(`  Done.\n\n  Also worth considering\n  - Dark mode: want it next?\n\n${box}`), null);
eq("heading with a blank line before its list", asks.pendingAsk(`  Also worth considering:\n\n  - Say "go" to add it.\n\n${box}`), null);
// s13 Codex R1 P2: the heading starts the reply (carries Claude Code's ⏺ marker).
eq("heading with the reply marker", asks.pendingAsk(`⏺ Also worth considering\n  - Say "go" to add dark mode.\n\n${box}`), null);
eq("heading with the reply marker, list after a blank line", asks.pendingAsk(`⏺ Also worth considering:\n\n  - Say "go" to add dark mode.\n\n${box}`), null);
eq("a real ask in the last paragraph still counts", asks.pendingAsk(`  All set. Reply "go" to apply it.\n\n${box}`), { kind: "reply", words: ["go"], text: `All set. Reply "go" to apply it.` });
eq("a real question still counts", asks.pendingAsk(`  Also worth considering\n  - Dark mode.\n\n  Should I start with the export?\n\n${box}`), { kind: "question", text: "Should I start with the export?" });
eq("merge marker after the list still counts", asks.pendingAsk(`  Also worth considering\n  - Say "merge #12" for the wallboard.\n\n  🔀 Ready to merge #316 — say "merge"\n\n${box}`), { kind: "merge", pr: 316 });
process.exit(bad ? 1 : 0);
