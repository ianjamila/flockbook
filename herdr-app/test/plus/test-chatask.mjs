// Tests for the one-click grant of a round / merge ask (asks.js grantAsk/askWords), shared by Needs you's buttons and
// the chat's ask strip (owner 11-13 16:12: "theres no button here" — the strip over the chat's reply box only said to
// type the words). Run: node test-chatask.mjs
import { loadMod, fakeShared } from "./loadmod.mjs";

let bad = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const RULE = "─".repeat(60);
const screen = (last, recap = false) => [
  "❯ do the thing",
  "⏺ Two fixes applied, recheck done.",
  `  ${last}`,
  "",
  ...(recap ? ["※ recap: Two fixes went in and the recheck passed; it now waits for you to type \"extra round\"", "  to grant round 3 on #99999. (disable recaps in /config)", ""] : []),
  "✻ Worked for 2s · done 4:07 PM",
  RULE, "❯ ", RULE, "  you:~/webshop | WORK",
].join("\n");
const ROUND = "🔁 Extra review round needed #99999: round 3 · items abc123 · repo demo-org/demo-repo";
const MERGE = "🔀 Ready to merge #4242 — say \"merge\"";

async function setup({ shown, sendResult = { lines: [{ type: "done", result: "sent" }] }, readCode = 0 }) {
  const st = fakeShared({ "flockbook.asks": { t9: { kind: "round", pr: 99999, round: 3 } } });
  const sent = [];
  const m = await loadMod("asks.js", {
    herdr: { ...st, hc: async (args) => (args[0] === "read" ? { code: readCode, stdout: shown } : { code: 1, stdout: "" }) },
    "./sidecar.js": { send: async (t, words) => { sent.push([t, words]); return sendResult; } },
    "./config.js": { setting: () => "on" },
  });
  return { m, st, sent };
}

{
  const { m } = await setup({ shown: "" });
  eq("words for a round", m.askWords({ kind: "round", pr: 1, round: 2 }), "extra round");
  eq("words for a merge", m.askWords({ kind: "merge", pr: 1 }), "merge");
  eq("no words for a migration (the owner types its go)", m.askWords({ kind: "migration", pr: 1 }), null);
  eq("no words for nothing", m.askWords(null), null);
  // The strip's hint offers the button now, not "type it yourself: the pipeline only counts your own words".
  eq("round hint names the button", /Extra round/.test(m.askMark({ kind: "round", pr: 1, round: 2 }).hint), true);
  eq("merge hint names the button", /Merge/.test(m.askMark({ kind: "merge", pr: 1 }).hint), true);
}
{
  const ask = { kind: "round", pr: 99999, round: 3 };
  const { m, st, sent } = await setup({ shown: screen(ROUND, true) });
  const r = await m.grantAsk("t9", ask);
  eq("still asks (under a recap) → sends the owner's words", sent, [["t9", "extra round"]]);
  eq("sent note", r, { text: "Sent “extra round”.", bad: false, sent: true });
  eq("answered: the ask leaves at once", st.data["flockbook.asks"].t9, undefined);
  eq("answered: remembered", Boolean(st.data["flockbook.asks.answered"]?.t9), true);
}
{
  const ask = { kind: "round", pr: 99999, round: 3 };
  const { m, sent, st } = await setup({ shown: screen("🔁 Extra review round needed #99999: round 4 · items x · repo demo-org/demo-repo") });
  const r = await m.grantAsk("t9", ask);
  eq("a newer round on screen → nothing sent", sent, []);
  eq("not-sent note", r.bad && r.sent === false && /no longer ends with this ask/.test(r.text), true);
  eq("not answered", Boolean(st.data["flockbook.asks"].t9), true);
}
{
  const ask = { kind: "merge", pr: 4242 };
  const { m, sent } = await setup({ shown: screen(MERGE), sendResult: { lines: [{ type: "done", result: "unconfirmed" }] } });
  const r = await m.grantAsk("t9", ask);
  eq("merge → sends merge", sent, [["t9", "merge"]]);
  eq("unconfirmed note", r, { text: "Sent “merge”. The agent did not confirm it yet.", bad: false, sent: true });
}
{
  const ask = { kind: "merge", pr: 4242 };
  const { m } = await setup({ shown: screen(MERGE), sendResult: { error: { message: "box has text" }, lines: [] } });
  const r = await m.grantAsk("t9", ask);
  eq("send error → its message, bad", r, { text: "box has text", bad: true, sent: false });
}
{
  const { m, sent } = await setup({ shown: screen(MERGE), readCode: 1 });
  const r = await m.grantAsk("t9", { kind: "merge", pr: 4242 });
  eq("screen unreadable → nothing sent", [sent.length, r.sent], [0, false]);
}
{
  const { m, sent } = await setup({ shown: screen(MERGE) });
  const r = await m.grantAsk("t9", { kind: "migration", pr: 4242 });
  eq("a migration go is never sent by a button", [sent.length, r.sent], [0, false]);
}
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
