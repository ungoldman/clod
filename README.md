# clod

Terminal UI for Claude sessions. Browse, search, preview, delete, and resume any session.

Like `claude -r` but better.

## Install

Not published to npm yet. Install from a clone:

```
git clone <repo-url> clod
cd clod
pnpm install
pnpm link --global
```

This puts `clod` on your PATH, so you can run it from anywhere:

```
clod
```

Or skip the link step and run it in place from the clone:

```
node src/index.js
```

## Shell integration (cd on exit)

When you resume a session, claude runs in that session's project directory. To
have your shell also end up there after claude exits, add one line to `.zshrc`:

```zsh
source /path/to/clod/shell/clod.zsh
```

This defines a `clod` function wrapping the bin (the bin stays the entry point —
the function calls it via `command clod`). A child process can't change its
parent shell's directory, so the bin reports the path over a file descriptor and
the function, running inside your shell, does the `cd`. The one source line is
irreducible; the function itself lives in this repo and updates with it.

Quitting without resuming leaves your shell where it was. Without the wrapper,
clod behaves exactly as before; nothing is written unless `CLOD_CWD_FD` is set.

Panes split *while* the resumed session is running also open in the project
directory: clod reports it to the terminal via OSC 7 (iTerm2, VS Code, Ghostty,
WezTerm, kitty) and aligns its own working directory for terminals that poll
the foreground process instead (tmux with `split-window -c
"#{pane_current_path}"`, Terminal.app).

## Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list |
| `enter` / `r` | Resume selected session |
| `p` / `space` | Preview conversation |
| `t` | Usage dashboard (token counts) |
| `/` | Search titles (fuzzy) and message contents |
| `D` | Delete (moves to Trash; includes file-history, session-env, and history.jsonl prompt lines) |
| `s` | Cycle sort: recent → lexicographic → by directory |
| `q` / `esc` | Quit |

## How it works

Claude Code stores all session files in `~/.claude/projects/`, regardless of which directory the session was started in. clod reads from there directly. No home directory scanning.

## What it shows

Each row: session title · branch · project path · tokens used · context window · time since last activity

`used` is real throughput: tokens processed and generated (input + output +
cache writes), excluding cache reads. Cache reads re-count the same context
every turn and would inflate the figure ~10x, so they're left out. `ctx` is the
input context size of the session's most recent turn.

Times within today are relative (`now`, `5m`, `3h`); older sessions show a date.

## Usage dashboard

Press `t` for an aggregate view across all sessions: total throughput, a token
breakdown by type (input / output / cache write / cache read), a 30-day
throughput-per-day sparkline, a per-model breakdown, and top projects by
throughput. The cache-inclusive grand total is shown alongside the headline so
you can see how much of the raw count is cache re-reads. All figures are real
recorded token counts, no estimation.

Bottom bar: last user message from the selected session.

## Requirements

- Node 22+
- pnpm
- Claude Code CLI (`claude`) on PATH for resume
