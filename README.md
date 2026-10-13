# claude-handoff

A [herdr](https://herdr.dev) plugin that moves Claude Code sessions between three places:

| Where | What it is | How you reach it |
|---|---|---|
| **herdr pane** | interactive `claude` running in a pane | the pane |
| **background session** | Claude Code's native background session (`claude --bg`, `/bg`) | `claude attach <id>` in any terminal, claude.ai when Remote Control is on |
| **claude rc** | a headless child of `claude remote-control`, created from claude.ai or the mobile app | claude.ai / the app only |

Background sessions are the pivot. A pane can drop its session into the background and any pane can attach to it again. A `claude rc` session can be adopted into the background once, after which it behaves like any other background session.

```
phone / claude.ai ──► claude rc ──(adopt, once: new claude.ai URL)──┐
                                                                     ▼
                     herdr pane ◄──── attach / Ctrl+Z ────► background session ◄── claude.ai (Remote Control)
                                ───────── /bg ─────────►
```

## Install

```sh
herdr plugin link /path/to/herdr-claude-handoff          # local checkout
# or, once published with the `herdr-plugin` topic:
herdr plugin install <owner>/herdr-claude-handoff
```

Requires Node.js ≥ 20 and Claude Code ≥ 2.1.296 on `PATH` (no npm dependencies).

## Keybindings

`prefix+c` and `prefix+b` are herdr defaults (new tab, sidebar), so the examples use `shift`. Add to `~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "claude-handoff.sessions"
description = "Claude sessions"

[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "claude-handoff.background"
description = "Send Claude to the background"
```

All actions also show up in herdr's action list and in herdr-gpui's command palette.

## Actions

### `background`: free a pane

Types `/bg` in the focused Claude pane and reports the background id. The pane returns to its shell. It refuses when the pane is not Claude, Claude is working, or the input box holds a draft (the draft would be sent as a message).

The session is only reachable on claude.ai if Remote Control was on (`/remote-control` in the session, or `claude --remote-control`). `/bg` gives the session a new id and a new claude.ai URL.

### `sessions`: picker popup

Lists live sessions in three groups:

- **En arrière-plan**: Enter opens `claude attach <id>` in a new tab. Ctrl+Z in that tab detaches; the session keeps running.
- **claude rc**: Enter adopts the session after a confirmation screen (see below).
- **Dans un terminal**: shown for reference.

Keys: ↑/↓ or j/k, Enter, `r` refresh, `q`/Esc quit.

### `open-url` and the link handler

Ctrl+click a `https://claude.ai/code/session_…` link in any pane. A background session is attached in a new tab. A `claude rc` session opens the picker on its confirmation screen. A session already in a terminal triggers a notification.

## Adopting a `claude rc` session

1. Re-checks that the process is still an idle rc child.
2. Sends SIGTERM to that child only. The rc daemon keeps running and does not respawn it.
3. Runs `claude --bg --resume <session id> --remote-control` in the session's directory. HERDR_* variables and `CLAUDE_CODE_OAUTH_TOKEN` are removed, because Remote Control needs the `/login` credentials.
4. Attaches the new background session in a tab and shows the new claude.ai URL.

History is kept in full. The claude.ai URL changes: stop using the old one, or claude rc may serve a diverging copy from the server's history. If a stopped background job already holds that session id, Claude Code resumes into a copy with a new id.

## What it deliberately does not do

- **No move back into claude rc.** `claude remote-control --session-id cse_…` restores the old URL, but it reloads history from the server and overwrites the local transcript, so every turn taken outside rc is lost. It also refuses sessions that rc did not create ("no environment_id"). The background session already gives phone access, so it is not needed.
- **No URL preservation.** Keeping the original claude.ai URL would need undocumented Claude Code internals.

## How it finds sessions

Every Claude Code process writes `~/.claude/sessions/<pid>.json` (`sessionId`, `bridgeSessionId`, `kind`, `entrypoint`, `status`, `jobId`, `procStart`). Stale files are skipped by checking the pid and its start time in `/proc`. An rc child is an `sdk-cli` process started with `--sdk-url …/v1/code/sessions/cse_…` whose parent runs `claude rc`/`remote-control`. herdr is driven only through its CLI (`$HERDR_BIN_PATH`).

Linux only for rc detection (it reads `/proc`). On macOS, background and attach still work.

## Develop

```sh
npm test     # node --test, no herdr or claude needed
herdr plugin log list --plugin claude-handoff
```

## License

MIT
