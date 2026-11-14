// fetch-remote-helpers.sh (owner 11-14, item 7): a git checkout builds only this machine's helper, so the Linux
// helpers for other machines come from a helpers.yml run's artifacts into remote/ (with SHA256SUMS), where
// install.sh already passes them on (--remote). `gh` here is a fake that prints what it was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const modDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(modDir, "fetch-remote-helpers.sh");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// The Mac's too (owner 11-14: a Windows PC's Herdr reaches the Mac as another machine and has to send it a helper).
const T = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "universal-apple-darwin"];

// A fake gh: `run list` prints the newest run id (or nothing), `run download <id> -R r -n helper-<t> -D <dir>` lays the
// artifact out as helpers.yml uploads it (<dir>/<t>/flockbook-modfeed + version.txt). Every call goes to calls.log.
function fakeGh(root, { runs = "4242", missing = "" } = {}) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "run list") [ -n "${runs}" ] && echo "${runs}"; exit 0 ;;
  "run download")
    shift 2; id="$1"; shift
    while [ $# -gt 0 ]; do case "$1" in -n) name="$2"; shift 2 ;; -D) dir="$2"; shift 2 ;; *) shift ;; esac; done
    t="\${name#helper-}"
    [ "$t" = "${missing}" ] && { echo "no artifact $name" >&2; exit 1; }
    mkdir -p "$dir/$t" && printf '#!/bin/sh\\necho %s %s\\n' "$t" "$id" > "$dir/$t/flockbook-modfeed" && echo '{}' > "$dir/$t/version.txt" ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}
const run = (args, root, bin) => spawnSync("/bin/sh", [script, ...args], { encoding: "utf8", cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } });

test("a given run: both Linux helpers and their sums land in --out, as install.sh's --remote reads them", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-fetch-"));
  const { bin, log } = fakeGh(root);
  const out = join(root, "remote");
  const r = run(["--repo", "me/flockbook", "--run", "777", "--out", out], root, bin);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n").sort();
  const want = T.map((t) => `${sha(readFileSync(join(out, t, "flockbook-modfeed")))}  ${t}/flockbook-modfeed`).sort();
  assert.deepEqual(sums, want);
  for (const t of T) assert.match(readFileSync(join(out, t, "flockbook-modfeed"), "utf8"), new RegExp(`${t} 777`));
  assert.ok(!existsSync(join(out, T[0], "version.txt")), "only the helpers, not the build's notes");
  assert.match(readFileSync(log, "utf8"), /run download 777 -R me\/flockbook -n helper-x86_64-unknown-linux-musl/);
  assert.match(r.stdout, /install\.sh/);
});

test("no --run: the newest successful helpers run of the branch", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-fetch-"));
  const { bin, log } = fakeGh(root, { runs: "9001" });
  const r = run(["--repo", "me/flockbook", "--branch", "custom/x", "--out", join(root, "remote")], root, bin);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /run list -R me\/flockbook -w helpers\.yml -b custom\/x -s success -L 1/);
  assert.match(calls, /run download 9001 /);
});

test("no successful run: stops, says how to start one, writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-fetch-"));
  const { bin } = fakeGh(root, { runs: "" });
  const out = join(root, "remote");
  const r = run(["--repo", "me/flockbook", "--branch", "custom/x", "--out", out], root, bin);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh workflow run helpers\.yml -R me\/flockbook --ref custom\/x/);
  assert.ok(!existsSync(out));
});

test("a missing artifact keeps the remote/ there was", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-fetch-"));
  const { bin } = fakeGh(root, { missing: "aarch64-unknown-linux-musl" });
  const out = join(root, "remote");
  mkdirSync(out); writeFileSync(join(out, "SHA256SUMS"), "old\n");
  const r = run(["--repo", "me/flockbook", "--run", "5", "--out", out], root, bin);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(out, "SHA256SUMS"), "utf8"), "old\n");
});

test("without gh: stops and says so", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-fetch-"));
  const r = run(["--repo", "me/flockbook", "--run", "5", "--out", join(root, "remote")], root, join(root, "nobin"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GitHub CLI/);
});

test("install.sh from a checkout with no remote/ says how to get the Linux helpers", () => {
  const r = spawnSync("/bin/sh", [join(modDir, "install.sh"), "--home", mkdtempSync(join(tmpdir(), "fb-app-")), "--no-build"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fetch-remote-helpers\.sh/);
});
