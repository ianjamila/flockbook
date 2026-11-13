# Flockbook plus: changes against upstream

Base: upstream `main` at `0cadf31` (after v0.13.0). What each change is for, in plain words, is in the
[README](README.md#flockbook-plus-this-build); this file says where it lives.

## Helper (`xplat/`, Rust)

| Commit | Change |
|---|---|
| Helper: send over Claude Code's suggested command (+ red test) | Replaced by upstream's own fix when upstream fe57f10 was merged in (11-13): the helper reads the box's first paint and sends over a dim suggestion (`queue.rs` `claude_suggestion_in_paint`). A "/word" really typed still gets the chat's Send anyway. The helper is now upstream's, unchanged. |
| Question answers: a comma in a single-choice label is not ambiguous (+ red test) | `herdr-core/src/question/claude_exact.rs`: only a multi-select answer splits on commas. Upstream merged it (PR #12). |

| Parked Claude tabs (11-13) | Claude Code can move a terminal's conversation to its background service ("parked": the client's pid file gets `parkedJobId`; the session runs on as a `bg` process whose pid file has that `jobId`). `herdr-core/src/resolver.rs` `claude_parked` follows it (in the terminal's process tree, else anywhere), and the session lookup now names the job's session (a parked client's own old one, or a `bg` job a client merely started, no longer makes it ambiguous). `flockbook-modfeed/src/parked.rs` gives such an agent the job's status (blocked while a prompt or question picker is on screen, else working/idle from the pid file) in every command, the phone page and queue, and the new `parked` command lists them (docs/protocol.md). |
| Answer on a parked or named tab (11-13) | A named Claude Code session (parked, or renamed) draws its name in a rule under the question picker, below its key line. `herdr-core/src/question/claude_exact.rs` `above_name_rule` drops that one rule before the exact picker and review compares, which took the last line as the key line and refused every answer from the chat ("The question on screen changed before the answer went in"). |

Upstream PR #12 (long questions, the "edit in <editor>" key line, typed capitals on the hc backend) is
already in upstream `main`.

## Mod (`mods/flockbook/`)

New files:

| File | What it does |
|---|---|
| `accounts.js` | The Claude Code accounts tabs run as (`accounts` setting): which one a screen shows, its name, its config folder, the `claude` command for it (finds `claude` in the usual folders, or `claude_path`). |
| `ai.js` | About lines and the Haiku calls behind them and Summarize: one call gate (known account, not paused, under the daily cap), usage-limit pauses with the reset time read in any time zone, per-account counts. One day rule for every time shown (`dayWord`/`clockText`): "tomorrow 1:00 am", "yesterday 9:10 pm", a weekday within 6 days, else the date; `history.js whenText` uses it too. |
| `asks.js` | Reads each local agent's screen every 15 s: replies that end asking you something, review-pipeline asks (setting), hand-offs (setting), background shells/agents, CI and review waits, MCP input requests, the "Now:" line, merged-PR checks via `gh` (setting). |
| `automove.js` | Move to <workspace> (tab menu), automatic moves to project workspaces and the wrong-workspace badge, from the `projects` setting. |
| `history.js` | "Since you last looked": per-tab snapshots and events (finished, needs you, waiting on CI, waiting on a review, hand-off, About, PR merged/closed), Copy and Mark seen, "waiting 2 h". 11-13: grouped by what each tab does now (`SINCE_GROUPS`), a card per tab (`nowText`, About line, change chips), times name their day (`whenText`); `overview.js` draws it, click opens the tab, every group folded at first + Expand all / Collapse all, Copy = the grouped text with a notice. |
| `hover.js` | The hover box on cards, tab pills and tab-list rows. |
| `patchcheck.js` | Warns once when an official update replaced the patched helper (only after a patched one was seen here). |
| `parked.js` | Parked Claude tabs (their conversation went on in Claude Code's background service, so Herdr lists no agent there): a 3 s tick asks the helper's `parked` command while a Claude terminal reports no status, and `agents()` / `spaces()` (which every module now imports from here, not from "herdr") add them back with their job's status, "done" until you look, as Herdr does. |
| `resume.js` | Remembers each Claude tab's session and offers them back after a restart (Resume, Resume all, Dismiss, "Opening…"). |
| `selection.js` | Text selection in the kit's text boxes in the theme's selection colour. |
| `statusline.js` | Each session's own status line in the chat header (with `extras/flockbook-statusline`). |
| `summary.js` | The "Summarize this tab" dialog. |
| `tabs.js` | The vertical tab list. A working agent's icon dances (two native `loop`s: hop + sway; `dances`, setting `dance`, on by default). |
| `termresize.js` | Drag-resize grips for the terminal window, and its size presets. `fitTerm`/`termAt`: the window stays clear of the tab list (it only shrinks, to the work column right of its remembered spot; a window never dropped is centered in the work column). |
| `icons/moved.svg`, `icons/tablist.svg` | Their icons. |

Changed files:

| File | Change |
|---|---|
| `state.js` | Tab names from the session title (`sessionTitle`, `sessionTopic`, keep/rename); the title symbols and ask marks as sub-statuses (`overlays`, `subStatus`, `SUB_GROUPS`, incl. "Waiting on a review", and a merge watch still running after "merge" kept as working under "Merging"); terminal window sizes; `keepTerminal` (run by the 300 ms screen sync): the open terminal window follows the shown tab (closes on a tab with no terminal) and reopens in place at its fitted size when the app, a sidebar or its spot changes (`termRoom`/`termApp` from widths the screens, the sidebar and the tab list measure; Herdr's `windows.json` for the spot). |
| `overview.js` | Status groups and sub-groups with waiting counts, Now/About lines, the Since-you-looked strip, the resume banner, pause notices, width fix. |
| `needs.js` | Asks from replies, Extra round / Merge buttons (check the screen first), MCP input requests, waiting times. |
| `top.js`, `side.js`, `termbar.js`, `menu.js`, `main.js` | Title tooltips, double-click to keep a name, hover labels, tab menu rows (Keep name, Name from session again, Move to, Summarize, Rewrite About line), the move badge, new views registered, the ticks (asks, about, history, resume, moves, patch check). |
| `chat.js`, `blocks.js` | Copy all for a reply's re-entry prompt (`reentryPrompt`): a footer-line button with a "copied" notice and 2 s "Copied", plus a right-click item. |
| `overview.js`, `blocks.js` | Copy prompt on a "Hand-off given" tab's Overview card and its "Since you last looked" card: reads the tab's newest reply through the helper (`sidecar.feed`) and copies its re-entry prompt with the chat's own finder (`replyPrompt`, shared with Copy all), without opening the tab. |
| `chat.js`, `composer.js`, `sidecar.js`, `cards.js` | Send anyway over a "/" suggestion, sends after `/clear`, ask markers above the reply box, untypeable answers, drafts, the chat's last lines at any zoom, the MCP input card; upstream's `--cache` send kept. |
| `config.js`, `settings.js` | New settings: About lines (on/off, daily cap, pause until tomorrow), terminal size, dancing tab-list icons (`dance`), and the Workflow switches `pipeline_asks`, `handoff_marks`, `worth_considering`, `auto_move` (all off by default), plus `accounts`, `projects`, `claude_path`, `helper_rebuild` (config.json). The update notice points to this build's own update command. |
| `asks.js` | 11-13: a running sub-agent row drawn "◯" (newer Claude Code) counts as background work, as "○" did, so a finished turn with a build agent still running stays Working instead of Done. |
| `estimate.js` | Row heights at a zoom below 1 count prose at its unzoomed line height, so a long reply's last lines (often the ask) are not cut off. 11-13: a code box's lines are counted as drawn (`codeLines`: Menlo at 0.61 em, wrapped by word like prose, indent kept), not letter by letter at 0.58 em, which left a long fenced re-entry prompt's last lines and its footer's Copy all cut off. |
| `chat.js` | 11-13: while the chat follows the newest row, a change in the list's size (the status rows, an ask strip or a card appearing under it, or a narrower pane) scrolls back to it, instead of leaving it half under the reply box. |

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
