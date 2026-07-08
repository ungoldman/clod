import type { SortMode } from './config.ts'
import { fmtTokens, relativeTime, type Session, shortPath } from './sessions.ts'

export type DisplayItem = { type: 'session'; session: Session } | { type: 'header'; cwd: string }

// items[i] is always a session here: callers skip headers before calling.
const sessionIdAt = (items: DisplayItem[], i: number): string =>
  (items[i] as Extract<DisplayItem, { type: 'session' }>).session.sessionId

// below these widths a column is hidden rather than truncated into noise
export const BRANCH_MIN = 8
export const DIR_MIN = 10

export function termSize(stdout?: { columns?: number; rows?: number }): {
  width: number
  height: number
} {
  return { width: stdout?.columns || 80, height: stdout?.rows || 24 }
}

export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return ''
  return str.length > max ? `${str.slice(0, max - 1)}…` : str
}

export function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}

export function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str
}

// subsequence fuzzy match: query chars must appear in order, case-insensitive
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

// Title matches fuzzy (it's short); content matches by substring (fuzzy over a
// long blob hits everything).
export function sessionMatches(query: string, session: Session): boolean {
  if (fuzzyMatch(query, session.title || 'Untitled')) return true
  return session.searchText ? session.searchText.includes(query.toLowerCase()) : false
}

export const usedStr = (s: Session): string =>
  s.throughput ? `${fmtTokens(s.throughput)} used` : '—'
export const ctxStr = (s: Session): string =>
  s.contextTokens != null ? `${fmtTokens(s.contextTokens)} ctx` : '—'

// Title-first: title takes its natural width; dir then branch fill the remainder
// and drop out (not stubbed) when it's too tight.
export function computeRowLayout(opts: {
  session: Session
  termWidth: number
  sortMode: SortMode
  timeWidth: number
  usedWidth: number
  ctxWidth: number
}) {
  const { session, termWidth, sortMode, timeWidth, usedWidth, ctxWidth } = opts
  const timeStr = relativeTime(session.lastTimestamp)
  const pathStr = shortPath(session.cwd)
  const naturalBranch = session.gitBranch ?? null
  const showDir = sortMode !== 'directory'

  // flex = space for title + branch + dir after the fixed right block
  // (used/ctx/time + three 2-space gaps).
  const fullTitle = session.title || 'Untitled'
  const flex = termWidth - 2 - usedWidth - ctxWidth - timeWidth - 6
  let avail = flex - fullTitle.length

  let dirWidth = 0
  if (showDir && avail >= DIR_MIN + 2) {
    dirWidth = Math.min(pathStr.length, avail - 2)
    avail -= dirWidth + 2
  }
  let branchWidth = 0
  if (naturalBranch && avail >= BRANCH_MIN + 2) {
    branchWidth = Math.min(naturalBranch.length, avail - 2)
    avail -= branchWidth + 2
  }
  // title absorbs the leftover as padding so the right block stays aligned
  const titleWidth = Math.max(
    1,
    flex - (dirWidth ? dirWidth + 2 : 0) - (branchWidth ? branchWidth + 2 : 0)
  )

  return {
    title: pad(truncate(fullTitle, titleWidth), titleWidth),
    branchCol: branchWidth > 0 ? truncate(naturalBranch, branchWidth) : null,
    dirCol: dirWidth > 0 ? truncate(pathStr, dirWidth) : null,
    usedCol: padLeft(usedStr(session), usedWidth),
    ctxCol: padLeft(ctxStr(session), ctxWidth),
    timeCol: pad(timeStr, timeWidth)
  }
}

// Sorted (and grouped, for directory mode) flat list of display items.
export function buildDisplayItems(sessions: Session[], sortMode: SortMode): DisplayItem[] {
  let sorted: Session[]
  if (sortMode === 'recent') {
    sorted = [...sessions].sort((a, b) => b.lastTimestamp - a.lastTimestamp)
  } else if (sortMode === 'lexic') {
    sorted = [...sessions].sort((a, b) => {
      const ta = a.title || 'Untitled'
      const tb = b.title || 'Untitled'
      return ta < tb ? -1 : ta > tb ? 1 : b.lastTimestamp - a.lastTimestamp
    })
  } else {
    const cwdLatest = new Map<string, number>()
    for (const s of sessions) {
      if (s.lastTimestamp > (cwdLatest.get(s.cwd) ?? 0)) cwdLatest.set(s.cwd, s.lastTimestamp)
    }
    // every cwd is in cwdLatest, so the lookups are defined
    sorted = [...sessions].sort((a, b) => {
      const g = (cwdLatest.get(b.cwd) as number) - (cwdLatest.get(a.cwd) as number)
      return g !== 0 ? g : b.lastTimestamp - a.lastTimestamp
    })
  }

  if (sortMode === 'recent' || sortMode === 'lexic')
    return sorted.map((s) => ({ type: 'session', session: s }))

  const items: DisplayItem[] = []
  let lastCwd: string | null = null
  for (const s of sorted) {
    if (s.cwd !== lastCwd) {
      items.push({ type: 'header', cwd: s.cwd })
      lastCwd = s.cwd
    }
    items.push({ type: 'session', session: s })
  }
  return items
}

// Keep matching sessions; keep a header only if a matching session follows it.
export function filterItems(items: DisplayItem[], query: string): DisplayItem[] {
  if (!query) return items
  const filtered: DisplayItem[] = []
  let pendingHeader: DisplayItem | null = null
  for (const item of items) {
    if (item.type === 'header') {
      pendingHeader = item
    } else if (sessionMatches(query, item.session)) {
      if (pendingHeader) {
        filtered.push(pendingHeader)
        pendingHeader = null
      }
      filtered.push(item)
    }
  }
  return filtered
}

// Pull viewStart back to show a header just above it, unless that would push the
// selection off-screen.
function includeHeaderAbove(
  items: DisplayItem[],
  newVs: number,
  selected: number,
  listHeight: number
): number {
  if (newVs > 0 && items[newVs - 1].type === 'header' && selected <= newVs - 1 + listHeight - 1)
    return newVs - 1
  return newVs
}

// Move selection by ±1, skipping headers, scrolling to keep it visible.
// null when there's nowhere to go.
export function computeNavigate(
  items: DisplayItem[],
  selectedIdx: number,
  viewStart: number,
  listHeight: number,
  dir: number
) {
  let next = selectedIdx + dir
  while (next >= 0 && next < items.length && items[next].type === 'header') next += dir
  if (next < 0 || next >= items.length) return null

  let newVs = viewStart
  if (next < viewStart) newVs = next
  else if (next >= viewStart + listHeight) newVs = next - listHeight + 1
  newVs = includeHeaderAbove(items, newVs, next, listHeight)
  return { selectedId: sessionIdAt(items, next), viewStart: newVs }
}

// Page selection and viewport, landing on a session and clamping at the edges.
// null when there's nowhere to go.
export function computePage(
  items: DisplayItem[],
  selectedIdx: number,
  viewStart: number,
  listHeight: number,
  dir: number
) {
  if (items.length === 0 || selectedIdx < 0) return null
  const last = items.length - 1
  const step = dir * listHeight
  const target = Math.max(0, Math.min(last, selectedIdx + step))
  let t = target
  while (t >= 0 && t <= last && items[t].type === 'header') t += dir
  if (t < 0 || t > last) {
    t = target
    while (t >= 0 && t <= last && items[t].type === 'header') t -= dir
  }
  if (t < 0 || t > last) return null

  const maxVs = Math.max(0, items.length - listHeight)
  let newVs = Math.max(0, Math.min(maxVs, viewStart + step))
  if (t < newVs) newVs = t
  else if (t >= newVs + listHeight) newVs = t - listHeight + 1
  newVs = includeHeaderAbove(items, newVs, t, listHeight)
  return { selectedId: sessionIdAt(items, t), viewStart: Math.max(0, newVs) }
}

// recent -> lexic -> directory -> recent
export function nextSortMode(sortMode: SortMode): SortMode {
  return sortMode === 'recent' ? 'lexic' : sortMode === 'directory' ? 'recent' : 'directory'
}

// Nearest surviving session to the deleted one: prefer the next below, else above.
export function findAdjacentSessionId(
  items: DisplayItem[],
  selectedIdx: number,
  remaining: Set<string>
): string | null {
  const match = (i: DisplayItem): i is Extract<DisplayItem, { type: 'session' }> =>
    i.type === 'session' && remaining.has(i.session.sessionId)
  const below = items.slice(selectedIdx + 1).find(match)
  if (below) return below.session.sessionId
  const above = items.slice(0, selectedIdx).reverse().find(match)
  if (above) return above.session.sessionId
  return null
}
