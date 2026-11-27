// Runs every plus test file (test-*.mjs next to this file); prints only failures and a total.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const DIR = fileURLToPath(new URL("./", import.meta.url));
let fails = 0, n = 0;
for (const f of readdirSync(DIR).filter((x) => /^test-.*\.mjs$/.test(x)).sort()) {
  n++;
  const r = spawnSync(process.execPath, [DIR + f], { encoding: "utf8", cwd: DIR });
  if (r.status !== 0) { fails++; console.log(`${f} exit ${r.status}`); console.log((r.stdout + r.stderr).split("\n").filter((l) => !l.startsWith("PASS")).slice(0, 8).join("\n")); }
}
console.log(`${n} test files, ${fails} failing`);
process.exit(fails ? 1 : 0);
