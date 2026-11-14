// Loads a flockbook mod file with its imports replaced by fakes, so tests can run the real code —
// timers, locks, shared state — without Herdr. `fakes`: { "herdr": {...}, "./state.js": {...}, … }; a module not
// given is a stand-in whose every export is a function returning undefined.
// Each load is a fresh copy (its own module state). Usage: const m = await loadMod("ai.js", fakes)
import fs from "node:fs";
import { MOD, LOADED as OUT } from "./paths.mjs";
let n = 0;
const stub = () => new Proxy({}, { get: (_, k) => (typeof k === "symbol" ? undefined : () => undefined) });
// parked.js with no parked tab: Herdr's own lists, as the mod reads them through it (owner 11-13). A test that
// loads the real parked.js passes it as "./parked.js".
const herdrLists = (h = {}) => ({ agents: () => h.agents?.(), spaces: () => h.spaces?.(), parkedOf: () => null, parkedTick: async () => {}, withSnapshot: (fn) => fn() });
export async function loadMod(file, fakes = {}) {
  let src = fs.readFileSync(MOD + file, "utf8");
  src = src
    .replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+"([^"]+)";/gm, (_, name, m) => `const ${name} = globalThis.__fk(${JSON.stringify(m)});`)
    .replace(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";/gm, (_, names, m) => `const {${names.replace(/\s+as\s+/g, ": ")}} = globalThis.__fk(${JSON.stringify(m)});`);
  globalThis.__fk = (m) => fakes[m] ?? (m === "./parked.js" ? herdrLists(fakes.herdr) : stub());
  fs.mkdirSync(OUT, { recursive: true });
  const out = `${OUT}${file.replace(/\W/g, "_")}.${process.pid}.${++n}.mjs`;
  fs.writeFileSync(out, src);
  try { return await import(out); } finally { fs.rmSync(out, { force: true }); }
}
// A fake shared store: shared(key) / setShared(key, value) over a plain object (values copied like Herdr's JSON store).
export function fakeShared(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  return {
    data,
    shared: (k) => (k in data ? JSON.parse(JSON.stringify(data[k])) : undefined),
    setShared: (k, v) => { if (v === null || v === undefined) delete data[k]; else data[k] = JSON.parse(JSON.stringify(v)); },
  };
}
// The real config.js over a plain settings object (`file`: what config.json holds). Returns the loaded module, the
// store behind it (`st.data["flockbook.config"].file` can be changed between calls) and the file object.
export async function realConfig(file = {}) {
  const st = fakeShared({ "flockbook.config": { file, bad: false, text: "{}" } });
  const cfg = await loadMod("config.js", { herdr: { ...st, appHome: () => "/Users/you/.config/herdr-app" } });
  return { cfg, st, set: (k, v) => { const c = st.data["flockbook.config"]; c.file[k] = v; } };
}
// The real accounts.js reading `settings` (through the real config.js) and running as `herdr` (home() is read from it).
// The real where.js too (s26: which machine claude runs on), over the same `herdr` (no machines unless it has some).
export async function realAccounts(herdr, settings = {}) {
  const { cfg, set } = await realConfig(settings);
  const where = await loadMod("where.js", { herdr: { machines: () => [], window: () => ({ platform: "macos" }), ...herdr }, "./config.js": cfg });
  const acc = await loadMod("accounts.js", { herdr, "./config.js": cfg, "./where.js": where });
  return { acc, cfg, set, where };
}
