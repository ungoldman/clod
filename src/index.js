#!/usr/bin/env node
import { listSessionFiles, parseSessions } from './sessions.js'

// Parse just enough newest sessions to fill a tall viewport, paint, and let the
// app pull in the rest in the background.
const FIRST_BATCH = 40

// Kick off the data load before importing the UI stack; the file reads and the
// react/ink import cost then overlap instead of stacking.
process.stdout.write('Loading sessions…\r')
const dataPromise = listSessionFiles().then(async (files) => ({
  files,
  sessions: await parseSessions(files.slice(0, FIRST_BATCH)),
}))

const [{ default: React }, { render }, { default: App }] = await Promise.all([
  import('react'),
  import('ink'),
  import('./ui.js'),
])

const { files, sessions } = await dataPromise
process.stdout.write('\r\x1b[K')

if (files.length === 0) {
  console.log('No Claude sessions found in ~/.claude/projects')
  process.exit(0)
}

const loadRest =
  files.length > FIRST_BATCH ? () => parseSessions(files.slice(FIRST_BATCH)) : null

let resumeTarget = null

process.stdout.write('\x1b[?1049h') // enter alternate screen
process.on('exit', () => process.stdout.write('\x1b[?1049l')) // restore on any exit

const { waitUntilExit } = render(
  React.createElement(App, {
    sessions,
    loadRest,
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
