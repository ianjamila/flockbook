// Tests that the question card's "Or type your own answer" box can be typed in (s12 bug: the row's
// on_key_down stopped every key, and a stopped key never reaches the text box as typed text).
import { MOD } from "./paths.mjs";
import fs from "node:fs";
const src = fs.readFileSync(MOD + "cards.js", "utf8");
let bad = 0;
const eq = (n, got, want) => { const ok = got === want; if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)}`); };

// 1. The own-answer row lets keys through to the box (no key handler that stops them).
const row = src.slice(src.indexOf("-other`)"), src.indexOf("box.child(sec)"));
eq("row found", row.length > 0 && row.length < 1500, true);
eq("row does not stop keys", /on_key_down\(\s*keep\s*\)/.test(row), false);
eq("row still keeps mouse presses", /on_mouse_down\("left", keep\)/.test(row), true);

// 2. The card's key handler leaves keys alone while the own-answer box has the keyboard.
const kd = src.slice(src.indexOf("  key_down(e, cx, address) {"), src.indexOf("  // Picks option"));
eq("key_down skips while the card lacks the keyboard (s13 F2: focus decides)", /if \(this\.focus \? !this\.focus\.is_focused\(\) : this\.typingIn !== null\)/.test(kd), true);
eq("box focus sets typingIn", /input\.on\("focus", \(\) => \{ this\.typingIn = qi; \}\)/.test(src), true);
eq("box blur clears typingIn", /input\.on\("blur", \(\) => \{ if \(this\.typingIn === qi\) this\.typingIn = null; \}\)/.test(src), true);
eq("Enter in the box acts like Enter on the card", /input\.on\("submit", \(e, cx\) => \{[^}]*this\.enter\(cx, this\.address\)/.test(src), true);

// 3. oneLine: an own answer stays on one line (a new line could not be typed into the terminal).
const a = src.indexOf("export function oneLine"), b = src.indexOf("\n}\n", a) + 3;
eq("oneLine found", a >= 0, true);
if (a >= 0) {
  const oneLine = new Function(src.slice(a, b).replace("export ", "") + "; return oneLine;")();
  eq("plain", oneLine("Olives Please"), "Olives Please");
  eq("trailing new line", oneLine("yes\n"), "yes");
  eq("inner new line", oneLine("a\nb"), "a b");
  eq("crlf + spaces", oneLine("a  \r\n  b"), "a b");
  eq("only new line", oneLine("\n"), "");
  eq("keeps inner double space", oneLine("a  b"), "a  b");
}
process.exit(bad ? 1 : 0);
