// Other machines in the sidebar (owner 11-14: "why cant i see my PC here i already connected it to herdr"): once a
// machine other than this computer is known (a space there, `hc machine ls`, or Herdr's machines()), the workspaces sit
// under a header per machine, as Herdr's own sidebar draws them: a fold chevron, "+" for a new workspace there, a
// row for a machine with none yet (or still loading), its state when it isn't connected, the login command, and
// Connect for one that was rebuilt.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, log, reset } from "./stub/herdr.mjs";
import { textOf, byId } from "./stub/ui.mjs";
import { fakeCx } from "./fake-cx.mjs";
import { space, agent } from "./fixtures.mjs";
import { SideView } from "../mods/flockbook/side.js";
import { groups, allTabs } from "../mods/flockbook/overview.js";
import { headText } from "../mods/flockbook/tabs.js";
import { machineGroups, machinesTick, spaceTitle, KEY_MACHINES, KEY_FOLDED, MACHINES_MS } from "../mods/flockbook/machines.js";

const PC = { host: "home-pc", id: "5d77", name: "pc-wsl", session: null, state: "connected", target: "pc-wsl", temporary: false, version: "0.1.21", via: false };
let lsCalls, ls, hcCalls, hcAnswer;
const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });

beforeEach(() => {
  reset();
  fake.props = undefined;
  fake.machines = [{ name: null, layout: "ready" }];
  fake.spaces = [space("sp1", { index: 1, name: "app" }), space("sp2", { index: 2, name: "api", active: false })];
  lsCalls = 0; hcCalls = []; ls = { machines: [] }; hcAnswer = null;
  fake.exec = (_cmd, args) => {
    if (args[0] === "machine" && args[1] === "ls") { lsCalls++; return ok(ls); }
    hcCalls.push(args);
    return hcAnswer ? hcAnswer(args) : ok({ ok: true });
  };
});

const open = async () => { const cx = fakeCx(); const v = new SideView(cx); await cx.settle(); return { v, cx }; };
const ids = (el) => {
  const out = [];
  const walk = (e) => { if (!e || typeof e !== "object") return; if (e._a?.id) out.push(e._a.id); (e.kids || []).forEach(walk); };
  walk(byId(el, "spaces"));
  return out.filter((x) => /^(space-|machine-|machine-new-|machine-loading-)/.test(x) && !/^machine-(add|connect|login-copy|login)-/.test(x) && !/-chevron$/.test(x));
};
const click = (el, id, cx = fakeCx()) => byId(el, id)._h.on_click({}, Object.assign(cx, { stop_propagation() {}, write_to_clipboard(x) { fake.clip = x; } }));

test("only this computer: the list stays flat, no machine header", async () => {
  const { v, cx } = await open();
  const el = v.render(cx);
  assert.deepEqual(ids(el), ["space-sp1", "space-sp2"]);
  assert.equal(lsCalls, 1, "asks hc for the machines once on open");
});

test("a connected PC with no workspaces: a header for each machine and a row to make one there", async () => {
  ls = { machines: [PC] };
  fake.machines = [{ name: null, layout: "ready" }, { name: "pc-wsl", layout: "ready" }];
  const { v, cx } = await open();
  const el = v.render(cx);
  assert.deepEqual(ids(el), ["machine-local", "space-sp1", "space-sp2", "machine-pc-wsl", "machine-new-pc-wsl"]);
  assert.match(textOf(byId(el, "machine-local")), /This computer/);
  assert.match(textOf(byId(el, "machine-pc-wsl")), /pc-wsl/);
  assert.match(textOf(byId(el, "machine-new-pc-wsl")), /New workspace there/);
  click(el, "machine-add-pc-wsl");
  assert.deepEqual(log.run.at(-1), ["space.new", { machine: "pc-wsl" }], "+ makes a workspace on the PC");
  click(el, "machine-new-pc-wsl");
  assert.deepEqual(log.run.at(-1), ["space.new", { machine: "pc-wsl" }]);
  click(el, "machine-add-local");
  assert.deepEqual(log.run.at(-1), ["space.new", { machine: "" }], "this computer's + makes a local one");
});

test("the PC's workspaces sit under its header; its layout still loading shows Loading…", async () => {
  ls = { machines: [PC] };
  fake.machines = [{ name: null, layout: "ready" }, { name: "pc-wsl", layout: "ready" }];
  fake.spaces.push(space("pc-wsl/sp9", { index: 3, name: "wsl home", machine: "pc-wsl", active: false }));
  let { v, cx } = await open();
  assert.deepEqual(ids(v.render(cx)), ["machine-local", "space-sp1", "space-sp2", "machine-pc-wsl", "space-pc-wsl/sp9"]);
  fake.spaces.pop();
  fake.machines[1].layout = "loading";
  assert.deepEqual(ids(v.render(cx)), ["machine-local", "space-sp1", "space-sp2", "machine-pc-wsl", "machine-loading-pc-wsl"]);
  assert.match(textOf(byId(v.render(cx), "machine-loading-pc-wsl")), /Loading…/);
});

test("a space on a machine hc doesn't list yet still gets its header (from the space itself)", async () => {
  fake.spaces.push(space("box/sp5", { index: 3, name: "srv", machine: "box", active: false }));
  const { v, cx } = await open();
  const el = v.render(cx);
  assert.deepEqual(ids(el), ["machine-local", "space-sp1", "space-sp2", "machine-box", "space-box/sp5"]);
  assert.match(textOf(byId(el, "machine-box")), /asleep/, "not known as connected: its state instead of +");
  assert.equal(byId(el, "machine-add-box"), null);
});

test("fold: a header click hides that machine's rows, for every copy of the sidebar, and back", async () => {
  ls = { machines: [PC] };
  fake.machines.push({ name: "pc-wsl", layout: "ready" });
  const { v, cx } = await open();
  click(v.render(cx), "machine-local");
  assert.deepEqual(fake.shared[KEY_FOLDED], [null]);
  assert.deepEqual(ids(v.render(cx)), ["machine-local", "machine-pc-wsl", "machine-new-pc-wsl"]);
  const other = new SideView(fakeCx());
  assert.deepEqual(ids(other.render(fakeCx())), ["machine-local", "machine-pc-wsl", "machine-new-pc-wsl"], "the floating copy agrees");
  assert.match(byId(v.render(cx), "machine-local-chevron").kids[0]._a.path, /chevron-right/);
  click(v.render(cx), "machine-local");
  assert.deepEqual(ids(v.render(cx)), ["machine-local", "space-sp1", "space-sp2", "machine-pc-wsl", "machine-new-pc-wsl"]);
  assert.match(byId(v.render(cx), "machine-local-chevron").kids[0]._a.path, /chevron-down/);
});

test("unreachable: its state, no +; needs a login: the command and Copy", async () => {
  ls = { machines: [{ ...PC, state: "unreachable", why: "no route to host" }, { ...PC, name: "lab", target: "lab", state: "needs_login" }] };
  const { v, cx } = await open();
  const el = v.render(cx);
  assert.match(textOf(byId(el, "machine-pc-wsl")), /unreachable/);
  assert.equal(byId(el, "machine-add-pc-wsl"), null);
  assert.match(textOf(byId(el, "machine-login-lab")), /needs a login: run.*hc machine login lab/);
  click(el, "machine-login-copy-lab");
  assert.equal(fake.clip, "hc machine login lab");
  assert.match(textOf(byId(v.render(cx), "machine-login-copy-lab")), /Copied/);
});

test("rebuilt: Connect removes and re-adds it under the same name; a failure says why and can be tried again", async () => {
  ls = { machines: [{ ...PC, state: "unreachable", why: 'a different core answers there ("9f2a")' }] };
  const { v, cx } = await open();
  let el = v.render(cx);
  assert.match(textOf(byId(el, "machine-pc-wsl")), /rebuilt/);
  assert.equal(byId(el, "machine-new-pc-wsl"), null, "a rebuilt machine shows its header only");
  hcAnswer = (args) => (args[1] === "add" ? { code: 1, stdout: JSON.stringify({ error: { message: "host key changed" } }), stderr: "" } : ok({}));
  click(el, "machine-connect-pc-wsl", cx);
  await cx.settle();
  assert.deepEqual(hcCalls, [["machine", "rm", "pc-wsl", "--json"], ["machine", "add", "pc-wsl", "--name", "pc-wsl", "--json"]]);
  el = v.render(cx);
  assert.match(textOf(byId(el, "machine-pc-wsl")), /host key changed/);
  hcAnswer = null; hcCalls = [];
  ls = { machines: [PC] };
  click(el, "machine-connect-pc-wsl", cx);
  await cx.settle();
  assert.deepEqual(hcCalls, [["machine", "add", "pc-wsl", "--name", "pc-wsl", "--json"]], "already removed: only the add again");
  assert.equal(byId(v.render(cx), "machine-connect-pc-wsl"), null, "connected again: no Connect");
});

test("machinesTick: once per 15 s across copies; temporary machines left out; a failed ls keeps the last list", async () => {
  ls = { machines: [PC, { ...PC, name: "tmp", temporary: true }] };
  await machinesTick(1_000_000);
  await machinesTick(1_000_000 + MACHINES_MS - 1000);
  assert.equal(lsCalls, 1);
  assert.deepEqual(fake.shared[KEY_MACHINES].list.map((m) => m.name), ["pc-wsl"]);
  fake.exec = () => ({ code: 1, stdout: "", stderr: "boom" });
  await machinesTick(1_000_000 + MACHINES_MS + 1);
  assert.deepEqual(fake.shared[KEY_MACHINES].list.map((m) => m.name), ["pc-wsl"]);
});

test("machineGroups: null with no other machine; machines in name order after this computer", () => {
  assert.equal(machineGroups(fake.spaces, [], [{ name: null, layout: "ready" }]), null);
  const g = machineGroups(fake.spaces, [{ ...PC, name: "zeta" }, PC], [{ name: "beta", layout: "loading" }]);
  assert.deepEqual(g.map((x) => x.name), [null, "beta", "pc-wsl", "zeta"]);
  assert.equal(g.find((x) => x.name === "beta").loading, true);
});

test("drag: a workspace can't be dropped among another machine's", async () => {
  ls = { machines: [PC] };
  fake.machines.push({ name: "pc-wsl", layout: "ready" });
  fake.spaces.push(space("pc-wsl/sp9", { index: 3, name: "wsl home", machine: "pc-wsl", active: false }));
  const { v, cx } = await open();
  const at = (dy) => ({ button: "left", click_count: 1, modifiers: {}, position: { x: 60, y: 300 + dy }, local_position: { x: 50, y: dy }, bounds: { x: 8, y: 300, width: 244, height: 34 } });
  const c = { ...fakeCx(), stop_propagation() {} };
  let el = v.render(cx);
  byId(el, "space-sp1")._h.on_mouse_down(at(10), c);
  byId(el, "space-sp1")._h.on_mouse_move(at(20), c);
  byId(el, "space-pc-wsl/sp9")._h.on_mouse_move(at(25), c);
  el = v.render(cx);
  assert.equal(byId(el, "space-drop-line"), null, "no line on the PC's row");
  byId(el, "spaces")._h.on_mouse_up(at(25), c);
  assert.deepEqual(log.run, []);
});

test("Overview by workspace and the tab list name a remote workspace's machine", () => {
  fake.spaces = [space("sp1", { name: "app", tabs: [{ id: "a", status: "idle" }] }),
    space("pc-wsl/sp9", { name: "wsl home", machine: "pc-wsl", active: false, tabs: [{ id: "pc-wsl/b", status: "idle" }] })];
  fake.agents = [agent("t1", "idle", { tab: "a" }), agent("pc-wsl/t2", "idle", { tab: "pc-wsl/b", space: "pc-wsl/sp9" })];
  assert.deepEqual(groups(allTabs(), "space").map((g) => g.title), ["app", "wsl home on pc-wsl"]);
  assert.equal(spaceTitle(fake.spaces[1]), "wsl home on pc-wsl");
  assert.equal(spaceTitle(fake.spaces[0]), "app");
  assert.equal(headText(spaceTitle(fake.spaces[1]), 1), "wsl home on pc-wsl · 1");
});
