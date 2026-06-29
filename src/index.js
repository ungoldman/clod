#!/usr/bin/env node
import { listSessionFiles, parseSessions } from './sessions.js'
import { loadConfig } from './config.js'

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

const [{ default: React }, { render }, { default: App }, config] = await Promise.all([
  import('react'),
  import('ink'),
  import('./ui.js'),
  loadConfig(),
])

let resumeTarget = null

process.stdout.write('\x1b[?1049h') // enter alternate screen
process.on('exit', () => process.stdout.write('\x1b[?1049l')) // restore on any exit

const { waitUntilExit } = render(
  React.createElement(App, {
    loadFirst: () => firstBatch,
    loadRest,
    initialSortMode: config.sortMode,
    onResume: (session) => { resumeTarget = session },
  })
)

await waitUntilExit()
process.stdout.write('\x1b[?1049l') // restore normal screen

if (resumeTarget) {
  const { spawnSync } = await import('child_process')
  spawnSync('claude', ['--resume', resumeTarget.sessionId], {
    stdio: 'inherit',
    cwd: resumeTarget.cwd,
  })
}
