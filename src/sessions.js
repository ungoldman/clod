import { readdir, readFile, stat } from 'fs/promises'
import trash from 'trash'
import { join, basename } from 'path'
import { homedir } from 'os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

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

function modelKey(modelId) {
  if (!modelId) return null
  if (modelId.includes('opus')) return 'opus'
  if (modelId.includes('sonnet')) return 'sonnet'
  if (modelId.includes('haiku')) return 'haiku'
  return null
}

// Add one assistant message's usage into the per-model token accumulator { key: {tokens} }.
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
    const m = (acc[key] ??= { tokens: 0 })
    m.tokens += input + output + cacheRead + cacheWrite
  }

  return input + cacheRead + cacheWrite
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

    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.type === 'custom-title' && r.customTitle) title = r.customTitle
        if (r.cwd && !cwd) cwd = r.cwd  // first-write: cwd doesn't change mid-session
        if (r.gitBranch && r.gitBranch !== 'HEAD') gitBranch = r.gitBranch  // last-write: captures branch switches
        if (r.timestamp) lastTimestamp = r.timestamp
        if (isRealUserMessage(r)) {
          lastUserMessage = extractText(r.message.content)
        } else if (r.type === 'assistant') {
          const ctx = accumulateUsage(r.message, models) // usage on every turn, incl. tool-only
          if (ctx != null) contextTokens = ctx
        }
      } catch {}
    }

    if (!cwd) return null

    let tokens = 0
    for (const k in models) tokens += models[k].tokens

    return {
      sessionId,
      title,
      cwd,
      gitBranch,
      lastUserMessage,
      contextTokens,
      models,
      tokens,
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

export async function deleteSession(filePath) {
  const siblingDir = filePath.replace(/\.jsonl$/, '')
  const toTrash = [filePath]
  try {
    await stat(siblingDir)
    toTrash.push(siblingDir)
  } catch {}
  await trash(toTrash)
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
