// s41 (owner 11-16: "when adding a new terminal … what account for claude since i have 2 accounts"): Herdr's + menu
// names a new tab after the menu entry, so a tab started from "Claude Code (Work)" (programs.json launcher) is named
// that. Like a tab named just "Claude Code", it counts as nobody-named: its label follows the session's topic.
// Run: node test-launch-name.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const st = fs.readFileSync(MOD + "state.js", "utf8");
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`missing ${a}`); return s.slice(i, j); };
const body = cut(st, "export function agentName", "// Claude Code's own working")
  + "\n" + cut(st, "export function autoNamed", "// Double-click on a tab");
const { agentName, autoNamed } = new Function("sessionTitle", "tabAgents",
  body.replaceAll("export ", "") + "; return { agentName, autoNamed };")((a) => a.title ?? null, () => []);

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const a = (tab_name, title = "Fix login bug") => ({ tab_name, title, program: { name: "Claude Code" } });
eq("program name: follows the topic", agentName(a("Claude Code")), "Fix login bug");
eq("launcher variant (Work): follows the topic", agentName(a("Claude Code (Work)")), "Fix login bug");
eq("launcher variant (Personal): follows the topic", agentName(a("Claude Code (Personal)")), "Fix login bug");
eq("a name someone gave stays", agentName(a("201 report")), "201 report");
eq("another program's variant stays", agentName(a("Codex (Work)")), "Codex (Work)");
eq("nested brackets are a real name", agentName(a("Claude Code (Work (old))")), "Claude Code (Work (old))");
eq("trailing words after the variant are a real name", agentName(a("Claude Code (Work) notes")), "Claude Code (Work) notes");

const tab = (name) => ({ named: true, name });
const ag = { program: { name: "Claude Code" } };
eq("autoNamed: program name", autoNamed(tab("Claude Code"), ag), true);
eq("autoNamed: launcher variant", autoNamed(tab("Claude Code (Work)"), ag), true);
eq("autoNamed: real name", autoNamed(tab("201 report"), ag), false);
eq("autoNamed: unnamed", autoNamed({ named: false, name: "1" }, ag), true);
process.exit(bad ? 1 : 0);
