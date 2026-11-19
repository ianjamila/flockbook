// Alerts (alerts.js, owner 11-19): the per-kind ping switches (~/.claude/notify-<kind>, Herdr's sounds) and the toast view
// that names the task. Each test names the failure it catches.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space } from "./fixtures.mjs";
import { setAlert, loadAlerts, alertOn, agentNote, ToastView, SILENT, KEY_LAST } from "../mods/flockbook/alerts.js";
import { viewName } from "../mods/flockbook/main.js";
import { SettingsView } from "../mods/flockbook/settings.js";
import { loadConfig } from "../mods/flockbook/config.js";

const FLAG = (k) => `/home/test/.claude/notify-${k}`;
const SETTINGS = "/home/test/.config/herdr-app/settings.json";
// A small file system: reads see writes; a write against a stale snapshot is refused, as Herdr does.
let files;
beforeEach(() => {
  reset();
  files = { [SETTINGS]: JSON.stringify({ zoom: 1, sounds: { enabled: true }, font_ligatures: false }, null, 2) + "\n" };
  fake.readText = (p) => files[p] ?? null;
  fake.writeText = (p, text, expected) => {
    if ((files[p] ?? null) !== expected) throw new Error("stale");
    files[p] = text; return null;
  };
  fake.spaces = [space("sp1", { name: "eaglewatch" })];
  fake.agents = [agent("t7", "done", { title: "✳ Fix roster import", tab_name: "Claude Code" })];
});
const herdr = () => JSON.parse(files[SETTINGS]);

// Catches: the switch not reaching Herdr's sound (it would still ding), or the write clobbering the person's other settings.
test("finished off: ~/.claude/notify-finished says off, Herdr's done sound goes silent, other settings kept; on puts it back", async () => {
  assert.equal(await setAlert("finished", false), true);
  assert.equal(files[FLAG("finished")], "off\n");
  assert.equal(alertOn("finished"), false);
  assert.equal(alertOn("needed"), true);
  assert.deepEqual(herdr(), { zoom: 1, sounds: { enabled: true, done: SILENT }, font_ligatures: false });
  await setAlert("finished", true);
  assert.equal(files[FLAG("finished")], "on\n");
  assert.deepEqual(herdr(), { zoom: 1, sounds: { enabled: true }, font_ligatures: false });
});

// Catches: turning a kind off and on losing the person's own sound file.
test("a sound file of the person's own is kept aside while its kind is off and comes back", async () => {
  files[SETTINGS] = JSON.stringify({ sounds: { blocked: "sounds/ping.mp3" } });
  await setAlert("needed", false);
  assert.equal(herdr().sounds.blocked, SILENT);
  await setAlert("needed", true);
  assert.equal(herdr().sounds.blocked, "sounds/ping.mp3");
});

// Catches: `cnotify finished off` (the terminal switch) not silencing Herdr, or the dialog showing the wrong state.
test("loadAlerts: a ~/.claude file written by cnotify is read, and Herdr's sound follows it", async () => {
  files[FLAG("needed")] = "off\n";
  await loadAlerts();
  assert.equal(alertOn("needed"), false);
  assert.equal(herdr().sounds.blocked, SILENT);
  assert.equal(herdr().sounds.done, undefined);
});

// Catches: a broken settings.json being overwritten.
test("a settings.json that is not JSON is left alone", async () => {
  files[SETTINGS] = "{ not json";
  await setAlert("finished", false);
  assert.equal(files[SETTINGS], "{ not json");
  assert.equal(files[FLAG("finished")], "off\n");
});

const note = (extra = {}) => ({ title: "Claude Code finished", body: "", level: "success", action: { name: "agent.focus", args: { terminal: "t7" } }, overlay: "ov1", ...extra });

// Catches: the vague "Claude Code finished" note (owner 11-19).
test("toast: Herdr's agent note names the task and its workspace; a click still goes to the agent", () => {
  fake.props = note();
  const el = new ToastView(fakeCx()).render(fakeCx());
  assert.equal(textOf(byId(el, "toast-title")), "Finished · Fix roster import");
  assert.equal(textOf(byId(el, "toast-body")), "eaglewatch");
  byId(el, "toast")._h.on_click({}, fakeCx());
  assert.deepEqual(log.run.at(-1), ["agent.focus", { terminal: "t7" }]);
  assert.deepEqual(log.closed, ["ov1"]);
  assert.equal(fake.shared[KEY_LAST].at(-1).title, "Claude Code finished", "what Herdr sent is kept for checks");
});

test("toast: a needs-you note says so", () => {
  fake.agents = [agent("t7", "blocked", { title: "Merge #2345" })];
  fake.props = note({ title: "Claude Code needs you", level: "error" });
  assert.equal(textOf(byId(new ToastView(fakeCx()).render(fakeCx()), "toast-title")), "Needs you · Merge #2345");
});

// Catches: a switched-off kind still showing its corner note, or the switch hiding other notes (Flockbook's own, errors).
test("toast: a kind that is off closes its note at once; other kinds and other notes still show", async () => {
  await setAlert("finished", false);
  fake.props = note();
  new ToastView(fakeCx());
  assert.deepEqual(log.closed, ["ov1"]);
  log.closed = [];
  fake.agents = [agent("t7", "blocked", { title: "Merge #2345" })];
  fake.props = note({ title: "Claude Code needs you", overlay: "ov2" });
  new ToastView(fakeCx());
  assert.equal(log.closed.length, 0, "needs-you still shows");
  await setAlert("needed", false);
  fake.props = { title: "Chat text: Large", level: "info", overlay: "ov3" };
  const el = new ToastView(fakeCx()).render(fakeCx());
  assert.equal(log.closed.length, 0);
  assert.equal(textOf(byId(el, "toast-title")), "Chat text: Large");
});

test("toast: an agent that is gone keeps Herdr's own words", () => {
  fake.agents = [];
  fake.props = note();
  assert.equal(textOf(byId(new ToastView(fakeCx()).render(fakeCx()), "toast-title")), "Claude Code finished");
  assert.equal(agentNote({ title: "Saved", overlay: "x" }), null);
});

// Catches: the layout's "toast": "flockbook" opening an "unknown view" box instead of the note.
test("main: a note's props (no view) pick the toast view; a block's view is kept", () => {
  assert.equal(viewName({ title: "Claude Code finished", overlay: "o" }), "toast");
  assert.equal(viewName({ view: "side" }), "side");
  assert.equal(viewName({}), undefined);
});

// Catches: the switches missing from the dialog, or a click not reaching the file.
test("settings dialog: Alerts holds both switches; Off writes ~/.claude/notify-needed", async () => {
  await loadConfig();
  const v = new SettingsView(fakeCx()); v.section = "alerts";
  const el = v.render(fakeCx());
  assert.match(textOf(byId(el, "set-alert_needed")), /An agent needs you/);
  assert.match(textOf(byId(el, "set-alert_finished")), /An agent finishes/);
  assert.equal(byId(el, "set-alert_needed-on")._a.bg, "#selected");
  byId(el, "set-alert_needed-off")._h.on_click({}, fakeCx());
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(files[FLAG("needed")], "off\n");
  assert.equal(byId(v.render(fakeCx()), "set-alert_needed-off")._a.bg, "#selected");
});
