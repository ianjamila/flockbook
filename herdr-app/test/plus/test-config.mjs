// config.js: the plus build's list settings (accounts, projects) and text settings are checked; a bad value falls
// back to the default instead of reaching the code that reads it. Run: node test-config.mjs
import { realConfig } from "./loadmod.mjs";
import { WORK_DIR } from "./paths.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const { cfg, set } = await realConfig({});
const V = cfg.VALID;

// accounts: [{ mark, name, config_dir }]
const WORK = { mark: "WORK", name: "Work account", config_dir: WORK_DIR }, HOME = { mark: "HOME", name: "Personal account" };
eq("accounts: two accounts", V.accounts([WORK, HOME]), true);
eq("accounts: one account, default folder", V.accounts([HOME]), true);
eq("accounts: empty list", V.accounts([]), false);
eq("accounts: not a list", V.accounts({ mark: "WORK", name: "x" }), false);
eq("accounts: duplicate marks", V.accounts([WORK, { ...HOME, mark: "WORK" }]), false);
eq("accounts: two on the default folder", V.accounts([HOME, { mark: "B", name: "Other" }]), false);
eq("accounts: mark with a space", V.accounts([{ ...HOME, mark: "MY HOME" }]), false);
eq("accounts: mark too long", V.accounts([{ ...HOME, mark: "X".repeat(25) }]), false);
eq("accounts: mark is a number (Codex 11-12 P2)", V.accounts([{ ...HOME, mark: 123 }]), false);
eq("accounts: mark is a list", V.accounts([{ ...HOME, mark: ["HOME"] }]), false);
eq("accounts: no name", V.accounts([{ mark: "HOME" }]), false);
eq("accounts: blank name", V.accounts([{ mark: "HOME", name: "  " }]), false);
eq("accounts: config_dir not text", V.accounts([{ ...WORK, config_dir: 5 }]), false);
eq("accounts: a null entry", V.accounts([HOME, null]), false);
eq("accounts: more than 8", V.accounts(Array.from({ length: 9 }, (_, i) => ({ mark: `A${i}`, name: `A${i}`, config_dir: `~/a${i}` }))), false);

// projects: [{ workspace, folder, title, suggest_only }]
const P = { workspace: "webshop", folder: "~/code/webshop", title: "webshop|#\\d+" };
eq("projects: good", V.projects([P, { workspace: "notes", folder: "~/notes", suggest_only: true }]), true);
eq("projects: empty list is allowed", V.projects([]), true);
eq("projects: bad pattern", V.projects([{ ...P, title: "web(shop" }]), false);
eq("projects: blank pattern", V.projects([{ ...P, title: "" }]), false);
eq("projects: no folder", V.projects([{ workspace: "webshop" }]), false);
eq("projects: no workspace", V.projects([{ folder: "~/x" }]), false);
eq("projects: suggest_only not true/false", V.projects([{ ...P, suggest_only: "yes" }]), false);
eq("projects: more than 16", V.projects(Array.from({ length: 17 }, (_, i) => ({ workspace: `w${i}`, folder: `~/w${i}` }))), false);

// Through setting(): a good value is used, a bad one gives the default (null), switches are off unless set.
eq("setting: unset accounts → default", cfg.setting("accounts"), null);
set("accounts", [WORK, HOME]);
eq("setting: good accounts used", cfg.setting("accounts").map((a) => a.mark), ["WORK", "HOME"]);
set("accounts", [WORK, { ...HOME, mark: "WORK" }]);
eq("setting: bad accounts → default", cfg.setting("accounts"), null);
set("projects", [{ ...P, title: "(" }]);
eq("setting: bad projects → default", cfg.setting("projects"), null);
set("claude_path", "");
eq("setting: blank claude_path → default", cfg.setting("claude_path"), null);
set("helper_rebuild", "make helper");
eq("setting: helper_rebuild text used", cfg.setting("helper_rebuild"), "make helper");
for (const k of ["pipeline_asks", "handoff_marks", "worth_considering", "auto_move"]) eq(`setting: ${k} off by default`, cfg.setting(k), "off");
set("pipeline_asks", "yes");
eq("setting: pipeline_asks not a choice → off", cfg.setting("pipeline_asks"), "off");
set("pipeline_asks", "on");
eq("setting: pipeline_asks on", cfg.setting("pipeline_asks"), "on");
eq("expandHome: ~/x", cfg.expandHome("~/x", "/Users/you"), "/Users/you/x");
eq("expandHome: absolute kept", cfg.expandHome("/opt/x", "/Users/you"), "/opt/x");
process.exit(bad ? 1 : 0);
