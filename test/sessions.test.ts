import assert from 'node:assert/strict'
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deleteSession,
  extractText,
  fmtTokens,
  getSessionMessages,
  listSessionFiles,
  loadSessions,
  parseSession,
  relativeTime,
  renameSession,
  shortPath,
  textBlocks,
  throughputOf
} from '../src/sessions.ts'

type Rec = Record<string, unknown> | string

// Write records to a temp .jsonl and return its path + stats.
async function makeFile(records: Rec[], nl = true): Promise<{ file: string; stat: Stats }> {
  const dir = await mkdtemp(join(tmpdir(), 'clod-sess-'))
  const file = join(dir, 'sid.jsonl')
  const body = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')
  await writeFile(file, nl ? `${body}\n` : body)
  return { file, stat: await stat(file) }
}

const assistant = (o: Record<string, unknown>) => ({ type: 'assistant', ...o })

test('parseSession: full session with title, branch, usage, search text', async () => {
  const { file, stat: st } = await makeFile([
    { type: 'custom-title', customTitle: 'ESLint Ratchet', sessionId: 'sid' },
    {
      type: 'user',
      message: { role: 'user', content: 'Help with the RATCHET check' },
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/home/u/proj',
      gitBranch: 'HEAD'
    },
    assistant({
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: 'Working on it' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0
        }
      },
      timestamp: '2026-01-01T00:01:00Z',
      cwd: '/home/u/proj',
      gitBranch: 'main'
    }),
    assistant({
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'Done' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 9000
        }
      },
      timestamp: '2026-01-01T00:02:00Z',
      cwd: '/home/u/proj',
      gitBranch: 'feature/x'
    })
  ])
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.equal(s.title, 'ESLint Ratchet')
  assert.equal(s.cwd, '/home/u/proj')
  assert.equal(s.gitBranch, 'feature/x') // HEAD skipped, last real branch wins
  assert.equal(s.lastUserMessage, 'Help with the RATCHET check')
  assert.deepEqual(s.totals, { input: 110, output: 55, cacheWrite: 220, cacheRead: 9000 })
  assert.equal(s.throughput, 385) // 110 + 55 + 220
  assert.equal(s.contextTokens, 9030) // last turn input + cacheRead + cacheWrite
  assert.deepEqual(Object.keys(s.models).sort(), ['opus', 'sonnet'])
  assert.ok(s.searchText.includes('ratchet'))
  assert.ok(s.searchText.includes('working on it'))
  assert.equal(s.lastTimestamp, new Date('2026-01-01T00:02:00Z').getTime())
})

test('parseSession: unknown model still yields context, no model bucket', async () => {
  const { file, stat: st } = await makeFile([
    {
      type: 'user',
      message: { role: 'user', content: 'hi' },
      cwd: '/p/x',
      gitBranch: 'HEAD',
      timestamp: '2026-01-01T00:00:00Z'
    },
    assistant({
      message: {
        role: 'assistant',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 5, output_tokens: 5 }
      },
      timestamp: '2026-01-01T00:01:00Z'
    })
  ])
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.equal(s.gitBranch, null) // only HEAD seen
  assert.deepEqual(s.models, {})
  assert.equal(s.contextTokens, 5)
  assert.equal(s.throughput, 0)
})

test('parseSession: model and usage edge branches (haiku, no model, missing input, no usage)', async () => {
  const { file, stat: st } = await makeFile([
    {
      type: 'user',
      message: { role: 'user', content: 'x' },
      cwd: '/p/e',
      timestamp: '2026-01-01T00:00:00Z'
    },
    assistant({
      message: {
        role: 'assistant',
        model: 'claude-haiku-4',
        content: [{ type: 'text', text: 'h' }],
        usage: { output_tokens: 5 }
      },
      timestamp: '2026-01-01T00:01:00Z'
    }),
    assistant({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'n' }],
        usage: { input_tokens: 3 }
      },
      timestamp: '2026-01-01T00:02:00Z'
    }), // no model
    assistant({
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: 'z' }]
      },
      timestamp: '2026-01-01T00:03:00Z'
    }) // no usage
  ])
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.ok('haiku' in s.models)
  assert.equal(s.models.haiku.input, 0) // input_tokens absent -> 0
  assert.deepEqual(Object.keys(s.models), ['haiku']) // no-model turn creates no bucket
})

test('parseSession: assistant without usage leaves context null; textBlocks handles missing content', async () => {
  const { file, stat: st } = await makeFile([
    {
      type: 'user',
      message: { role: 'user', content: 'hey' },
      cwd: '/p/y',
      timestamp: '2026-01-01T00:00:00Z'
    },
    assistant({
      message: { role: 'assistant', model: 'claude-opus-4', usage: { input_tokens: 1 } },
      timestamp: '2026-01-01T00:01:00Z'
    })
  ])
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.equal(s.contextTokens, 1) // usage present -> context set even with no content
})

test('parseSession: injected/meta/tool/system/attachment/malformed lines and array content', async () => {
  const { file, stat: st } = await makeFile([
    '',
    {
      type: 'user',
      message: { role: 'user', content: '<system-reminder>ignore</system-reminder>' },
      cwd: '/p/z',
      timestamp: '2026-01-01T00:00:00Z'
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<injected>' },
          { type: 'text', text: 'real question' }
        ]
      },
      timestamp: '2026-01-01T00:00:30Z'
    },
    { type: 'user', message: { role: 'user' } }, // no content
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }]
      },
      timestamp: '2026-01-01T00:01:00Z',
      gitBranch: ''
    },
    { type: 'system', subtype: 'x', timestamp: '2026-01-01T00:01:10Z' },
    { type: 'attachment', timestamp: '2026-01-01T00:01:20Z' },
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"broken',
    { type: 'custom-title', sessionId: 'x' }, // no customTitle
    '{"type":"custom-title","customTitle":'
  ])
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.equal(s.cwd, '/p/z')
  assert.equal(s.title, null)
  assert.equal(s.lastUserMessage, 'real question')
  assert.equal(s.searchText, 'real question')
})

test('parseSession: cwd set but no timestamp falls back to mtime; file without trailing newline', async () => {
  const { file, stat: st } = await makeFile(
    [{ type: 'user', message: { role: 'user', content: 'no time' }, cwd: '/p/nt' }],
    false
  )
  const s = await parseSession(file, st)
  assert.ok(s)
  assert.equal(s.lastTimestamp, st.mtimeMs)
})

test('parseSession: returns null when no cwd is ever found', async () => {
  const { file, stat: st } = await makeFile([
    assistant({
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1 }
      },
      timestamp: '2026-01-01T00:00:00Z'
    })
  ])
  assert.equal(await parseSession(file, st), null)
})

test('parseSession: returns null when the file cannot be read', async () => {
  const { stat: st } = await makeFile([
    { type: 'user', message: { role: 'user', content: 'x' }, cwd: '/p' }
  ])
  assert.equal(await parseSession('/no/such/file.jsonl', st), null)
})

test('extractText / textBlocks fallbacks', () => {
  assert.equal(extractText('hello'), 'hello')
  assert.equal(extractText([{ type: 'text', text: 'a' }]), 'a')
  assert.equal(extractText([{ type: 'tool_use' }]), '') // no text block found
  assert.equal(extractText([{ type: 'text' }]), '') // text block with no text field
  assert.equal(extractText(undefined), '')
  assert.equal(textBlocks('hello'), 'hello')
  assert.equal(
    textBlocks([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' }
    ]),
    'a b'
  )
  assert.equal(textBlocks([{ type: 'text' }, { type: 'text', text: 'b' }]), ' b') // missing text -> ''
  assert.equal(textBlocks(undefined), '')
})

test('throughputOf', () => {
  assert.equal(throughputOf({ input: 10, output: 5, cacheWrite: 3, cacheRead: 99 }), 18)
  assert.equal(throughputOf({}), 0)
})

test('relativeTime', () => {
  const RealDate = Date
  const fixed = new RealDate(2026, 6, 3, 15, 0, 0).getTime() // Jul 3 2026, 15:00 local
  class FakeDate extends RealDate {
    constructor(ms?: number) {
      super(ms ?? fixed)
    }
    static now() {
      return fixed
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor
  try {
    assert.equal(relativeTime(fixed), 'now')
    assert.equal(relativeTime(fixed - 5 * 60000), '5m')
    assert.equal(relativeTime(fixed - 3 * 3600000), '3h')
    assert.equal(relativeTime(new RealDate(2026, 5, 1, 12, 0, 0).getTime()), 'Jun 1')
    assert.equal(relativeTime(new RealDate(2025, 5, 1, 12, 0, 0).getTime()), 'Jun 1 2025')
  } finally {
    globalThis.Date = RealDate
  }
})

test('shortPath / fmtTokens', () => {
  assert.equal(shortPath(join(homedir(), 'proj')), '~/proj')
  assert.equal(fmtTokens(500), '500')
  assert.equal(fmtTokens(12000), '12k')
  assert.equal(fmtTokens(3_400_000), '3.4M')
  assert.equal(fmtTokens(2_000_000_000), '2.0B')
})

// ─── HOME-scoped IO ─────────────────────────────────────────────────────────

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const prev = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clod-home-'))
  process.env.HOME = home
  try {
    return await fn(home)
  } finally {
    process.env.HOME = prev
  }
}

test('listSessionFiles: collects .jsonl newest-first, skips junk, returns [] with no projects dir', async () => {
  await withHome(async (home) => {
    assert.deepEqual(await listSessionFiles(), []) // no ~/.claude/projects yet

    const projects = join(home, '.claude', 'projects')
    await mkdir(join(projects, 'proj-a'), { recursive: true })
    await mkdir(join(projects, 'proj-b'), { recursive: true })
    await writeFile(join(projects, 'proj-a', 'older.jsonl'), '{}\n')
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(join(projects, 'proj-b', 'newer.jsonl'), '{}\n')
    await writeFile(join(projects, 'proj-a', 'notes.txt'), 'ignore me')
    await writeFile(join(projects, 'a-file-not-a-dir'), 'x') // readdir on it throws -> skipped
    await symlink(join(projects, 'missing-target.jsonl'), join(projects, 'proj-a', 'broken.jsonl')) // stat throws -> filtered

    const files = await listSessionFiles()
    assert.deepEqual(
      files.map((f) => f.filePath.split('/').at(-1)),
      ['newer.jsonl', 'older.jsonl']
    )
  })
})

test('loadSessions: parses and sorts by lastTimestamp', async () => {
  await withHome(async (home) => {
    const proj = join(home, '.claude', 'projects', 'p')
    await mkdir(proj, { recursive: true })
    await writeFile(
      join(proj, 's1.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, cwd: '/p', timestamp: '2026-01-01T00:00:00Z' })}\n`
    )
    await writeFile(
      join(proj, 's2.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' }, cwd: '/p', timestamp: '2026-02-01T00:00:00Z' })}\n`
    )
    const sessions = await loadSessions()
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].sessionId, 's2') // newer first
  })
})

test('getSessionMessages: user + assistant, joins text, skips empties/meta/malformed; [] on missing', async () => {
  const { file } = await makeFile([
    { type: 'user', message: { role: 'user', content: 'q1' }, timestamp: 't1' },
    assistant({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a1' },
          { type: 'text', text: ' more' }
        ]
      },
      timestamp: 't2'
    }),
    assistant({ message: { role: 'assistant', content: 'string reply' }, timestamp: 't3' }),
    assistant({ message: { role: 'assistant', content: [{ type: 'tool_use' }] }, timestamp: 't4' }), // no text -> skipped
    'not json',
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }
    } // not a real user msg
  ])
  const msgs = await getSessionMessages(file)
  assert.deepEqual(msgs, [
    { role: 'user', text: 'q1', timestamp: 't1' },
    { role: 'assistant', text: 'a1 more', timestamp: 't2' },
    { role: 'assistant', text: 'string reply', timestamp: 't3' }
  ])
  assert.deepEqual(await getSessionMessages('/no/such.jsonl'), [])
})

test('getSessionMessages: text blocks with no text field', async () => {
  const { file } = await makeFile([
    { type: 'user', message: { role: 'user', content: [{ type: 'text' }] } }, // no text -> ''
    assistant({ message: { role: 'assistant', content: [{ type: 'text' }] } }) // no text -> '' -> skipped
  ])
  assert.deepEqual(await getSessionMessages(file), [
    { role: 'user', text: '', timestamp: undefined }
  ])
})

test('renameSession: appends custom-title and agent-name records, parseSession picks up', async () => {
  const { file } = await makeFile([
    { type: 'custom-title', customTitle: 'old name', sessionId: 'sid' },
    { type: 'agent-name', agentName: 'old name', sessionId: 'sid' },
    {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/home/u/proj'
    }
  ])

  await renameSession(file, 'new name')

  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  assert.deepEqual(
    lines.slice(-2).map((l) => JSON.parse(l)),
    [
      { type: 'custom-title', customTitle: 'new name', sessionId: 'sid' },
      { type: 'agent-name', agentName: 'new name', sessionId: 'sid' }
    ]
  )

  const s = await parseSession(file, await stat(file))
  assert.ok(s)
  assert.equal(s.title, 'new name')
})

test('deleteSession: trashes all keyed artifacts and scrubs history', async () => {
  await withHome(async (home) => {
    const claude = join(home, '.claude')
    const proj = join(claude, 'projects', 'p')
    await mkdir(proj, { recursive: true })
    const file = join(proj, 'sid.jsonl')
    await writeFile(file, '{}\n')
    await mkdir(join(proj, 'sid'), { recursive: true }) // sibling dir
    await writeFile(join(proj, 'sid', 'sub.jsonl'), '{}\n')
    for (const d of ['tasks', 'file-history', 'session-env']) {
      await mkdir(join(claude, d, 'sid'), { recursive: true })
    }
    await mkdir(join(claude, 'debug'), { recursive: true })
    await writeFile(join(claude, 'debug', 'sid.txt'), 'log')
    await mkdir(join(claude, 'telemetry'), { recursive: true })
    await writeFile(join(claude, 'telemetry', '1p_failed_events.sid.1.json'), '{}')
    await writeFile(join(claude, 'telemetry', '1p_failed_events.other.1.json'), '{}')
    const history = join(claude, 'history.jsonl')
    await writeFile(
      history,
      `${JSON.stringify({ sessionId: 'sid', p: 1 })}\n${JSON.stringify({ sessionId: 'keep', p: 2 })}\n`
    )

    const trashed: string[] = []
    const fakeTrash = async (paths: string | readonly string[]) => {
      for (const p of Array.isArray(paths) ? paths : [paths]) trashed.push(p)
    }

    await deleteSession(file, fakeTrash)

    assert.ok(trashed.includes(file))
    assert.ok(trashed.includes(join(proj, 'sid')))
    assert.ok(trashed.includes(join(claude, 'tasks', 'sid')))
    assert.ok(trashed.includes(join(claude, 'file-history', 'sid')))
    assert.ok(trashed.includes(join(claude, 'session-env', 'sid')))
    assert.ok(trashed.includes(join(claude, 'debug', 'sid.txt')))
    assert.ok(trashed.includes(join(claude, 'telemetry', '1p_failed_events.sid.1.json')))
    assert.ok(!trashed.includes(join(claude, 'telemetry', '1p_failed_events.other.1.json')))
    // history scrubbed to only the surviving line, removed lines trashed
    assert.equal(
      await readFile(history, 'utf8'),
      `${JSON.stringify({ sessionId: 'keep', p: 2 })}\n`
    )
    assert.ok(trashed.some((p) => p.includes('history-removed-sid.jsonl')))
  })
})

test('deleteSession: no telemetry dir, no history file -> single trash call, no throw', async () => {
  await withHome(async (home) => {
    const proj = join(home, '.claude', 'projects', 'p')
    await mkdir(proj, { recursive: true })
    const file = join(proj, 'sid.jsonl')
    await writeFile(file, '{}\n')

    const trashed: string[] = []
    await deleteSession(file, async (paths) => {
      for (const p of Array.isArray(paths) ? paths : [paths]) trashed.push(p)
    })
    assert.deepEqual(trashed, [file]) // only the transcript existed; history absent -> no scrub trash
  })
})

test('deleteSession: history without the session id is left untouched', async () => {
  await withHome(async (home) => {
    const claude = join(home, '.claude')
    const proj = join(claude, 'projects', 'p')
    await mkdir(proj, { recursive: true })
    const file = join(proj, 'sid.jsonl')
    await writeFile(file, '{}\n')
    const history = join(claude, 'history.jsonl')
    await writeFile(history, `${JSON.stringify({ sessionId: 'other' })}\n`)

    const trashed: string[] = []
    await deleteSession(file, async (paths) => {
      for (const p of Array.isArray(paths) ? paths : [paths]) trashed.push(p)
    })
    assert.deepEqual(trashed, [file]) // no history-removed trash
    assert.equal(await readFile(history, 'utf8'), `${JSON.stringify({ sessionId: 'other' })}\n`)
  })
})
