# Flockbook plus: changes against upstream

Base: upstream `main` at `0cadf31` (after v0.13.0). What each change is for, in plain words, is in the
[README](README.md#flockbook-plus-this-build); this file says where it lives.

## Helper (`xplat/`, Rust)

| Commit | Change |
|---|---|
| Helper: send over Claude Code's suggested command (+ red test) | `flockbook-modfeed/src/queue.rs`, `cards.rs`: a send while Claude Code shows its "/" command list clears the box (ctrl+e ctrl+u) and checks it is one row before pasting; `docs/protocol.md` notes it. |
| Question answers: a comma in a single-choice label is not ambiguous (+ red test) | `herdr-core/src/question/claude_exact.rs`: only a multi-select answer splits on commas. |

Upstream PR #12 (long questions, the "edit in <editor>" key line, typed capitals on the hc backend) is
already in upstream `main`.

## Mod (`mods/flockbook/`)

New files:

| File | What it does |
|---|---|
| `accounts.js` | The Claude Code accounts tabs run as (`accounts` setting): which one a screen shows, its name, its config folder, the `claude` command for it (finds `claude` in the usual folders, or `claude_path`). |
| `ai.js` | About lines and the Haiku calls behind them and Summarize: one call gate (known account, not paused, under the daily cap), usage-limit pauses with the reset time read in any time zone, per-account counts. |
| `asks.js` | Reads each local agent's screen every 15 s: replies that end asking you something, review-pipeline asks (setting), hand-offs (setting), background shells/agents, CI and review waits, MCP input requests, the "Now:" line, merged-PR checks via `gh` (setting). |
| `automove.js` | Move to <workspace> (tab menu), automatic moves to project workspaces and the wrong-workspace badge, from the `projects` setting. |
| `history.js` | "Since you last looked": per-tab snapshots and events (finished, needs you, waiting on CI, waiting on a review, hand-off, About, PR merged/closed), Copy and Mark seen, "waiting 2 h". |
| `hover.js` | The hover box on cards, tab pills and tab-list rows. |
| `patchcheck.js` | Warns once when an official update replaced the patched helper (only after a patched one was seen here). |
| `resume.js` | Remembers each Claude tab's session and offers them back after a restart (Resume, Resume all, Dismiss, "Opening…"). |
| `selection.js` | Text selection in the kit's text boxes in the theme's selection colour. |
| `statusline.js` | Each session's own status line in the chat header (with `extras/flockbook-statusline`). |
| `summary.js` | The "Summarize this tab" dialog. |
| `tabs.js` | The vertical tab list. |
| `termresize.js` | Drag-resize grips for the terminal window, and its size presets. |
| `icons/moved.svg`, `icons/tablist.svg` | Their icons. |

Changed files:

| File | Change |
|---|---|
| `state.js` | Tab names from the session title (`sessionTitle`, `sessionTopic`, keep/rename); the title symbols and ask marks as sub-statuses (`overlays`, `subStatus`, `SUB_GROUPS`, incl. "Waiting on a review"); terminal window sizes. |
| `overview.js` | Status groups and sub-groups with waiting counts, Now/About lines, the Since-you-looked strip, the resume banner, pause notices, width fix. |
| `needs.js` | Asks from replies, Extra round / Merge buttons (check the screen first), MCP input requests, waiting times. |
| `top.js`, `side.js`, `termbar.js`, `menu.js`, `main.js` | Title tooltips, double-click to keep a name, hover labels, tab menu rows (Keep name, Name from session again, Move to, Summarize, Rewrite About line), the move badge, new views registered, the ticks (asks, about, history, resume, moves, patch check). |
| `chat.js`, `composer.js`, `sidecar.js`, `cards.js` | Send anyway over a "/" suggestion, sends after `/clear`, ask markers above the reply box, untypeable answers, drafts, the chat's last lines at any zoom, the MCP input card; upstream's `--cache` send kept. |
| `config.js`, `settings.js` | New settings: About lines (on/off, daily cap, pause until tomorrow), terminal size, and the Workflow switches `pipeline_asks`, `handoff_marks`, `worth_considering`, `auto_move` (all off by default), plus `accounts`, `projects`, `claude_path`, `helper_rebuild` (config.json). The update notice points to this build's own update command. |
| `estimate.js` | Row heights at a zoom below 1 count prose at its unzoomed line height, so a long reply's last lines (often the ask) are not cut off. |

## Layout, themes, install

| File | Change |
|---|---|
| `layouts/flockbook.json` | A top bar per screen, the tab-list column, the terminal grips. |
| `themes/flockbook.json`, `themes/flockbook-light.json` | VS Code–style palette; a visible `selection` colour. |
| `install.sh` | From a git checkout: builds the helper (`--build-helper`, asks in a terminal) or copies over an existing install (`--copy-only`, which backs up the mod, layout and each theme it replaces first and stops if a backup fails); switches to the layout (`--no-layout`); copies the status-line wrapper. `--dry-run` never builds. The release-zip path is unchanged. |
| `keys.json` | ⌥⌘B tab list, ⌘⇧K keep the tab's name, ⌘⇧M its Move to … rows. |
| `extras/` | `flockbook-statusline` (status-line wrapper) and `enable-statusline.mjs` (turns it on / off in a Claude Code settings.json). |
| `test/stub/ui.mjs` | Fakes for `HoverCard`, `ScrollHandle`, `set_theme`. |
| `test/*.test.mjs` | Upstream tests updated where this build changes behaviour on purpose. |
| `test/plus/` | This build's own tests (`npm run test:plus`; `npm test` runs both). |
