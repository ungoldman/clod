import { readdir, readFile, stat, writeFile } from 'fs/promises'
import trash from 'trash'
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

async function parseSession(filePath) {
  const sessionId = basename(filePath, '.jsonl')

  try {
    const [fileStats, raw] = await Promise.all([stat(filePath), readFile(filePath, 'utf8')])
    const lines = raw.split('\n').filter(Boolean)

    let title = null
    let cwd = null
    let gitBranch = null
    let lastUserMessage = null
    let lastTimestamp = null
    let contextTokens = null // input context of the most recent assistant turn
    const models = {}
    const searchParts = [] // user + assistant prose, lowercased at the end for content search

    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.type === 'custom-title' && r.customTitle) title = r.customTitle
        if (r.cwd && !cwd) cwd = r.cwd  // first-write: cwd doesn't change mid-session
        if (r.gitBranch && r.gitBranch !== 'HEAD') gitBranch = r.gitBranch  // last-write: captures branch switches
        if (r.timestamp) lastTimestamp = r.timestamp
        if (isRealUserMessage(r)) {
          lastUserMessage = extractText(r.message.content)
          searchParts.push(lastUserMessage)
        } else if (r.type === 'assistant') {
          const ctx = accumulateUsage(r.message, models) // usage on every turn, incl. tool-only
          if (ctx != null) contextTokens = ctx
          searchParts.push(textBlocks(r.message?.content))
        }
      } catch {}
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

export async function loadSessions() {
  let projects
  try {
    projects = await readdir(PROJECTS_DIR)
  } catch {
    return []
  }

  const results = await Promise.all(
    projects.map(async (project) => {
      const projectPath = join(PROJECTS_DIR, project)
      try {
        const files = await readdir(projectPath)
        return Promise.all(
          files.filter(f => f.endsWith('.jsonl')).map(f => parseSession(join(projectPath, f)))
        )
      } catch {
        return []
      }
    })
  )

  return results.flat().filter(Boolean).sort((a, b) => b.lastTimestamp - a.lastTimestamp)
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

// A session is more than its transcript. Claude Code also keeps, keyed by
// session id: file-history/ (snapshots of files edited during the session),
// session-env/, and the session's prompt lines in the global history.jsonl.
// Everything goes to the Trash, so a delete stays reversible.
export async function deleteSession(filePath) {
  const sessionId = basename(filePath, '.jsonl')
  const candidates = [
    filePath,
    filePath.replace(/\.jsonl$/, ''), // sibling dir (e.g. subagent transcripts)
    join(CLAUDE_DIR, 'file-history', sessionId),
    join(CLAUDE_DIR, 'session-env', sessionId),
  ]
  const toTrash = []
  for (const p of candidates) {
    try {
      await stat(p)
      toTrash.push(p)
    } catch {}
  }
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
  await trash([removedPath])
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
