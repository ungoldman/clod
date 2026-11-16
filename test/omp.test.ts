import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  activeBranch,
  agentDir,
  getSessionMessages,
  listSessionFiles,
  omp,
  parseSession
} from '../src/harnesses/omp.ts'

type Rec = Record<string, unknown> | string

// A title slot exactly as omp writes it: 256 bytes, newline included.
function slot(title: string, source?: string): string {
  const base = { type: 'title', v: 1, title, ...(source ? { source } : {}), updatedAt: 't' }
  const unpadded = JSON.stringify({ ...base, pad: '' })
  return JSON.stringify({ ...base, pad: ' '.repeat(255 - Buffer.byteLength(unpadded)) })
}

const header = (o: Record<string, unknown> = {}) => ({
  type: 'session',
  version: 3,
  id: '01a1-full-id',
  timestamp: '2026-11-01T00:00:00.000Z',
  cwd: '/nowhere/repo',
  ...o
})

const msg = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  o: Record<string, unknown> = {}
) => ({
  type: 'message',
  id,
  parentId,
  timestamp: `2026-11-01T00:00:0${id.length % 10}.000Z`,
  message: { role, content, ...o }
})

async function writeSession(records: Rec[], dir?: string): Promise<string> {
  const d = dir ?? (await mkdtemp(join(tmpdir(), 'clod-omp-')))
  const file = join(d, '2026-11-01T00-00-00-000Z_01a1-full-id.jsonl')
  await writeFile(
    file,
    `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`
  )
  return file
}

async function parse(records: Rec[]) {
  const file = await writeSession(records)
  return parseSession(file, await stat(file))
}

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite
})

test('parse: slot title, usage, ctx, and the active branch of a fork', async () => {
  const s = await parse([
    slot('󰚰 CLOD: work', 'auto'),
    header(),
    { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-11-01T00:00:00.500Z' },
    msg('u1', 'm0', 'user', [{ type: 'text', text: '  first ask  ' }]),
    msg('a1', 'u1', 'assistant', [{ type: 'thinking' }, { type: 'text', text: 'answer' }], {
      model: 'claude-opus-5-5',
      usage: usage(10, 20, 100, 5),
      contextSnapshot: { promptTokens: 1000 }
    }),
    msg('t1', 'a1', 'toolResult', [{ type: 'text', text: 'huge tool output' }]),
    // abandoned branch off a1: its tokens still count, its prompt is not the last
    msg('u2x', 'a1', 'user', 'abandoned ask'),
    msg('a2x', 'u2x', 'assistant', 'abandoned answer', {
      model: 'qwen3-coder',
      usage: usage(1, 1),
      contextSnapshot: { promptTokens: 9999 }
    }),
    msg('u2', 't1', 'user', [{ type: 'image' }, { type: 'text', text: 'second ask' }]),
    {
      type: 'model_usage',
      id: 'mu1',
      parentId: 'u2',
      purpose: 'title',
      model: 'claude-opus-5-5',
      usage: usage(500, 500),
      activeLeafId: 'u2'
    },
    {
      type: 'model_usage',
      id: 'mu2',
      parentId: 'u2',
      purpose: 'job-widget',
      model: 'claude-haiku-4-5',
      usage: usage(3, 4),
      activeLeafId: 'u2'
    },
    'not json',
    {
      type: 'custom',
      customType: 'session_exit',
      id: 'x1',
      parentId: 'u2',
      timestamp: '2026-11-02T00:00:00.000Z'
    }
  ])
  assert.ok(s)
  assert.equal(s.harness, 'omp')
  assert.equal(s.sessionId, '01a1-full-id')
  assert.equal(s.title, null)
  assert.equal(s.aiTitle, '󰚰 CLOD: work')
  assert.equal(s.cwd, '/nowhere/repo')
  assert.equal(s.gitBranch, null) // not a repo
  assert.equal(s.firstUserMessage, 'first ask')
  assert.equal(s.lastUserMessage, 'second ask')
  assert.equal(s.contextTokens, 1000) // the abandoned branch's ctx is not this one's
  assert.deepEqual(s.models.opus, usage(10, 20, 100, 5)) // title call skipped
  assert.deepEqual(s.models['qwen3-coder'], usage(1, 1))
  assert.deepEqual(s.models.haiku, usage(3, 4))
  assert.deepEqual(s.totals, usage(14, 25, 100, 5))
  assert.equal(s.throughput, 44)
  assert.ok(s.searchText.includes('abandoned ask'))
  assert.ok(!s.searchText.includes('huge tool output'))
  assert.equal(s.lastTimestamp, Date.parse('2026-11-02T00:00:00.000Z'))

  const msgs = await getSessionMessages(s.filePath)
  assert.deepEqual(
    msgs.map((m) => [m.role, m.text]),
    [
      ['user', '  first ask  '],
      ['assistant', 'answer'],
      ['user', 'second ask']
    ]
  )
})

test('parse: a user title, a sourceless slot, and an empty slot', async () => {
  assert.equal((await parse([slot('Mine', 'user'), header()]))?.title, 'Mine')
  assert.equal((await parse([slot('Old omp'), header()]))?.aiTitle, 'Old omp')
  const empty = await parse([slot(''), header()])
  assert.equal(empty?.title, null)
  assert.equal(empty?.aiTitle, null)
  assert.equal(empty?.firstUserMessage, null)
  assert.equal(empty?.contextTokens, null)
  assert.equal(empty?.lastTimestamp, (await stat(empty.filePath)).mtimeMs) // no timestamps at all
})

test('parse: a legacy slotless file reads the header title; a second header is ignored', async () => {
  const s = await parse([
    header({ title: 'Legacy name', titleSource: 'user' }),
    header({ id: 'other', cwd: '/elsewhere' })
  ])
  assert.equal(s?.title, 'Legacy name')
  assert.equal(s?.cwd, '/nowhere/repo')
  assert.equal((await parse([header({ title: 'Gen', titleSource: 'auto' })]))?.aiTitle, 'Gen')
  // a slot title wins over a header title
  assert.equal((await parse([slot('Slot', 'auto'), header({ title: 'Hdr' })]))?.aiTitle, 'Slot')
})

test('parse: no header or cwd is null, as is an unreadable file; id falls back to the filename', async () => {
  assert.equal(await parse([slot('x', 'auto')]), null)
  assert.equal(await parse([header({ cwd: undefined })]), null)
  const fake = { mtimeMs: 0 } as never
  assert.equal(await parseSession('/no/such_file.jsonl', fake), null)
  assert.deepEqual(await getSessionMessages('/no/such_file.jsonl'), [])
  assert.equal((await parse([header({ id: undefined })]))?.sessionId, '01a1-full-id')
})

test('parse: a --from-claude import reads the original transcript branch, null when gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clod-omp-imp-'))
  const original = join(dir, 'claude.jsonl')
  await writeFile(
    original,
    ['{"gitBranch":"feat/a"}', '{"gitBranch":"HEAD"}', '{"gitBranch":""}', ''].join('\n')
  )
  const imp = (sourcePath: string) => ({
    type: 'custom',
    customType: 'foreign_session_import',
    data: { sourcePath },
    id: 'f1',
    parentId: null
  })
  assert.equal((await parse([slot('i', 'auto'), header(), imp(original)]))?.gitBranch, 'feat/a')
  assert.equal((await parse([header(), imp(join(dir, 'gone.jsonl'))]))?.gitBranch, null)
  // an import record without a path is not an import
  assert.equal(
    (await parse([header(), { type: 'custom', customType: 'foreign_session_import', data: {} }]))
      ?.gitBranch,
    null
  )
})

test('parse: a tool result on the last line is read whole, for its leaf', async () => {
  const s = await parse([
    header(),
    msg('u1', null, 'user', 'kept'),
    msg('u2', null, 'user', 'dropped'),
    { ...msg('t9', 'u2', 'toolResult', []), activeLeafId: 'u1' }
  ])
  assert.equal(s?.lastUserMessage, 'kept')
})

test('parse: a tool result line without an id or parent still parses the rest', async () => {
  const s = await parse([
    header(),
    { type: 'message', message: { role: 'toolResult' } },
    { type: 'message', id: 'tr', message: { role: 'toolResult' } },
    msg('u1', 'tr', 'user', 'hi'),
    { type: 'message', message: { role: 'user', content: 'no id' } },
    { type: 'message', id: 'q', parentId: 'u1', message: { role: 'system' } },
    { type: 'message', id: 'z', parentId: 'q' }
  ])
  assert.equal(s?.lastUserMessage, 'hi')
  assert.deepEqual(
    (await getSessionMessages(s?.filePath as string)).map((m) => m.text),
    ['hi']
  )
})

test('parse: sparse records default to zero usage, unknown model, and no text', async () => {
  const s = await parse([
    header(),
    msg('u1', null, 'user', [{ type: 'text' }]),
    msg('a1', 'u1', 'assistant', undefined, { usage: { cacheRead: 7 } })
  ])
  assert.deepEqual(s?.models.unknown, usage(0, 0, 7, 0))
  assert.equal(s?.contextTokens, null)
  assert.equal(s?.firstUserMessage, null)
  assert.equal(s?.lastUserMessage, '')
})

test('activeBranch: captured leaf, missing leaf fallback, null leaf, cycles, empty', () => {
  const n = (id: string, parentId: string | null, leafId: string | null = id) => ({
    id,
    parentId,
    leafId
  })
  assert.deepEqual([...activeBranch([n('a', null), n('b', 'a'), n('c', 'a', 'b')])], ['b', 'a'])
  // the captured leaf is gone: newest self-selecting entry
  assert.deepEqual([...activeBranch([n('a', null), n('b', 'a'), n('c', 'a', 'gone')])], ['b', 'a'])
  assert.deepEqual([...activeBranch([n('a', null, 'x'), n('b', 'a', 'gone')])], [])
  assert.deepEqual([...activeBranch([n('a', null), n('b', 'a', null)])], []) // a cleared session
  assert.deepEqual([...activeBranch([n('a', 'b'), n('b', 'a')])], ['b', 'a']) // a cycle ends
  assert.deepEqual([...activeBranch([])], [])
})

test('listSessionFiles: depth-two .jsonl under the agent dir, PI_CODING_AGENT_DIR honored', async () => {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = await mkdtemp(join(tmpdir(), 'clod-omp-agent-'))
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    assert.equal(agentDir(), dir)
    assert.deepEqual(await listSessionFiles(), [])
    const slug = join(dir, 'sessions', '-dev-q')
    await mkdir(join(slug, 'artifact'), { recursive: true })
    const file = await writeSession([header()], slug)
    await writeFile(join(slug, 'artifact', 'Sub.jsonl'), '{}\n') // subagent transcript
    await writeFile(join(slug, 'x.jsonl.1.bak'), '{}\n')
    await writeFile(join(dir, 'sessions', 'stray-file'), 'x')
    await symlink(join(slug, 'missing'), join(slug, 'broken.jsonl'))
    const files = await listSessionFiles()
    assert.deepEqual(
      files.map((f) => [f.harness, f.filePath]),
      [['omp', file]]
    )
    const s = await omp.parse(files[0])
    assert.ok(s)
    assert.equal((await omp.messages(s)).length, 0)
    assert.deepEqual(omp.resume(s), { command: 'omp', args: ['--resume', '01a1-full-id'] })
    await assert.rejects(omp.rename(s, 'x'), /not supported/)
    await assert.rejects(omp.delete(s), /not supported/)
    delete process.env.PI_CODING_AGENT_DIR
    assert.match(agentDir(), /\.omp\/agent$/)
  } finally {
    if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev
  }
})
