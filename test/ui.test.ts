import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { render } from 'ink-testing-library'
import React from 'react'
import type { Session } from '../src/sessions.ts'
import App, { type AppProps } from '../src/ui.ts'
import { mkSession } from './helpers.ts'

const h = React.createElement
const delay = (ms = 60) => new Promise((r) => setTimeout(r, ms))

const KEY = {
  down: '\x1B[B',
  up: '\x1B[A',
  left: '\x1B[D',
  right: '\x1B[C',
  pageDown: '\x1B[6~',
  pageUp: '\x1B[5~',
  enter: '\r',
  esc: '\x1B',
  backspace: '\x7F',
  space: ' '
}

// A frame is styled when the host terminal supports color (the cursor's
// inverse-video codes then split the row text); strip the ANSI codes so
// text assertions see the same frame everywhere.
function plain(frame: string | undefined): string {
  return (frame ?? '')
    .split('\x1B')
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, '')))
    .join('')
}

// A real transcript so preview/delete panes can load messages.
async function transcript(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clod-ui-'))
  const file = join(dir, 'sid.jsonl')
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return file
}

function renderApp(sessions: Session[], overrides: Partial<AppProps> = {}) {
  const resumed: Session[] = []
  const deleted: string[] = []
  const renamed: [string, string][] = []
  const props: AppProps = {
    loadFirst: () => Promise.resolve(sessions),
    loadRest: null,
    onResume: (s) => resumed.push(s),
    onDelete: async (fp) => {
      deleted.push(fp)
    },
    onRename: async (fp, title) => {
      renamed.push([fp, title])
    },
    ...overrides
  }
  return { ...render(h(App, props)), resumed, deleted, renamed }
}

test('renders a loading frame, then the session list with a snippet', async () => {
  const now = Date.now()
  const s1 = mkSession({
    sessionId: 's1',
    title: 'first task',
    cwd: '/p/a',
    gitBranch: 'main',
    throughput: 1000,
    contextTokens: 5000,
    lastUserMessage: 'do the thing',
    lastTimestamp: now
  })
  const s2 = mkSession({
    sessionId: 's2',
    title: 'second task',
    cwd: '/p/b',
    lastTimestamp: now - 1000
  })
  const { lastFrame, unmount } = renderApp([s1, s2])
  assert.match(lastFrame() ?? '', /loading sessions/)
  await delay()
  assert.match(lastFrame() ?? '', /first task/)
  assert.match(lastFrame() ?? '', /second task/)
  assert.match(lastFrame() ?? '', /do the thing/)
  unmount()
})

test('loadRest merges a background batch; loadFirst may return a plain array', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'alpha', lastTimestamp: 2 })
  const s2 = mkSession({ sessionId: 's2', title: 'beta', lastTimestamp: 1 })
  const { lastFrame, unmount } = renderApp([s1], {
    loadFirst: () => [s1],
    loadRest: () => Promise.resolve([s2])
  })
  await delay()
  const frame = lastFrame() ?? ''
  assert.match(frame, /alpha/)
  assert.match(frame, /beta/)
  assert.match(frame, /2 sessions/)
  unmount()
})

test('empty result shows no-sessions state', async () => {
  const { lastFrame, unmount } = renderApp([])
  await delay()
  assert.match(lastFrame() ?? '', /0 sessions/)
  assert.match(lastFrame() ?? '', /no user messages/)
  unmount()
})

test('arrow and page keys move the selection', async () => {
  const sessions = Array.from({ length: 8 }, (_, i) =>
    mkSession({ sessionId: `s${i}`, title: `task ${i}`, lastTimestamp: 100 - i })
  )
  const { lastFrame, stdin, unmount } = renderApp(sessions)
  await delay()
  stdin.write(KEY.down)
  stdin.write(KEY.down)
  stdin.write(KEY.up)
  stdin.write(KEY.pageDown)
  stdin.write(KEY.pageUp)
  await delay(20)
  assert.match(lastFrame() ?? '', /task 0/)
  unmount()
})

test('search filters, supports backspace and escape', async () => {
  const s1 = mkSession({
    sessionId: 's1',
    title: 'ratchet work',
    searchText: 'ratchet',
    lastTimestamp: 2
  })
  const s2 = mkSession({
    sessionId: 's2',
    title: 'unrelated',
    searchText: 'nope',
    lastTimestamp: 1
  })
  const { lastFrame, stdin, unmount } = renderApp([s1, s2])
  await delay()
  stdin.write('/')
  await delay(20) // let isSearching flush before typing
  for (const c of 'ratchet') stdin.write(c)
  await delay(20)
  assert.match(lastFrame() ?? '', /\/ratchet/)
  assert.match(lastFrame() ?? '', /1 matches/)
  stdin.write('\x01') // ctrl char: ignored as search input
  stdin.write(KEY.backspace) // delete a char
  await delay(20)
  stdin.write(KEY.esc) // clear search
  await delay(20)
  assert.match(lastFrame() ?? '', /unrelated/)
  unmount()
})

test('search: backspace on empty query exits search; no-match enter is a no-op', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'alpha', searchText: 'alpha' })
  const { stdin, resumed, unmount } = renderApp([s1])
  await delay()
  stdin.write('/')
  await delay(20)
  stdin.write(KEY.backspace) // empty -> leave search
  await delay(20)
  stdin.write('/')
  await delay(20)
  stdin.write('z') // no matches
  await delay(20)
  stdin.write(KEY.enter) // nothing selected -> no resume
  await delay(20)
  assert.equal(resumed.length, 0)
  unmount()
})

test('search: navigation keys work while searching, enter resumes', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'task one', searchText: 'task', lastTimestamp: 3 })
  const s2 = mkSession({ sessionId: 's2', title: 'task two', searchText: 'task', lastTimestamp: 2 })
  const { stdin, resumed, unmount } = renderApp([s1, s2])
  await delay()
  stdin.write('/')
  await delay(20)
  stdin.write('t')
  await delay(20)
  stdin.write(KEY.down)
  stdin.write(KEY.up)
  stdin.write(KEY.pageDown)
  stdin.write(KEY.pageUp)
  stdin.write(KEY.enter)
  await delay(20)
  assert.equal(resumed.length, 1)
  unmount()
})

test('preview opens, scrolls, and closes; loads messages', async () => {
  const file = await transcript([
    { type: 'user', message: { role: 'user', content: 'question one' }, timestamp: 't1' },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] },
      timestamp: 't2'
    }
  ])
  const s1 = mkSession({ sessionId: 's1', title: 'previewed', filePath: file })
  const { lastFrame, stdin, unmount } = renderApp([s1])
  await delay()
  stdin.write(KEY.space) // open preview
  await delay()
  assert.match(lastFrame() ?? '', /Preview: previewed/)
  assert.match(lastFrame() ?? '', /question one/)
  stdin.write(KEY.down)
  stdin.write(KEY.up)
  await delay(20)
  stdin.write(KEY.space) // close
  await delay(20)
  assert.doesNotMatch(lastFrame() ?? '', /Preview:/)
  unmount()
})

test('preview with no messages shows empty state; closes via q', async () => {
  const file = await transcript([
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }
  ])
  const s1 = mkSession({ sessionId: 's1', title: 'empty one', filePath: file })
  const { lastFrame, stdin, unmount } = renderApp([s1])
  await delay()
  stdin.write(KEY.space)
  await delay()
  assert.match(lastFrame() ?? '', /No messages found/)
  stdin.write('q')
  await delay(20)
  assert.doesNotMatch(lastFrame() ?? '', /Preview:/)
  unmount()
})

test('usage dashboard opens and closes', async () => {
  const s1 = mkSession({
    sessionId: 's1',
    title: 'x',
    throughput: 1000,
    models: { opus: { input: 500, output: 100, cacheWrite: 400, cacheRead: 9000 } },
    totals: { input: 500, output: 100, cacheWrite: 400, cacheRead: 9000 },
    lastTimestamp: Date.now()
  })
  const { lastFrame, stdin, unmount } = renderApp([s1])
  await delay()
  stdin.write('u')
  await delay(20)
  assert.match(lastFrame() ?? '', /Usage/)
  assert.match(lastFrame() ?? '', /By model/)
  stdin.write('u') // toggle back
  await delay(20)
  assert.doesNotMatch(lastFrame() ?? '', /By model/)
  unmount()
})

test('delete: cancel keeps the session, confirm removes it', async () => {
  const file = await transcript([
    { type: 'user', message: { role: 'user', content: 'hello there' }, timestamp: 't1' }
  ])
  const s1 = mkSession({ sessionId: 's1', title: 'keep me', filePath: file, lastTimestamp: 2 })
  const s2 = mkSession({ sessionId: 's2', title: 'delete me', filePath: file, lastTimestamp: 1 })
  const { lastFrame, stdin, deleted, unmount } = renderApp([s1, s2])
  await delay()
  stdin.write(KEY.down) // select s2
  stdin.write('D')
  await delay()
  assert.match(lastFrame() ?? '', /Delete: delete me/)
  assert.match(lastFrame() ?? '', /hello there/)
  stdin.write('n') // cancel
  await delay(20)
  assert.doesNotMatch(lastFrame() ?? '', /Delete:/)
  stdin.write('D')
  await delay()
  stdin.write('y') // confirm
  await delay(20)
  assert.equal(deleted.length, 1)
  assert.doesNotMatch(lastFrame() ?? '', /delete me/)
  unmount()
})

test('rename: r opens input prefilled with the title, enter confirms', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'old', filePath: '/tmp/s1.jsonl' })
  const { lastFrame, stdin, renamed, unmount } = renderApp([s1])
  await delay()
  stdin.write('r')
  await delay(20)
  assert.match(lastFrame() ?? '', /> old█/)
  assert.match(lastFrame() ?? '', /enter confirm {2}esc cancel/)
  for (const c of 'er') stdin.write(c)
  await delay(20)
  stdin.write(KEY.enter)
  await delay(20)
  assert.deepEqual(renamed, [['/tmp/s1.jsonl', 'older']])
  assert.match(lastFrame() ?? '', /older/)
  assert.doesNotMatch(lastFrame() ?? '', /█/)
  unmount()
})

test('rename: row shows the new title before the write resolves (no flicker)', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'old' })
  const { lastFrame, stdin, unmount } = renderApp([s1], {
    onRename: () => new Promise(() => {}) // never resolves
  })
  await delay()
  stdin.write('r')
  await delay(20)
  for (const c of 'er') stdin.write(c)
  await delay(20)
  stdin.write(KEY.enter)
  await delay(20)
  assert.match(lastFrame() ?? '', /older/)
  unmount()
})

test('rename: esc discards, backspace edits, null title prefills Untitled', async () => {
  const s1 = mkSession({ sessionId: 's1', title: null })
  const { lastFrame, stdin, renamed, unmount } = renderApp([s1])
  await delay()
  stdin.write('r')
  await delay(20)
  assert.match(lastFrame() ?? '', /> Untitled█/)
  stdin.write(KEY.backspace)
  stdin.write('\x01') // ctrl char: ignored as input
  await delay(20)
  assert.match(lastFrame() ?? '', /> Untitle█/)
  stdin.write(KEY.esc)
  await delay(20)
  assert.equal(renamed.length, 0)
  assert.match(lastFrame() ?? '', /Untitled/)
  unmount()
})

// Mid-line cursor positions are asserted through where insertions and
// deletions land, not through the cursor cell itself.
test('rename: arrows move the cursor, typing and backspace act at it', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'old name' })
  const { lastFrame, stdin, unmount } = renderApp([s1])
  await delay()
  stdin.write('r')
  await delay(20)
  stdin.write(KEY.left)
  stdin.write(KEY.left)
  await delay(20)
  stdin.write('X') // insert at the cursor, not append
  await delay(20)
  assert.match(plain(lastFrame()), /> old naXme/)
  stdin.write(KEY.right) // step over the m
  await delay(20)
  stdin.write(KEY.backspace) // delete at the cursor, not the end
  await delay(20)
  assert.match(plain(lastFrame()), /> old naXe/)
  for (let i = 0; i < 10; i++) stdin.write(KEY.left) // past the start: clamped
  await delay(20)
  stdin.write('Y')
  await delay(20)
  assert.match(plain(lastFrame()), /> Yold naXe/)
  for (let i = 0; i < 12; i++) stdin.write(KEY.right) // past the end: clamped
  await delay(20)
  assert.match(plain(lastFrame()), /> Yold naXe█/)
  unmount()
})

test('rename: empty and unchanged values confirm without renaming', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'same' })
  const { stdin, renamed, unmount } = renderApp([s1])
  await delay()
  stdin.write('r')
  await delay(20)
  stdin.write(KEY.enter) // unchanged -> no write
  await delay(20)
  stdin.write('r')
  await delay(20)
  for (let i = 0; i < 4; i++) stdin.write(KEY.backspace)
  await delay(20)
  stdin.write(KEY.enter) // empty -> no write
  await delay(20)
  assert.equal(renamed.length, 0)
  unmount()
})

test('sort cycle reaches directory grouping (headers rendered)', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'a', cwd: '/proj/one', lastTimestamp: 2 })
  const s2 = mkSession({ sessionId: 's2', title: 'b', cwd: '/proj/two', lastTimestamp: 1 })
  const { lastFrame, stdin, unmount } = renderApp([s1, s2])
  await delay()
  stdin.write('s') // recent -> lexic
  await delay(20)
  stdin.write('s') // lexic -> directory
  await delay(20)
  assert.match(lastFrame() ?? '', /grouped by directory/)
  assert.match(lastFrame() ?? '', /proj\/one/)
  unmount()
})

test('enter resumes the selected session; q quits', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'resume me' })
  const { stdin, resumed, unmount } = renderApp([s1])
  await delay()
  stdin.write(KEY.enter)
  await delay(20)
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].sessionId, 's1')
  stdin.write('q')
  await delay(20)
  unmount()
})

test('escape quits from the list', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'x' })
  const { stdin, unmount } = renderApp([s1])
  await delay()
  stdin.write(KEY.esc)
  await delay(20)
  unmount()
})

test('initialSortMode is honored', async () => {
  const s1 = mkSession({ sessionId: 's1', title: 'a', cwd: '/proj/one', lastTimestamp: 2 })
  const { lastFrame, unmount } = renderApp([s1], { initialSortMode: 'lexic' })
  await delay()
  assert.match(lastFrame() ?? '', /sorted lexicographically/)
  unmount()
})
