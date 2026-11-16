import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { branchAt, findGitDir, readReflog, reflogBranches } from '../src/git.ts'

const Z = '0'.repeat(40)
const SHA = 'a'.repeat(40)
const line = (t: number, msg: string) => `${Z} ${SHA} Nate <n@x> ${t} -0800\t${msg}`

async function repo(o: {
  log?: string[]
  head?: string
  heads?: string[]
  tags?: string[]
  remotes?: string[]
  packed?: string
}): Promise<{ root: string; gitDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clod-git-'))
  const gitDir = join(root, '.git')
  await mkdir(join(gitDir, 'logs'), { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), o.head ?? 'ref: refs/heads/main\n')
  if (o.log) await writeFile(join(gitDir, 'logs', 'HEAD'), `${o.log.join('\n')}\n`)
  for (const h of o.heads ?? []) {
    const p = join(gitDir, 'refs', 'heads', h)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, `${SHA}\n`)
  }
  for (const t of o.tags ?? []) {
    await mkdir(join(gitDir, 'refs', 'tags'), { recursive: true })
    await writeFile(join(gitDir, 'refs', 'tags', t), `${SHA}\n`)
  }
  for (const r of o.remotes ?? [])
    await mkdir(join(gitDir, 'refs', 'remotes', r), { recursive: true })
  if (o.packed) await writeFile(join(gitDir, 'packed-refs'), o.packed)
  return { root, gitDir }
}

test('branchAt follows checkouts, skips detached stretches, and starts from the first from', async () => {
  const { gitDir } = await repo({
    heads: ['main', 'feat/x', 'dev'],
    tags: ['v1'],
    remotes: ['origin'],
    log: [
      line(100, 'commit (initial): init'),
      line(200, 'checkout: moving from main to feat/x'),
      line(300, `checkout: moving from feat/x to ${SHA.slice(0, 7)}`),
      line(400, 'checkout: moving from aaaaaaa to v1'),
      line(500, 'checkout: moving from v1 to origin/topic'),
      line(600, 'checkout: moving from origin/topic to dev'),
      line(700, 'rebase (start): checkout main'),
      line(800, 'rebase (finish): returning to refs/heads/dev'),
      line(900, 'pull --rebase (abort): returning to refs/heads/main'),
      'garbage without a tab',
      `${Z} ${SHA} Nate <n@x> notatime -0800\tcheckout: moving from a to b`
    ]
  })
  const log = await readReflog(gitDir)
  assert.ok(log)
  assert.equal(branchAt(log, 50_000), 'main') // before any step: the first checkout's from
  assert.equal(branchAt(log, 250_000), 'feat/x')
  assert.equal(branchAt(log, 350_000), 'feat/x') // sha detach keeps the last branch
  assert.equal(branchAt(log, 450_000), 'feat/x') // tag
  assert.equal(branchAt(log, 550_000), 'feat/x') // remote-tracking ref
  assert.equal(branchAt(log, 650_000), 'dev')
  assert.equal(branchAt(log, 750_000), 'dev') // mid-rebase
  assert.equal(branchAt(log, 850_000), 'dev')
  assert.equal(branchAt(log, 950_000), 'main')
})

test('a local branch named like a sha or a remote path is still a branch; packed refs count', async () => {
  const { gitDir } = await repo({
    remotes: ['origin'],
    packed: `# pack-refs with: peeled\n${SHA} refs/heads/deadbeef\n${SHA} refs/heads/origin/mine\n${SHA} refs/tags/v2\n${SHA} refs/remotes/upstream/main\n^${SHA}\n`,
    log: [
      line(100, 'checkout: moving from v2 to deadbeef'),
      line(200, 'checkout: moving from deadbeef to origin/mine'),
      line(300, 'checkout: moving from origin/mine to upstream/main'),
      line(400, 'checkout: moving from upstream/main to plain')
    ]
  })
  const log = await readReflog(gitDir)
  assert.ok(log)
  assert.equal(log.initial, null) // first from was a packed tag
  assert.equal(branchAt(log, 50_000), null)
  assert.equal(branchAt(log, 150_000), 'deadbeef')
  assert.equal(branchAt(log, 250_000), 'origin/mine')
  assert.equal(branchAt(log, 350_000), 'origin/mine')
  assert.equal(branchAt(log, 450_000), 'plain') // unknown name, no remote prefix: a branch
})

test('branch renames carry the current branch, first-step rename sets the start', async () => {
  const { gitDir } = await repo({
    log: [
      line(100, 'Branch: renamed refs/heads/old to refs/heads/new'),
      line(200, 'Branch: renamed refs/heads/elsewhere to refs/heads/other'),
      line(300, 'checkout: moving from new to b'),
      line(400, 'Branch: renamed refs/heads/b to refs/heads/c')
    ]
  })
  const log = await readReflog(gitDir)
  assert.ok(log)
  assert.equal(branchAt(log, 50_000), 'old')
  assert.equal(branchAt(log, 150_000), 'new')
  assert.equal(branchAt(log, 250_000), 'new') // renaming another branch changes nothing
  assert.equal(branchAt(log, 450_000), 'c')
})

test('no checkout in the log falls back to HEAD; detached HEAD gives null; no log gives null', async () => {
  const a = await repo({ log: [line(100, 'commit: x')] })
  assert.equal(branchAt((await readReflog(a.gitDir)) as never, 200_000), 'main')
  const b = await repo({ log: [line(100, 'commit: x')], head: `${SHA}\n` })
  assert.equal(branchAt((await readReflog(b.gitDir)) as never, 200_000), null)
  const c = await repo({})
  assert.equal(await readReflog(c.gitDir), null)
})

test('findGitDir walks up, follows a worktree pointer (relative or absolute), null outside a repo', async () => {
  const { root, gitDir } = await repo({ log: [line(100, 'commit: x')] })
  const deep = join(root, 'a', 'b')
  await mkdir(deep, { recursive: true })
  assert.equal(await findGitDir(deep), gitDir)

  const wtGit = join(gitDir, 'worktrees', 'wt')
  await mkdir(join(wtGit, 'logs'), { recursive: true })
  await writeFile(join(wtGit, 'commondir'), '../..\n')
  await writeFile(join(wtGit, 'HEAD'), 'ref: refs/heads/wt-branch\n')
  await writeFile(
    join(wtGit, 'logs', 'HEAD'),
    `${line(100, 'checkout: moving from main to wt-branch')}\n`
  )
  const wt = join(root, 'wt')
  await mkdir(wt)
  await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`)
  assert.equal(await findGitDir(wt), wtGit)
  const wtLog = await readReflog(wtGit) // refs read from the common dir
  assert.equal(branchAt(wtLog as never, 200_000), 'wt-branch')
  const wt2 = join(root, 'wt2')
  await mkdir(wt2)
  await writeFile(join(wt2, '.git'), 'gitdir: ../.git/worktrees/wt\n')
  assert.equal(await findGitDir(wt2), wtGit)

  const junk = join(root, 'junk')
  await mkdir(junk)
  await writeFile(join(junk, '.git'), 'not a pointer\n')
  assert.equal(await findGitDir(junk), gitDir) // keeps walking past a bad .git file

  const outside = await mkdtemp(join(tmpdir(), 'clod-nogit-'))
  assert.equal(await findGitDir(outside), null)
  // a removed worktree under the main checkout does not borrow the parent's branch
  assert.equal(await findGitDir(join(root, 'removed-worktree')), null)
})

test('reflogBranches caches per cwd and gitdir, null outside a repo or without a log', async () => {
  const { root } = await repo({
    log: [line(100, 'checkout: moving from main to feat')]
  })
  const branch = reflogBranches()
  assert.equal(await branch(root, 200_000), 'feat')
  assert.equal(await branch(root, 50_000), 'main') // cached
  assert.equal(await branch(await mkdtemp(join(tmpdir(), 'clod-nogit-')), 1), null)
  const bare = await repo({})
  assert.equal(await branch(bare.root, 1), null)
})
