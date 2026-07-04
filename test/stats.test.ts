import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bar, computeStats, sparkline } from '../src/stats.ts'
import { mkSession } from './helpers.ts'

test('bar', () => {
  assert.equal(bar(5, 10, 10), '█████')
  assert.equal(bar(10, 10, 4), '████')
  assert.equal(bar(5, 0, 10), '') // max 0 -> empty
})

test('sparkline', () => {
  assert.equal(sparkline([0, 0, 0]), '   ') // all zero -> spaces
  const s = sparkline([1, 5, 10])
  assert.equal(s.length, 3)
  assert.notEqual(s, '   ')
})

test('computeStats aggregates throughput, breakdown, models, projects, days', () => {
  const now = Date.now()
  const sessions = [
    mkSession({
      cwd: '/p/a',
      throughput: 1000,
      lastTimestamp: now,
      totals: { input: 400, output: 100, cacheWrite: 500, cacheRead: 9000 },
      models: { opus: { input: 400, output: 100, cacheWrite: 500, cacheRead: 9000 } }
    }),
    mkSession({
      cwd: '/p/a',
      throughput: 500,
      lastTimestamp: now,
      totals: { input: 200, output: 100, cacheWrite: 200, cacheRead: 0 },
      models: { sonnet: { input: 200, output: 100, cacheWrite: 200, cacheRead: 0 } }
    }),
    mkSession({
      cwd: '/p/b',
      throughput: 2000,
      lastTimestamp: now,
      totals: { input: 1000, output: 500, cacheWrite: 500, cacheRead: 100 },
      models: { opus: { input: 1000, output: 500, cacheWrite: 500, cacheRead: 100 } }
    })
  ]
  const stats = computeStats(sessions)
  assert.equal(stats.totalSessions, 3)
  assert.equal(stats.totalThroughput, 3500)
  assert.equal(stats.grandTotal, 3500 + 9100) // + cacheRead
  assert.equal(stats.breakdown.cacheRead, 9100)
  // byModel sorted desc: opus (1000+2000=3000) before sonnet (500)
  assert.deepEqual(
    stats.byModel.map((m) => m.name),
    ['opus', 'sonnet']
  )
  // byProject sorted desc: /p/b (2000) before /p/a (1500)
  assert.deepEqual(
    stats.byProject.map((p) => p.cwd),
    ['/p/b', '/p/a']
  )
  assert.equal(stats.days.length, 30)
  assert.equal(stats.days.at(-1)?.tokens, 3500) // all activity is today
})

test('sparkline renders a zero among non-zero values', () => {
  const s = sparkline([0, 5])
  assert.equal(s.length, 2)
  assert.equal(s[0], ' ') // zero -> blank slot even when max > 0
})

test('computeStats counts zero-throughput sessions', () => {
  const stats = computeStats([mkSession({ cwd: '/z', throughput: 0, lastTimestamp: Date.now() })])
  assert.equal(stats.totalThroughput, 0)
  assert.equal(stats.byProject[0].cwd, '/z')
})

test('computeStats handles empty input', () => {
  const stats = computeStats([])
  assert.equal(stats.totalSessions, 0)
  assert.equal(stats.totalThroughput, 0)
  assert.equal(stats.byModel.length, 0)
  assert.equal(stats.days.length, 30)
})
