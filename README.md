# clod

Terminal UI for browsing and resuming Claude Code sessions across your home directory.

`claude -r` scopes to the current project. clod shows all sessions across all projects, organized and sortable by directory, with last-message snippets and delete support.

## Usage

```
node src/index.js
```

Or install globally and run as `clod`.

## Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list |
| `enter` / `r` | Resume selected session |
| `p` | Preview conversation |
| `ctrl+d` | Delete (moves to Trash) |
| `s` | Cycle sort: by directory → recent → lexicographic |
| `q` / `esc` | Quit |

## What it shows

Each row: session title · project path · time since last activity

Bottom bar: last user message from the selected session.

## Requirements

- Node 22+
- pnpm
- Claude Code CLI (`claude`) on PATH for resume

## Install dependencies

```
pnpm install
```
