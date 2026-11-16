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

// Session ids a running omp holds the ownership lease on, from omp's own probe,
// which takes no lease itself. Ids must be full: a prefix silently matches none.
// An empty set when omp is not installed, null when the probe fails.
export async function ompLeases(ids: string[]): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set()
  try {
    const { stdout } = await promisify(execFile)(
      'omp',
      ['session', 'lease', '--json', '--', ...ids],
      {
        timeout: 5000
      }
    )
    return new Set((JSON.parse(stdout) as { held?: string[] }).held ?? [])
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null
  }
}

// Every process with a controlling terminal, as `ps` names the terminal.
export async function terminalProcesses(): Promise<{ tty: string; command: string }[]> {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'tty=,command='], {
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 2000
    })
    return stdout
      .split('\n')
      .map((l) => /^\s*(\S+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && !/^\?+$/.test(m[1]))
      .map((m) => ({ tty: m[1], command: m[2] }))
  } catch {
    return []
  }
}
