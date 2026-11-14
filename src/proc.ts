import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Start time of a live process in ps's lstart format, read the way Claude Code
// reads its own procStart (C locale, UTC, 1s timeout). Isolated so isSessionLive
// can take a fake in tests and this adapter stays out of the coverage gate.
export async function processStartedAt(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 1000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}
