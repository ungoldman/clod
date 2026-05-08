#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { loadSessions } from './sessions.js'
import App from './ui.js'

process.stdout.write('Loading sessions…\r')
const sessions = await loadSessions()
process.stdout.write('\r\x1b[K')

if (sessions.length === 0) {
  console.log('No Claude sessions found in ~/.claude/projects')
  process.exit(0)
}

let resumeTarget = null

process.stdout.write('\x1b[?1049h') // enter alternate screen
process.on('exit', () => process.stdout.write('\x1b[?1049l')) // restore on any exit

const { waitUntilExit } = render(
  React.createElement(App, {
    sessions,
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
