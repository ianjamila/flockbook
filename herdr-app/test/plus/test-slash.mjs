import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "composer.js", "utf8");
const start = src.indexOf("// A box edge"), end = src.indexOf("export const SUGGESTION_NOTE");
const { suggestedSlash, boxOneLine } = new Function(src.slice(start, end).replaceAll("export function", "function") + "; return { suggestedSlash, boxOneLine };")();
const E = "─".repeat(100), T = "──────────── Herdr flockbook polish ─";
const stat = "  you:\\~ | HOME x\n  Haiku 5.5";
const slash = [
  ["dim suggestion /clear", `older text\n\n${E}\n❯ /clear\n${E}\n${stat}`, "/clear"],
  ["typed /cl with list", `  ❯ /clear        Start a new session with empty context\n    /claude-api   Build apps\n${E}\n❯ /cl\n${E}\n${stat}`, null],
  ["placeholder Try", `${E}\n❯ Try "create a util logging.py that..."\n${E}\n${stat}`, null],
  ["empty box", `${E}\n❯ \n${E}\n${stat}`, null],
  ["title border + /compact", `x\n${T}\n❯ /compact\n${E}\n${stat}`, "/compact"],
  ["typed with argument", `${E}\n❯ /model opus\n${E}\n${stat}`, null],
  ["two-line box", `${E}\n❯ /clear\n  more text\n${E}\n${stat}`, null],
  ["no box", `just text`, null],
  ["plugin command list above", `    /claude-md-management:revise-claude-md        (claude-md-management) Update\n${E}\n❯ /cla\n${E}\n${stat}`, null],
];
const one = [
  ["empty", `${E}\n❯ \n${E}\n${stat}`, true],
  ["placeholder", `${E}\n❯ Try "x"\n${E}\n${stat}`, true],
  ["suggestion left", `${E}\n❯ /clear\n${E}\n${stat}`, true],
  ["typed second line left", `${E}\n❯ \n  second line\n${E}\n${stat}`, false],
  ["no box", "x", false],
];
let bad = 0;
for (const [name, screen, want] of slash) { const got = suggestedSlash(screen); if (got !== want) bad++; console.log(got === want ? "PASS" : "FAIL", "suggestedSlash", name, "→", got); }
for (const [name, screen, want] of one) { const got = boxOneLine(screen); if (got !== want) bad++; console.log(got === want ? "PASS" : "FAIL", "boxOneLine", name, "→", got); }
process.exit(bad ? 1 : 0);
