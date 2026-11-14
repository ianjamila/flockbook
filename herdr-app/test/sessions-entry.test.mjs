// The ways into the Resume sessions dialog (sessions.js): the key command, the sidebar row, the Overview's link (with and
// without a resume offer), and main.js routing props.view "sessions" to it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fake, log, reset } from "./stub/herdr.mjs";
import { byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { agent, space } from "./fixtures.mjs";
import { command } from "../mods/flockbook/top.js";
import { SideView } from "../mods/flockbook/side.js";
import { OverviewView } from "../mods/flockbook/overview.js";
import { KEY_OFFER } from "../mods/flockbook/resume.js";
import { KEY_SESSIONS, SESSIONS_W } from "../mods/flockbook/state.js";

beforeEach(() => {
  reset();
  fake.spaces = [space("sp1", { name: "app", tabs: [] })];
  fake.agents = [agent("t1", "working")];
});

const opened = () => log.overlays.filter((o) => o.props?.view === "sessions");

test("the key command flockbook.sessions opens the dialog; again replaces the open one", () => {
  command("sessions");
  assert.deepEqual(opened().map((o) => [o.kind, o.width]), [["dialog", SESSIONS_W]]);
  assert.equal(fake.shared[KEY_SESSIONS], "o1");
  command("sessions");
  assert.deepEqual(log.closed, ["o1"], "the open one is closed first");
  assert.equal(opened().length, 2);
});

test("the sidebar has a Resume sessions row", () => {
  byId(new SideView(fakeCx()).render(fakeCx()), "side-sessions")._h.on_click({}, fakeCx());
  assert.equal(opened().length, 1);
});

test("the Overview links to it, with no resume offer and with one", () => {
  const without = new OverviewView(fakeCx()).render(fakeCx());
  assert.equal(byId(without, "ov-resume"), null);
  byId(without, "ov-sessions")._h.on_click({}, fakeCx());
  assert.equal(opened().length, 1);
  fake.shared[KEY_OFFER] = { at: 1, tabs: [{ sid: "s1", account: "default", cwd: "/home/test", title: "Cart fix", spaceName: "app" }] };
  const withOffer = new OverviewView(fakeCx()).render(fakeCx());
  byId(withOffer, "ov-resume-sessions")._h.on_click({}, fakeCx());
  assert.equal(opened().length, 2);
  assert.ok(byId(withOffer, "ov-sessions"), "the always-there link stays too");
});

test("the keys file binds a free combo to it, and main.js routes the view", () => {
  const keys = JSON.parse(readFileSync(new URL("../keys.json", import.meta.url), "utf8"))["layout:flockbook"];
  assert.equal(keys["cmd-shift-r"], "flockbook.sessions");
  assert.equal(Object.values(keys).filter((v) => v === "flockbook.sessions").length, 1);
  assert.match(readFileSync(new URL("../mods/flockbook/main.js", import.meta.url), "utf8"), /sessions: SessionsView/);
});
