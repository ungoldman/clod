# clod

Terminal UI for Claude sessions. Browse, search, preview, delete, and resume any session.

Like `claude -r` but better.

## Install

Not published to npm yet. Install from a clone:

```
git clone git@github.com:ungoldman/clod.git
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
| `/` | Search titles (fuzzy) and message contents |
| `D` | Delete (moves to Trash; includes tasks, file-history, session-env, debug/telemetry, and history.jsonl prompt lines) |
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

## Maintenance

`scripts/cleanup.mjs` trashes orphaned session artifacts under `~/.claude`
(file-history, session-env, tasks, telemetry, and stale `history.jsonl` lines
for sessions with no transcript left). Dry-run by default; `--apply` to act.
Per-session delete already covers these, so this is only for backlog from
deletions made outside clod. Don't `--apply` mid-session — a just-started
session looks orphaned until its transcript flushes.

```
node scripts/cleanup.mjs          # preview
node scripts/cleanup.mjs --apply  # trash them
```

## Requirements

- Node 22+
- pnpm
- Claude Code CLI (`claude`) on PATH for resume
