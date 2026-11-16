import type { Stats } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { reflogBranches } from '../git.ts'
import { ompLeases, terminalProcesses } from '../proc.ts'
import {
  type Harness,
  type Message,
  modelKey,
  type Session,
  type SessionFile,
  type TokenUsage,
  type TrashFn,
  throughputOf
} from '../sessions.ts'
import { trashPaths } from '../trash.ts'

// omp honors PI_CODING_AGENT_DIR for its whole agent tree, sessions and
// history.db included.
export const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent')
const sessionsDir = () => join(agentDir(), 'sessions')

interface RawBlock {
  type?: string
  text?: string
}
interface RawUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}
interface RawRecord {
  type?: string
  id?: string
  parentId?: string | null
  activeLeafId?: string | null
  timestamp?: string
  cwd?: string
  title?: string
  source?: string
  titleSource?: string
  customType?: string
  purpose?: string
  model?: string
  usage?: RawUsage
  data?: { sourcePath?: string }
  message?: {
    role?: string
    model?: string
    content?: string | RawBlock[]
    usage?: RawUsage
    contextSnapshot?: { promptTokens?: number }
  }
}

// Tree bookkeeping per entry: enough to find the active branch without
// keeping parsed records around.
interface Node {
  id: string
  parentId: string | null
  leafId: string | null
}

interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  ctx: number | null
}

const text = (content: string | RawBlock[] | undefined): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
      : ''

// omp's resolveSessionLeafId: the last entry's captured leaf, falling back to the
// newest entry that selects itself when that leaf no longer exists.
export function activeBranch(nodes: Node[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const last = nodes.at(-1)
  let leaf = last ? last.leafId : null
  if (leaf !== null && !byId.has(leaf)) {
    leaf = null
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].leafId === nodes[i].id) {
        leaf = nodes[i].id
        break
      }
    }
  }
  const branch = new Set<string>()
  for (let n = leaf ? byId.get(leaf) : undefined; n && !branch.has(n.id); ) {
    branch.add(n.id)
    n = n.parentId ? byId.get(n.parentId) : undefined
  }
  return branch
}

function addUsage(acc: Record<string, TokenUsage>, model: string | undefined, u: RawUsage) {
  const key = modelKey(model) ?? model ?? 'unknown'
  acc[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  acc[key].input += u.input || 0
  acc[key].output += u.output || 0
  acc[key].cacheRead += u.cacheRead || 0
  acc[key].cacheWrite += u.cacheWrite || 0
}

// Everything clod shows from one transcript. Tool results are most of the bytes
// and carry nothing clod shows, so they only get their tree links read.
async function readTranscript(filePath: string) {
  const raw = await readFile(filePath, 'utf8')
  const lines = raw.split('\n')
  let title: string | null = null
  let aiTitle: string | null = null
  let header: RawRecord | null = null
  let lastTimestamp: string | null = null
  let importedFrom: string | null = null
  const nodes: Node[] = []
  const turns: Turn[] = []
  const models: Record<string, TokenUsage> = {}

  let lastLine = lines.length - 1
  while (lastLine > 0 && !lines[lastLine]) lastLine--
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const head = line.slice(0, 400)
    // the last entry is parsed whole, since it may carry the active leaf
    if (i !== lastLine && head.includes('"role":"toolResult"')) {
      const id = /"id":"([^"]+)"/.exec(head)?.[1]
      if (id) {
        const parentId = /"parentId":"([^"]+)"/.exec(head)?.[1] ?? null
        nodes.push({ id, parentId, leafId: id })
        lastTimestamp = /"timestamp":"([^"]+)"/.exec(head)?.[1] ?? lastTimestamp
      }
      continue
    }
    let r: RawRecord
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (i === 0 && r.type === 'title') {
      // source "user" is a rename, "auto" (or none, from older omp) is generated
      if (r.title) {
        if (r.source === 'user') title = r.title
        else aiTitle = r.title
      }
      continue
    }
    if (r.type === 'session') {
      header ??= r
      if (r.title && !title && !aiTitle) {
        if (r.titleSource === 'user') title = r.title
        else aiTitle = r.title
      }
      continue
    }
    if (r.timestamp) lastTimestamp = r.timestamp
    if (r.id) {
      nodes.push({
        id: r.id,
        parentId: r.parentId ?? null,
        leafId: r.activeLeafId !== undefined ? r.activeLeafId : r.id
      })
    }
    if (r.type === 'custom' && r.customType === 'foreign_session_import' && r.data?.sourcePath) {
      importedFrom = r.data.sourcePath
    }
    // background model calls (title generation) would skew usage against Claude's
    if (r.type === 'model_usage' && r.usage && r.purpose !== 'title')
      addUsage(models, r.model, r.usage)
    if (r.type !== 'message' || !r.id) continue
    const m = r.message
    if (m?.role === 'assistant') {
      if (m.usage) addUsage(models, m.model, m.usage)
      turns.push({
        id: r.id,
        role: 'assistant',
        text: text(m.content).trim(),
        timestamp: r.timestamp,
        ctx: m.contextSnapshot?.promptTokens ?? null
      })
    } else if (m?.role === 'user') {
      turns.push({
        id: r.id,
        role: 'user',
        text: text(m.content),
        timestamp: r.timestamp,
        ctx: null
      })
    }
  }
  return { title, aiTitle, header, lastTimestamp, importedFrom, nodes, turns, models }
}

// omp drops gitBranch on --from-claude, so an import reads it off the original.
async function importedBranch(sourcePath: string): Promise<string | null> {
  try {
    const raw = await readFile(sourcePath, 'utf8')
    let branch: string | null = null
    for (const m of raw.matchAll(/"gitBranch":"([^"]*)"/g))
      if (m[1] && m[1] !== 'HEAD') branch = m[1]
    return branch
  } catch {
    return null
  }
}

// omp records no git branch, so it comes from the cwd repo's reflog, read once
// per repo per listing.
let branchOf = reflogBranches()

export async function parseSession(filePath: string, fileStats: Stats): Promise<Session | null> {
  try {
    const t = await readTranscript(filePath)
    const cwd = t.header?.cwd
    if (!cwd) return null
    const branch = activeBranch(t.nodes)
    const onBranch = t.turns.filter((x) => branch.has(x.id))
    const users = onBranch.filter((x) => x.role === 'user')
    const lastCtx = [...onBranch].reverse().find((x) => x.ctx !== null)

    const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const k in t.models) {
      totals.input += t.models[k].input
      totals.output += t.models[k].output
      totals.cacheRead += t.models[k].cacheRead
      totals.cacheWrite += t.models[k].cacheWrite
    }
    const lastTimestamp = t.lastTimestamp ? new Date(t.lastTimestamp).getTime() : fileStats.mtimeMs
    const gitBranch = t.importedFrom
      ? await importedBranch(t.importedFrom)
      : await branchOf(cwd, lastTimestamp)

    return {
      harness: 'omp',
      sessionId: t.header?.id ?? (basename(filePath, '.jsonl').split('_').at(-1) as string),
      title: t.title,
      aiTitle: t.aiTitle,
      cwd,
      gitBranch,
      firstUserMessage: users.find((u) => u.text.trim())?.text.trim() ?? null,
      lastUserMessage: users.at(-1)?.text ?? null,
      contextTokens: lastCtx?.ctx ?? null,
      models: t.models,
      totals,
      throughput: throughputOf(totals),
      searchText: t.turns
        .map((x) => x.text)
        .join(' ')
        .toLowerCase(),
      mtime: fileStats.mtimeMs,
      lastTimestamp,
      filePath
    }
  } catch {
    return null
  }
}

export async function getSessionMessages(filePath: string): Promise<Message[]> {
  try {
    const t = await readTranscript(filePath)
    const branch = activeBranch(t.nodes)
    return t.turns
      .filter((x) => branch.has(x.id) && (x.role === 'user' || x.text))
      .map((x) => ({ role: x.role, text: x.text, timestamp: x.timestamp }))
  } catch {
    return []
  }
}

// <agentDir>/sessions/<cwd-slug>/<ISO>_<id>.jsonl. Deeper .jsonl files are
// subagent transcripts inside a session's artifact directory.
export async function listSessionFiles(): Promise<SessionFile[]> {
  branchOf = reflogBranches()
  let slugs: string[]
  try {
    slugs = await readdir(sessionsDir())
  } catch {
    return []
  }
  const files = (
    await Promise.all(
      slugs.map(async (slug) => {
        const dir = join(sessionsDir(), slug)
        try {
          return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
        } catch {
          return []
        }
      })
    )
  ).flat()
  const stats = await Promise.all(
    files.map(async (filePath): Promise<SessionFile | null> => {
      try {
        return { harness: 'omp', filePath, stats: await stat(filePath) }
      } catch {
        return null
      }
    })
  )
  return stats.filter((s): s is SessionFile => s !== null)
}

// ─── Live sessions ───────────────────────────────────────────────────────────

export interface Probes {
  leases: (ids: string[]) => Promise<Set<string> | null>
  terminals: () => Promise<{ tty: string; command: string }[]>
}

const realProbes: Probes = { leases: ompLeases, terminals: terminalProcesses }

// An interactive omp, not one of its workers or a one-shot subcommand.
function isInteractiveOmp(command: string): boolean {
  const [bin, sub] = command.split(/\s+/)
  return basename(bin) === 'omp' && !command.includes('__omp_worker') && sub !== 'session'
}

// Transcripts an interactive omp has open. omp rewrites terminal-sessions/<tty>
// whenever a terminal creates, switches, or resumes a session, so a breadcrumb
// names the open one while an omp runs on that tty. Breadcrumbs outlive omp,
// and ones named for a multiplexer pane or terminal app have no tty to check.
async function openFiles(probes: Probes): Promise<Set<string>> {
  const ttys = new Set(
    (await probes.terminals())
      .filter((p) => isInteractiveOmp(p.command))
      .map((p) => p.tty.replace(/\//g, '-'))
  )
  const dir = join(agentDir(), 'terminal-sessions')
  const open = new Set<string>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return open
  }
  for (const name of names.filter((n) => ttys.has(n))) {
    try {
      const file = (await readFile(join(dir, name), 'utf8')).split('\n')[1]?.trim()
      if (file) open.add(file)
    } catch {}
  }
  return open
}

// Sessions a running omp would write back over: held while it writes, or open
// in a terminal while it idles, which holds no lease. null when the lease probe
// failed, so a caller about to write can refuse rather than guess.
export async function liveSessionIds(
  sessions: Session[],
  probes: Probes = realProbes
): Promise<Set<string> | null> {
  const [held, files] = await Promise.all([
    probes.leases(sessions.map((s) => s.sessionId)),
    openFiles(probes)
  ])
  if (held === null) return null
  for (const s of sessions) if (files.has(s.filePath)) held.add(s.sessionId)
  return held
}

// For the list's mark: a failed probe marks nothing.
export const listLive = async (sessions: Session[], probes: Probes = realProbes) =>
  (await liveSessionIds(sessions, probes)) ?? new Set<string>()

async function refuseLive(session: Session, probes: Probes): Promise<void> {
  const live = await liveSessionIds([session], probes)
  if (live === null) throw new Error('could not check whether omp has the session open')
  if (live.has(session.sessionId)) throw new Error('session is open in omp')
}

// ─── history.db ──────────────────────────────────────────────────────────────

export interface HistoryDb {
  run: (sql: string, ...params: (string | number)[]) => void
  close: () => void
}

// Node 22 prints an ExperimentalWarning for node:sqlite, which would land on
// the TUI. Node 24 prints none.
export function quietSqlite(emit: typeof process.emitWarning): typeof process.emitWarning {
  return ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (text.includes('SQLite')) return
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
}

// omp's index of titles and recaps, opened only when it exists: opening a
// missing path would create one omp never made.
export async function openHistory(): Promise<HistoryDb | null> {
  const path = join(agentDir(), 'history.db')
  try {
    await stat(path)
  } catch {
    return null
  }
  const emit = process.emitWarning
  process.emitWarning = quietSqlite(emit)
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
  const db = new sqlite.DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000')
  return {
    run: (sql, ...params) => {
      db.prepare(sql).run(...params)
    },
    close: () => db.close()
  }
}

// The index is a cache omp's picker rebuilds from transcripts, so a busy or
// odd database never fails the rename or delete that already landed.
async function updateHistory(
  openDb: () => Promise<HistoryDb | null>,
  statements: [string, ...(string | number)[]][]
): Promise<void> {
  let db: HistoryDb | null = null
  try {
    db = await openDb()
    for (const [sql, ...params] of statements) db?.run(sql, ...params)
  } catch {
  } finally {
    db?.close()
  }
}

// ─── Rename ──────────────────────────────────────────────────────────────────

const SLOT_BYTES = 256

const slotLine = (title: string, updatedAt: string, pad: string) =>
  `${JSON.stringify({ type: 'title', v: 1, title, source: 'user', updatedAt, pad })}\n`

// omp's serializeTitleSlot: the longest code-point prefix of the title that
// fits, padded with spaces to exactly 256 bytes.
export function serializeSlot(title: string, updatedAt: string): string {
  const points = [...title]
  let n = points.length
  while (
    n > 0 &&
    Buffer.byteLength(slotLine(points.slice(0, n).join(''), updatedAt, '')) > SLOT_BYTES
  )
    n--
  const fit = points.slice(0, n).join('')
  return slotLine(
    fit,
    updatedAt,
    ' '.repeat(SLOT_BYTES - Buffer.byteLength(slotLine(fit, updatedAt, '')))
  )
}

// omp's #cleanTitle
export const cleanTitle = (title: string): string =>
  title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// Rename as omp's own picker does: the slot on line 1 rewritten in place at the
// same length, plus the title index. No title_change record, which would fork
// the tree under an omp that has the file open, and no file rename, since omp
// keys sessions by the id in the filename.
export async function renameSession(
  session: Session,
  title: string,
  {
    probes = realProbes,
    openDb = openHistory
  }: { probes?: Probes; openDb?: () => Promise<HistoryDb | null> } = {}
): Promise<void> {
  const clean = cleanTitle(title)
  if (!clean) throw new Error('title is empty')
  await refuseLive(session, probes)
  const fh = await open(session.filePath, 'r+')
  try {
    const head = Buffer.alloc(SLOT_BYTES)
    const { bytesRead } = await fh.read(head, 0, SLOT_BYTES, 0)
    let slot: { type?: string; v?: number } | null = null
    try {
      if (bytesRead === SLOT_BYTES && head[SLOT_BYTES - 1] === 10)
        slot = JSON.parse(head.toString('utf8'))
    } catch {}
    if (slot?.type !== 'title' || slot.v !== 1)
      throw new Error('no title slot, resume it in omp to rename')
    await fh.write(Buffer.from(serializeSlot(clean, new Date().toISOString())), 0, SLOT_BYTES, 0)
  } finally {
    await fh.close()
  }
  await updateHistory(openDb, [
    [
      "INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER)) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
      session.sessionId,
      clean
    ]
  ])
}

// ─── Delete ──────────────────────────────────────────────────────────────────

// Delete as omp's picker does (the transcript, its artifact directory, and
// rewrite leftovers), trashed rather than unlinked, refused while omp has it
// open since a live omp writes the whole file back. Lock sidecars stay, as omp
// leaves them. The title and recap rows go too, as omp gc drops them. Prompt
// history stays: it is deduped across sessions and feeds a full-text index.
export async function deleteSession(
  session: Session,
  {
    trashFn = trashPaths,
    probes = realProbes,
    openDb = openHistory
  }: { trashFn?: TrashFn; probes?: Probes; openDb?: () => Promise<HistoryDb | null> } = {}
): Promise<void> {
  await refuseLive(session, probes)
  const file = session.filePath
  const stem = basename(file, '.jsonl')
  const candidates = [file, join(dirname(file), stem)]
  try {
    for (const name of await readdir(dirname(file)))
      if (name.startsWith(`${stem}.jsonl.`) && name.endsWith('.bak'))
        candidates.push(join(dirname(file), name))
  } catch {}
  const toTrash: string[] = []
  for (const p of candidates) {
    try {
      await stat(p)
      toTrash.push(p)
    } catch {}
  }
  await trashFn(toTrash)
  await updateHistory(openDb, [
    ['DELETE FROM session_titles WHERE session_id = ?', session.sessionId],
    ['DELETE FROM session_recaps WHERE session_id = ?', session.sessionId]
  ])
}

export const omp: Harness = {
  id: 'omp',
  name: 'omp',
  mark: 'π',
  listFiles: listSessionFiles,
  parse: (f) => parseSession(f.filePath, f.stats),
  messages: (s) => getSessionMessages(s.filePath),
  // the full id: omp resolves a prefix too, but its lease probe does not
  resume: (s) => ({ command: 'omp', args: ['--resume', s.sessionId] }),
  liveIds: (sessions) => listLive(sessions),
  rename: (s, title) => renameSession(s, title),
  delete: (s) => deleteSession(s)
}
