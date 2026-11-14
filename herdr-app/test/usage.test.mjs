// Weekly usage left at the bottom of the side bar (owner 11-15 s35): per Claude account (the "accounts" setting) and
// Codex, the freshest reading from this computer or any connected machine, polled by the mod and drawn from one shared
// key. Render calls no helper (s33: Herdr cuts off slow renders).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { space } from "./fixtures.mjs";
import { SideView } from "../mods/flockbook/side.js";
import { KEY_MACHINES } from "../mods/flockbook/machines.js";
import { KEY_CONFIG } from "../mods/flockbook/config.js";
import { KEY_USAGE, pollUsage, figures, rows, merge, readings, clock, USAGE_MS, USAGE_REMOTE_MS } from "../mods/flockbook/usage.js";

const NOW = new Date(2026, 10, 15, 14, 0).getTime();   // Sunday 15 Nov 2026, 14:00 local
const secs = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime() / 1000;
const PERSONAL = { mark: "HOME", name: "Personal account" };
const WORK = { mark: "WORK", name: "Work account", config_dir: "~/.claude-eaglewatch" };
const claude = (config, email, left, at, resets = secs(2026, 10, 22, 11, 53)) => ({ type: "usage", kind: "claude", config, email,
  weekly: { left, used: 100 - left, resets_at: resets }, at });
const codex = (left, at, resets = secs(2026, 10, 20, 9, 5)) => ({ type: "usage", kind: "codex", plan: "prolite", weekly: { left, used: 100 - left, resets_at: resets }, at });
const data = (sources) => ({ sources: Object.fromEntries(Object.entries(sources).map(([k, lines]) => [k, { asked: NOW, lines }])) });
const answer = (lines) => ({ code: 0, stdout: [{ type: "header", protocol: 1, sidecar: "0.1.0", cmd: "usage" }, ...lines, { type: "end", ok: true, ms: 1 }].map((l) => JSON.stringify(l)).join("\n"), stderr: "" });
const failure = (code) => answer([{ type: "error", code, message: code }]);

beforeEach(() => {
  reset();
  fake.props = undefined;
  fake.settings = { zoom: 1 };                           // dark (some tests switch to light)
  fake.home = "/home/test";
  fake.machines = [{ name: null, layout: "ready" }];
  fake.spaces = [space("sp1", { index: 1, name: "app" })];
  fake.shared[KEY_CONFIG] = { file: { accounts: [PERSONAL, WORK] } };
  fake.exec = () => ({ code: 127, stdout: "", stderr: "" });
});

const draw = (d) => {
  if (d) fake.shared[KEY_USAGE] = d;
  const cx = fakeCx();
  return new SideView(cx).render(cx);
};

test("the freshest reading wins across this computer and a connected machine", () => {
  // The same account (by email) on the Mac and the PC: the PC's reading is newer, so it is shown, and the tooltip names it.
  const el = draw(data({
    "": [claude("/home/test/.claude", "me@example.test", 50, NOW - 3_600_000)],
    "pc-wsl": [claude("/home/x/.claude", "me@example.test", 40, NOW - 60_000)],
  }));
  assert.match(textOf(byId(el, "usage-0-left")), /^40% left$/);
  assert.match(byId(el, "usage-0")._a.tooltip, /on pc-wsl/);
  // The older one is not mixed in; the same figure read at the same time: this computer's.
  const tie = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 40, NOW)], "pc-wsl": [claude("/home/x/.claude", "me@example.test", 40, NOW)] }));
  assert.match(textOf(byId(tie, "usage-0-left")), /^40% left$/);
  assert.match(byId(tie, "usage-0")._a.tooltip, /on this computer/);
  // Codex: one account, newest wins.
  const cx = draw(data({ "": [codex(70, NOW - 120_000)], "pc-wsl": [codex(65, NOW - 30_000)] }));
  assert.match(textOf(byId(cx, "usage-2-left")), /^65% left$/);
});

// s38 live: each session re-saves the figure from its own last reply, so a newer reading can be an idle session's
// old, higher "left" (PC 32% left read 52 s after the Mac's 20%). Within one week usage only goes up: the latest
// week's lowest "left" wins; a new week wins over the last one's figure; a few minutes' jitter is the same week.
test("within one week the lowest left wins, whichever machine read it last", () => {
  const stale = draw(data({
    "": [claude("/home/test/.claude", "me@example.test", 20, NOW - 60_000), codex(60, NOW - 60_000)],
    "pc-wsl": [claude("/home/x/.claude", "me@example.test", 32, NOW - 8_000), codex(74, NOW - 5_000)],
  }));
  assert.match(textOf(byId(stale, "usage-0-left")), /^20% left$/);
  assert.match(byId(stale, "usage-0")._a.tooltip, /on this computer/);
  assert.match(textOf(byId(stale, "usage-2-left")), /^60% left$/);
  // After the reset: the new week's 96% left wins over an idle session's 3% of the old week, read later.
  const fresh = draw(data({
    "": [claude("/home/test/.claude", "me@example.test", 96, NOW - 60_000, secs(2026, 10, 29, 11, 53))],
    "pc-wsl": [claude("/home/x/.claude", "me@example.test", 3, NOW - 1_000)],
  }));
  assert.match(textOf(byId(fresh, "usage-0-left")), /^96% left$/);
  // resets_at a few minutes apart is the same week.
  const jitter = draw(data({
    "": [claude("/home/test/.claude", "me@example.test", 30, NOW - 60_000, secs(2026, 10, 22, 11, 48))],
    "pc-wsl": [claude("/home/x/.claude", "me@example.test", 45, NOW - 1_000)],
  }));
  assert.match(textOf(byId(jitter, "usage-0-left")), /^30% left$/);
});

test("percent left, and a bar filled to what is left", () => {
  const el = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 36, NOW - 60_000)] }));
  assert.equal(textOf(byId(el, "usage-0-left")), "36% left");
  assert.equal(byId(el, "usage-0-fill")._a.w, "36%");
  assert.equal(textOf(byId(el, "usage-0-line")), `resets ${clock(secs(2026, 10, 22, 11, 53))}`);
  assert.equal(clock(secs(2026, 10, 15, 11, 53)), "Sun 11:53");
});

// Owner 11-15 s38 (screenshot): the Flockbook theme is black and white (its "warning" colour is white too), so a 2%
// bar looked like a 73% one. The bar and the "% left" take a level colour from the owner's VS Code palette: green from
// 40% left, amber from 15%, red under 15%; light mode takes the palette's darker shades. The product names are
// coloured too: Claude in its clay colour, Codex blue.
test("level colours: green, amber, red by what is left, in dark and light", () => {
  const at = (left) => draw(data({ "": [claude("/home/test/.claude", "me@example.test", left, NOW - 60_000)] }));
  const fill = (el) => byId(el, "usage-0-fill")._a.bg;
  const text = (el) => byId(el, "usage-0-left")._a.text_color;
  assert.equal(fill(at(73)), "#23d18b");
  assert.equal(fill(at(40)), "#23d18b", "40% is still green");
  assert.equal(fill(at(39)), "#f5f543");
  assert.equal(fill(at(15)), "#f5f543", "15% is still amber");
  assert.equal(fill(at(14)), "#f14c4c");
  assert.equal(fill(at(2)), "#f14c4c");
  assert.equal(text(at(2)), "#f14c4c", "the % left is in the level colour too");
  assert.equal(text(at(73)), "#23d18b");
  fake.settings = { zoom: 1, dark: false };
  assert.equal(fill(at(73)), "#00bc00");
  assert.equal(fill(at(20)), "#949800");
  assert.equal(fill(at(2)), "#cd3131");
});

test("product names are coloured: Claude clay, Codex blue (dark and light)", () => {
  const d = data({ "": [claude("/home/test/.claude", "me@example.test", 50, NOW - 60_000), codex(70, NOW - 60_000)] });
  const name = (el, i) => byId(el, `usage-${i}-name`);
  let el = draw(d);
  assert.equal(textOf(name(el, 0)), "Claude");
  assert.equal(name(el, 0)._a.text_color, "#d97757");
  assert.equal(textOf(name(el, 2)), "Codex");
  assert.equal(name(el, 2)._a.text_color, "#3b8eea");
  fake.settings = { zoom: 1, dark: false };
  el = draw(d);
  assert.equal(name(el, 0)._a.text_color, "#c15f3c");
  assert.equal(name(el, 2)._a.text_color, "#0451a5");
});

test("a reset time already past: 100% left and a line saying so", () => {
  const el = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 3, Date.now() - 7_200_000, Date.now() / 1000 - 600)] }));
  assert.equal(textOf(byId(el, "usage-0-left")), "100% left");
  assert.equal(byId(el, "usage-0-fill")._a.w, "100%");
  assert.equal(byId(el, "usage-0-fill")._a.bg, "#23d18b", "100% is green, not low");
  assert.equal(textOf(byId(el, "usage-0-line")), "reset since the last reading");
});

test("a reading older than 15 minutes says how old", () => {
  const f = (age) => figures({ kind: "claude", email: "a@b.test", reading: { ...claude("/c", "a@b.test", 36, NOW - age), machine: "" } }, NOW);
  assert.equal(f(14 * 60_000).line, `resets ${clock(secs(2026, 10, 22, 11, 53))}`);
  assert.equal(f(2 * 3_600_000).line, `resets ${clock(secs(2026, 10, 22, 11, 53))} · as of 2 h ago`);
  assert.match(f(20 * 60_000).line, /as of 20 min ago$/);
  assert.match(f(3 * 86_400_000).line, /as of 3 d ago$/);
  const el = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 36, Date.now() - 2 * 3_600_000)] }));
  assert.match(textOf(byId(el, "usage-0-line")), /· as of 2 h ago$/);
});

test("no reading: a dash and the reason, for the accounts that are set and for Codex", () => {
  const el = draw(data({}));
  for (const i of [0, 1]) {
    assert.equal(textOf(byId(el, `usage-${i}-left`)), "—");
    assert.equal(textOf(byId(el, `usage-${i}-line`)), "no Claude session has run with this account yet");
    assert.equal(byId(el, `usage-${i}-fill`), null, "no bar fill without a reading");
  }
  assert.equal(textOf(byId(el, "usage-2-left")), "—");
  assert.equal(textOf(byId(el, "usage-2-line")), "no Codex session found");
  // Before the first answer there is no key at all.
  const none = draw(null);
  assert.equal(textOf(byId(none, "usage-2-line")), "no Codex session found");
});

test("order: the accounts setting's order, then other Claude accounts found, then Codex", () => {
  fake.shared[KEY_CONFIG] = { file: { accounts: [WORK, PERSONAL] } };
  const el = draw(data({
    "": [claude("/home/test/.claude", "me@example.test", 10, NOW - 1000), claude("/home/test/.claude-eaglewatch", "work@example.test", 20, NOW - 1000),
      claude("/home/test/.claude-other", "other@example.test", 30, NOW - 1000), codex(40, NOW - 1000)],
  }));
  const lefts = [0, 1, 2, 3].map((i) => textOf(byId(el, `usage-${i}-left`)));
  assert.deepEqual(lefts, ["20% left", "10% left", "30% left", "40% left"]);
  assert.match(textOf(byId(el, "usage-0")), /work@example.test/);
  assert.match(textOf(byId(el, "usage-1")), /me@example.test/);
  assert.match(textOf(byId(el, "usage-2")), /other@example.test/);
  assert.equal(byId(el, "usage-4"), null);
  // A reading from the other machine matches the account by its folder's name when the paths differ.
  const r = rows(data({ "pc-wsl": [claude("/Users/x/.claude-eaglewatch", "work@example.test", 20, NOW)] }), [PERSONAL, WORK], "/home/test");
  assert.equal(r[1].reading.weekly.left, 20);
  assert.equal(r[0].reading, null);
  // One account only (no setting): that one, plus Codex.
  fake.shared[KEY_CONFIG] = { file: {} };
  const single = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 10, NOW - 1000)] }));
  assert.equal(textOf(byId(single, "usage-0-left")), "10% left");
  assert.equal(textOf(byId(single, "usage-1-line")), "no Codex session found");
});

// s36 review P3: a Windows reading's folder has backslashes; and a row's match by folder NAME must not take the
// reading another row matches by its exact folder.
test("matching: Windows folders match exactly, and exact matches go first for every row", () => {
  const WIN = { mark: "WIN", name: "PC account", config_dir: "C:\\Users\\x\\.claude-ew\\" };
  const w = rows(data({ "pc-wsl": [claude("C:\\Users\\x\\.claude-ew", "pc@example.test", 55, NOW)] }), [WIN], "C:\\Users\\x");
  assert.equal(w[0].email, "pc@example.test");
  assert.equal(w[0].folder.replace(/\\/g, "/"), "C:/Users/x/.claude-ew");
  // PERSONAL (~/.claude here) has no reading of its own; another machine's reading sits at a folder also named .claude
  // but belongs to the account whose exact folder is listed second: it must stay with that row.
  const SECOND = { mark: "PC", name: "PC Claude", config_dir: "/mnt/c/Users/x/.claude" };
  const r = rows(data({ "pc-wsl": [claude("/mnt/c/Users/x/.claude", "pc@example.test", 44, NOW)] }), [PERSONAL, SECOND], "/home/test");
  assert.equal(r[1].email, "pc@example.test", JSON.stringify(r));
  assert.equal(r[0].reading, null, JSON.stringify(r));
});

test("the block is the last thing in the side bar and the tooltip tells the details", () => {
  const el = draw(data({ "": [claude("/home/test/.claude", "me@example.test", 36, Date.now() - 60_000)] }));
  const root = byId(el, "side-root");
  assert.equal(root.kids.at(-1)._a.id, "usage", "at the bottom, below Settings");
  assert.ok(root.kids.at(-2)._a.id === "side-settings");
  const tip = byId(el, "usage-0")._a.tooltip;
  assert.match(tip, /me@example\.test/);
  assert.match(tip, /64% of the weekly limit used/);
  assert.match(tip, /resets Sun 2026-11-22 11:53/);
  assert.match(tip, /read 1 min ago on this computer/);
  assert.match(textOf(byId(el, "usage-0")), /Claude/);
  assert.match(textOf(byId(el, "usage-0")), /Weekly/);
});

test("render calls no helper and reads the shared key once", () => {
  fake.shared[KEY_USAGE] = data({ "": [claude("/home/test/.claude", "me@example.test", 36, NOW)], "pc-wsl": [codex(60, NOW)] });
  const store = fake.shared;
  let reads = 0;
  fake.shared = new Proxy(store, { get: (t, k) => { if (k === KEY_USAGE) reads++; return t[k]; } });
  const cx = fakeCx();
  const v = new SideView(cx);
  log.exec = [];
  reads = 0;
  v.render(cx);
  assert.equal(log.exec.length, 0, "no exec during render");
  assert.equal(reads, 1, "the shared key is read once per render");
  v.render(cx);
  assert.equal(log.exec.length, 0);
});

test("polling: this computer every 60 s, each connected machine every 120 s, a missing helper quietly skipped", async () => {
  fake.shared[KEY_MACHINES] = { at: NOW, list: [{ name: "pc-wsl", state: "connected" }, { name: "old-box", state: "connected" }, { name: "asleep", state: "asleep" }] };
  const asked = [];
  fake.exec = (_cmd, args) => {
    asked.push(args.filter((a) => a !== "--home" && !a.startsWith("/")).join(" "));
    if (args.includes("pc-wsl")) return answer([claude("/home/x/.claude", "me@example.test", 33, NOW)]);
    if (args.includes("old-box")) return failure("remote_helper_missing");
    return answer([codex(80, NOW)]);
  };
  await pollUsage(NOW);
  assert.deepEqual(asked.sort(), ["usage", "usage --machine old-box --cache", "usage --machine pc-wsl --cache"].sort(), "a machine that is not connected is not asked");
  assert.equal(readings(fake.shared[KEY_USAGE]).length, 2);
  assert.deepEqual(fake.shared[KEY_USAGE].sources["old-box"].lines, [], "a helper that is missing there gives no readings");
  // Not due: nothing more is asked.
  asked.length = 0;
  await pollUsage(NOW + USAGE_MS - 1000);
  assert.deepEqual(asked, []);
  // 60 s on: this computer only (the machines wait for 120 s).
  await pollUsage(NOW + USAGE_MS);
  assert.deepEqual(asked, ["usage"]);
  asked.length = 0;
  await pollUsage(NOW + USAGE_REMOTE_MS);
  assert.equal(asked.length, 3, "after 120 s: this computer and both machines again");
});

test("polling: a dropped link keeps the last readings; a failed local helper is no crash", async () => {
  fake.shared[KEY_USAGE] = data({ "pc-wsl": [codex(60, NOW)] });
  fake.shared[KEY_MACHINES] = { at: NOW, list: [{ name: "pc-wsl", state: "connected" }] };
  fake.exec = (_cmd, args) => (args.includes("pc-wsl") ? failure("remote_failed") : { code: 127, stdout: "", stderr: "" });
  await pollUsage(NOW + USAGE_REMOTE_MS);
  assert.equal(readings(fake.shared[KEY_USAGE]).length, 1, "the PC's last reading stays");
});

test("merge: Claude by email, a reading without one by its folder's name", () => {
  const m = merge(readings(data({ "": [claude("/a/.claude", "A@x.test", 10, 1), claude("/b/.claude-w", null, 20, 1)], "pc": [claude("/c/.claude", "a@x.test", 30, 2), claude("/d/.claude-w", null, 40, 3)] })));
  assert.equal(m.claude.length, 2);
  // One account each (same week): the lowest "left" of its readings, not the newest (s38).
  assert.equal(m.claude.find((x) => x.email).reading.weekly.left, 10);
  assert.equal(m.claude.find((x) => !x.email).reading.weekly.left, 20);
  assert.deepEqual([...m.claude.find((x) => x.email).configs].sort(), ["/a/.claude", "/c/.claude"]);
});
