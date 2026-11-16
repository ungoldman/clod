import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  activeBranch,
  agentDir,
  cleanTitle,
  deleteSession,
  getSessionMessages,
  listLive,
  listSessionFiles,
  liveSessionIds,
  omp,
  openHistory,
  type Probes,
  parseSession,
  quietSqlite,
  renameSession,
  serializeSlot
} from '../src/harnesses/omp.ts'
import type { Session } from '../src/sessions.ts'

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
    delete process.env.PI_CODING_AGENT_DIR
    assert.match(agentDir(), /\.omp\/agent$/)
  } finally {
    if (prev !== undefined) process.env.PI_CODING_AGENT_DIR = prev
  }
})

// ─── rename, delete, live ───────────────────────────────────────────────────

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = await mkdtemp(join(tmpdir(), 'clod-omp-agent-'))
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

const idle: Probes = { leases: async () => new Set(), terminals: async () => [] }

function historyDb(dir: string) {
  const db = new DatabaseSync(join(dir, 'history.db'))
  db.exec(`CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE session_recaps (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, recap TEXT NOT NULL);
    CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT, session_id TEXT);
    INSERT INTO session_titles VALUES ('01a1-full-id', 'Old', 1), ('other', 'Keep', 1);
    INSERT INTO session_recaps (session_id, cwd, recap) VALUES ('01a1-full-id', '/p', 'r'), ('other', '/p', 'r');
    INSERT INTO history (prompt, session_id) VALUES ('hi', '01a1-full-id');`)
  return db
}

async function sessionIn(
  dir: string,
  records: Rec[] = [slot('Old', 'auto'), header(), msg('u1', null, 'user', 'hi')]
) {
  const slug = join(dir, 'sessions', '-dev-q')
  await mkdir(slug, { recursive: true })
  const file = await writeSession(records, slug)
  return (await parseSession(file, await stat(file))) as Session
}

test('serializeSlot / cleanTitle: 256 bytes exactly, code-point truncation, omp cleaning', () => {
  const line = serializeSlot('󰚰 short', '2026-11-15T00:00:00.000Z')
  assert.equal(Buffer.byteLength(line), 256)
  assert.equal(JSON.parse(line).source, 'user')
  const long = serializeSlot('é'.repeat(300), '2026-11-15T00:00:00.000Z')
  assert.equal(Buffer.byteLength(long), 256)
  assert.match(JSON.parse(long).title, /^é+$/)
  assert.equal(cleanTitle('  a\u0007b \n\t c  '), 'a b c')
})

test('rename: rewrites the slot in place at the same length and upserts the index', async () => {
  await withAgentDir(async (dir) => {
    const db = historyDb(dir)
    const s = await sessionIn(dir)
    const before = await readFile(s.filePath)
    await renameSession(s, '  New\tname ', { probes: idle })
    const after = await readFile(s.filePath)
    assert.equal(after.length, before.length)
    assert.deepEqual(after.subarray(256), before.subarray(256))
    const reparsed = await parseSession(s.filePath, await stat(s.filePath))
    assert.equal(reparsed?.title, 'New name')
    assert.equal(reparsed?.aiTitle, null)
    const rows = db
      .prepare('SELECT session_id, title FROM session_titles ORDER BY session_id')
      .all()
    assert.deepEqual(
      rows.map((r) => [r.session_id, r.title]),
      [
        ['01a1-full-id', 'New name'],
        ['other', 'Keep']
      ]
    )
    db.close()
  })
})

test('rename: no history.db is skipped, a broken one is tolerated', async () => {
  await withAgentDir(async (dir) => {
    const s = await sessionIn(dir)
    await renameSession(s, 'one', { probes: idle })
    assert.equal(await openHistory(), null) // never created
    await writeFile(join(dir, 'history.db'), '') // empty db: no tables
    await renameSession(s, 'two', { probes: idle })
    assert.equal((await parseSession(s.filePath, await stat(s.filePath)))?.title, 'two')
    await renameSession(s, 'three', {
      probes: idle,
      openDb: async () => {
        throw new Error('busy')
      }
    })
  })
})

test('rename refuses an empty title, a live session, a failed probe, and a slotless file', async () => {
  await withAgentDir(async (dir) => {
    const s = await sessionIn(dir)
    const before = await readFile(s.filePath, 'utf8')
    await assert.rejects(renameSession(s, ' \n ', { probes: idle }), /empty/)
    await assert.rejects(
      renameSession(s, 'x', { probes: { ...idle, leases: async (ids) => new Set(ids) } }),
      /open in omp/
    )
    await assert.rejects(
      renameSession(s, 'x', { probes: { ...idle, leases: async () => null } }),
      /could not check/
    )
    assert.equal(await readFile(s.filePath, 'utf8'), before)

    const legacy = await sessionIn(join(dir, 'l'), [header(), msg('u1', null, 'user', 'hi')])
    await assert.rejects(renameSession(legacy, 'x', { probes: idle }), /no title slot/)
    const short = await sessionIn(join(dir, 's'), [header()])
    await assert.rejects(renameSession(short, 'x', { probes: idle }), /no title slot/)
    const notJson = await sessionIn(join(dir, 'j'), [`{${'x'.repeat(254)}`, header()])
    await assert.rejects(
      renameSession({ ...notJson, filePath: notJson?.filePath ?? '' }, 'x', { probes: idle }),
      /no title slot/
    )
  })
})

test('delete: trashes the transcript, artifacts, and .bak leftovers, drops title and recap rows', async () => {
  await withAgentDir(async (dir) => {
    const db = historyDb(dir)
    const s = await sessionIn(dir)
    const slug = join(dir, 'sessions', '-dev-q')
    const stem = '2026-11-01T00-00-00-000Z_01a1-full-id'
    await mkdir(join(slug, stem))
    await writeFile(join(slug, `${stem}.jsonl.123.bak`), '')
    await writeFile(join(slug, `.${stem}.jsonl.lock.os`), '')
    await writeFile(join(slug, `${stem}.jsonl.notes`), '')
    const trashed: string[] = []
    await deleteSession(s, {
      probes: idle,
      trashFn: async (paths) => {
        trashed.push(...paths)
      }
    })
    assert.deepEqual(
      trashed.sort(),
      [join(slug, stem), s.filePath, join(slug, `${stem}.jsonl.123.bak`)].sort()
    )
    const count = (table: string) =>
      (
        db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = '01a1-full-id'`)
          .get() as { n: number }
      ).n
    assert.equal(count('session_titles'), 0)
    assert.equal(count('session_recaps'), 0)
    assert.equal(count('history'), 1)
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM session_titles').get() as { n: number }).n,
      1
    )
    db.close()
  })
})

test('delete refuses a live session and tolerates a vanished directory', async () => {
  await withAgentDir(async (dir) => {
    const s = await sessionIn(dir)
    await assert.rejects(
      deleteSession(s, { probes: { ...idle, leases: async (ids) => new Set(ids) } }),
      /open in omp/
    )
    const trashed: string[] = []
    await deleteSession(
      { ...s, filePath: join(dir, 'gone', 'x.jsonl') },
      { probes: idle, trashFn: async (p) => void trashed.push(...p) }
    )
    assert.deepEqual(trashed, [])
  })
})

test('liveSessionIds: a lease, or a breadcrumb on a tty running an interactive omp', async () => {
  await withAgentDir(async (dir) => {
    const a = await sessionIn(join(dir, 'a'))
    const b = { ...a, sessionId: 'b', filePath: '/x/b.jsonl' }
    const c = { ...a, sessionId: 'c', filePath: '/x/c.jsonl' }
    const d = { ...a, sessionId: 'd', filePath: '/x/d.jsonl' }
    const all = [a, b, c, d]
    assert.deepEqual(await liveSessionIds(all, idle), new Set()) // no terminal-sessions dir
    const crumbs = join(dir, 'terminal-sessions')
    await mkdir(join(crumbs, 'ttys009'), { recursive: true }) // unreadable as a file
    await writeFile(join(crumbs, 'ttys001'), `/p\n${b.filePath}\ncwdstat 1 2\n`)
    await writeFile(join(crumbs, 'pts-3'), `/p\n${c.filePath}\n`)
    await writeFile(join(crumbs, 'ttys002'), `/p\n${d.filePath}\n`) // its omp is a worker
    await writeFile(join(crumbs, 'ttys004'), '/p\n') // no session line
    await writeFile(join(crumbs, 'tmux-%1'), `/p\n${d.filePath}\n`) // no tty to check
    const probes: Probes = {
      leases: async () => new Set(['held']),
      terminals: async () => [
        { tty: 'ttys001', command: '/Users/u/.local/bin/omp' },
        { tty: 'pts/3', command: 'omp --resume c' },
        { tty: 'ttys002', command: 'omp __omp_worker_x' },
        { tty: 'ttys002', command: 'omp session lease --json -- d' },
        { tty: 'ttys004', command: 'omp' },
        { tty: 'ttys009', command: 'omp' },
        { tty: 'ttys005', command: 'zsh' }
      ]
    }
    assert.deepEqual(await liveSessionIds(all, probes), new Set(['held', 'b', 'c']))
    assert.equal(await liveSessionIds(all, { ...probes, leases: async () => null }), null)
    assert.deepEqual(await listLive(all, { ...probes, leases: async () => null }), new Set())
    assert.deepEqual(await listLive(all, probes), new Set(['held', 'b', 'c']))
  })
})

test('quietSqlite drops only the SQLite experimental warning', () => {
  const seen: unknown[] = []
  const emit = quietSqlite(((w: unknown) => void seen.push(w)) as typeof process.emitWarning)
  emit('SQLite is an experimental feature')
  emit(new Error('SQLite again'))
  emit('something else')
  emit(new Error('another'))
  assert.equal(seen.length, 2)
})

test('the omp harness renames and deletes through its real probes', async () => {
  await withAgentDir(async (dir) => {
    const s = await sessionIn(dir, [
      slot('Old', 'auto'),
      header({ id: '00000000-clod-test-not-a-session' })
    ])
    await omp.rename(s, 'via harness')
    assert.equal((await parseSession(s.filePath, await stat(s.filePath)))?.title, 'via harness')
    // nothing exists at this path, so the real trash gets an empty list
    await omp.delete({ ...s, filePath: join(dir, 'missing', 'x.jsonl') })
  })
})
