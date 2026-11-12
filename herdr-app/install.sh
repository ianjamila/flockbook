#!/bin/sh
# Installs Flockbook for the Herdr app. Two ways:
#  - From the release zip (bin/ and remote/ next to this file): runs `flockbook-modfeed install` with this
#    machine's helper and the helpers for other machines (remote/), as the official release does.
#    The helper: bin/ on macOS (the signed one); remote/<target>/ on Linux, checked against remote/SHA256SUMS.
#  - From a git checkout (the "plus" build, see README.md): there is no bin/, so it builds the helper from this
#    checkout (`--build-helper`, needs Rust's cargo; it asks when run in a terminal). The built helper carries this
#    checkout's mod, layout, themes and keys, and installs them with itself. Without cargo, `--copy-only` copies the
#    mod, layout and themes over an existing Flockbook install and keeps its helper.
# Then it switches Herdr to the flockbook layout (`--no-layout`: it doesn't).
# The layout, mod, themes and keys are built into the helper; python3 is not needed.
# Usage: ./install.sh [--home <herdr-app home>] [--dry-run] [--build-helper | --no-build | --copy-only] [--no-layout]
#        (./install.sh --help: every option of `flockbook-modfeed install`)
# Updating the plus build: `git pull && ./install.sh` in the checkout. Your settings (<home>/flockbook/config.json)
# are never touched; a mod file you changed yourself stops the install, which then says which.
# Your arguments come last, so they win over the ones this script adds.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "STOP: $*" >&2; exit 1; }

# This script's own options come out of the argument list; the rest go to `flockbook-modfeed install`.
build=ask; copy=no; layout=yes; dry=no; home_arg=""; prev=""
for a in "$@"; do
  shift
  case "$a" in
    --build-helper) build=yes ;;
    --no-build) build=no ;;
    --copy-only) copy=yes; build=no ;;
    --no-layout) layout=no ;;
    *)
      [ "$a" = "--dry-run" ] && dry=yes
      [ "$prev" = "--home" ] && home_arg="$a"
      set -- "$@" "$a" ;;
  esac
  prev="$a"
done
app_home="${home_arg:-${HERDR_APP_HOME:-${HOME:-}/.config/herdr-app}}"

os="$(uname -s)"
case "$os" in
  Darwin) rel=bin/flockbook-modfeed ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) rel=remote/x86_64-unknown-linux-musl/flockbook-modfeed ;;
      aarch64|arm64) rel=remote/aarch64-unknown-linux-musl/flockbook-modfeed ;;
      *) die "there is no helper for Linux on $(uname -m) yet." ;;
    esac ;;
  MINGW* | MSYS* | CYGWIN*) die "Windows is not supported yet. Flockbook for the Herdr app installs on macOS and Linux." ;;
  *) die "$os is not supported yet. Flockbook for the Herdr app installs on macOS and Linux." ;;
esac

# Switches the open Herdr window to the flockbook layout, when the herdr-app command is there.
switch_layout() {
  [ "$layout" = yes ] && [ "$dry" = no ] || return 0
  cli=""
  if command -v herdr-app >/dev/null 2>&1; then cli="herdr-app"
  elif [ -x "${HOME:-}/.local/bin/herdr-app" ]; then cli="${HOME}/.local/bin/herdr-app"; fi
  if [ -n "$cli" ] && HERDR_APP_HOME="$app_home" "$cli" do layout.switch '{"name": "flockbook"}' >/dev/null 2>&1; then
    echo "Herdr now shows the flockbook layout. Pick a Flockbook theme in Herdr's Settings → Theme if you like."
  else
    echo "Open Herdr and run: layout.switch {\"name\": \"flockbook\"} (or pick it in Herdr's layout menu)."
  fi
}

# The plus build's optional status-line wrapper (extras/enable-statusline.mjs turns it on): copied next to the
# helper, so the chat header can show each session's own status line once it is on.
put_extras() {
  [ "$dry" = no ] && [ -f "$here/extras/flockbook-statusline" ] || return 0
  mkdir -p "$app_home/flockbook/bin"
  cp "$here/extras/flockbook-statusline" "$app_home/flockbook/bin/flockbook-statusline"
  chmod 755 "$app_home/flockbook/bin/flockbook-statusline"
}

# The plus build, copy only: the mod, layout and themes over an existing install; its helper and keys stay.
copy_only() {
  [ -d "$here/mods/flockbook" ] || die "--copy-only needs the repo's herdr-app folder (mods/flockbook is missing)."
  [ -x "$app_home/flockbook/bin/flockbook-modfeed" ] || die "--copy-only keeps the helper that is installed, and there is none in $app_home/flockbook/bin. Install the official Flockbook first (or use --build-helper)."
  if [ "$dry" = yes ]; then
    echo "Dry run: would copy mods/flockbook, layouts/flockbook.json and themes/flockbook*.json into $app_home (after a backup); nothing written."
    return 0
  fi
  stamp="$(date +%Y%m%d-%H%M%S)-$$"
  backup="$app_home/flockbook/backups/$stamp"
  mkdir -p "$backup"
  [ -d "$app_home/mods/flockbook" ] && cp -R "$app_home/mods/flockbook" "$backup/mod"
  [ -f "$app_home/layouts/flockbook.json" ] && cp "$app_home/layouts/flockbook.json" "$backup/"
  mkdir -p "$app_home/mods" "$app_home/layouts" "$app_home/themes"
  rm -rf "$app_home/mods/flockbook.new"
  cp -R "$here/mods/flockbook" "$app_home/mods/flockbook.new"
  rm -rf "$app_home/mods/flockbook"
  mv "$app_home/mods/flockbook.new" "$app_home/mods/flockbook"
  cp "$here/layouts/flockbook.json" "$app_home/layouts/flockbook.json"
  for f in "$here"/themes/flockbook*.json; do cp "$f" "$app_home/themes/"; done
  echo "Copied the plus mod, layout and themes into $app_home (the old ones are in $backup)."
  echo "The helper was kept: the chat works, but the plus helper fixes are not in it (./install.sh --build-helper adds them)."
}

# The plus build, from source: the helper built from this checkout (it embeds this checkout's herdr-app files).
build_helper() {
  cargo="$(command -v cargo 2>/dev/null || true)"
  [ -n "$cargo" ] || { [ -x "${HOME:-}/.cargo/bin/cargo" ] && cargo="${HOME}/.cargo/bin/cargo"; } || true
  [ -n "$cargo" ] || die "building the helper needs Rust (https://rustup.rs), then run ./install.sh again. Or ./install.sh --copy-only to keep the helper you have."
  [ -f "$here/../xplat/Cargo.toml" ] || die "no xplat/ next to herdr-app/: run this from a full git checkout of the repo."
  # The newest release tag below this checkout: the helper's version, so Flockbook's update check compares
  # against upstream releases. A shallow clone has no tags: then no version (and no update check).
  version="$(git -C "$here" describe --tags --abbrev=0 2>/dev/null || true)"
  echo "Building the helper (a few minutes the first time)…"
  ( cd "$here/../xplat" && FLOCKBOOK_VERSION="${version#v}" "$cargo" build --release --locked -p flockbook-modfeed ) >&2
  built="$here/../xplat/target/release/flockbook-modfeed"
  [ -x "$built" ] || die "the build made no helper at $built."
  exe="$built"
}

exe="$here/$rel"
if [ -x "$exe" ]; then
  # A helper from remote/ runs only if its sum matches (bin/ is the same file as remote/universal-apple-darwin/).
  case "$rel" in
    remote/*)
      [ -f "$here/remote/SHA256SUMS" ] || die "no remote/SHA256SUMS to check $rel against."
      if command -v sha256sum >/dev/null 2>&1; then have="$(sha256sum "$exe" | cut -d' ' -f1)"
      elif command -v shasum >/dev/null 2>&1; then have="$(shasum -a 256 "$exe" | cut -d' ' -f1)"
      else die "this needs sha256sum or shasum to check $rel."; fi
      want="$(awk -v f="${rel#remote/}" '$2 == f || $2 == "*" f { print $1 }' "$here/remote/SHA256SUMS")"
      [ -n "$want" ] && [ "$have" = "$want" ] || die "$rel does not match remote/SHA256SUMS. Nothing was installed."
      ;;
  esac
else
  exe="${FLOCKBOOK_MODFEED:-}"
fi
if [ -z "$exe" ] || [ ! -x "$exe" ]; then
  if [ "$copy" = yes ]; then copy_only; put_extras; switch_layout; exit 0; fi
  # A git checkout: build the helper when asked, or when a person at a terminal says yes.
  if [ "$build" = ask ] && [ -t 0 ] && [ -t 1 ] && [ -f "$here/../xplat/Cargo.toml" ]; then
    printf "No helper here (this is a git checkout). Build it from this checkout now? It needs Rust's cargo. [Y/n] "
    read -r answer || answer=n
    case "$answer" in ""|y|Y|yes|Yes) build=yes ;; *) build=no ;; esac
  fi
  if [ "$build" = yes ]; then
    build_helper
  else
    echo "STOP: no helper at $here/$rel." >&2
    echo "In the repo, build one: ./install.sh --build-helper (or by hand: (cd xplat && cargo build --release -p flockbook-modfeed)," >&2
    echo "then run: xplat/target/release/flockbook-modfeed install --helper xplat/target/release/flockbook-modfeed)." >&2
    echo "Or ./install.sh --copy-only to copy the mod over an installed Flockbook and keep its helper." >&2
    exit 1
  fi
fi
set -- --helper "$exe" "$@"
if [ -f "$here/remote/SHA256SUMS" ]; then set -- --remote "$here/remote" "$@"; fi
"$exe" install "$@"
put_extras
switch_layout
