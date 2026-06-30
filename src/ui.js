import React from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import {
  getSessionMessages,
  deleteSession,
  relativeTime,
  shortPath,
  fmtTokens,
  throughputOf,
  MONTHS,
} from "./sessions.js";
import { saveConfig } from "./config.js";

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

function padLeft(str, len) {
  return str.length >= len ? str.slice(0, len) : " ".repeat(len - str.length) + str;
}

// subsequence fuzzy match: query chars must appear in order, case-insensitive
function fuzzyMatch(query, target) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Title gets fuzzy (it's short); content gets a strict substring (fuzzy over a long
// blob matches almost everything). A session matches if either does.
function sessionMatches(query, session) {
  if (fuzzyMatch(query, session.title || "Untitled")) return true;
  return session.searchText ? session.searchText.includes(query.toLowerCase()) : false;
}

// ─── Row ─────────────────────────────────────────────────────────────────────

// below these widths a column is hidden rather than truncated into noise
const BRANCH_MIN = 8;
const DIR_MIN = 10;

const usedStr = (s) => (s.throughput ? `${fmtTokens(s.throughput)} used` : "—");
const ctxStr = (s) => (s.contextTokens != null ? `${fmtTokens(s.contextTokens)} ctx` : "—");

const SessionRow = memo(function SessionRow({
  session,
  selected,
  termWidth,
  sortMode,
  timeWidth,
  usedWidth,
  ctxWidth,
}) {
  const timeStr = relativeTime(session.lastTimestamp);
  const pathStr = shortPath(session.cwd);
  const naturalBranch = session.gitBranch ?? null;
  const showDir = sortMode !== "directory";

  // Title-first allocation: the title always gets its natural width; dir, then
  // branch, fill in from what's left and are hidden (not stubbed) when it's too
  // tight. flex = room for title + branch + dir after the fixed right block
  // (used, ctx, time + their three 2-space gaps).
  const fullTitle = session.title || "Untitled";
  const flex = termWidth - 2 - usedWidth - ctxWidth - timeWidth - 6;
  let avail = flex - fullTitle.length;

  let dirWidth = 0;
  if (showDir && avail >= DIR_MIN + 2) {
    dirWidth = Math.min(pathStr.length, avail - 2);
    avail -= dirWidth + 2;
  }
  let branchWidth = 0;
  if (naturalBranch && avail >= BRANCH_MIN + 2) {
    branchWidth = Math.min(naturalBranch.length, avail - 2);
    avail -= branchWidth + 2;
  }
  // title absorbs the leftover as padding so the right block stays aligned
  const titleWidth = Math.max(
    1,
    flex - (dirWidth ? dirWidth + 2 : 0) - (branchWidth ? branchWidth + 2 : 0),
  );

  const title = pad(truncate(fullTitle, titleWidth), titleWidth);
  const branchCol = branchWidth > 0 ? truncate(naturalBranch, branchWidth) : null;
  const dirCol = dirWidth > 0 ? truncate(pathStr, dirWidth) : null;
  const usedCol = padLeft(usedStr(session), usedWidth);
  const ctxCol = padLeft(ctxStr(session), ctxWidth);
  const timeCol = pad(timeStr, timeWidth);

  if (selected) {
    const branchPart = branchCol ? `  ${branchCol}` : "";
    const dirPart = dirCol ? `  ${dirCol}` : "";
    const line = `> ${title}${branchPart}${dirPart}  ${usedCol}  ${ctxCol}  ${timeCol}`;
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
    h(Text, { dimColor: true }, `  ${usedCol}`),
    h(Text, { color: "green", dimColor: true }, `  ${ctxCol}`),
    h(Text, { dimColor: true }, `  ${timeCol}`),
  );
});

// ─── Directory header ─────────────────────────────────────────────────────────

function DirectoryHeader({ cwd }) {
  return h(
    Box,
    { paddingLeft: 1 },
    h(Text, { color: "yellow" }, shortPath(cwd)),
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
    if (input === "q" || input === "p" || input === " " || key.escape || key.backspace) {
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

// ─── Usage dashboard ────────────────────────────────────────────────────────

const SPARK = " ▁▂▃▄▅▆▇█";

function bar(value, max, width) {
  const n = max > 0 ? Math.round((value / max) * width) : 0;
  return "█".repeat(n);
}

function sparkline(values) {
  const max = Math.max(0, ...values);
  return values
    .map((v) => (max > 0 && v > 0 ? SPARK[Math.min(8, Math.ceil((v / max) * 8))] : SPARK[0]))
    .join("");
}

function computeStats(sessions) {
  // breakdown by token type across all sessions
  const breakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let totalThroughput = 0;
  const byModel = {};
  const byProject = new Map();
  const byDay = new Map();

  for (const s of sessions) {
    const t = s.totals || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    breakdown.input += t.input;
    breakdown.output += t.output;
    breakdown.cacheWrite += t.cacheWrite;
    breakdown.cacheRead += t.cacheRead;
    totalThroughput += s.throughput || 0;

    for (const k in s.models || {}) {
      const m = (byModel[k] ??= { throughput: 0 });
      m.throughput += throughputOf(s.models[k]);
    }
    const p = byProject.get(s.cwd) ?? { cwd: s.cwd, throughput: 0 };
    p.throughput += s.throughput || 0;
    byProject.set(s.cwd, p);

    const d = new Date(s.lastTimestamp);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    byDay.set(key, (byDay.get(key) ?? 0) + (s.throughput || 0));
  }

  // last 30 days of throughput, oldest → newest
  const now = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    days.push({ date: d, tokens: byDay.get(key) ?? 0 });
  }

  return {
    totalSessions: sessions.length,
    totalThroughput,
    grandTotal: totalThroughput + breakdown.cacheRead,
    breakdown,
    byModel: Object.entries(byModel)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.throughput - a.throughput),
    byProject: [...byProject.values()].sort((a, b) => b.throughput - a.throughput),
    days,
  };
}

function StatsView({ sessions, onBack, termWidth, termHeight }) {
  const stats = useMemo(() => computeStats(sessions), [sessions]);

  useInput((input, key) => {
    if (input === "q" || input === "t" || key.escape) onBack();
  });

  const labelW = 9;
  const barW = Math.min(24, Math.max(10, termWidth - 40));
  const modelMax = Math.max(0, ...stats.byModel.map((m) => m.throughput));

  const bd = stats.breakdown;
  const bdRows = [
    { label: "Input", value: bd.input },
    { label: "Output", value: bd.output },
    { label: "Cache wr", value: bd.cacheWrite },
    { label: "Cache rd", value: bd.cacheRead },
  ];
  const bdMax = Math.max(0, ...bdRows.map((r) => r.value));

  const projMax = Math.max(0, ...stats.byProject.map((p) => p.throughput));
  const maxProjects = Math.max(3, termHeight - 16);
  const projects = stats.byProject.slice(0, maxProjects);
  const projLabelW = Math.min(34, Math.max(12, termWidth - barW - 16));

  const spark = sparkline(stats.days.map((d) => d.tokens));
  const sparkStart = `${MONTHS[stats.days[0].date.getMonth()]} ${stats.days[0].date.getDate()}`;
  const sparkEnd = "today";

  const section = (label) =>
    h(Box, { marginTop: 1 }, h(Text, { bold: true, color: "cyan" }, label));

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { backgroundColor: "blue", paddingX: 1 },
      h(Text, { color: "white", bold: true }, "Usage  ·  real throughput (cache reads excluded)"),
    ),
    h(
      Box,
      { paddingX: 1, flexDirection: "column" },
      h(
        Text,
        {},
        `${stats.totalSessions} sessions   `,
        h(Text, { color: "green", bold: true }, `${fmtTokens(stats.totalThroughput)} throughput`),
        h(Text, { dimColor: true }, `   ${fmtTokens(stats.grandTotal)} incl. cache reads`),
      ),

      section("Token breakdown"),
      ...bdRows.map((r) =>
        h(
          Text,
          { key: r.label },
          pad(r.label, labelW),
          h(Text, { color: r.label === "Cache rd" ? "gray" : "green" }, bar(r.value, bdMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(r.value)}`),
        ),
      ),

      section("Throughput / day (30d)"),
      h(
        Text,
        {},
        h(Text, { dimColor: true }, `${pad(sparkStart, 7)} `),
        h(Text, { color: "green" }, spark),
        h(Text, { dimColor: true }, ` ${sparkEnd}`),
      ),

      section("By model"),
      ...stats.byModel.map((m) =>
        h(
          Text,
          { key: m.name },
          pad(m.name, labelW),
          h(Text, { color: "green" }, bar(m.throughput, modelMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(m.throughput)}`),
        ),
      ),

      section("Top projects by throughput"),
      ...projects.map((p) =>
        h(
          Text,
          { key: p.cwd },
          pad(truncate(shortPath(p.cwd), projLabelW), projLabelW),
          " ",
          h(Text, { color: "green" }, bar(p.throughput, projMax, barW)),
          h(Text, { dimColor: true }, ` ${fmtTokens(p.throughput)}`),
        ),
      ),
    ),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "q/esc/t back")),
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App({ loadFirst, loadRest, initialSortMode, onResume }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const termHeight = stdout?.rows || 24;

  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [viewStart, setViewStart] = useState(0);
  const [mode, setMode] = useState("list");
  const [sortMode, setSortMode] = useState(initialSortMode ?? "recent"); // 'recent' | 'directory' | 'lexic'
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(true);

  // The UI paints before any session is parsed: the newest batch lands first,
  // older sessions follow in one background batch (disjoint from the first, so
  // a delete can't be resurrected by the merge).
  useEffect(() => {
    (async () => {
      setSessions(await loadFirst());
      if (loadRest) {
        const more = await loadRest();
        setSessions((cur) => [...cur, ...more]);
      }
      setLoading(false);
    })();
  }, []);

  const listHeight =
    termHeight - HEADER_HEIGHT - SNIPPET_HEIGHT - HINT_HEIGHT - 1;

  // shared column widths so count/time align across every row
  const timeWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, relativeTime(s.lastTimestamp).length), 4),
    [sessions],
  );
  const usedWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, usedStr(s).length), 1),
    [sessions],
  );
  const ctxWidth = useMemo(
    () => sessions.reduce((m, s) => Math.max(m, ctxStr(s).length), 1),
    [sessions],
  );

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
    // keep session items matching the query (title or content); keep headers only if they have matching sessions below
    const filtered = [];
    let pendingHeader = null;
    for (const item of displayItems) {
      if (item.type === "header") {
        pendingHeader = item;
      } else {
        if (sessionMatches(searchQuery, item.session)) {
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
      // pull back to include a directory header immediately above viewStart,
      // but only if the selected row stays visible (else it falls off the bottom)
      if (
        newVs > 0 &&
        filteredItems[newVs - 1]?.type === 'header' &&
        next <= newVs - 1 + listHeight - 1
      )
        newVs--;
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
    } else if ((input === "p" || input === " ") && current) setMode("preview");
    else if (input === "t") setMode("stats");
    else if ((key.return || input === "r") && current) {
      onResume(current);
      exit();
    } else if (input === "D" && current) setMode("deleting");
    else if (input === "s") {
      const next =
        sortMode === "recent" ? "lexic" : sortMode === "directory" ? "recent" : "directory";
      setSortMode(next);
      setViewStart(0);
      saveConfig({ sortMode: next }); // persist for next launch (fire and forget)
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

  if (mode === "stats") {
    return h(StatsView, {
      sessions,
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
    : loading && !current
      ? "…"
      : "no user messages";

  const sortLabel = {
    directory: "grouped by directory",
    recent: "sorted by most recent",
    lexic: "sorted lexicographically",
  }[sortMode];
  const matchCount = filteredItems.filter((i) => i.type === "session").length;
  const searchLabel =
    isSearching || searchQuery
      ? ` │ /${searchQuery}${isSearching ? "█" : ""}  ${matchCount} matches`
      : "";
  const headerText = pad(
    sessions.length === 0 && loading
      ? " clod │ loading sessions…"
      : ` clod │ ${sessions.length}${loading ? "+" : ""} sessions │ ${sortLabel}${searchLabel}${loading ? " │ loading…" : ""}`,
    termWidth,
  );
  const navText = pad(
    " ↑↓ navigate  / search  space/p preview  enter/r resume  t usage  D delete  s sort  q quit",
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
      viewSlice.length === 0 && loading
        ? h(Box, { paddingX: 2 }, h(Text, { dimColor: true }, "Loading…"))
        : null,
      ...viewSlice.map((item, i) =>
        item.type === "header"
          ? h(DirectoryHeader, { key: item.cwd, cwd: item.cwd })
          : h(SessionRow, {
              key: item.session.sessionId,
              session: item.session,
              selected: item.session.sessionId === selectedId,
              termWidth,
              sortMode,
              timeWidth,
              usedWidth,
              ctxWidth,
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
