import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, saveConfig } from '../src/config.ts'

async function tmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clod-cfg-'))
  return join(dir, name)
}

test('saveConfig then loadConfig round-trips a valid sortMode', async () => {
  const file = await tmpFile('c.json')
  await saveConfig({ sortMode: 'directory' }, file)
  assert.deepEqual(await loadConfig(file), { sortMode: 'directory' })
})

test('loadConfig defaults to recent on missing file', async () => {
  assert.deepEqual(await loadConfig(await tmpFile('nope.json')), { sortMode: 'recent' })
})

test('loadConfig defaults to recent on malformed JSON', async () => {
  const file = await tmpFile('bad.json')
  await writeFile(file, '{not json')
  assert.deepEqual(await loadConfig(file), { sortMode: 'recent' })
})

test('loadConfig defaults to recent on invalid sortMode value', async () => {
  const file = await tmpFile('inv.json')
  await writeFile(file, JSON.stringify({ sortMode: 'sideways' }))
  assert.deepEqual(await loadConfig(file), { sortMode: 'recent' })
})

test('loadConfig defaults to recent when sortMode is not a string', async () => {
  const file = await tmpFile('num.json')
  await writeFile(file, JSON.stringify({ sortMode: 42 }))
  assert.deepEqual(await loadConfig(file), { sortMode: 'recent' })
})

test('saveConfig swallows write errors', async () => {
  // path under a nonexistent directory -> writeFile rejects -> swallowed
  const bad = join(tmpdir(), 'clod-does-not-exist-dir', 'x', 'c.json')
  await assert.doesNotReject(saveConfig({ sortMode: 'recent' }, bad))
})
