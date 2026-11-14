// Tests for cards.js elicitation(): an MCP server's "requests your input" box read off the screen (s9, 11-12).
// The screens are modelled on Claude Code's dialog (title 'MCP server “<name>” requests your input', the message,
// then Accept / Decline); no real capture was available. Run: node test-elicit.mjs
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "asks.js", "utf8");   // moved from cards.js in s10
const i = src.indexOf("// <elicitation>"), j = src.indexOf("// </elicitation>");
const { elicitation, elicitFocus } = new Function(src.slice(i, j).replaceAll("export ", "") + "; return { elicitation, elicitFocus: typeof elicitFocus === \"function\" ? elicitFocus : () => \"missing\" };")();

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const RULE = "─".repeat(60);
const supabase = [
  "⏺ Running the migration check",
  "",
  RULE,
  " MCP server “supabase” requests your input",
  "",
  " This tool performs destructive operations on the database.",
  " Run it on project webshop-prod?",
  "",
  " ❯ Accept    Decline",
  "",
  " Esc to cancel · ↑↓ to navigate",
].join("\n");
eq("supabase: server + text", elicitation(supabase), { server: "supabase", text: "This tool performs destructive operations on the database. Run it on project webshop-prod?" });

const stacked = [
  "╭" + "─".repeat(40) + "╮",
  "│ MCP server “github” requests your input │",
  "│ Pick a repo                             │",
  "│ ❯ Accept                                │",
  "│   Decline                               │",
  "╰" + "─".repeat(40) + "╯",
].join("\n");
eq("boxed, buttons stacked", elicitation(stacked), { server: "github", text: "Pick a repo" });

const cut = " MCP server “supa…” requests your input\n Go on?\n ❯ Accept   Decline";
eq("cut name", elicitation(cut)?.server, "supa…");

eq("no dialog", elicitation("⏺ Done.\n" + RULE + "\n❯ \n" + RULE), null);
eq("title but no buttons yet (still drawing)", elicitation(" MCP server “x” requests your input\n Loading"), null);
eq("moved on: prompt box after it", elicitation(supabase + "\n" + RULE + "\n❯ next prompt\n" + RULE), null);
eq("empty", elicitation(""), null);
eq("words 'Accept' in the message don't count without Decline", elicitation(" MCP server “x” requests your input\n Accept the terms\n more"), null);

// s27: which button the terminal has selected (Accept / Decline buttons on the card press only when it is right).
eq("focus: Accept selected, side by side", elicitFocus(supabase), "accept");
eq("focus: Decline selected, side by side", elicitFocus(supabase.replace(" ❯ Accept    Decline", "   Accept  ❯ Decline")), "decline");
eq("focus: stacked, Accept", elicitFocus(stacked), "accept");
eq("focus: stacked, Decline", elicitFocus(stacked.replace("│ ❯ Accept ", "│   Accept ").replace("│   Decline ", "│ ❯ Decline ")), "decline");
eq("focus: no marker", elicitFocus(" MCP server “x” requests your input\n Go on?\n Accept   Decline"), null);
eq("focus: no dialog", elicitFocus("⏺ Done."), null);
eq("focus: a ❯ in the message is not the selection", elicitFocus(" MCP server “x” requests your input\n ❯ Accept the risk?\n   Accept  ❯ Decline"), "decline");
process.exit(bad ? 1 : 0);
