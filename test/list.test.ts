import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BRANCH_MIN,
  buildDisplayItems,
  computeNavigate,
  computePage,
  computeRowLayout,
  ctxStr,
  type DisplayItem,
  filterItems,
  findAdjacentSessionId,
  fuzzyMatch,
  nextSortMode,
  pad,
  padLeft,
  sessionMatches,
  termSize,
  truncate,
  usedStr
} from '../src/list.ts'
import { mkSession } from './helpers.ts'

test('truncate', () => {
  assert.equal(truncate(null, 5), '')
  assert.equal(truncate('', 5), '')
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 4), 'abc…')
})

test('pad', () => {
  assert.equal(pad('ab', 5), 'ab   ')
  assert.equal(pad('abcdef', 3), 'abc')
  assert.equal(pad('abc', 3), 'abc')
})

test('termSize', () => {
  assert.deepEqual(termSize({ columns: 120, rows: 40 }), { width: 120, height: 40 })
  assert.deepEqual(termSize({}), { width: 80, height: 24 }) // non-TTY: no columns/rows
  assert.deepEqual(termSize(), { width: 80, height: 24 }) // no stdout at all
})

test('padLeft', () => {
  assert.equal(padLeft('ab', 5), '   ab')
  assert.equal(padLeft('abcdef', 3), 'abc')
})

test('fuzzyMatch', () => {
  assert.equal(fuzzyMatch('', 'anything'), true)
  assert.equal(fuzzyMatch('abc', 'aXbXc'), true)
  assert.equal(fuzzyMatch('RTK', 'ratchet kit'), true)
  assert.equal(fuzzyMatch('zzz', 'abc'), false)
})

test('sessionMatches: title fuzzy, content substring, miss', () => {
  const s = mkSession({ title: 'eslint ratchet', searchText: 'the warnings ratchet check' })
  assert.equal(sessionMatches('ratchet', s), true) // title fuzzy
  const s2 = mkSession({ title: 'unrelated', searchText: 'contains ratchet inside' })
  assert.equal(sessionMatches('ratchet', s2), true) // content substring
  const s3 = mkSession({ title: 'unrelated', searchText: 'nothing here' })
  assert.equal(sessionMatches('ratchet', s3), false)
  const s4 = mkSession({ title: 'unrelated', searchText: '' })
  assert.equal(sessionMatches('zzz', s4), false) // empty searchText
  assert.equal(sessionMatches('untitled', mkSession({ title: null, searchText: '' })), true) // null title -> 'Untitled'
})

test('usedStr / ctxStr', () => {
  assert.equal(usedStr(mkSession({ throughput: 0 })), '—')
  assert.equal(usedStr(mkSession({ throughput: 12000 })), '12k used')
  assert.equal(ctxStr(mkSession({ contextTokens: null })), '—')
  assert.equal(ctxStr(mkSession({ contextTokens: 5000 })), '5k ctx')
})

test('computeRowLayout: wide terminal shows branch and dir', () => {
  const s = mkSession({
    title: 'fix bug',
    gitBranch: 'feature/x',
    cwd: '/home/u/proj',
    throughput: 1000
  })
  const r = computeRowLayout({
    session: s,
    termWidth: 120,
    sortMode: 'recent',
    timeWidth: 4,
    usedWidth: 8,
    ctxWidth: 6
  })
  assert.equal(r.branchCol, 'feature/x')
  assert.equal(r.dirCol, '/home/u/proj')
  assert.ok(r.title.startsWith('fix bug'))
})

test('computeRowLayout: directory mode hides dir', () => {
  const s = mkSession({ gitBranch: 'main', cwd: '/home/u/proj' })
  const r = computeRowLayout({
    session: s,
    termWidth: 120,
    sortMode: 'directory',
    timeWidth: 4,
    usedWidth: 8,
    ctxWidth: 6
  })
  assert.equal(r.dirCol, null)
  assert.equal(r.branchCol, 'main')
})

test('computeRowLayout: narrow terminal hides branch and dir, truncates title', () => {
  const s = mkSession({
    title: 'a very long session title that will not fit',
    gitBranch: 'main',
    cwd: '/home/u/proj'
  })
  const r = computeRowLayout({
    session: s,
    termWidth: 40,
    sortMode: 'recent',
    timeWidth: 4,
    usedWidth: 8,
    ctxWidth: 6
  })
  assert.equal(r.branchCol, null)
  assert.equal(r.dirCol, null)
  assert.ok(r.title.includes('…'))
})

test('computeRowLayout: no branch', () => {
  const s = mkSession({ gitBranch: null })
  const r = computeRowLayout({
    session: s,
    termWidth: 120,
    sortMode: 'recent',
    timeWidth: 4,
    usedWidth: 8,
    ctxWidth: 6
  })
  assert.equal(r.branchCol, null)
})

test('computeRowLayout: untitled session', () => {
  const r = computeRowLayout({
    session: mkSession({ title: null, gitBranch: 'main' }),
    termWidth: 120,
    sortMode: 'recent',
    timeWidth: 4,
    usedWidth: 8,
    ctxWidth: 6
  })
  assert.ok(r.title.startsWith('Untitled'))
})

test('BRANCH_MIN exported', () => {
  assert.equal(typeof BRANCH_MIN, 'number')
})

test('buildDisplayItems: recent sorts by timestamp desc', () => {
  const a = mkSession({ sessionId: 'a', lastTimestamp: 100 })
  const b = mkSession({ sessionId: 'b', lastTimestamp: 300 })
  const c = mkSession({ sessionId: 'c', lastTimestamp: 200 })
  const items = buildDisplayItems([a, b, c], 'recent')
  assert.deepEqual(
    items.map((i) => (i.type === 'session' ? i.session.sessionId : `#${i.cwd}`)),
    ['b', 'c', 'a']
  )
})

test('buildDisplayItems: lexic sorts by title then timestamp', () => {
  const a = mkSession({ sessionId: 'a', title: 'zebra', lastTimestamp: 1 })
  const b = mkSession({ sessionId: 'b', title: 'apple', lastTimestamp: 1 })
  const c1 = mkSession({ sessionId: 'c1', title: 'mango', lastTimestamp: 1 })
  const c2 = mkSession({ sessionId: 'c2', title: 'mango', lastTimestamp: 5 })
  const u1 = mkSession({ sessionId: 'u1', title: null, lastTimestamp: 1 })
  const u2 = mkSession({ sessionId: 'u2', title: null, lastTimestamp: 2 })
  const items = buildDisplayItems([a, b, c1, c2, u1, u2], 'lexic')
  const ids = items.map((i) => (i.type === 'session' ? i.session.sessionId : '')).filter(Boolean)
  // both 'Untitled' (uppercase U) sort before 'apple', newer-first between them; then mango, zebra
  assert.deepEqual(ids, ['u2', 'u1', 'b', 'c2', 'c1', 'a'])
})

test('buildDisplayItems: directory groups with headers, latest-active group first', () => {
  const a = mkSession({ sessionId: 'a', cwd: '/p/old', lastTimestamp: 10 })
  const b = mkSession({ sessionId: 'b', cwd: '/p/new', lastTimestamp: 100 })
  const c = mkSession({ sessionId: 'c', cwd: '/p/new', lastTimestamp: 90 })
  const items = buildDisplayItems([a, b, c], 'directory')
  assert.deepEqual(
    items.map((i) => (i.type === 'header' ? `H:${i.cwd}` : i.session.sessionId)),
    ['H:/p/new', 'b', 'c', 'H:/p/old', 'a']
  )
})

test('filterItems: empty query returns input; headers kept only with a matching child', () => {
  const items = buildDisplayItems(
    [
      mkSession({ sessionId: 'a', title: 'ratchet work', cwd: '/p/x', lastTimestamp: 2 }),
      mkSession({ sessionId: 'b', title: 'unrelated', cwd: '/p/y', lastTimestamp: 1 })
    ],
    'directory'
  )
  assert.equal(filterItems(items, ''), items)
  const filtered = filterItems(items, 'ratchet')
  assert.deepEqual(
    filtered.map((i) => (i.type === 'header' ? `H:${i.cwd}` : i.session.sessionId)),
    ['H:/p/x', 'a']
  )
})

// A directory-grouped item list for navigation tests:
// 0:H 1:s1 2:s2 3:H 4:s3 5:s4 6:H 7:s5 8:s6
function grouped(): DisplayItem[] {
  return buildDisplayItems(
    [
      mkSession({ sessionId: 's1', cwd: '/a', lastTimestamp: 90 }),
      mkSession({ sessionId: 's2', cwd: '/a', lastTimestamp: 89 }),
      mkSession({ sessionId: 's3', cwd: '/b', lastTimestamp: 80 }),
      mkSession({ sessionId: 's4', cwd: '/b', lastTimestamp: 79 }),
      mkSession({ sessionId: 's5', cwd: '/c', lastTimestamp: 70 }),
      mkSession({ sessionId: 's6', cwd: '/c', lastTimestamp: 69 })
    ],
    'directory'
  )
}

test('computeNavigate: moves down, skipping headers', () => {
  const items = grouped()
  assert.deepEqual(computeNavigate(items, 2, 0, 3, 1), { selectedId: 's3', viewStart: 2 })
})

test('computeNavigate: returns null at edges', () => {
  const items = grouped()
  assert.equal(computeNavigate(items, 8, 6, 3, 1), null) // past bottom
  assert.equal(computeNavigate(items, 1, 0, 3, -1), null) // before top (only header above)
})

test('computeNavigate: scrolls up when target above viewport', () => {
  const items = grouped()
  const r = computeNavigate(items, 4, 4, 2, -1) // to s2 (idx 2), above viewStart 4
  assert.equal(r?.selectedId, 's2')
  assert.equal(r?.viewStart, 2)
})

test('computeNavigate: pulls back to show directory header above', () => {
  const items = grouped()
  // from s4 (idx5), viewStart 5, up to s3 (idx4); header B at idx3 is pulled in
  const r = computeNavigate(items, 5, 5, 2, -1)
  assert.equal(r?.selectedId, 's3')
  assert.equal(r?.viewStart, 3)
})

test('computePage: pages down and up, clamping', () => {
  const items = grouped()
  const down = computePage(items, 1, 0, 3, 1)
  assert.equal(down?.selectedId, 's3') // idx 1 + 3 = 4, which is s3
  const up = computePage(items, 8, 6, 3, -1)
  assert.ok(up && up.viewStart >= 0)
})

test('computePage: scrolls viewport down when landing below it', () => {
  const items = grouped()
  const r = computePage(items, 1, 0, 2, 1) // step 2 -> lands on s3 (idx 4), below viewStart+listHeight
  assert.equal(r?.selectedId, 's3')
  assert.equal(r?.viewStart, 3)
})

test('computePage: null on empty list or no selection', () => {
  assert.equal(computePage([], 0, 0, 3, 1), null)
  assert.equal(computePage(grouped(), -1, 0, 3, 1), null)
})

test('computePage: null when the list holds only headers', () => {
  assert.equal(computePage([{ type: 'header', cwd: '/x' }], 0, 0, 1, 1), null)
})

test('computePage: backward skip when clamp lands on a trailing header', () => {
  // artificial list ending in a header forces the forward scan out of range,
  // then the backward scan finds the session
  const items: DisplayItem[] = [
    { type: 'session', session: mkSession({ sessionId: 's0' }) },
    { type: 'header', cwd: '/z' }
  ]
  const r = computePage(items, 0, 0, 1, 1)
  assert.equal(r?.selectedId, 's0')
})

test('nextSortMode cycles recent -> lexic -> directory -> recent', () => {
  assert.equal(nextSortMode('recent'), 'lexic')
  assert.equal(nextSortMode('lexic'), 'directory')
  assert.equal(nextSortMode('directory'), 'recent')
})

test('findAdjacentSessionId: prefers below, falls back above, else null', () => {
  const items = grouped()
  const remaining = new Set(['s1', 's2', 's3', 's4', 's5', 's6'])
  // removing s3 (idx4): next session below is s4
  assert.equal(findAdjacentSessionId(items, 4, remaining), 's4')
  // if nothing below survives, take the nearest above
  const onlyAbove = new Set(['s1', 's2'])
  assert.equal(findAdjacentSessionId(items, 4, onlyAbove), 's2')
  // nothing survives
  assert.equal(findAdjacentSessionId(items, 4, new Set<string>()), null)
})
