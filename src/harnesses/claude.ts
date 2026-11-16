import type { Stats } from 'node:fs'
import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { processStartedAt } from '../proc.ts'
import {
  type Harness,
  type Message,
  type Session,
  type SessionFile,
  type TokenUsage,
  type TrashFn,
  throughputOf
} from '../sessions.ts'
import { trashPaths } from '../trash.ts'

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
  aiTitle?: string
}

// Resolved lazily so tests can point $HOME at a fixture tree; os.homedir()
// honors $HOME on posix, read afresh each call.
const claudeDir = () => join(homedir(), '.claude')
const projectsDir = () => join(claudeDir(), 'projects')
// Claude Code's per-session task output and scratchpads, outside ~/.claude.
// getuid exists on every platform clod runs on (macOS, Linux, WSL).
const claudeTmpDir = () =>
  join(process.env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${process.getuid?.()}`)

// Claude Code injects system content as XML-tagged blocks; any message starting
// with an opening tag is injected content, not a real user message
const INJECTED = /^<[a-z]/i

// Claude Code writes "[Request interrupted by user]" and the like as user records
const NOTICE = /^\[[^\]]*\]$/

// A slash command arrives as one injected block, with what the user typed inside
// <command-args>; without this the whole prompt reads as system content.
const COMMAND =
  /<command-name>([^<]*)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/

function rawText(content: RawContent | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.find((b) => b.type === 'text')?.text ?? ''
  return ''
}

function userText(record: RawRecord): string | null {
  if (record.type !== 'user' || record.isMeta) return null
  const content = record.message?.content
  if (hasRealText(content)) return extractText(content)
  const m = COMMAND.exec(rawText(content))
  if (!m) return null
  const args = m[2]?.trim()
  return args ? `${m[1].trim()} ${args}` : m[1].trim()
}

function hasRealText(content: RawContent | undefined): boolean {
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
    let aiTitle: string | null = null
    let cwd: string | null = null
    let gitBranch: string | null = null
    let firstUserMessage: string | null = null
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
          } else {
            const text = userText(r)
            if (text !== null) {
              lastUserMessage = text
              searchParts.push(text)
              const trimmed = text.trim()
              if (!firstUserMessage && trimmed && !NOTICE.test(trimmed)) firstUserMessage = trimmed
            }
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
      } else if (head.startsWith('{"type":"ai-title"')) {
        try {
          const r: RawRecord = JSON.parse(buf.toString('utf8', pos, lineEnd))
          if (r.aiTitle) aiTitle = r.aiTitle
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
      harness: 'claude',
      sessionId,
      title,
      aiTitle,
      cwd,
      gitBranch,
      firstUserMessage,
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
        return { harness: 'claude', filePath, stats: await stat(filePath) }
      } catch {
        return null
      }
    })
  )
  return stats
    .filter((s): s is SessionFile => s !== null)
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
}

export async function getSessionMessages(filePath: string): Promise<Message[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const messages: Message[] = []

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const r: RawRecord = JSON.parse(line)
        const text = userText(r)
        if (text !== null) {
          messages.push({ role: 'user', text, timestamp: r.timestamp })
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

// Claude Code writes sessions/<pid>.json at startup and rewrites its sessionId on
// /clear, /resume, and forks. A crash leaves the file behind, so the pid has to be
// alive and started when the file says: procStart is ps's lstart, in UTC.
export async function isSessionLive(
  sessionId: string,
  startedAt: (pid: number) => Promise<string | null> = processStartedAt
): Promise<boolean> {
  const dir = join(claudeDir(), 'sessions')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let r: { pid?: number; sessionId?: string; procStart?: string }
    try {
      r = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (r.sessionId !== sessionId || !r.pid) continue
    try {
      process.kill(r.pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') continue
    }
    if (!r.procStart) return true
    const started = await startedAt(r.pid)
    // unreadable start time: assume the session is open rather than risk a write
    if (started === null) return true
    if (started.split(/\s+/).join(' ') === r.procStart.split(/\s+/).join(' ')) return true
  }
  return false
}

const LIVE = 'session is open in Claude Code'

// Rename by appending the records Claude Code's /rename writes; the last one
// wins on parse. custom-title feeds the resume picker, agent-name the title
// shown inside a resumed session. The picker falls back to custom-title.json
// when no custom-title sits in the transcript's tail, so it has to match too.
// An open session would write its own title back over this one.
export async function renameSession(
  filePath: string,
  title: string,
  isLive: (sessionId: string) => Promise<boolean> = isSessionLive
): Promise<void> {
  const sessionId = basename(filePath, '.jsonl')
  if (await isLive(sessionId)) throw new Error(LIVE)
  // the title file first: if the append then fails, the transcript keeps its old
  // custom-title, which the picker reads ahead of the file. Modes match Claude
  // Code's, chmod'd too since a mode option only applies when the path is created.
  const sessionDir = filePath.replace(/\.jsonl$/, '')
  const titleFile = join(sessionDir, 'custom-title.json')
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  await chmod(sessionDir, 0o700)
  await writeFile(titleFile, JSON.stringify({ customTitle: title }), { mode: 0o600 })
  await chmod(titleFile, 0o600)
  const records = [
    { type: 'custom-title', customTitle: title, sessionId },
    { type: 'agent-name', agentName: title, sessionId }
  ]
  await appendFile(filePath, records.map((r) => `${JSON.stringify(r)}\n`).join(''))
}

// Trash everything Claude Code keys by session id, plus the session's
// history.jsonl lines. Goes to Trash (recoverable). Skips plans/ and paste-cache/
// (shared) and sessions/<pid>.json (ephemeral). An open session would write the
// transcript back, so it is refused.
export async function deleteSession(
  filePath: string,
  trashFn: TrashFn = trashPaths,
  {
    isLive = isSessionLive,
    tmpDir = claudeTmpDir()
  }: { isLive?: (sessionId: string) => Promise<boolean>; tmpDir?: string } = {}
): Promise<void> {
  const sessionId = basename(filePath, '.jsonl')
  if (await isLive(sessionId)) throw new Error(LIVE)
  const dir = claudeDir()
  const projectDir = dirname(filePath)
  const candidates = [
    join(dir, 'tasks', sessionId),
    join(dir, 'file-history', sessionId),
    join(dir, 'session-env', sessionId),
    join(dir, 'uploads', sessionId),
    join(dir, 'debug', `${sessionId}.txt`),
    join(tmpDir, basename(projectDir), sessionId)
  ]

  // In the project dir, the transcript, its same-named dir, and every sidecar
  // (<id>.jsonl.superseded-*, <id>.ccr-tip.json, <id>-<stamp>.cast, ...) share the
  // id as a prefix, and a uuid can't prefix another session's.
  try {
    for (const name of await readdir(projectDir)) {
      if (
        name === sessionId ||
        name.startsWith(`${sessionId}.`) ||
        name.startsWith(`${sessionId}-`)
      )
        candidates.push(join(projectDir, name))
    }
  } catch {}
  // telemetry is keyed by a filename prefix too
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

export const claude: Harness = {
  id: 'claude',
  name: 'Claude Code',
  mark: '✻',
  listFiles: listSessionFiles,
  parse: (f) => parseSession(f.filePath, f.stats),
  messages: (s) => getSessionMessages(s.filePath),
  resume: (s) => ({ command: 'claude', args: ['--resume', s.sessionId] }),
  rename: (s, title) => renameSession(s.filePath, title),
  delete: (s) => deleteSession(s.filePath)
}
