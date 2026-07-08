import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { helpText, parseArgs, readPackage } from '../src/cli.ts'

async function tmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clod-cli-'))
  return join(dir, name)
}

test('parseArgs returns launch with no flags', () => {
  assert.equal(parseArgs([]), 'launch')
})

test('parseArgs recognizes --help and -h', () => {
  assert.equal(parseArgs(['--help']), 'help')
  assert.equal(parseArgs(['-h']), 'help')
})

test('parseArgs recognizes --version and -v', () => {
  assert.equal(parseArgs(['--version']), 'version')
  assert.equal(parseArgs(['-v']), 'version')
})

test('parseArgs prefers help when both help and version are present', () => {
  assert.equal(parseArgs(['-v', '-h']), 'help')
})

test('readPackage reads version, description, and homepage', async () => {
  const file = await tmpFile('package.json')
  await writeFile(
    file,
    JSON.stringify({ version: '9.9.9', description: 'A test.', homepage: 'https://example.com' })
  )
  assert.deepEqual(await readPackage(file), {
    version: '9.9.9',
    description: 'A test.',
    homepage: 'https://example.com'
  })
})

test('helpText embeds the description and homepage', () => {
  const text = helpText({ description: 'A test.', homepage: 'https://example.com' })
  assert.match(text, /^clod - A test\./)
  assert.match(text, /-h, --help/)
  assert.match(text, /-v, --version/)
  assert.match(text, /https:\/\/example\.com$/)
})
