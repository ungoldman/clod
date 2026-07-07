import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React from 'react'
import { type SortMode, saveConfig } from './config.ts'
import {
  buildDisplayItems,
  computeNavigate,
  computePage,
  computeRowLayout,
  ctxStr,
  type DisplayItem,
  filterItems,
  findAdjacentSessionId,
  nextSortMode,
  pad,
  truncate,
  usedStr
} from './list.ts'
import {
  deleteSession,
  fmtTokens,
  getSessionMessages,
  type Message,
  MONTHS,
  relativeTime,
  renameSession,
  type Session,
  shortPath
} from './sessions.ts'
import { bar, computeStats, sparkline } from './stats.ts'

const h = React.createElement
const { useState, useEffect, useMemo, memo } = React

const HINT_HEIGHT = 1
const HEADER_HEIGHT = 2
const SNIPPET_HEIGHT = 3

// ─── Row ─────────────────────────────────────────────────────────────────────

const SessionRow = memo(function SessionRow({
  session,
  selected,
  termWidth,
  sortMode,
  timeWidth,
  usedWidth,
  ctxWidth
}: {
  session: Session
  selected: boolean
  termWidth: number
  sortMode: SortMode
  timeWidth: number
  usedWidth: number
  ctxWidth: number
}) {
  const { title, branchCol, dirCol, usedCol, ctxCol, timeCol } = computeRowLayout({
    session,
    termWidth,
    sortMode,
    timeWidth,
    usedWidth,
    ctxWidth
  })

  if (selected) {
    const branchPart = branchCol ? `  ${branchCol}` : ''
    const dirPart = dirCol ? `  ${dirCol}` : ''
    const line = `> ${title}${branchPart}${dirPart}  ${usedCol}  ${ctxCol}  ${timeCol}`
    const full = pad(line, termWidth)
    return h(Box, {}, h(Text, { backgroundColor: 'grey', color: 'white', bold: true }, full))
  }

  return h(
    Box,
    { flexDirection: 'row' },
    h(Text, {}, '  '),
    h(Text, {}, title),
    branchCol ? h(Text, { color: 'yellow', dimColor: true }, `  ${branchCol}`) : null,
    dirCol ? h(Text, { color: 'cyan', dimColor: true }, `  ${dirCol}`) : null,
    h(Text, { dimColor: true }, `  ${usedCol}`),
    h(Text, { color: 'green', dimColor: true }, `  ${ctxCol}`),
    h(Text, { dimColor: true }, `  ${timeCol}`)
  )
})

// ─── Row rename field ────────────────────────────────────────────────────────

function InputText({
  value,
  cursor,
  termWidth
}: {
  value: string
  cursor: number
  termWidth: number
}) {
  const style = { backgroundColor: 'grey', color: 'white', bold: true }

  // Past the end there is no character to sit on: show a block instead
  // (ink trims trailing whitespace, so an inverse space would be invisible).
  if (cursor >= value.length) {
    return h(Box, {}, h(Text, style, pad(`> ${value}█`, termWidth)))
  }

  // The cursor is the inverse-video cell over the character it sits on.
  return h(
    Box,
    {},
    h(Text, style, `> ${value.slice(0, cursor)}`),
    h(Text, { ...style, inverse: true }, value[cursor]),
    h(Text, style, pad(value.slice(cursor + 1), Math.max(0, termWidth - cursor - 3)))
  )
}

// Immutable value+cursor pair for the rename input
class InputTextState {
  readonly value: string
  readonly cursorPosition: number

  constructor(value: string, cursorPosition: number) {
    this.value = value
    this.cursorPosition = cursorPosition
  }

  static open(title: string): InputTextState {
    return new InputTextState(title, title.length)
  }

  get trimmedValue(): string {
    return this.value.trim()
  }

  moveCursorLeft(): InputTextState {
    return new InputTextState(this.value, Math.max(0, this.cursorPosition - 1))
  }

  moveCursorRight(): InputTextState {
    return new InputTextState(this.value, Math.min(this.value.length, this.cursorPosition + 1))
  }

  deleteCharBeforeCursor(): InputTextState {
    const cursorPosition = Math.max(0, this.cursorPosition - 1)
    return new InputTextState(
      this.value.slice(0, cursorPosition) + this.value.slice(this.cursorPosition),
      cursorPosition
    )
  }

  insert(text: string): InputTextState {
    return new InputTextState(
      this.value.slice(0, this.cursorPosition) + text + this.value.slice(this.cursorPosition),
      this.cursorPosition + text.length
    )
  }
}

// ─── Directory header ─────────────────────────────────────────────────────────

function DirectoryHeader({ cwd }: { cwd: string }) {
  return h(Box, { paddingLeft: 1 }, h(Text, { color: 'yellow' }, shortPath(cwd)))
}

// ─── Preview mode ─────────────────────────────────────────────────────────────

function PreviewMode({
  session,
  onBack,
  termWidth,
  termHeight
}: {
  session: Session
  onBack: () => void
  termWidth: number
  termHeight: number
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [scroll, setScroll] = useState(0)

  useEffect(() => {
    getSessionMessages(session.filePath).then((msgs) => {
      setMessages(msgs)
      setScroll(Math.max(0, msgs.length - 1))
    })
  }, [session.filePath])

  const viewHeight = termHeight - HEADER_HEIGHT - HINT_HEIGHT - 2

  useInput((input, key) => {
    if (input === 'q' || input === ' ' || key.escape || key.backspace) {
      onBack()
      return
    }
    if (!messages) return
    if (key.downArrow) setScroll((s) => Math.min(s + 1, Math.max(0, messages.length - 1)))
    if (key.upArrow) setScroll((s) => Math.max(0, s - 1))
  })

  const headerTitle = truncate(session.title || 'Untitled', termWidth - 10)

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { flexDirection: 'row', paddingX: 1 },
      h(Text, { color: 'white', bold: true }, `Preview: ${headerTitle}`)
    ),
    h(
      Box,
      { flexDirection: 'column', height: viewHeight },
      messages === null
        ? h(Box, { padding: 1 }, h(Text, { dimColor: true }, 'Loading…'))
        : messages.length === 0
          ? h(Box, { padding: 1 }, h(Text, { dimColor: true }, 'No messages found.'))
          : renderMessages(messages, scroll, viewHeight, termWidth)
    ),
    h(Box, {}, h(Text, { dimColor: true }, '↑↓ scroll  q/esc back'))
  )
}

function renderMessages(
  messages: Message[],
  scroll: number,
  viewHeight: number,
  termWidth: number
) {
  // scroll is the index of the last visible message; show the window ending there
  const start = Math.max(0, scroll - viewHeight + 2)
  const visible = messages.slice(start, start + viewHeight)

  return h(
    Box,
    { flexDirection: 'column' },
    ...visible.map((msg, i) => {
      const isUser = msg.role === 'user'
      const prefix = isUser ? 'you: ' : '  AI: '
      const maxText = termWidth - prefix.length - 2
      const text = truncate(msg.text.replace(/\n+/g, ' '), maxText)
      return h(
        Box,
        { key: i, flexDirection: 'row', paddingX: 1 },
        h(Text, { color: isUser ? 'white' : 'cyan', dimColor: !isUser }, prefix + text)
      )
    })
  )
}

// ─── Delete confirm ───────────────────────────────────────────────────────────

function DeleteConfirm({
  session,
  onConfirm,
  onCancel,
  termWidth,
  termHeight
}: {
  session: Session
  onConfirm: () => void
  onCancel: () => void
  termWidth: number
  termHeight: number
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)

  useEffect(() => {
    getSessionMessages(session.filePath).then(setMessages)
  }, [session.filePath])

  useInput((input) => {
    if (input === 'y') onConfirm()
    else onCancel()
  })

  const previewHeight = termHeight - 6 // header + id + prompt + status
  const previewMessages = messages?.slice(-previewHeight) ?? []

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { paddingX: 1 },
      h(
        Text,
        { color: 'white', bold: true },
        `Delete: ${truncate(session.title || 'Untitled', termWidth - 10)}`
      )
    ),
    h(Box, { paddingX: 1 }, h(Text, { dimColor: true }, session.sessionId)),
    h(
      Box,
      { flexDirection: 'column', height: previewHeight, paddingX: 1 },
      messages === null
        ? h(Text, { dimColor: true }, 'Loading…')
        : previewMessages.length === 0
          ? h(Text, { dimColor: true }, 'No messages.')
          : previewMessages.map((msg, i) => {
              const isUser = msg.role === 'user'
              const prefix = isUser ? 'you: ' : '  AI: '
              const text = truncate(msg.text.replace(/\n+/g, ' '), termWidth - prefix.length - 4)
              return h(
                Text,
                { key: i, color: isUser ? undefined : 'cyan', dimColor: !isUser },
                prefix + text
              )
            })
    ),
    h(
      Box,
      {
        borderStyle: 'single',
        borderColor: 'red',
        borderLeft: false,
        borderRight: false,
        borderBottom: false
      },
      h(Text, { color: 'red' }, 'y delete  n/esc cancel')
    )
  )
}

// ─── Usage dashboard ────────────────────────────────────────────────────────

function StatsView({
  sessions,
  onBack,
  termWidth,
  termHeight
}: {
  sessions: Session[]
  onBack: () => void
  termWidth: number
  termHeight: number
}) {
  const stats = useMemo(() => computeStats(sessions), [sessions])

  useInput((input, key) => {
    if (input === 'q' || input === 'u' || key.escape) onBack()
  })

  const labelW = 9
  const barW = Math.min(24, Math.max(10, termWidth - 40))
  const modelMax = Math.max(0, ...stats.byModel.map((m) => m.throughput))

  const bd = stats.breakdown
  const bdRows = [
    { label: 'Input', value: bd.input },
    { label: 'Output', value: bd.output },
    { label: 'Cache wr', value: bd.cacheWrite },
    { label: 'Cache rd', value: bd.cacheRead }
  ]
  const bdMax = Math.max(0, ...bdRows.map((r) => r.value))

  const projMax = Math.max(0, ...stats.byProject.map((p) => p.throughput))
  const maxProjects = Math.max(3, termHeight - 16)
  const projects = stats.byProject.slice(0, maxProjects)
  const projLabelW = Math.min(34, Math.max(12, termWidth - barW - 16))

  const spark = sparkline(stats.days.map((d) => d.tokens))
  const sparkStart = `${MONTHS[stats.days[0].date.getMonth()]} ${stats.days[0].date.getDate()}`
  const sparkEnd = 'today'

  const section = (label: string) =>
    h(Box, { marginTop: 1 }, h(Text, { bold: true, color: 'cyan' }, label))

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { paddingX: 1 },
      h(Text, { color: 'white', bold: true }, 'Usage  ·  real throughput (cache reads excluded)')
    ),
    h(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      h(
        Text,
        {},
        `${stats.totalSessions} sessions   `,
        h(Text, { color: 'green', bold: true }, `${fmtTokens(stats.totalThroughput)} throughput`),
        h(Text, { dimColor: true }, `   ${fmtTokens(stats.grandTotal)} incl. cache reads`)
      ),

      section('Token breakdown'),
      ...bdRows.map((r) =>
        h(
          Text,
          { key: r.label },
          pad(r.label, labelW),
          h(Text, { color: r.label === 'Cache rd' ? 'gray' : 'green' }, bar(r.value, bdMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(r.value)}`)
        )
      ),

      section('Throughput / day (30d)'),
      h(
        Text,
        {},
        h(Text, { dimColor: true }, `${pad(sparkStart, 7)} `),
        h(Text, { color: 'green' }, spark),
        h(Text, { dimColor: true }, ` ${sparkEnd}`)
      ),

      section('By model'),
      ...stats.byModel.map((m) =>
        h(
          Text,
          { key: m.name },
          pad(m.name, labelW),
          h(Text, { color: 'green' }, bar(m.throughput, modelMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(m.throughput)}`)
        )
      ),

      section('Top projects by throughput'),
      ...projects.map((p) =>
        h(
          Text,
          { key: p.cwd },
          pad(truncate(shortPath(p.cwd), projLabelW), projLabelW),
          ' ',
          h(Text, { color: 'green' }, bar(p.throughput, projMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(p.throughput)}`)
        )
      )
    ),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, 'q/esc/u back'))
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export interface AppProps {
  loadFirst: () => Promise<Session[]> | Session[]
  loadRest: (() => Promise<Session[]>) | null
  initialSortMode?: SortMode
  onResume: (session: Session) => void
  onDelete?: (filePath: string) => Promise<void>
  onRename?: (filePath: string, title: string) => Promise<void>
}

export default function App({
  loadFirst,
  loadRest,
  initialSortMode,
  onResume,
  onDelete = deleteSession,
  onRename = renameSession
}: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termWidth = stdout?.columns || 80
  const termHeight = stdout?.rows || 24

  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewStart, setViewStart] = useState(0)
  const [mode, setMode] = useState<'list' | 'preview' | 'stats' | 'deleting'>('list')
  const [sortMode, setSortMode] = useState<SortMode>(initialSortMode ?? 'recent')
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [rename, setRename] = useState<InputTextState | null>(null)
  const [loading, setLoading] = useState(true)

  // Paint before any session is parsed: newest batch first, the rest in one later
  // batch (disjoint from the first, so a delete can't be resurrected by the merge).
  useEffect(() => {
    ;(async () => {
      setSessions(await loadFirst())
      if (loadRest) {
        const more = await loadRest()
        setSessions((cur) => [...cur, ...more])
      }
      setLoading(false)
    })()
  }, [])

  const listHeight = termHeight - HEADER_HEIGHT - SNIPPET_HEIGHT - HINT_HEIGHT - 1

  // shared column widths so count/time align across every row
  const timeWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, relativeTime(s.lastTimestamp).length), 4),
    [sessions]
  )
  const usedWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, usedStr(s).length), 1),
    [sessions]
  )
  const ctxWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, ctxStr(s).length), 1),
    [sessions]
  )

  const displayItems = useMemo(() => buildDisplayItems(sessions, sortMode), [sessions, sortMode])
  const filteredItems = useMemo(
    () => filterItems(displayItems, searchQuery),
    [displayItems, searchQuery]
  )

  const selectedIdx = useMemo(
    () =>
      filteredItems.findIndex(
        (item) => item.type === 'session' && item.session.sessionId === selectedId
      ),
    [filteredItems, selectedId]
  )

  const currentItem: DisplayItem | undefined = filteredItems[selectedIdx]
  const current = currentItem?.type === 'session' ? currentItem.session : undefined

  useEffect(() => {
    if (selectedIdx === -1) {
      const first = filteredItems.find((i) => i.type === 'session')
      if (first && first.type === 'session') setSelectedId(first.session.sessionId)
    }
  }, [filteredItems])

  useEffect(() => {
    setViewStart((vs) => Math.min(vs, Math.max(0, filteredItems.length - listHeight)))
  }, [termHeight])

  function navigate(dir: number) {
    const r = computeNavigate(filteredItems, selectedIdx, viewStart, listHeight, dir)
    if (r) {
      setSelectedId(r.selectedId)
      setViewStart(r.viewStart)
    }
  }

  function page(dir: number) {
    const r = computePage(filteredItems, selectedIdx, viewStart, listHeight, dir)
    if (r) {
      setSelectedId(r.selectedId)
      setViewStart(r.viewStart)
    }
  }

  useInput((input, key) => {
    if (mode !== 'list') return

    if (rename !== null) {
      if (key.escape) {
        setRename(null)
        return
      }
      if (key.return) {
        const title = rename.trimmedValue
        setRename(null)
        if (current && title && title !== (current.title || 'Untitled')) {
          // update the row in the same frame the input closes
          const updateRow = (s: Session) =>
            s.sessionId === current.sessionId ? { ...s, title } : s
          setSessions((cur) => cur.map(updateRow))
          // persist in the background
          onRename(current.filePath, title)
        }
        return
      }
      if (key.leftArrow) {
        setRename((r) => r && r.moveCursorLeft())
        return
      }
      if (key.rightArrow) {
        setRename((r) => r && r.moveCursorRight())
        return
      }
      if (key.backspace || key.delete || input === '\x7f') {
        setRename((r) => r && r.deleteCharBeforeCursor())
        return
      }
      if (input && input !== '\x7f' && !key.ctrl && !key.meta) {
        setRename((r) => r && r.insert(input))
      }
      return
    }

    if (isSearching) {
      if (key.escape) {
        setIsSearching(false)
        setSearchQuery('')
        setViewStart(0)
        return
      }
      if (key.backspace || key.delete || input === '\x7f') {
        if (searchQuery.length === 0) {
          setIsSearching(false)
        } else {
          setSearchQuery((q) => q.slice(0, -1))
          setViewStart(0)
        }
        return
      }
      if (key.upArrow) {
        navigate(-1)
        return
      }
      if (key.downArrow) {
        navigate(1)
        return
      }
      if (key.pageUp) {
        page(-1)
        return
      }
      if (key.pageDown) {
        page(1)
        return
      }
      if (key.return) {
        if (current) {
          onResume(current)
          exit()
        }
        return
      }
      if (input && input !== '\x7f' && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input)
        setViewStart(0)
      }
      return
    }

    if (key.upArrow) navigate(-1)
    else if (key.downArrow) navigate(1)
    else if (key.pageUp) page(-1)
    else if (key.pageDown) page(1)
    else if (input === '/') setIsSearching(true)
    else if (input === ' ' && current) setMode('preview')
    else if (input === 'u') setMode('stats')
    else if (key.return && current) {
      onResume(current)
      exit()
    } else if (input === 'r' && current) {
      setRename(InputTextState.open(current.title || 'Untitled'))
    } else if (input === 'D' && current) setMode('deleting')
    else if (input === 's') {
      const next = nextSortMode(sortMode)
      setSortMode(next)
      setViewStart(0)
      saveConfig({ sortMode: next }) // persist for next launch (fire and forget)
    } else if (input === 'q' || key.escape) exit()
  })

  const viewSlice = filteredItems.slice(viewStart, viewStart + listHeight)

  if (mode === 'preview' && current) {
    return h(PreviewMode, {
      session: current,
      onBack: () => setMode('list'),
      termWidth,
      termHeight
    })
  }

  if (mode === 'stats') {
    return h(StatsView, {
      sessions,
      onBack: () => setMode('list'),
      termWidth,
      termHeight
    })
  }

  if (mode === 'deleting' && current) {
    return h(DeleteConfirm, {
      session: current,
      termWidth,
      termHeight,
      onConfirm: async () => {
        try {
          await onDelete(current.filePath)
        } catch {
          setMode('list')
          return
        }
        const next = sessions.filter((s) => s.sessionId !== current.sessionId)
        setSessions(next)
        if (next.length === 0) {
          exit()
          return
        }
        const remaining = new Set(next.map((s) => s.sessionId))
        const adjId = findAdjacentSessionId(filteredItems, selectedIdx, remaining)
        if (adjId) setSelectedId(adjId)
        setViewStart((vs) => Math.min(vs, Math.max(0, next.length - 1 - listHeight)))
        setMode('list')
      },
      onCancel: () => setMode('list')
    })
  }

  const snippet = current?.lastUserMessage
    ? truncate(current.lastUserMessage.replace(/\n+/g, ' '), termWidth - 6)
    : loading && !current
      ? '…'
      : 'no user messages'

  const sortLabel: Record<SortMode, string> = {
    directory: 'grouped by directory',
    recent: 'sorted by most recent',
    lexic: 'sorted lexicographically'
  }
  const matchCount = filteredItems.filter((i) => i.type === 'session').length
  const searchLabel =
    isSearching || searchQuery
      ? ` │ /${searchQuery}${isSearching ? '█' : ''}  ${matchCount} matches`
      : ''
  const headerText = pad(
    sessions.length === 0 && loading
      ? ' clod │ loading sessions…'
      : ` clod │ ${sessions.length}${loading ? '+' : ''} sessions │ ${sortLabel[sortMode]}${searchLabel}${loading ? ' │ loading…' : ''}`,
    termWidth
  )
  const navText = pad(
    rename !== null
      ? ' enter confirm  esc cancel'
      : ' ↑↓ nav  / search  space preview  enter resume  r rename  u usage  s sort  D delete  q quit',
    termWidth
  )

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      {
        borderStyle: 'single',
        borderLeft: false,
        borderRight: false,
        borderTop: false,
        borderColor: 'gray'
      },
      h(Text, { backgroundColor: 'black', color: 'white', bold: true }, headerText)
    ),
    h(
      Box,
      { flexDirection: 'column', height: listHeight },
      viewSlice.length === 0 && loading
        ? h(Box, { paddingX: 2 }, h(Text, { dimColor: true }, 'Loading…'))
        : null,
      ...viewSlice.map((item) =>
        item.type === 'header'
          ? h(DirectoryHeader, { key: item.cwd, cwd: item.cwd })
          : item.session.sessionId === selectedId && rename !== null
            ? h(InputText, {
                key: item.session.sessionId,
                value: rename.value,
                cursor: rename.cursorPosition,
                termWidth
              })
            : h(SessionRow, {
                key: item.session.sessionId,
                session: item.session,
                selected: item.session.sessionId === selectedId,
                termWidth,
                sortMode,
                timeWidth,
                usedWidth,
                ctxWidth
              })
      )
    ),
    h(
      Box,
      {
        flexDirection: 'row',
        borderStyle: 'single',
        borderColor: 'gray',
        borderLeft: false,
        borderRight: false,
        paddingX: 1
      },
      h(Text, { color: 'cyan', dimColor: true }, '" '),
      h(Text, { dimColor: true, italic: true }, snippet)
    ),
    h(Box, {}, h(Text, { backgroundColor: 'black', color: 'white', dimColor: true }, navText))
  )
}
