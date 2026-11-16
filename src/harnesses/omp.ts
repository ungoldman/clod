import type { Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { reflogBranches } from '../git.ts'
import {
  type Harness,
  type Message,
  modelKey,
  type Session,
  type SessionFile,
  type TokenUsage,
  throughputOf
} from '../sessions.ts'

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

export const omp: Harness = {
  id: 'omp',
  name: 'omp',
  mark: 'π',
  listFiles: listSessionFiles,
  parse: (f) => parseSession(f.filePath, f.stats),
  messages: (s) => getSessionMessages(s.filePath),
  // the full id: omp resolves a prefix too, but its lease probe does not
  resume: (s) => ({ command: 'omp', args: ['--resume', s.sessionId] }),
  rename: async () => {
    throw new Error('rename is not supported for omp yet')
  },
  delete: async () => {
    throw new Error('delete is not supported for omp yet')
  }
}
