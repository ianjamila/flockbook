// Tests for tabs.js (the tab list on the right): rowParts and headText. Run: node test-tablist.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const DIR = MOD;
const src = fs.readFileSync(DIR + "tabs.js", "utf8");
const pure = src.slice(src.indexOf("// <pure>"), src.indexOf("// </pure>")).replaceAll("export ", "");
const R = new Function(pure + "; return { rowParts, headText, stripGlyphs };")();
let bad = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const SS = { glyphs: "🔍", hint: "🔍 Codex review", tip: "Codex review running." };
eq("plain tab: label, no second line, ⌘ hint", R.rowParts({ label: "Fix login", ss: null, title: "Fix login", need: null, index: 2 }),
  { text: "Fix login", sub: null, tip: "Fix login — ⌘2", bell: false, key: "⌘2" });
eq("background work: words on the second line, name as is", R.rowParts({ label: "Fix login", ss: SS, title: "Fix login", need: null, index: 1 }).sub, "🔍 Codex review");
eq("background work: the name keeps no symbols", R.rowParts({ label: "Fix login", ss: SS, title: "Fix login", need: null, index: 1 }).text, "Fix login");
eq("tooltip: title, background work, need, key", R.rowParts({ label: "A", ss: SS, title: "Session topic", need: "merge", index: 3 }).tip,
  "Session topic — Codex review running. — Needs you: waits for your merge. — ⌘3");
eq("question → bell", R.rowParts({ label: "A", ss: null, title: null, need: "question", index: 1 }).bell, true);
eq("unknown need kind: generic words", R.rowParts({ label: "A", ss: null, title: null, need: "other", index: 12 }).tip, "A — Needs you: waits for you.");
eq("tab 10+: no ⌘ hint", R.rowParts({ label: "A", ss: null, title: null, need: null, index: 10 }).key, null);
eq("tab 9: ⌘9", R.rowParts({ label: "A", ss: null, title: null, need: null, index: 9 }).key, "⌘9");
eq("no index: no hint", R.rowParts({ label: "zsh", ss: null, title: null, need: null }).key, null);
eq("empty hint: no second line", R.rowParts({ label: "A", ss: { hint: "", tip: "" }, title: null, need: null, index: 1 }).sub, null);
eq("second line: the name drops its leading symbols", R.rowParts({ label: "🛠️🔀 Webshop auto-close", ss: SS, title: null, need: null, index: 2 }).text, "Webshop auto-close");
eq("no second line: the name keeps its symbols", R.rowParts({ label: "🟣 Fable review", ss: null, title: null, need: null, index: 2 }).text, "🟣 Fable review");
eq("stripGlyphs: keeps a leading #", R.stripGlyphs("✅🔀 #1841 stats"), "#1841 stats");
eq("stripGlyphs: all symbols → kept as is", R.stripGlyphs("✅"), "✅");
eq("head: space and count", R.headText("webshop", 7), "webshop · 7");
eq("head: no space", R.headText(undefined, 0), "Tabs · 0");
// s9: the reply's ask keeps its symbol in front of the name (🔁 extra round, 🔀 merge).
const RS = { hint: "🔁 extra round #1838 · ✅ results waiting", tip: "x", askGlyph: "🔁" };
eq("round ask: 🔁 before the bare name", R.rowParts({ label: "✅ Style Guide", ss: RS, title: "✅ Style Guide", need: "round", index: 1 }).text, "🔁 Style Guide");
eq("round ask: bell", R.rowParts({ label: "✅ Style Guide", ss: RS, title: "✅ Style Guide", need: "round", index: 1 }).bell, true);
eq("merge ask, name already has 🔀: once", R.rowParts({ label: "🔀 PR 5", ss: { hint: "🔀 ready to merge #5", tip: "x", askGlyph: "🔀" }, title: "🔀 PR 5", need: "merge", index: 1 }).text, "🔀 PR 5");
process.exit(bad ? 1 : 0);
