import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// A branch state change read off the HEAD reflog. null is a detached HEAD.
type Step = { at: number; branch: string | null }
type Reflog = { initial: string | null; steps: Step[] }

const HEX = /^[0-9a-f]{7,64}$/

// The gitdir for cwd: the nearest .git up the tree, following a worktree's
// `gitdir:` pointer. null outside a repo.
export async function findGitDir(cwd: string): Promise<string | null> {
  const dir = resolve(cwd)
  const dotGit = join(dir, '.git')
  try {
    const st = await stat(dotGit)
    if (st.isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))
    if (m) return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim())
  } catch {}
  const parent = dirname(dir)
  return parent === dir ? null : findGitDir(parent)
}

async function readOr(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

// Refs live in the common dir, which a worktree's gitdir names in `commondir`.
async function commonDir(gitDir: string): Promise<string> {
  const rel = (await readOr(join(gitDir, 'commondir'))).trim()
  return rel ? resolve(gitDir, rel) : gitDir
}

// A checkout target that is not a branch: a sha, a tag, or a remote-tracking ref
// with no local branch of the same name.
function detachedTarget(
  name: string,
  refs: { heads: Set<string>; tags: Set<string>; remotes: Set<string> }
): boolean {
  if (HEX.test(name) && !refs.heads.has(name)) return true
  if (refs.heads.has(name)) return false
  if (refs.tags.has(name)) return true
  const remote = name.split('/')[0]
  return name.includes('/') && refs.remotes.has(remote)
}

async function refNames(common: string) {
  const heads = new Set<string>()
  const tags = new Set<string>()
  const remotes = new Set<string>()
  const add = (ref: string) => {
    if (ref.startsWith('refs/heads/')) heads.add(ref.slice(11))
    else if (ref.startsWith('refs/tags/')) tags.add(ref.slice(10))
    else if (ref.startsWith('refs/remotes/')) remotes.add(ref.split('/')[2])
  }
  for (const line of (await readOr(join(common, 'packed-refs'))).split('\n')) {
    const ref = line.split(' ')[1]
    if (ref) add(ref)
  }
  const walk = async (rel: string): Promise<void> => {
    let names: Dirent[]
    try {
      names = await readdir(join(common, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const d of names) {
      if (d.isDirectory()) await walk(`${rel}/${d.name}`)
      else add(`${rel}/${d.name}`)
    }
  }
  await walk('refs/heads')
  await walk('refs/tags')
  try {
    for (const d of await readdir(join(common, 'refs', 'remotes'))) remotes.add(d)
  } catch {}
  return { heads, tags, remotes }
}

// Parse <gitdir>/logs/HEAD into branch steps. Reftable repos and removed
// worktrees have no such file, and get null.
export async function readReflog(gitDir: string): Promise<Reflog | null> {
  const raw = await readOr(join(gitDir, 'logs', 'HEAD'))
  if (!raw) return null
  const refs = await refNames(await commonDir(gitDir))
  const head = /^ref: refs\/heads\/(.+)$/m.exec(await readOr(join(gitDir, 'HEAD')))?.[1] ?? null

  const steps: Step[] = []
  let initial: string | null | undefined
  let state: string | null = null
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const at = Number(/ (\d+) [+-]\d{4}$/.exec(line.slice(0, tab))?.[1]) * 1000
    if (!at) continue
    const msg = line.slice(tab + 1)
    let next: string | null | undefined
    const checkout = /^checkout: moving from (\S+) to (\S+)$/.exec(msg)
    const returned = /\((?:finish|abort)\): returning to refs\/heads\/(\S+)$/.exec(msg)
    const renamed = /^Branch: renamed refs\/heads\/(\S+) to refs\/heads\/(\S+)$/.exec(msg)
    if (checkout) {
      if (initial === undefined) initial = detachedTarget(checkout[1], refs) ? null : checkout[1]
      next = detachedTarget(checkout[2], refs) ? null : checkout[2]
    } else if (/\(start\): checkout /.test(msg)) next = null
    else if (returned) next = returned[1]
    else if (renamed) {
      if (initial === undefined) initial = renamed[1]
      if ((steps.length ? state : initial) === renamed[1]) next = renamed[2]
    }
    if (next !== undefined) {
      state = next
      steps.push({ at, branch: next })
    }
  }
  return { initial: initial === undefined ? head : initial, steps }
}

// The last branch checked out at or before `at`, skipping detached stretches,
// as Claude Code's recorded gitBranch reads in clod.
export function branchAt(log: Reflog, at: number): string | null {
  let branch = log.initial
  for (const step of log.steps) {
    if (step.at > at) break
    if (step.branch) branch = step.branch
  }
  return branch
}

// One reflog read per gitdir per clod run.
export function reflogBranches() {
  const gitDirs = new Map<string, Promise<string | null>>()
  const logs = new Map<string, Promise<Reflog | null>>()
  return async (cwd: string, at: number): Promise<string | null> => {
    if (!gitDirs.has(cwd)) gitDirs.set(cwd, findGitDir(cwd))
    const gitDir = await gitDirs.get(cwd)
    if (!gitDir) return null
    if (!logs.has(gitDir)) logs.set(gitDir, readReflog(gitDir))
    const parsed = await logs.get(gitDir)
    return parsed ? branchAt(parsed, at) : null
  }
}
