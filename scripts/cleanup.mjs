#!/usr/bin/env node
// One-off maintenance: trash orphaned session artifacts under ~/.claude —
// file-history/, session-env/, tasks/, and telemetry payloads whose session no
// longer has a transcript in projects/ — and scrub their stale history.jsonl
// lines. Everything goes to the Trash; a full history.jsonl backup goes too.
//
// Dry-run by default (prints the plan). Pass --apply to actually trash.
//
//   node scripts/cleanup.mjs          # show what would be removed
//   node scripts/cleanup.mjs --apply  # do it
//
// Not wired into the TUI on purpose: clod's per-session delete already covers
// these going forward, so this only clears backlog from deletions made outside
// clod. plans/ and paste-cache/ are left alone — they're shared across sessions
// and need reference-counting to remove safely.

import { readdir, readFile, writeFile, copyFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import trash from 'trash'

const apply = process.argv.includes('--apply')
const CLAUDE = join(homedir(), '.claude')
const PROJECTS = join(CLAUDE, 'projects')

// valid ids: any transcript stem, with the agent- subsession prefix stripped
const valid = new Set()
for (const p of await readdir(PROJECTS)) {
  let names
  try { names = await readdir(join(PROJECTS, p)) } catch { continue }
  for (const n of names) {
    if (n.endsWith('.jsonl')) valid.add(n.replace(/\.jsonl$/, '').replace(/^agent-/, ''))
  }
}
console.log(`valid sessions: ${valid.size}`)

const toTrash = []
for (const sub of ['file-history', 'session-env', 'tasks']) {
  const dir = join(CLAUDE, sub)
  let names
  try { names = await readdir(dir) } catch { continue }
  let n = 0
  for (const name of names) {
    if (!valid.has(name)) { toTrash.push(join(dir, name)); n++ }
  }
  console.log(`  ${sub}: ${n} orphan(s)`)
}
try {
  const telDir = join(CLAUDE, 'telemetry')
  let n = 0
  for (const name of await readdir(telDir)) {
    const m = name.match(/^1p_failed_events\.([^.]+)\./)
    if (m && !valid.has(m[1])) { toTrash.push(join(telDir, name)); n++ }
  }
  console.log(`  telemetry: ${n} orphan(s)`)
} catch {}

// history.jsonl: split keep/remove by orphaned sessionId
const histPath = join(CLAUDE, 'history.jsonl')
const raw = await readFile(histPath, 'utf8')
const lines = raw.split('\n')
const kept = [], removed = []
for (const line of lines) {
  if (!line) { kept.push(line); continue }
  let sid = null
  try { sid = JSON.parse(line).sessionId } catch {}
  if (sid && !valid.has(sid)) removed.push(line)
  else kept.push(line)
}
console.log(`  history.jsonl: ${removed.length} stale line(s) of ${lines.filter(Boolean).length}`)

if (!apply) {
  console.log(`\ndry run — ${toTrash.length} artifact(s) + ${removed.length} history line(s) would be removed. Pass --apply to do it.`)
  process.exit(0)
}

// recovery copies (both go to Trash): full history backup + the removed lines
const bakPath = histPath + '.orphan-cleanup-bak'
await copyFile(histPath, bakPath)
const removedPath = join(CLAUDE, 'history-removed-orphans.jsonl')
await writeFile(removedPath, removed.join('\n') + '\n')

console.log(`\ntrashing ${toTrash.length} artifact(s) + 2 history recovery file(s)...`)
await trash([...toTrash, bakPath, removedPath])

// rewrite history last, so the original stays intact until everything else is safe
await writeFile(histPath, kept.join('\n'))
console.log('done. history.jsonl rewritten; backups are in Trash.')
