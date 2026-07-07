<div align="center">

<img src="./logo.png" width="120" height="120" alt="rock">

# clod

Terminal UI for managing Claude Code sessions.

[![npm][npm-image]][npm-url]
[![build][build-image]][build-url]

[npm-image]: https://img.shields.io/npm/v/@hype/clod.svg
[npm-url]: https://www.npmjs.com/package/@hype/clod
[build-image]: https://github.com/ungoldman/clod/actions/workflows/tests.yml/badge.svg
[build-url]: https://github.com/ungoldman/clod/actions/workflows/tests.yml

</div>

Browse, search, preview, resume, rename, and delete any session from any directory.

![clod session list](images/demo.png)

Like `claude -r` but better.

## Install

**Requirements:**

- Node 22+
- Claude Code CLI (`claude`) on PATH for resume

Install globally via your node package manager of choice:

```
pnpm i -g @hype/clod
```

This puts `clod` on your PATH, so you can run it from anywhere:

```
clod
```

## Usage

### Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list |
| `PgUp` / `PgDn` | Jump up/down a page |
| `/` | Search titles (fuzzy) and message contents |
| `space` | Preview conversation |
| `enter` | Resume selected session |
| `r` | Rename selected session (enter confirms, esc cancels) |
| `u` | Usage dashboard (token counts) |
| `s` | Cycle sort: recent → lexicographic → by directory |
| `D` | Delete (moves to Trash; includes tasks, file-history, session-env, debug/telemetry, and history.jsonl prompt lines) |
| `q` / `esc` | Quit |

### What it shows

Each row: session title · branch · project path · tokens used · context window · time since last activity

`used` is real throughput: tokens processed and generated (input + output +
cache writes), excluding cache reads. Cache reads re-count the same context
every turn and would inflate the figure ~10x, so they're left out. `ctx` is the
input context size of the session's most recent turn.

Times within today are relative (`now`, `5m`, `3h`); older sessions show a date.

Bottom bar: last user message from the selected session.

### Dashboard

Press `u` for an aggregate view across all sessions: total throughput, a token
breakdown by type (input / output / cache write / cache read), a 30-day
throughput-per-day sparkline, a per-model breakdown, and top projects by
throughput. The cache-inclusive grand total is shown alongside the headline so
you can see how much of the raw count is cache re-reads. All figures are real
recorded token counts, no estimation.

![clod usage dashboard](images/demo-dashboard.png)

### How it works

Claude Code stores all session files in `~/.claude/projects/`, regardless of which directory the session was started in. `clod` reads from there directly. No home directory scanning.

### Maintenance

`scripts/cleanup.js` trashes orphaned session artifacts under `~/.claude`
(file-history, session-env, tasks, telemetry, and stale `history.jsonl` lines
for sessions with no transcript left). Dry-run by default; `--apply` to act.
Per-session delete already covers these, so this is only for backlog from
deletions made outside `clod`. Don't `--apply` mid-session — a just-started
session looks orphaned until its transcript flushes.

```
node scripts/cleanup.js          # preview
node scripts/cleanup.js --apply  # trash them
```

## Development

TypeScript, ESM-only. Source in `src/` compiles to `dist/` with `tsc`.

```
pnpm dev        # run from source with reload
pnpm test       # lint, typecheck, build, and run tests
pnpm coverage   # tests with the 100% coverage gate
pnpm lint       # biome check
pnpm format     # biome check --write
```

Tests use `node:test` and run through Node's type stripping, so no test-runner
dependency. The parsing, sorting, and stats logic lives in `src/{sessions,list,stats,config}.ts`
and is held at 100% coverage; the Ink render layer (`src/ui.ts`) is exercised by
`ink-testing-library` but kept out of the gate.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[ISC](LICENSE)

Logo is the rock emoji, rendered locally from the system Apple Color Emoji font.
