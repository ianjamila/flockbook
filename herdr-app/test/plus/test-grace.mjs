// Tests for state.js blockedPast (a blocked agent counts for Needs you only after BLOCK_GRACE_MS). Run: node test-grace.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "state.js", "utf8");
const pure = src.slice(src.indexOf("// <grace>"), src.indexOf("// </grace>")).replaceAll("export ", "");
const R = new Function(pure + "; return { blockedPast, BLOCK_GRACE_MS };")();
let bad = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const G = R.BLOCK_GRACE_MS;
const ag = (address, status) => ({ address, status });
const seen = {};
eq("just blocked: not yet", [...R.blockedPast(seen, [ag("t1f", "blocked")], 1000)], []);
eq("first sighting noted", seen, { t1f: 1000 });
eq("a moment later (auto mode still checking): not yet", [...R.blockedPast(seen, [ag("t1f", "blocked")], 1000 + G - 1)], []);
eq("past the grace: counts", [...R.blockedPast(seen, [ag("t1f", "blocked")], 1000 + G)], ["t1f"]);
eq("settled (working again): forgotten", (R.blockedPast(seen, [ag("t1f", "working")], 1000 + G + 5), seen), {});
eq("blocked again later: a new grace", [...R.blockedPast(seen, [ag("t1f", "blocked")], 50_000)], []);
eq("two agents: each its own clock", [...R.blockedPast({ a: 0 }, [ag("a", "blocked"), ag("b", "blocked")], G)], ["a"]);
eq("gone agent: dropped", (() => { const s = { gone: 1 }; R.blockedPast(s, [], 5); return s; })(), {});
eq("grace is 10 s", G, 10_000);
process.exit(bad ? 1 : 0);
