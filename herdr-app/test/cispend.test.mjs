// CI spending this month in the side bar, above the weekly usage (owner 11-15 s39: "github out of 300 dollars, ubicloud
// current usage"; Ubicloud: an estimate + in-use status + a link). Read from the Mac's spend.json (here, or on a
// connected machine); render calls nothing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { space } from "./fixtures.mjs";
import { SideView } from "../mods/flockbook/side.js";
import { KEY_MACHINES } from "../mods/flockbook/machines.js";
import { KEY_CONFIG } from "../mods/flockbook/config.js";
import { KEY_CISPEND, newestSpend, spendFigures, dayText, pollSpend, CISPEND_MS, SPEND_FILE } from "../mods/flockbook/cispend.js";

const NOW = new Date(2026, 10, 15, 14, 0).getTime();
const LINKS = { github: "https://github.com/enterprises/x/settings/billing", ubicloud: "https://console.ubicloud.com" };
const spend = (extra = {}) => ({
  v: 1, at: NOW - 60 * 60_000, month: "2026-11",
  github: { usedUsd: 242.64, includedUsd: 300, perDayUsd: 40.44, projectedExhaustion: "2026-11-16", action: "none", ubicloudConnected: true, at: NOW - 2 * 3600_000 },
  ubicloud: { listUsd: 1.39, creditUsd: 2.5, estUsd: 0, minutes: 1114, exact: false, counting: 0, labels: { "ubicloud-standard-2-ubuntu-2404": 1114 }, unknown: [], firstDay: "2026-11-01", lastAt: "2026-11-03T22:42:22Z", inUse: [] },
  links: LINKS, ...extra,
});
const src = (by) => ({ sources: Object.fromEntries(Object.entries(by).map(([k, data]) => [k, { asked: NOW, data }])) });

beforeEach(() => {
  reset();
  fake.props = undefined;
  fake.settings = { zoom: 1 };
  fake.window = { ...fake.window, platform: "macos" };
  fake.home = "/Users/test";
  fake.machines = [{ name: null, layout: "ready" }];
  fake.spaces = [space("sp1", { index: 1, name: "app" })];
  fake.shared[KEY_CONFIG] = { file: {} };
  fake.exec = () => ({ code: 127, stdout: "", stderr: "" });
  fake.readText = undefined;
});
const draw = () => { const cx = fakeCx(); return new SideView(cx).render(cx); };

test("the newest reading wins across this computer and connected machines; a bad file is ignored", () => {
  const d = src({ "": spend({ at: NOW - 3600_000 }), mac: spend({ at: NOW - 60_000 }), junk: { v: 2, at: NOW } });
  assert.equal(newestSpend(d).machine, "mac");
  assert.equal(newestSpend(src({})), null);
  assert.equal(newestSpend(null), null);
});

test("days read as calendar days", () => {
  assert.equal(dayText("2026-11-16"), "Mon 16 Nov");
  assert.equal(dayText("bad"), null);
});

test("GitHub: used of the $300 included, the pace and the day it runs out; coloured by what is left", () => {
  const f = spendFigures({ ...spend(), machine: "" }, NOW);
  assert.equal(f.github.right, "$242.64 of $300");
  assert.equal(f.github.used, 81);
  assert.equal(f.github.level, "warn", "19% left: amber");
  assert.equal(f.github.line, "~$40.44/day · runs out Mon 16 Nov");
  assert.match(f.github.tip, /\$242\.64 of the \$300\.00 included/);
  assert.match(f.github.tip, /click to open GitHub billing/);
  const over = spendFigures({ ...spend({ github: { ...spend().github, usedUsd: 312.5 } }), machine: "" }, NOW);
  assert.deepEqual([over.github.used, over.github.level, over.github.line], [100, "low", "$12.50 over"]);
});

test("Ubicloud: an estimate after the credit, in use or not, the minutes, and counting while it catches up", () => {
  let u = spendFigures({ ...spend(), machine: "" }, NOW).ubicloud;
  assert.equal(u.right, "$0 (credit)", "under the $2.50 credit");
  assert.equal(u.line, "not in use · CI on GitHub · 1,114 min this month");
  assert.match(u.tip, /estimate from GitHub's job records, \$1\.39 at list price, less its \$2\.50 monthly credit/);
  assert.match(u.tip, /since Sun 1 Nov/);
  assert.match(u.tip, /sampled/);
  u = spendFigures({ ...spend({ ubicloud: { ...spend().ubicloud, estUsd: 6.4, listUsd: 8.9, inUse: ["CHECKS", "DB"], counting: 3 } }), machine: "" }, NOW).ubicloud;
  assert.equal(u.right, "≈ $6.40");
  assert.equal(u.line, "in use now: checks, database jobs · counting… 3 days left");
  const g = spendFigures({ ...spend({ ubicloud: { ...spend().ubicloud, inUse: ["CHECKS"] } }), machine: "" }, NOW).github;
  assert.equal(g.line, "~$40.44/day · CI on Ubicloud now");
  assert.equal(spendFigures({ ...spend({ ubicloud: { ...spend().ubicloud, listUsd: 0, minutes: 0 } }), machine: "" }, NOW).ubicloud.right, "$0");
});

test("a reading older than a missed check says how old", () => {
  const f = spendFigures({ ...spend({ at: NOW - 5 * 3600_000 }), machine: "mac" }, NOW);
  assert.match(f.github.line, / · as of 5 h ago$/);
  assert.match(f.ubicloud.line, / · as of 5 h ago$/);
  assert.match(f.github.tip, /read 5 h ago on mac/);
});

test("the block sits above the weekly usage, below Settings; nothing without a reading", () => {
  let root = byId(draw(), "side-root");
  assert.equal(byId(root, "cispend"), null);
  fake.shared[KEY_CISPEND] = src({ "": spend() });
  const el = draw();
  root = byId(el, "side-root");
  const ids = root.kids.map((k) => k._a?.id);
  assert.deepEqual(ids.slice(-3), ["side-settings", "cispend", "usage"]);
  assert.match(textOf(byId(el, "cispend")), /CI spending this month/);
  assert.match(textOf(byId(el, "cispend-github")), /GitHub.*\$242\.64 of \$300/);
  assert.match(textOf(byId(el, "cispend-ubicloud")), /Ubicloud.*\$0 \(credit\)/);
});

test("a click opens GitHub billing or the Ubicloud console", () => {
  fake.shared[KEY_CISPEND] = src({ "": spend() });
  const el = draw();
  const opened = [];
  const cx = { ...fakeCx(), open_url: (u) => opened.push(u) };
  byId(el, "cispend-github")._h.on_click({}, cx);
  byId(el, "cispend-ubicloud")._h.on_click({}, cx);
  assert.deepEqual(opened, [LINKS.github, LINKS.ubicloud]);
});

test("render calls nothing", () => {
  fake.shared[KEY_CISPEND] = src({ "": spend() });
  const cx = fakeCx();
  const v = new SideView(cx);
  log.exec = [];
  log.reads = [];
  v.render(cx);
  v.render(cx);
  assert.equal(log.exec.length, 0, JSON.stringify(log.exec));
  assert.equal(log.reads.length, 0, JSON.stringify(log.reads));
});

test("polling: this Mac's file, then each connected machine's (its home asked once); every 5 min; a missing file keeps the last", async () => {
  fake.shared[KEY_MACHINES] = { at: NOW, list: [{ name: "mac", state: "connected" }, { name: "away", state: "asleep" }] };
  fake.exec = (cmd, _args, opts) => (cmd === "/bin/sh" && opts?.on === "mac" ? { code: 0, stdout: "/Users/mac" } : { code: 127, stdout: "", stderr: "" });
  const files = { [`/Users/test/${SPEND_FILE}`]: spend({ at: NOW - 3600_000 }), [`mac:/Users/mac/${SPEND_FILE}`]: spend({ at: NOW - 60_000 }) };
  fake.readText = (p, opts) => { const f = files[opts?.on ? `${opts.on}:${p}` : p]; return f ? JSON.stringify(f) : null; };
  await pollSpend(NOW);
  assert.deepEqual(log.reads.map(([p, o]) => `${o?.on ?? ""}:${p}`).sort(), [`:/Users/test/${SPEND_FILE}`, `mac:/Users/mac/${SPEND_FILE}`].sort(), "an asleep machine is not read");
  assert.equal(newestSpend(fake.shared[KEY_CISPEND]).machine, "mac");
  log.reads = [];
  await pollSpend(NOW + CISPEND_MS - 1000);
  assert.equal(log.reads.length, 0, "not due");
  delete files[`mac:/Users/mac/${SPEND_FILE}`];
  await pollSpend(NOW + CISPEND_MS);
  assert.equal(newestSpend(fake.shared[KEY_CISPEND]).machine, "mac", "the Mac's last reading stays");
});

test("polling on Windows: no file here, the Mac's is read over the link", async () => {
  fake.window = { ...fake.window, platform: "windows" };
  fake.shared[KEY_MACHINES] = { at: NOW, list: [{ name: "mac", state: "connected" }] };
  fake.exec = (cmd, _args, opts) => (cmd === "/bin/sh" && opts?.on === "mac" ? { code: 0, stdout: "/Users/mac" } : { code: 127, stdout: "", stderr: "" });
  fake.readText = (p, opts) => (opts?.on === "mac" ? JSON.stringify(spend()) : null);
  await pollSpend(NOW);
  assert.deepEqual(log.reads.map(([, o]) => o?.on ?? ""), ["mac"]);
  assert.equal(newestSpend(fake.shared[KEY_CISPEND]).machine, "mac");
});
