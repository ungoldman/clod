import type { Stats } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { trashPaths } from './trash.ts'

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Session {
  sessionId: string
  title: string | null
  cwd: string
  gitBranch: string | null
  lastUserMessage: string | null
  contextTokens: number | null
  models: Record<string, TokenUsage>
  totals: TokenUsage
  throughput: number
  searchText: string
  mtime: number
  lastTimestamp: number
  filePath: string
}

export interface Message {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
}

export interface SessionFile {
  filePath: string
  stats: Stats
}

export type TrashFn = (paths: string | readonly string[]) => Promise<void>

// Raw JSONL record shapes. Everything is optional: these are parsed off disk and
// only the fields clod reads are typed.
interface RawContentBlock {
  type?: string
  text?: string
  tool_use_id?: string
}
type RawContent = string | RawContentBlock[]
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
interface RawMessage {
  role?: string
  model?: string
  content?: RawContent
  usage?: RawUsage
}
interface RawRecord {
  type?: string
  timestamp?: string
  gitBranch?: string
  cwd?: string
  isMeta?: boolean
  message?: RawMessage
  customTitle?: string
}

// Resolved lazily so tests can point $HOME at a fixture tree; os.homedir()
// honors $HOME on posix, read afresh each call.
const claudeDir = () => join(homedir(), '.claude')
const projectsDir = () => join(claudeDir(), 'projects')

// Claude Code injects system content as XML-tagged blocks; any message starting
// with an opening tag is injected content, not a real user message
const INJECTED = /^<[a-z]/i

function isRealUserMessage(record: RawRecord): boolean {
  if (record.type !== 'user' || record.isMeta) return false
  const content = record.message?.content
  if (typeof content === 'string') return !INJECTED.test(content)
  if (Array.isArray(content))
    return content.some((b) => b.type === 'text' && !INJECTED.test(b.text ?? ''))
  return false
}

export function extractText(content: RawContent | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.find((b) => b.type === 'text' && !INJECTED.test(b.text ?? ''))?.text ?? ''
  }
  return ''
}

// All text blocks of a message, joined; used to build the searchable content blob.
export function textBlocks(content: RawContent | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ')
  return ''
}

function modelKey(modelId: string | undefined): 'opus' | 'sonnet' | 'haiku' | null {
  if (!modelId) return null
  if (modelId.includes('opus')) return 'opus'
  if (modelId.includes('sonnet')) return 'sonnet'
  if (modelId.includes('haiku')) return 'haiku'
  return null
}

// Fold one assistant turn's usage into the per-model accumulator. cacheRead is
// tracked apart: it re-counts the cached context every turn and dwarfs the rest
// (~10x). Returns this turn's context size (input + cache), or null if no usage.
function accumulateUsage(
  message: RawMessage | undefined,
  acc: Record<string, TokenUsage>
): number | null {
  const u = message?.usage
  if (!u) return null

  const input = u.input_tokens || 0
  const output = u.output_tokens || 0
  const cacheRead = u.cache_read_input_tokens || 0
  const cacheWrite = u.cache_creation_input_tokens || 0

  const key = modelKey(message?.model)
  if (key) {
    acc[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const m = acc[key]
    m.input += input
    m.output += output
    m.cacheRead += cacheRead
    m.cacheWrite += cacheWrite
  }

  return input + cacheRead + cacheWrite
}

// Real throughput: new tokens processed + generated, excluding cache re-reads.
// Matches the figure shown in the shell status line.
export function throughputOf(usage: Partial<TokenUsage>): number {
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheWrite || 0)
}

// last capture of re in str; re must have the g flag
function matchLast(re: RegExp, str: string): string | null {
  let last: string | null = null
  for (const m of str.matchAll(re)) last = m[1] // single capture group, always present on a match
  return last
}

export async function parseSession(filePath: string, fileStats: Stats): Promise<Session | null> {
  const sessionId = basename(filePath, '.jsonl')

  try {
    // Read as a Buffer and decode per line only as far as the sniff needs; skipped
    // lines (most of the bytes) are never decoded, which is the big startup cost.
    const buf = await readFile(filePath)

    let title: string | null = null
    let cwd: string | null = null
    let gitBranch: string | null = null
    let lastUserMessage: string | null = null
    let lastTimestamp: string | null = null
    let contextTokens: number | null = null // input context of the most recent assistant turn
    const models: Record<string, TokenUsage> = {}
    const searchParts: string[] = [] // prose for content search, lowercased at the end

    const setEnvelope = (
      ts: string | null | undefined,
      branch: string | null | undefined,
      dir: string | null | undefined
    ) => {
      if (ts) lastTimestamp = ts
      if (branch && branch !== 'HEAD') gitBranch = branch // last-write: captures branch switches
      if (dir && !cwd) cwd = dir // first-write: cwd doesn't change mid-session
    }

    // Most bytes are tool results and attachments clod never shows. Sniff each line's
    // head to decide whether to JSON.parse it; the sniff only gates parsing, so a
    // false positive costs one wasted parse, never wrong data. Assistant records
    // serialize "message" before "type", so their early marker is the message "role";
    // skipped lines get their envelope (timestamp/branch/cwd) from a tail regex.
    const NL = 10
    for (let pos = 0, lineEnd = 0; pos < buf.length; pos = lineEnd + 1) {
      lineEnd = buf.indexOf(NL, pos)
      if (lineEnd === -1) lineEnd = buf.length
      if (lineEnd === pos) continue

      const head = buf.toString('utf8', pos, Math.min(pos + 600, lineEnd))
      const isAssistant = head.includes('"role":"assistant"') || head.includes('"type":"assistant"')
      const isUser =
        !isAssistant && (head.includes('"type":"user"') || head.includes('"role":"user"'))
      const isProse =
        isAssistant ||
        (isUser &&
          !head.includes('"isMeta":true') &&
          !head.includes('"tool_use_id"') &&
          !head.includes('"type":"tool_result"'))

      if (isProse) {
        try {
          const r: RawRecord = JSON.parse(buf.toString('utf8', pos, lineEnd))
          setEnvelope(r.timestamp, r.gitBranch, r.cwd)
          if (r.type === 'assistant') {
            const ctx = accumulateUsage(r.message, models) // usage on every turn, incl. tool-only
            if (ctx != null) contextTokens = ctx
            searchParts.push(textBlocks(r.message?.content))
          } else if (isRealUserMessage(r)) {
            lastUserMessage = extractText(r.message?.content)
            searchParts.push(lastUserMessage)
          }
        } catch {}
      } else if (
        isUser ||
        head.includes('"type":"system"') ||
        /^\{"type":"(attachment|pr-link|queue-operation)"/.test(head)
      ) {
        const tail = buf.toString('utf8', Math.max(pos, lineEnd - 400), lineEnd)
        setEnvelope(
          matchLast(/"timestamp":"([^"]+)"/g, tail),
          matchLast(/"gitBranch":"([^"]*)"/g, tail),
          matchLast(/"cwd":"([^"]*)"/g, tail)
        )
      } else if (head.includes('"type":"custom-title"')) {
        try {
          const r: RawRecord = JSON.parse(buf.toString('utf8', pos, lineEnd))
          if (r.customTitle) title = r.customTitle
        } catch {}
      }
    }

    if (!cwd) return null

    const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const k in models) {
      totals.input += models[k].input
      totals.output += models[k].output
      totals.cacheRead += models[k].cacheRead
      totals.cacheWrite += models[k].cacheWrite
    }
    const throughput = throughputOf(totals)

    return {
      sessionId,
      title,
      cwd,
      gitBranch,
      lastUserMessage,
      contextTokens,
      models,
      totals,
      throughput,
      searchText: searchParts.join(' ').toLowerCase(),
      mtime: fileStats.mtimeMs,
      lastTimestamp: lastTimestamp ? new Date(lastTimestamp).getTime() : fileStats.mtimeMs,
      filePath
    }
  } catch {
    return null
  }
}

// All session files with stats, newest first. mtime proxies the last record's
// timestamp (files are append-only), so the head is what a recency sort needs first.
export async function listSessionFiles(): Promise<SessionFile[]> {
  let projects: string[]
  try {
    projects = await readdir(projectsDir())
  } catch {
    return []
  }

  const files = (
    await Promise.all(
      projects.map(async (project) => {
        const projectPath = join(projectsDir(), project)
        try {
          const names = await readdir(projectPath)
          return names.filter((f) => f.endsWith('.jsonl')).map((f) => join(projectPath, f))
        } catch {
          return []
        }
      })
    )
  ).flat()

  const stats = await Promise.all(
    files.map(async (filePath): Promise<SessionFile | null> => {
      try {
        return { filePath, stats: await stat(filePath) }
      } catch {
        return null
      }
    })
  )
  return stats
    .filter((s): s is SessionFile => s !== null)
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
}

export async function parseSessions(files: SessionFile[]): Promise<Session[]> {
  const sessions = await Promise.all(files.map((f) => parseSession(f.filePath, f.stats)))
  return sessions.filter((s): s is Session => s !== null)
}

export async function loadSessions(): Promise<Session[]> {
  const sessions = await parseSessions(await listSessionFiles())
  return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

export async function getSessionMessages(filePath: string): Promise<Message[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const messages: Message[] = []

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const r: RawRecord = JSON.parse(line)
        if (isRealUserMessage(r)) {
          messages.push({
            role: 'user',
            text: extractText(r.message?.content),
            timestamp: r.timestamp
          })
        } else if (r.type === 'assistant') {
          const content = r.message?.content
          let text = ''
          if (Array.isArray(content))
            text = content
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('')
          else if (typeof content === 'string') text = content
          if (text.trim())
            messages.push({ role: 'assistant', text: text.trim(), timestamp: r.timestamp })
        }
      } catch {}
    }

    return messages
  } catch {
    return []
  }
}

// Trash everything Claude Code keys by session id under ~/.claude, plus the
// session's history.jsonl lines. Goes to Trash (recoverable). Skips plans/ and
// paste-cache/ (shared) and sessions/<pid>.json (ephemeral).
export async function deleteSession(
  filePath: string,
  trashFn: TrashFn = trashPaths
): Promise<void> {
  const sessionId = basename(filePath, '.jsonl')
  const dir = claudeDir()
  const candidates = [
    filePath,
    filePath.replace(/\.jsonl$/, ''), // sibling dir (e.g. subagent transcripts)
    join(dir, 'tasks', sessionId),
    join(dir, 'file-history', sessionId),
    join(dir, 'session-env', sessionId),
    join(dir, 'debug', `${sessionId}.txt`)
  ]

  // telemetry is keyed by a filename prefix, not an exact path
  const telemetryDir = join(dir, 'telemetry')
  try {
    const prefix = `1p_failed_events.${sessionId}.`
    for (const name of await readdir(telemetryDir)) {
      if (name.startsWith(prefix)) candidates.push(join(telemetryDir, name))
    }
  } catch {}

  const toTrash: string[] = []
  for (const p of candidates) {
    try {
      await stat(p)
      toTrash.push(p)
    } catch {}
  }
  await trashFn(toTrash)
  await scrubHistory(sessionId, trashFn)
}

// Remove the session's prompt lines from history.jsonl, writing the removed lines
// to a file that's trashed too, so even this stays recoverable.
async function scrubHistory(sessionId: string, trashFn: TrashFn): Promise<void> {
  const historyPath = join(claudeDir(), 'history.jsonl')
  let raw: string
  try {
    raw = await readFile(historyPath, 'utf8')
  } catch {
    return
  }
  const needle = `"sessionId":"${sessionId}"`
  if (!raw.includes(needle)) return

  const kept: string[] = []
  const removed: string[] = []
  for (const line of raw.split('\n')) {
    if (line.includes(needle)) removed.push(line)
    else kept.push(line)
  }

  const removedPath = join(claudeDir(), `history-removed-${sessionId}.jsonl`)
  await writeFile(removedPath, `${removed.join('\n')}\n`)
  await writeFile(historyPath, kept.join('\n'))
  await trashFn([removedPath])
}

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

export function relativeTime(ms: number): string {
  const now = new Date()
  const then = new Date(ms)
  const sameDay =
    now.getFullYear() === then.getFullYear() &&
    now.getMonth() === then.getMonth() &&
    now.getDate() === then.getDate()

  if (sameDay) {
    const diff = Date.now() - ms
    if (diff < 60000) return 'now'
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m`
    return `${Math.floor(mins / 60)}h`
  }

  const label = `${MONTHS[then.getMonth()]} ${then.getDate()}`
  return then.getFullYear() === now.getFullYear() ? label : `${label} ${then.getFullYear()}`
}

export function shortPath(p: string): string {
  return p.replace(homedir(), '~')
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
