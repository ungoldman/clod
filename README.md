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

## Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list |
| `enter` / `r` | Resume selected session |
| `p` / `space` | Preview conversation |
| `t` | Usage dashboard (token counts) |
| `/` | Fuzzy search by title |
| `D` | Delete (moves to Trash) |
| `s` | Cycle sort: recent → lexicographic → by directory |
| `q` / `esc` | Quit |

## How it works

Claude Code stores all session files in `~/.claude/projects/`, regardless of which directory the session was started in. clod reads from there directly. No home directory scanning.

## What it shows

Each row: session title · branch · project path · tokens used · context window · time since last activity

`used` is cumulative billed tokens (cache reads included, so it runs large); `ctx`
is the input context size of the session's most recent turn.

Times within today are relative (`now`, `5m`, `3h`); older sessions show a date.

## Usage dashboard

Press `t` for an aggregate view across all sessions: total tokens, a 30-day
tokens-per-day sparkline, a per-model breakdown, and top projects by token count.
All figures are real recorded token counts, no estimation.

Bottom bar: last user message from the selected session.

## Requirements

- Node 22+
- pnpm
- Claude Code CLI (`claude`) on PATH for resume
