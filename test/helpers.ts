import type { Session } from '../src/sessions.ts'

// A fully-populated Session with sane defaults; override any field per test.
export function mkSession(o: Partial<Session> = {}): Session {
  return {
    sessionId: 'sid',
    title: 'a title',
    cwd: '/home/u/proj',
    gitBranch: null,
    lastUserMessage: null,
    contextTokens: null,
    models: {},
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    throughput: 0,
    searchText: '',
    mtime: 0,
    lastTimestamp: 0,
    filePath: '/tmp/sid.jsonl',
    ...o
  }
}
