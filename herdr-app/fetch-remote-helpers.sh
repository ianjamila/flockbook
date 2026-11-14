#!/bin/sh
# Puts the Linux helpers for other machines (SSH machines in Herdr) into remote/ next to this file, with
# SHA256SUMS, from a helpers.yml run's artifacts. A git checkout builds only this machine's helper; with remote/
# here, ./install.sh installs these beside it (as the release zip's remote/ does), so the chat works on a
# Linux machine you added in Herdr too. Needs the GitHub CLI (gh), signed in.
# Usage: ./fetch-remote-helpers.sh [--run <id>] [--repo <owner/name>] [--branch <name>] [--out <folder>]
#   no --run: the newest successful helpers.yml run of this checkout's branch, on the repo that branch pushes to.
#   Start one with: gh workflow run helpers.yml -R <owner/name> --ref <branch>
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "STOP: $*" >&2; exit 1; }
targets="x86_64-unknown-linux-musl aarch64-unknown-linux-musl"

run=""; repo=""; branch=""; out="$here/remote"
while [ $# -gt 0 ]; do
  case "$1" in
    --run) run="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
command -v gh >/dev/null 2>&1 || die "this needs the GitHub CLI (gh, https://cli.github.com), signed in."
if [ -z "$branch" ]; then branch="$(git -C "$here" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"; fi
if [ -z "$repo" ]; then
  # The repo this branch pushes to (a fork's branch is not on upstream).
  remote="$(git -C "$here" config "branch.$branch.pushRemote" 2>/dev/null || git -C "$here" config "branch.$branch.remote" 2>/dev/null || echo origin)"
  url="$(git -C "$here" remote get-url "$remote" 2>/dev/null || true)"
  repo="$(printf '%s\n' "$url" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  [ -n "$repo" ] || die "cannot tell which GitHub repo this is: pass --repo <owner/name>."
fi
if [ -z "$run" ]; then
  [ -n "$branch" ] || die "cannot tell this checkout's branch: pass --branch or --run."
  run="$(gh run list -R "$repo" -w helpers.yml -b "$branch" -s success -L 1 --json databaseId -q '.[0].databaseId' || true)"
  [ -n "$run" ] || die "no successful helpers.yml run of $branch on $repo. Start one: gh workflow run helpers.yml -R $repo --ref $branch (then run this again when it is done)."
fi

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "this needs sha256sum or shasum."; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
new="$tmp/remote"
mkdir -p "$new"
: > "$new/SHA256SUMS"
for t in $targets; do
  gh run download "$run" -R "$repo" -n "helper-$t" -D "$tmp/$t" >&2 || die "run $run on $repo has no helper-$t artifact. remote/ was not changed."
  [ -f "$tmp/$t/$t/flockbook-modfeed" ] || die "the helper-$t artifact of run $run has no $t/flockbook-modfeed. remote/ was not changed."
  mkdir -p "$new/$t"
  cp "$tmp/$t/$t/flockbook-modfeed" "$new/$t/flockbook-modfeed"
  chmod 755 "$new/$t/flockbook-modfeed"
  echo "$(sum "$new/$t/flockbook-modfeed")  $t/flockbook-modfeed" >> "$new/SHA256SUMS"
done
mkdir -p "$(dirname "$out")"
rm -rf "$out"
cp -R "$new" "$out"
echo "Put the Linux helpers of run $run ($repo) in $out:"
cat "$out/SHA256SUMS"
echo "Now ./install.sh installs them beside this machine's helper."
