// Batch 1 item 6 (s13): the question card's keys vs its own-answer box, run on the real Cards class with fakes.
// F2: card shortcuts are gated on the card's own focus (is_focused), not on the typingIn flag (a missed blur left
// it stuck); F3: Escape in the box hands the keyboard back to the card without sending or clearing; hydration sets
// the address BEFORE filling the boxes (set_value fires "change", which wrote into the previous tab's answer);
// Enter in the box sends exactly once. Run: node test-cardkeys.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

let owner = "card";   // who has the keyboard: "card" or "box<qi>"
const boxes = [];
const TextareaState = { new: () => {
  const qi = boxes.length, h = {};
  const b = { v: "", on: (ev, fn) => { h[ev] = fn; return true; }, value: () => b.v,
    set_value: (v) => { b.v = String(v); h.change?.({}, cx); },
    focus: () => { owner = `box${qi}`; h.focus?.({}, cx); }, fire: (ev, e = {}) => h[ev]?.(e, cx) };
  boxes.push(b); return b;
} };
const handle = { focus: () => { const was = owner; owner = "card"; if (was.startsWith("box")) boxes[Number(was.slice(3))]?.fire("blur"); }, is_focused: () => owner === "card" };
const cx = { focus_handle: () => handle, notify() {}, spawn: (fn) => fn(cx), stop_propagation() {} };
const m = await loadMod("cards.js", { "gpui-base": { TextareaState, Textarea: { new: () => ({}) } } });
const c = new m.Cards(cx);
let sent = 0;
c.answer = () => { sent++; };
const q = { questions: [{ question: "Pick", options: [{ label: "a" }, { label: "b" }] }] };
const e1 = c.entry("t1"); e1.card = { kind: "question", request: "r1", question: q, unread: 0 };
c.hydrate("t1");

// Box has the keyboard: digits and Enter go to the box, not the card.
boxes[0].focus();
eq("box focused: digit left to the box", c.key_down({ key: "1" }, cx, "t1"), false);
eq("box focused: no pick made", e1.picks.get(0)?.size ?? 0, 0);
eq("box focused: Enter key left to the box", c.key_down({ key: "enter" }, cx, "t1"), false);
// Typing, then Enter in the box (submit): sends once.
boxes[0].v = "my own"; boxes[0].fire("change");
boxes[0].fire("submit", {});
c.key_down({ key: "enter" }, cx, "t1");   // the same Enter reaching the card's handler too
eq("Enter in the box sends exactly once", sent, 1);
// Escape in the box: keyboard back to the card, nothing sent, text kept.
sent = 0; boxes[0].focus();
eq("Escape in the box is taken", c.key_down({ key: "escape" }, cx, "t1"), true);
eq("Escape: card has the keyboard", owner, "card");
eq("Escape: nothing sent", sent, 0);
eq("Escape: text kept", [boxes[0].v, e1.others.get(0)], ["my own", "my own"]);
// A stale typingIn (blur never came) must not block the card's own keys (F2).
c.typingIn = 0; owner = "card";
eq("stale typingIn: digit picks on the focused card", c.key_down({ key: "2" }, cx, "t1"), true);
eq("stale typingIn: pick made", [...(e1.picks.get(0) ?? [])], [1]);

// Hydration: switching to t2's card fills the boxes with t2's text and leaves t1's answer alone.
const e2 = c.entry("t2"); e2.card = { kind: "question", request: "r2", question: q, unread: 0 };
e2.others.set(0, "two");
c.hydrate("t2");
eq("hydrate: box shows t2's text", boxes[0].v, "two");
eq("hydrate: t1's answer untouched", e1.others.get(0), "my own");
eq("hydrate: t2's answer kept", e2.others.get(0), "two");
c.hydrate("t1");
eq("hydrate back: box shows t1's text", boxes[0].v, "my own");
eq("hydrate back: t2 untouched", e2.others.get(0), "two");
process.exit(bad ? 1 : 0);
