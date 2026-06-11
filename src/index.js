#!/usr/bin/env node
import { listSessionFiles, parseSessions } from './sessions.js'

// Parse just enough newest sessions to fill a tall viewport, paint, and let the
// app pull in the rest in the background.
const FIRST_BATCH = 40

const files = await listSessionFiles() // a few ms: readdir + stat only

if (files.length === 0) {
  console.log('No Claude sessions found in ~/.claude/projects')
  process.exit(0)
}

// Parsing starts now and overlaps the react/ink import; the UI paints
// immediately and the list streams in.
const firstBatch = parseSessions(files.slice(0, FIRST_BATCH))
const loadRest =
  files.length > FIRST_BATCH ? () => parseSessions(files.slice(FIRST_BATCH)) : null

const [{ default: React }, { render }, { default: App }] = await Promise.all([
  import('react'),
  import('ink'),
  import('./ui.js'),
])

let resumeTarget = null

process.stdout.write('\x1b[?1049h') // enter alternate screen
process.on('exit', () => process.stdout.write('\x1b[?1049l')) // restore on any exit

const { waitUntilExit } = render(
  React.createElement(App, {
    loadFirst: () => firstBatch,
    loadRest,
    onResume: (session) => { resumeTarget = session },
  })
)

await waitUntilExit()
process.stdout.write('\x1b[?1049l') // restore normal screen

// OSC 7 tells the terminal this pane's working directory, so panes split during
// the resumed session open in the project directory (iTerm2, VS Code, Ghostty,
// WezTerm, kitty; ignored elsewhere).
function reportCwd(dir) {
  const url = `file://${encodeURI(dir)}`
  process.stdout.write(`\x1b]7;${url}\x07`)
}

if (resumeTarget) {
  const originalCwd = process.cwd()
  reportCwd(resumeTarget.cwd)
  process.chdir(resumeTarget.cwd) // align clod's own cwd for foreground-process-based terminals

  const { spawnSync } = await import('child_process')
  spawnSync('claude', ['--resume', resumeTarget.sessionId], {
    stdio: 'inherit',
    cwd: resumeTarget.cwd,
  })

  // Shell integration: a wrapper function can open an fd, point CLOD_CWD_FD at
  // it, and cd to whatever lands there after clod exits (see README). A child
  // process can't change the parent shell's cwd directly.
  const cwdFd = Number(process.env.CLOD_CWD_FD)
  if (cwdFd) {
    const { writeSync } = await import('fs')
    try {
      writeSync(cwdFd, resumeTarget.cwd + '\n')
    } catch {}
  } else {
    // no wrapper: the shell is still in the original directory, so make the
    // terminal's belief match reality again
    reportCwd(originalCwd)
  }
}
