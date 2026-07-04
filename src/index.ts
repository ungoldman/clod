#!/usr/bin/env node
import { loadConfig } from './config.ts'
import { listSessionFiles, parseSessions, type Session } from './sessions.ts'

// Parse enough newest sessions to fill a viewport; stream the rest in later.
const FIRST_BATCH = 40

const files = await listSessionFiles()

if (files.length === 0) {
  console.log('No Claude sessions found in ~/.claude/projects')
  process.exit(0)
}

// Start parsing before the react/ink import so the two overlap.
const firstBatch = parseSessions(files.slice(0, FIRST_BATCH))
const loadRest = files.length > FIRST_BATCH ? () => parseSessions(files.slice(FIRST_BATCH)) : null

const [{ default: React }, { render }, { default: App }, config] = await Promise.all([
  import('react'),
  import('ink'),
  import('./ui.ts'),
  loadConfig()
])

// Object holder: TS narrows a reassigned `let` back to null after the closure,
// but a property read stays widened.
const resume: { target: Session | null } = { target: null }

process.stdout.write('\x1b[?1049h') // enter alternate screen
process.on('exit', () => process.stdout.write('\x1b[?1049l')) // restore on any exit

const { waitUntilExit } = render(
  React.createElement(App, {
    loadFirst: () => firstBatch,
    loadRest,
    initialSortMode: config.sortMode,
    onResume: (session) => {
      resume.target = session
    }
  })
)

await waitUntilExit()
process.stdout.write('\x1b[?1049l') // restore normal screen

const target = resume.target
if (target) {
  const { spawnSync } = await import('node:child_process')
  spawnSync('claude', ['--resume', target.sessionId], {
    stdio: 'inherit',
    cwd: target.cwd
  })
}
