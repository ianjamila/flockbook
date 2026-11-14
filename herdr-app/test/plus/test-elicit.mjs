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
eq("supabase: server + text", elicitation(supabase), { server: "supabase", text: "This tool performs destructive operations on the database. Run it on project webshop-prod?", full: "This tool performs destructive operations on the database. Run it on project webshop-prod?" });

const stacked = [
  "╭" + "─".repeat(40) + "╮",
  "│ MCP server “github” requests your input │",
  "│ Pick a repo                             │",
  "│ ❯ Accept                                │",
  "│   Decline                               │",
  "╰" + "─".repeat(40) + "╯",
].join("\n");
eq("boxed, buttons stacked", elicitation(stacked), { server: "github", text: "Pick a repo", full: "Pick a repo" });

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
// s28 (Codex R1 P1): a message line that looks like a selected button ("❯ Decline") is not the selection; only the
// control rows nearest the footer count, and two ❯ markers there (or a second Accept / Decline) mean "can't tell".
const msgDecline = " MCP server “x” requests your input\n Options were:\n ❯ Decline\n\n ❯ Accept    Decline\n\n Esc to cancel";
eq("focus: a message line '❯ Decline' above the controls → accept", elicitFocus(msgDecline), "accept");
eq("text keeps that message line", elicitation(msgDecline)?.text, "Options were: ❯ Decline");
eq("focus: two markers in the control rows → null", elicitFocus(" MCP server “x” requests your input\n Go on?\n ❯ Accept  ❯ Decline"), null);
const adjacent = "│ MCP server “x” requests your input │\n│ Go on? │\n│ ❯ Decline │\n│   Accept │\n│   Decline │";
eq("focus: a button-like message line right above stacked buttons → null (two Declines)", elicitFocus(adjacent), null);
// s28 (Codex R1 P1): the whole request, not a 1200-char cut, is what a press compares.
const long = "x".repeat(1300);
const longScreen = (tail) => ` MCP server “supabase” requests your input\n ${long} ${tail}\n ❯ Accept    Decline`;
eq("full text kept past 1200 chars", elicitation(longScreen("project A"))?.full?.endsWith("project A"), true);
eq("display text still cut", elicitation(longScreen("project A"))?.text.length <= 1200, true);
// s28 (Codex R2 P1): a long request (more than 60 lines) whose message holds a button-like line: the real controls
// below are still found (the whole screen is searched), and controls followed by anything but the dialog's footer
// (keys hints, blank or box lines) can't be trusted: no answer from the card.
const longMsg = [" MCP server “x” requests your input", ...Array.from({ length: 30 }, (_, i) => ` line ${i}`), " Accept ❯ Decline",
  ...Array.from({ length: 40 }, (_, i) => ` more ${i}`), "", " ❯ Accept    Decline", "", " Esc to cancel · ↑↓ to navigate"].join("\n");
eq("focus: long request, button-like message line → the real controls (accept)", elicitFocus(longMsg), "accept");
eq("long request: its text runs to the real controls", elicitation(longMsg)?.full.endsWith("more 39"), true);
eq("controls followed by other text → not trusted", elicitFocus(" MCP server “x” requests your input\n Go?\n ❯ Accept    Decline\n Some other words here"), null);
eq("…and no card text either", elicitation(" MCP server “x” requests your input\n Go?\n ❯ Accept    Decline\n Some other words here"), null);
process.exit(bad ? 1 : 0);
