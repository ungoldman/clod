# clod

Terminal UI for browsing, searching, previewing, deleting, and resuming all Claude Code sessions in your home directory.

Like `claude -r` but better.

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
| `p` / `space` | Preview conversation |
| `/` | Search by title |
| `ctrl+d` | Delete (moves to Trash) |
| `s` | Cycle sort: by directory → recent → lexicographic |
| `q` / `esc` | Quit |

## What it shows

Each row: session title · branch · project path · time since last activity

Bottom bar: last user message from the selected session.

## Requirements

- Node 22+
- pnpm
- Claude Code CLI (`claude`) on PATH for resume

## Install dependencies

```
pnpm install
```
