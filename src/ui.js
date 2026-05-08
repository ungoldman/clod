import React from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import {
  getSessionMessages,
  deleteSession,
  relativeTime,
  shortPath,
} from "./sessions.js";

const h = React.createElement;
const { useState, useEffect, useMemo, memo } = React;

const HINT_HEIGHT = 1;
const HEADER_HEIGHT = 2;
const SNIPPET_HEIGHT = 3;

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function pad(str, len) {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

// ─── Row ─────────────────────────────────────────────────────────────────────

const TITLE_MIN = 10;
const BRANCH_MIN = 8;
const DIR_MIN = 10;

const SessionRow = memo(function SessionRow({
  session,
  selected,
  termWidth,
  sortMode,
}) {
  const timeStr = relativeTime(session.lastTimestamp);
  const pathStr = shortPath(session.cwd);
  const naturalBranch = session.gitBranch ?? null;
  const showDir = sortMode !== "directory";

  const timeWidth = Math.max(timeStr.length, 4);
  const numSeps = 1 + (showDir ? 1 : 0) + (naturalBranch ? 1 : 0);
  const pool = Math.max(0, termWidth - 2 - numSeps * 2 - timeWidth);

  let dirWidth = showDir ? pathStr.length : 0;
  let branchWidth = naturalBranch ? naturalBranch.length : 0;
  let titleWidth = pool - dirWidth - branchWidth;

  if (titleWidth < TITLE_MIN) {
    const dirShrink = Math.min(
      Math.max(0, dirWidth - DIR_MIN),
      TITLE_MIN - titleWidth,
    );
    dirWidth -= dirShrink;
    titleWidth += dirShrink;
  }
  if (titleWidth < TITLE_MIN) {
    const branchShrink = Math.min(
      Math.max(0, branchWidth - BRANCH_MIN),
      TITLE_MIN - titleWidth,
    );
    branchWidth -= branchShrink;
    titleWidth += branchShrink;
  }
  titleWidth = Math.max(TITLE_MIN, titleWidth);

  const title = pad(
    truncate(session.title || "Untitled", titleWidth),
    titleWidth,
  );
  const timeCol = pad(timeStr, timeWidth);
  const branchCol = naturalBranch ? truncate(naturalBranch, branchWidth) : null;
  const dirCol = showDir ? truncate(pathStr, dirWidth) : null;

  if (selected) {
    const branchPart = branchCol ? `  ${branchCol}` : "";
    const dirPart = dirCol ? `  ${dirCol}` : "";
    const line = `> ${title}${branchPart}${dirPart}  ${timeCol}`;
    const full = pad(line, termWidth);
    return h(
      Box,
      {},
      h(Text, { backgroundColor: "grey", color: "white", bold: true }, full),
    );
  }

  return h(
    Box,
    { flexDirection: "row" },
    h(Text, {}, "  "),
    h(Text, {}, title),
    branchCol
      ? h(Text, { color: "yellow", dimColor: true }, `  ${branchCol}`)
      : null,
    dirCol ? h(Text, { color: "cyan", dimColor: true }, `  ${dirCol}`) : null,
    h(Text, { dimColor: true }, `  ${timeCol}`),
  );
});

// ─── Directory header ─────────────────────────────────────────────────────────

function DirectoryHeader({ cwd }) {
  return h(
    Box,
    { paddingLeft: 1 },
    h(Text, { color: "yellow", dimColor: true }, shortPath(cwd)),
  );
}

// ─── Preview mode ─────────────────────────────────────────────────────────────

function PreviewMode({ session, onBack, termWidth, termHeight }) {
  const [messages, setMessages] = useState(null);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    getSessionMessages(session.filePath).then((msgs) => {
      setMessages(msgs);
      setScroll(Math.max(0, msgs.length - 1));
    });
  }, [session.filePath]);

  const viewHeight = termHeight - HEADER_HEIGHT - HINT_HEIGHT - 2;

  useInput((input, key) => {
    if (input === "q" || key.escape || key.backspace) {
      onBack();
      return;
    }
    if (!messages) return;
    if (key.downArrow)
      setScroll((s) => Math.min(s + 1, Math.max(0, messages.length - 1)));
    if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
  });

  const headerTitle = truncate(session.title || "Untitled", termWidth - 10);

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { flexDirection: "row", backgroundColor: "blue", paddingX: 1 },
      h(Text, { color: "white", bold: true }, `Preview: ${headerTitle}`),
    ),
    h(
      Box,
      { flexDirection: "column", height: viewHeight },
      messages === null
        ? h(Box, { padding: 1 }, h(Text, { dimColor: true }, "Loading…"))
        : messages.length === 0
          ? h(
              Box,
              { padding: 1 },
              h(Text, { dimColor: true }, "No messages found."),
            )
          : renderMessages(messages, scroll, viewHeight, termWidth),
    ),
    h(Box, {}, h(Text, { dimColor: true }, "↑↓ scroll  q/esc back")),
  );
}

function renderMessages(messages, scroll, viewHeight, termWidth) {
  // scroll is the index of the last visible message; show the window ending there
  const start = Math.max(0, scroll - viewHeight + 2);
  const visible = messages.slice(start, start + viewHeight);

  return h(
    Box,
    { flexDirection: "column" },
    ...visible.map((msg, i) => {
      const isUser = msg.role === "user";
      const prefix = isUser ? "you: " : "  AI: ";
      const maxText = termWidth - prefix.length - 2;
      const text = truncate(msg.text.replace(/\n+/g, " "), maxText);
      return h(
        Box,
        { key: i, flexDirection: "row", paddingX: 1 },
        h(
          Text,
          { color: isUser ? "white" : "cyan", dimColor: !isUser },
          prefix + text,
        ),
      );
    }),
  );
}

// ─── Delete confirm ───────────────────────────────────────────────────────────

function DeleteConfirm({
  session,
  onConfirm,
  onCancel,
  termWidth,
  termHeight,
}) {
  const [messages, setMessages] = useState(null);

  useEffect(() => {
    getSessionMessages(session.filePath).then(setMessages);
  }, [session.filePath]);

  useInput((input, key) => {
    if (input === "y") onConfirm();
    else onCancel();
  });

  const previewHeight = termHeight - 6; // header + id + prompt + status
  const previewMessages = messages?.slice(-previewHeight) ?? [];

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { backgroundColor: "red", paddingX: 1 },
      h(
        Text,
        { color: "white", bold: true },
        `Delete: ${truncate(session.title || "Untitled", termWidth - 10)}`,
      ),
    ),
    h(Box, { paddingX: 1 }, h(Text, { dimColor: true }, session.sessionId)),
    h(
      Box,
      { flexDirection: "column", height: previewHeight, paddingX: 1 },
      messages === null
        ? h(Text, { dimColor: true }, "Loading…")
        : previewMessages.length === 0
          ? h(Text, { dimColor: true }, "No messages.")
          : previewMessages.map((msg, i) => {
              const isUser = msg.role === "user";
              const prefix = isUser ? "you: " : "  AI: ";
              const text = truncate(
                msg.text.replace(/\n+/g, " "),
                termWidth - prefix.length - 4,
              );
              return h(
                Text,
                {
                  key: i,
                  color: isUser ? undefined : "cyan",
                  dimColor: !isUser,
                },
                prefix + text,
              );
            }),
    ),
    h(
      Box,
      {
        borderStyle: "single",
        borderColor: "red",
        borderLeft: false,
        borderRight: false,
        borderBottom: false,
      },
      h(Text, { color: "red" }, "y delete  n/esc cancel"),
    ),
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App({ sessions: initialSessions, onResume }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const [sessions, setSessions] = useState(initialSessions);
  const [selectedId, setSelectedId] = useState(initialSessions[0]?.sessionId);
  const [viewStart, setViewStart] = useState(0);
  const [mode, setMode] = useState("list");
  const [sortMode, setSortMode] = useState("directory"); // 'recent' | 'directory' | 'lexic'
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const listHeight =
    termHeight - HEADER_HEIGHT - SNIPPET_HEIGHT - HINT_HEIGHT - 1;

  // Sorted + grouped flat list of display items
  const displayItems = useMemo(() => {
    let sorted;
    if (sortMode === "recent") {
      sorted = [...sessions].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    } else if (sortMode === "lexic") {
      sorted = [...sessions].sort((a, b) => {
        const ta = a.title || "Untitled";
        const tb = b.title || "Untitled";
        return ta < tb ? -1 : ta > tb ? 1 : b.lastTimestamp - a.lastTimestamp;
      });
    } else {
      const cwdLatest = new Map();
      for (const s of sessions) {
        if (s.lastTimestamp > (cwdLatest.get(s.cwd) ?? 0))
          cwdLatest.set(s.cwd, s.lastTimestamp);
      }
      sorted = [...sessions].sort((a, b) => {
        const g = cwdLatest.get(b.cwd) - cwdLatest.get(a.cwd);
        return g !== 0 ? g : b.lastTimestamp - a.lastTimestamp;
      });
    }

    if (sortMode === "recent" || sortMode === "lexic")
      return sorted.map((s) => ({ type: "session", session: s }));

    const items = [];
    let lastCwd = null;
    for (const s of sorted) {
      if (s.cwd !== lastCwd) {
        items.push({ type: "header", cwd: s.cwd });
        lastCwd = s.cwd;
      }
      items.push({ type: "session", session: s });
    }
    return items;
  }, [sessions, sortMode]);

  const filteredItems = useMemo(() => {
    if (!searchQuery) return displayItems;
    const q = searchQuery.toLowerCase();
    // keep session items matching query; keep headers only if they have matching sessions below
    const filtered = [];
    let pendingHeader = null;
    for (const item of displayItems) {
      if (item.type === "header") {
        pendingHeader = item;
      } else {
        const title = (item.session.title || "Untitled").toLowerCase();
        if (title.includes(q)) {
          if (pendingHeader) {
            filtered.push(pendingHeader);
            pendingHeader = null;
          }
          filtered.push(item);
        }
      }
    }
    return filtered;
  }, [displayItems, searchQuery]);

  const selectedIdx = useMemo(
    () =>
      filteredItems.findIndex(
        (item) =>
          item.type === "session" && item.session.sessionId === selectedId,
      ),
    [filteredItems, selectedId],
  );

  const current = filteredItems[selectedIdx]?.session;

  useEffect(() => {
    if (selectedIdx === -1) {
      const first = filteredItems.find((i) => i.type === "session");
      if (first) setSelectedId(first.session.sessionId);
    }
  }, [filteredItems]);

  useEffect(() => {
    setViewStart(vs => Math.min(vs, Math.max(0, filteredItems.length - listHeight)));
  }, [termHeight]);

  function navigate(dir) {
    let next = selectedIdx + dir;
    while (
      next >= 0 &&
      next < filteredItems.length &&
      filteredItems[next].type === "header"
    )
      next += dir;
    if (next < 0 || next >= filteredItems.length) return;
    setSelectedId(filteredItems[next].session.sessionId);
    setViewStart((vs) => {
      let newVs = vs;
      if (next < vs) newVs = next;
      else if (next >= vs + listHeight) newVs = next - listHeight + 1;
      // pull back to include a directory header immediately above viewStart
      if (newVs > 0 && filteredItems[newVs - 1]?.type === 'header') newVs--;
      return newVs;
    });
  }

  useInput((input, key) => {
    if (mode !== "list") return;

    if (isSearching) {
      if (key.escape) {
        setIsSearching(false);
        setSearchQuery("");
        setViewStart(0);
        return;
      }
      if (key.backspace || key.delete || input === "\x7f") {
        if (searchQuery.length === 0) {
          setIsSearching(false);
        } else {
          setSearchQuery((q) => q.slice(0, -1));
          setViewStart(0);
        }
        return;
      }
      if (key.upArrow) {
        navigate(-1);
        return;
      }
      if (key.downArrow) {
        navigate(1);
        return;
      }
      if (key.return) {
        if (current) {
          onResume(current);
          exit();
        }
        return;
      }
      if (input && input !== "\x7f" && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input);
        setViewStart(0);
      }
      return;
    }

    if (key.upArrow) navigate(-1);
    else if (key.downArrow) navigate(1);
    else if (input === "/") {
      setIsSearching(true);
    } else if (input === "p") setMode("preview");
    else if (key.return || input === "r") {
      onResume(current);
      exit();
    } else if (input === "d" && key.ctrl) setMode("deleting");
    else if (input === "s") {
      setSortMode((m) =>
        m === "recent" ? "lexic" : m === "directory" ? "recent" : "directory",
      );
      setViewStart(0);
    } else if (input === "q" || key.escape) exit();
  });

  const viewSlice = filteredItems.slice(viewStart, viewStart + listHeight);

  if (mode === "preview" && current) {
    return h(PreviewMode, {
      session: current,
      onBack: () => setMode("list"),
      termWidth,
      termHeight,
    });
  }

  if (mode === "deleting" && current) {
    return h(DeleteConfirm, {
      session: current,
      termWidth,
      termHeight,
      onConfirm: async () => {
        try {
          await deleteSession(current.filePath);
        } catch {
          setMode("list");
          return;
        }
        const next = sessions.filter((s) => s.sessionId !== current.sessionId);
        setSessions(next);
        if (next.length === 0) {
          exit();
          return;
        }
        // find the adjacent session in display order from the surviving set
        const remaining = new Set(next.map((s) => s.sessionId));
        const nextSession =
          filteredItems.slice(selectedIdx + 1).find((i) => i.type === "session" && remaining.has(i.session.sessionId)) ??
          filteredItems.slice(0, selectedIdx).reverse().find((i) => i.type === "session" && remaining.has(i.session.sessionId));
        if (nextSession) setSelectedId(nextSession.session.sessionId);
        setViewStart((vs) =>
          Math.min(vs, Math.max(0, next.length - 1 - listHeight)),
        );
        setMode("list");
      },
      onCancel: () => setMode("list"),
    });
  }

  const snippet = current?.lastUserMessage
    ? truncate(current.lastUserMessage.replace(/\n+/g, " "), termWidth - 6)
    : "no user messages";

  const sortLabel = {
    directory: "",
    recent: "sorted by most recent",
    lexic: "sorted lexicographically",
  }[sortMode];
  const matchCount = filteredItems.filter((i) => i.type === "session").length;
  const searchLabel =
    isSearching || searchQuery
      ? `  /${searchQuery}${isSearching ? "█" : ""}  (${matchCount})`
      : "";
  const headerText = pad(
    ` clod  (${sessions.length})${sortLabel ? "  " + sortLabel : ""}${searchLabel}`,
    termWidth,
  );
  const navText = pad(
    " ↑↓ navigate  / search  p preview  enter/r resume  ^d delete  s sort  q quit",
    termWidth,
  );

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      {
        borderStyle: "single",
        borderLeft: false,
        borderRight: false,
        borderTop: false,
        borderColor: "gray",
      },
      h(
        Text,
        {
          backgroundColor: "black",
          color: "white",
          bold: true,
        },
        headerText,
      ),
    ),
    h(
      Box,
      { flexDirection: "column", height: listHeight },
      ...viewSlice.map((item, i) =>
        item.type === "header"
          ? h(DirectoryHeader, { key: item.cwd, cwd: item.cwd })
          : h(SessionRow, {
              key: item.session.sessionId,
              session: item.session,
              selected: item.session.sessionId === selectedId,
              termWidth,
              sortMode,
            }),
      ),
    ),
    h(
      Box,
      {
        flexDirection: "row",
        borderStyle: "single",
        borderColor: "gray",
        borderLeft: false,
        borderRight: false,
        paddingX: 1,
      },
      h(Text, { color: "cyan", dimColor: true }, '" '),
      h(Text, { dimColor: true, italic: true }, snippet),
    ),
    h(
      Box,
      {},
      h(
        Text,
        { backgroundColor: "black", color: "white", dimColor: true },
        navText,
      ),
    ),
  );
}
