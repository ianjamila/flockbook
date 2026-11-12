// install.sh (Codex review 11-12): --copy-only backs up every file it replaces (a customised theme too) and stops
// before overwriting when a backup fails; --dry-run never builds the helper. Run: node test-install.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const S = fs.mkdtempSync(path.join(os.tmpdir(), "fb-install-"));
const SCRIPT = fileURLToPath(new URL("../../install.sh", import.meta.url));
fs.mkdirSync(`${S}/app/flockbook/bin`, { recursive: true });
fs.mkdirSync(`${S}/app/themes`, { recursive: true });
fs.mkdirSync(`${S}/user`, { recursive: true });
const run = (args) => {
  const r = spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: `${S}/user` }, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
};
let bad = 0;
const ok = (n, c) => { if (!c) bad++; console.log(c ? "PASS" : "FAIL", n); };
// Dry runs with no helper: nothing is built.
let r = run(["--home", `${S}/app`, "--dry-run", "--build-helper"]);
ok("dry --build-helper exits 0", r.code === 0);
ok("dry --build-helper says it would build", /Dry run: would build the helper/.test(r.out));
ok("dry --build-helper did not build", !/Building the helper/.test(r.out));
r = run(["--home", `${S}/app`, "--dry-run"]);
ok("dry (ask, no tty) builds nothing", r.code === 0 && !/Building the helper/.test(r.out) && /after asking/.test(r.out));
r = run(["--home", `${S}/app`, "--dry-run", "--no-build"]);
ok("dry --no-build still stops without a helper", r.code === 1 && /STOP/.test(r.out));
// Copy-only over a customised theme.
fs.writeFileSync(`${S}/app/flockbook/bin/flockbook-modfeed`, "#!/bin/sh\n");
fs.chmodSync(`${S}/app/flockbook/bin/flockbook-modfeed`, 0o755);
fs.writeFileSync(`${S}/app/themes/flockbook.json`, '{"mine":true}\n');
fs.writeFileSync(`${S}/app/themes/other.json`, '{"other":true}\n');
r = run(["--home", `${S}/app`, "--copy-only", "--no-layout"]);
ok("copy-only exits 0", r.code === 0);
const bk = fs.readdirSync(`${S}/app/flockbook/backups`);
const saved = `${S}/app/flockbook/backups/${bk[0]}/themes/flockbook.json`;
ok("customised theme backed up", fs.existsSync(saved) && fs.readFileSync(saved, "utf8").includes("mine"));
ok("theme replaced", !fs.readFileSync(`${S}/app/themes/flockbook.json`, "utf8").includes("mine"));
ok("other theme untouched and not backed up", fs.existsSync(`${S}/app/themes/other.json`) && !fs.existsSync(`${S}/app/flockbook/backups/${bk[0]}/themes/other.json`));
// A backup that can't be written stops before anything is overwritten.
fs.writeFileSync(`${S}/app/themes/flockbook.json`, '{"mine":2}\n');
fs.chmodSync(`${S}/app/flockbook/backups`, 0o555);
r = run(["--home", `${S}/app`, "--copy-only", "--no-layout"]);
fs.chmodSync(`${S}/app/flockbook/backups`, 0o755);
ok("unwritable backup stops", r.code === 1 && /STOP/.test(r.out));
ok("…and nothing was overwritten", fs.readFileSync(`${S}/app/themes/flockbook.json`, "utf8").includes('"mine":2'));
fs.rmSync(S, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
