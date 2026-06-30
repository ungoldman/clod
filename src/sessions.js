import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'

const CLAUDE_DIR = join(homedir(), '.claude')
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')

// Claude Code injects system content as XML-tagged blocks; any message starting
// with an opening tag is injected content, not a real user message
const INJECTED = /^<[a-z]/i

function isRealUserMessage(record) {
  if (record.type !== 'user' || record.isMeta) return false
  const content = record.message?.content
  if (typeof content === 'string') return !INJECTED.test(content)
  if (Array.isArray(content)) return content.some(b => b.type === 'text' && !INJECTED.test(b.text))
  return false
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.find(b => b.type === 'text' && !INJECTED.test(b.text))?.text ?? ''
  }
  return ''
}

// All text blocks of a message, joined; used to build the searchable content blob.
function textBlocks(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join(' ')
  return ''
}

function modelKey(modelId) {
  if (!modelId) return null
  if (modelId.includes('opus')) return 'opus'
  if (modelId.includes('sonnet')) return 'sonnet'
  if (modelId.includes('haiku')) return 'haiku'
  return null
}

// Add one assistant message's usage into the per-model accumulator, split by token type:
// { key: {input, output, cacheRead, cacheWrite} }. cacheRead is kept separate because it
// re-counts the same cached context every turn and dwarfs everything else (~10x).
// Returns the context-window size at this turn (input + cache), or null if no usage.
function accumulateUsage(message, acc) {
  const u = message?.usage
  if (!u) return null

  const input = u.input_tokens || 0
  const output = u.output_tokens || 0
  const cacheRead = u.cache_read_input_tokens || 0
  const cacheWrite = u.cache_creation_input_tokens || 0

  const key = modelKey(message?.model)
  if (key) {
    const m = (acc[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    m.input += input
    m.output += output
    m.cacheRead += cacheRead
    m.cacheWrite += cacheWrite
  }

  return input + cacheRead + cacheWrite
}

// Real throughput: new tokens processed + generated, excluding cache re-reads.
// Matches the figure shown in the shell status line.
export function throughputOf(usage) {
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheWrite || 0)
}

// last capture of re in str; re must have the g flag
function matchLast(re, str) {
  let m
  let last = null
  while ((m = re.exec(str))) last = m[1]
  return last
}

async function parseSession(filePath, fileStats) {
  const sessionId = basename(filePath, '.jsonl')

  try {
    // Read as a Buffer and decode per line, only as much as the sniff needs.
    // Skipped lines (most of the bytes) never get decoded at all; that decode
    // is otherwise the single largest startup cost.
    const buf = await readFile(filePath)

    let title = null
    let cwd = null
    let gitBranch = null
    let lastUserMessage = null
    let lastTimestamp = null
    let contextTokens = null // input context of the most recent assistant turn
    const models = {}
    const searchParts = [] // user + assistant prose, lowercased at the end for content search

    const setEnvelope = (ts, branch, dir) => {
      if (ts) lastTimestamp = ts
      if (branch && branch !== 'HEAD') gitBranch = branch  // last-write: captures branch switches
      if (dir && !cwd) cwd = dir  // first-write: cwd doesn't change mid-session
    }

    // Most bytes are tool results, file snapshots, and attachments that clod never
    // displays. Sniff each line's head to decide whether it needs a JSON.parse at
    // all. The sniff only gates parsing — handling dispatches on the parsed type —
    // so a false positive costs one parse, never wrong data. Assistant records
    // serialize "message" before the envelope "type", so the early marker is the
    // message's "role"; user records lead with the envelope "type". For skipped
    // message lines the envelope tail (timestamp, gitBranch, cwd) is regexed out.
    // (Byte-offset decoding can split a multibyte char at a window edge; that
    // yields a replacement char, which never corrupts the ASCII markers/fields
    // these windows are scanned for.)
    const NL = 10
    for (let pos = 0, lineEnd; pos < buf.length; pos = lineEnd + 1) {
      lineEnd = buf.indexOf(NL, pos)
      if (lineEnd === -1) lineEnd = buf.length
      if (lineEnd === pos) continue

      const head = buf.toString('utf8', pos, Math.min(pos + 600, lineEnd))
      const isAssistant =
        head.includes('"role":"assistant"') || head.includes('"type":"assistant"')
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
          const r = JSON.parse(buf.toString('utf8', pos, lineEnd))
          setEnvelope(r.timestamp, r.gitBranch, r.cwd)
          if (r.type === 'assistant') {
            const ctx = accumulateUsage(r.message, models) // usage on every turn, incl. tool-only
            if (ctx != null) contextTokens = ctx
            searchParts.push(textBlocks(r.message?.content))
          } else if (isRealUserMessage(r)) {
            lastUserMessage = extractText(r.message.content)
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
          matchLast(/"cwd":"([^"]*)"/g, tail),
        )
      } else if (head.includes('"type":"custom-title"')) {
        try {
          const r = JSON.parse(buf.toString('utf8', pos, lineEnd))
          if (r.customTitle) title = r.customTitle
        } catch {}
      }
    }

    if (!cwd) return null

    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const k in models) {
      totals.input += models[k].input
      totals.output += models[k].output
      totals.cacheRead += models[k].cacheRead
      totals.cacheWrite += models[k].cacheWrite
    }
    const throughput = throughputOf(totals)   // input + output + cacheWrite

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
      filePath,
    }
  } catch {
    return null
  }
}

// All session files with stats, newest first. mtime is a faithful proxy for the
// last record's timestamp (files are append-only), so the head of this list is
// what a recency-sorted viewport needs parsed first.
export async function listSessionFiles() {
  let projects
  try {
    projects = await readdir(PROJECTS_DIR)
  } catch {
    return []
  }

  const files = (
    await Promise.all(
      projects.map(async (project) => {
        const projectPath = join(PROJECTS_DIR, project)
        try {
          const names = await readdir(projectPath)
          return names.filter(f => f.endsWith('.jsonl')).map(f => join(projectPath, f))
        } catch {
          return []
        }
      })
    )
  ).flat()

  const stats = await Promise.all(
    files.map(async (filePath) => {
      try {
        return { filePath, stats: await stat(filePath) }
      } catch {
        return null
      }
    })
  )
  return stats.filter(Boolean).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
}

export async function parseSessions(files) {
  const sessions = await Promise.all(files.map(f => parseSession(f.filePath, f.stats)))
  return sessions.filter(Boolean)
}

export async function loadSessions() {
  const sessions = await parseSessions(await listSessionFiles())
  return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

export async function getSessionMessages(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const messages = []

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line)
        if (isRealUserMessage(r)) {
          messages.push({ role: 'user', text: extractText(r.message.content), timestamp: r.timestamp })
        } else if (r.type === 'assistant') {
          const content = r.message?.content
          let text = ''
          if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('')
          else if (typeof content === 'string') text = content
          if (text.trim()) messages.push({ role: 'assistant', text: text.trim(), timestamp: r.timestamp })
        }
      } catch {}
    }

    return messages
  } catch {
    return []
  }
}

// Trash everything Claude Code keys by session id under ~/.claude, plus the
// session's history.jsonl lines. Reversible (goes to Trash). Skips plans/ and
// paste-cache/ (shared across sessions) and sessions/<pid>.json (ephemeral).
export async function deleteSession(filePath) {
  const sessionId = basename(filePath, '.jsonl')
  const candidates = [
    filePath,
    filePath.replace(/\.jsonl$/, ''), // sibling dir (e.g. subagent transcripts)
    join(CLAUDE_DIR, 'tasks', sessionId),
    join(CLAUDE_DIR, 'file-history', sessionId),
    join(CLAUDE_DIR, 'session-env', sessionId),
    join(CLAUDE_DIR, 'debug', `${sessionId}.txt`),
  ]

  // telemetry is keyed by a filename prefix, not an exact path
  const telemetryDir = join(CLAUDE_DIR, 'telemetry')
  try {
    const prefix = `1p_failed_events.${sessionId}.`
    for (const name of await readdir(telemetryDir)) {
      if (name.startsWith(prefix)) candidates.push(join(telemetryDir, name))
    }
  } catch {}

  const toTrash = []
  for (const p of candidates) {
    try {
      await stat(p)
      toTrash.push(p)
    } catch {}
  }
  const { default: trash } = await import('trash') // lazy: only deletes need it
  await trash(toTrash)
  await scrubHistory(sessionId)
}

// Remove the session's prompt lines from history.jsonl. The removed lines are
// written to their own file and that file is trashed, so even this part of the
// delete can be recovered from the Trash.
async function scrubHistory(sessionId) {
  const historyPath = join(CLAUDE_DIR, 'history.jsonl')
  let raw
  try {
    raw = await readFile(historyPath, 'utf8')
  } catch {
    return
  }
  const needle = `"sessionId":"${sessionId}"`
  if (!raw.includes(needle)) return

  const kept = []
  const removed = []
  for (const line of raw.split('\n')) {
    if (line.includes(needle)) removed.push(line)
    else kept.push(line)
  }

  const removedPath = join(CLAUDE_DIR, `history-removed-${sessionId}.jsonl`)
  await writeFile(removedPath, removed.join('\n') + '\n')
  await writeFile(historyPath, kept.join('\n'))
  const { default: trash } = await import('trash')
  await trash([removedPath])
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function relativeTime(ms) {
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

export function shortPath(p) {
  return p.replace(homedir(), '~')
}

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
