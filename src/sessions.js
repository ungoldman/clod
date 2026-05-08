import { readdir, readFile, stat } from 'fs/promises'
import trash from 'trash'
import { join, basename } from 'path'
import { homedir } from 'os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Claude Code injects system content as XML-tagged blocks; filter those out
const INJECTED = /^<(?:context|system|command|tool_result|result|task|env)\b/i

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

    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.type === 'custom-title' && r.customTitle) title = r.customTitle
        if (r.cwd && !cwd) cwd = r.cwd  // first-write: cwd doesn't change mid-session
        if (r.gitBranch && r.gitBranch !== 'HEAD') gitBranch = r.gitBranch  // last-write: captures branch switches
        if (r.timestamp) lastTimestamp = r.timestamp
        if (isRealUserMessage(r)) lastUserMessage = extractText(r.message.content)
      } catch {}
    }

    if (!cwd) return null

    return {
      sessionId,
      title,
      cwd,
      gitBranch,
      lastUserMessage,
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

export function relativeTime(ms) {
  const diff = Date.now() - ms
  if (diff < 60000) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

export function shortPath(p) {
  return p.replace(homedir(), '~')
}
