import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deleteSession,
  getSessionMessages,
  harnessOf,
  listSessionFiles,
  liveSessions,
  renameSession
} from '../src/harnesses/index.ts'
import { mkSession } from './helpers.ts'

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

test('claude harness: messages, rename, resume, and a refused delete dispatch by session', async () => {
  await withHome(async (home) => {
    const proj = join(home, '.claude', 'projects', 'p')
    await mkdir(proj, { recursive: true })
    const file = join(proj, 'sid.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'user', message: { content: 'hi' }, cwd: '/p' })}\n`
    )
    const s = mkSession({ sessionId: 'sid', filePath: file })

    assert.deepEqual(await getSessionMessages(s), [
      { role: 'user', text: 'hi', timestamp: undefined }
    ])
    await renameSession(s, 'named')
    assert.match(await readFile(file, 'utf8'), /"customTitle":"named"/)
    assert.deepEqual(harnessOf(s).resume(s), { command: 'claude', args: ['--resume', 'sid'] })

    // this process stands in for a live Claude Code, so delete refuses before trashing
    await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
    await writeFile(
      join(home, '.claude', 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'sid' })
    )
    await assert.rejects(deleteSession(s), /open in Claude Code/)
    assert.equal((await listSessionFiles()).length, 1)
    // the same pid file marks it open in the list, and a file with no session id is skipped
    await writeFile(join(home, '.claude', 'sessions', '1.json'), JSON.stringify({ pid: 1 }))
    const omp = mkSession({ harness: 'omp', sessionId: 'o', filePath: join(home, 'x.jsonl') })
    const prev = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(home, '.omp-agent')
    try {
      assert.deepEqual(await liveSessions([s, omp]), new Set(['sid']))
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = prev
    }
  })
})
