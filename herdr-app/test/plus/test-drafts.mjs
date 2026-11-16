// Tests for composer.js draftsToKeep (s9, 11-12): unsent reply text is kept in shared state so a rebuilt chat
// (a mod reload, a layout change) doesn't start with an empty box. Run: node test-drafts.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "composer.js", "utf8");
const i = src.indexOf("// <drafts>"), j = src.indexOf("// </drafts>");
const draftsToKeep = new Function(src.slice(i, j).replaceAll("export ", "") + "; return draftsToKeep;")();

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

eq("shown box kept", draftsToKeep(new Map(), "t1", "half a reply", []), { t1: { text: "half a reply", files: [] } });
eq("others kept with the shown one", draftsToKeep(new Map([["t2", { text: "other", files: [] }]]), "t1", "mine", []),
  { t2: { text: "other", files: [] }, t1: { text: "mine", files: [] } });
eq("sent (empty box) drops the shown one", draftsToKeep(new Map([["t1", { text: "old", files: [] }]]), "t1", "", []), {});
eq("spaces only count as empty", draftsToKeep(new Map(), "t1", "   \n", []), {});
eq("files alone are a draft", draftsToKeep(new Map(), "t1", "", ["/tmp/a.png"]), { t1: { text: "", files: ["/tmp/a.png"] } });
eq("empty others left out", draftsToKeep(new Map([["t2", { text: " ", files: [] }]]), null, "", []), {});
eq("no shown agent keeps the others", draftsToKeep(new Map([["t2", { text: "x", files: [] }]]), null, "", []), { t2: { text: "x", files: [] } });
// s10: a rebuilt box takes the cursor back when the old one had it (composer.js refocusWanted, <refocus> markers).
const ra = src.indexOf("// <refocus>"), rb = src.indexOf("// </refocus>");
const refocusWanted = new Function("BLUR_GRACE_MS", src.slice(ra, rb).replace("export ", "") + "; return refocusWanted;")(2000);
eq("focused box: refocus", refocusWanted({ on: true, at: 0 }, 99_999), true);
eq("blur as the old box went away: refocus", refocusWanted({ on: false, at: 10_000 }, 11_000), true);
eq("blurred long ago (owner clicked elsewhere): no", refocusWanted({ on: false, at: 10_000 }, 20_000), false);
eq("never focused: no", refocusWanted(null, 5), false);
process.exit(bad ? 1 : 0);
