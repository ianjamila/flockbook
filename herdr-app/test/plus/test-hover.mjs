// Tests for hover.js's pure parts (s11, 11-12): plain-word helpers, the helpers heading, the Needs you words.
// Run: node test-hover.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "hover.js", "utf8");
const i = src.indexOf("// <hover-pure>"), j = src.indexOf("// </hover-pure>");
const { plainHelper, helpersHead, needText } = new Function(src.slice(i, j).replaceAll("export ", "") + "; return { plainHelper, helpersHead, needText };")();

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

eq("implementer + file name", plainHelper("implementer: Wiring editor state into TerritoryClient.tsx"), "Builder: wiring editor state into the code");
eq("two files fold", plainHelper("verifier: Checking a.ts and b.sql"), "Checker: checking the code");
eq("plugin prefix", plainHelper("feature-dev:code-reviewer: Reading the diff"), "Reviewer: reading the diff");
eq("unknown kind kept", plainHelper("my-agent: Doing things"), "My agent: doing things");
eq("no colon", plainHelper("something"), "something");
eq("heading one", helpersHead(["implementer: x"]), "1 helper working (builder)");
eq("heading two, roles once", helpersHead(["implementer: x", "implementer: y", "judge: z"]), "3 helpers working (builder, review judge)");
eq("heading none", helpersHead([]), null);
eq("need: MCP", needText("question", null, "linear"), "MCP “linear” asks for input. Answer it in the tab's terminal.");
eq("need: question", needText("question", null, null), "It waits for your answer or approval.");
eq("need: merge", needText("merge", "🔀 Merge #1838", null), "🔀 Merge #1838.");
eq("need: none", needText(null, null, null), null);
process.exit(bad ? 1 : 0);
