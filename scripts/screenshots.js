#!/usr/bin/env node
// Regenerate the README demo screenshots from the current UI.
//
// Writes fake session fixtures to a throwaway HOME, drives clod in tmux,
// renders each captured frame with freeze, and scales to README width. The
// fixtures are entirely synthetic, so no real session data is exposed.
//
// Requires (dev-only): tmux, freeze (charmbracelet/freeze), and macOS sips.
//
//   node scripts/screenshots.js

import { mkdir, writeFile, rm } from 'fs/promises'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'src', 'index.js')
const IMAGES = join(ROOT, 'images')
const DEMO_HOME = '/tmp/clod-demo'
const SESSION = 'clodshot'
const ROWS = 30, COLS = 120, WIDTH = 840

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', ...opts })
const has = (bin) => { try { sh(`command -v ${bin}`); return true } catch { return false } }

// ─── Fake fixtures ────────────────────────────────────────────────────────────

// Believable, fully synthetic sessions spanning recent timestamps.
const SESSIONS = [
  { cwd: 'dev/acme-api', branch: 'main',                  title: 'debug prod 502s on checkout',       model: 'opus',   tput: 4_200_000, ctx: 318_000, ago: 4,    msg: 'getting intermittent 502s on /checkout in prod, can you dig into the gateway logs?' },
  { cwd: 'dev/acme-api', branch: 'fix/token-refresh',     title: 'token refresh race condition',      model: 'opus',   tput: 1_900_000, ctx: 142_000, ago: 38,   msg: 'two requests refresh the token at once and one gets a stale value' },
  { cwd: 'dev/acme-api', branch: 'feature/rate-limiting', title: 'rate limiting middleware',          model: 'sonnet', tput: 820_000,   ctx: 96_000,  ago: 180,  msg: 'add a sliding-window rate limiter keyed by api token' },
  { cwd: 'dev/dashboard', branch: 'feat/dark-mode',       title: 'dark mode design tokens',           model: 'opus',   tput: 3_100_000, ctx: 264_000, ago: 300,  msg: 'wire up the dark theme using CSS custom properties from the design system' },
  { cwd: 'dev/dashboard', branch: 'main',                 title: 'add CSV export to reports',         model: 'sonnet', tput: 540_000,   ctx: 71_000,  ago: 1440, msg: 'reports page needs a download-as-CSV button' },
  { cwd: 'dev/dashboard', branch: 'main',                 title: 'add pagination to activity feed',   model: 'sonnet', tput: 410_000,   ctx: 58_000,  ago: 1560, msg: 'the activity feed loads everything at once, paginate it' },
  { cwd: 'work/billing-service', branch: 'fix/webhook-retry', title: 'refactor payment webhook handler', model: 'opus', tput: 6_400_000, ctx: 487_000, ago: 2880, msg: 'stripe webhooks occasionally double-charge on retry, make the handler idempotent' },
  { cwd: 'work/billing-service', branch: 'main',          title: 'investigate memory leak in worker', model: 'opus',   tput: 2_700_000, ctx: 203_000, ago: 3180, msg: 'the invoice worker rss climbs all day until it OOMs' },
  { cwd: 'dev/dashboard', branch: 'main',                 title: 'migrate test suite to vitest',      model: 'sonnet', tput: 1_300_000, ctx: 118_000, ago: 4320, msg: 'move us off jest, the esm interop is painful' },
  { cwd: 'dev/acme-api', branch: 'main',                  title: 'fix flaky auth integration test',   model: 'opus',   tput: 980_000,   ctx: 88_000,  ago: 5760, msg: 'the auth test fails ~1 in 5 on CI, figure out why' },
  { cwd: 'dev/notes-cli', branch: 'main',                 title: 'add fuzzy search to note list',     model: 'sonnet', tput: 620_000,   ctx: 64_000,  ago: 7200, msg: 'i want to type a few chars and filter notes by title' },
  { cwd: 'dev/notes-cli', branch: 'main',                 title: 'README and usage docs',             model: 'sonnet', tput: 240_000,   ctx: 41_000,  ago: 8640, msg: 'write up install + usage in the readme' },
  { cwd: 'dev/image-pipeline', branch: 'main',            title: 'optimize thumbnail generation',     model: 'opus',   tput: 5_100_000, ctx: 352_000, ago: 11520, msg: 'thumbnails take forever, can we parallelize and cache?' },
  { cwd: 'dev/image-pipeline', branch: 'feat/webp',       title: 'add webp output support',           model: 'sonnet', tput: 710_000,   ctx: 79_000,  ago: 12960, msg: 'emit webp alongside jpeg for modern browsers' },
  { cwd: 'work/billing-service', branch: 'main',          title: 'wire up feature flags',             model: 'sonnet', tput: 450_000,   ctx: 52_000,  ago: 17280, msg: 'integrate the flag service so we can gate the new pricing page' },
  { cwd: 'dev/acme-api', branch: 'main',                  title: 'bump deps and fix CI',              model: 'sonnet', tput: 330_000,   ctx: 47_000,  ago: 21600, msg: 'deps are months behind, update and get the build green' },
  { cwd: 'scratch', branch: null,                         title: 'sketch out auth flow diagram',      model: 'opus',   tput: 190_000,   ctx: 33_000,  ago: 25920, msg: 'help me think through the oauth pkce flow for the mobile app' },
  { cwd: 'scratch', branch: null,                         title: 'one-off log parsing script',        model: 'sonnet', tput: 120_000,   ctx: 28_000,  ago: 33120, msg: 'parse these nginx logs and tell me the top 10 slowest endpoints' },
]
const MODEL_ID = { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' }

async function writeFixtures() {
  await rm(DEMO_HOME, { recursive: true, force: true })
  const projects = join(DEMO_HOME, '.claude', 'projects')
  let n = 0
  for (const d of SESSIONS) {
    const sessionId = `0000000${(++n).toString(16)}-dead-4bee-9000-${n.toString(16).padStart(12, '0')}`
    const cwd = join(DEMO_HOME, d.cwd)
    const base = { cwd, gitBranch: d.branch || 'HEAD', sessionId }
    const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString()

    // used = sum over turns of (input + output + cacheWrite); ctx = LAST turn's
    // (input + cacheRead + cacheWrite). Two turns: the first carries the bulk of
    // throughput, the last sets a realistic cache-dominated context size.
    const last = { input: 2000, output: 1500, cacheWrite: 3000, cacheRead: Math.max(0, d.ctx - 5000) }
    const firstTput = d.tput - (last.input + last.output + last.cacheWrite)
    const fInput = 8000, fOutput = Math.round(d.tput * 0.1)
    const first = { input: fInput, output: fOutput, cacheWrite: Math.max(0, firstTput - fInput - fOutput), cacheRead: 0 }
    const turn = (u, minAgo) => ({
      type: 'assistant', timestamp: at(minAgo), ...base,
      message: {
        role: 'assistant', model: MODEL_ID[d.model],
        content: [{ type: 'text', text: 'On it. Let me work through this.' }],
        usage: { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead },
      },
    })

    const lines = [
      { type: 'custom-title', customTitle: d.title, sessionId },
      { type: 'user', timestamp: at(d.ago + 2), ...base, message: { role: 'user', content: d.msg } },
      turn(first, d.ago + 1),
      turn(last, d.ago),
    ]
    const dir = join(projects, d.cwd.replace(/\//g, '-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  console.log(`wrote ${SESSIONS.length} fake sessions to ${projects}`)
}

// ─── Capture + render ───────────────────────────────────────────────────────

// Normalize a captured frame to exactly ROWS lines padded to COLS visible
// columns, so every shot renders at the same canvas size.
const ANSI = /\x1b\[[0-9;:]*m/g
function normalize(frame) {
  let lines = frame.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines = lines.slice(0, ROWS)
  while (lines.length < ROWS) lines.push('')
  return lines
    .map((l) => {
      const vis = l.replace(ANSI, '').length
      return vis < COLS ? l + '\x1b[0m' + ' '.repeat(COLS - vis) : l
    })
    .join('\n')
}

async function shoot(name, keys) {
  sh(`tmux kill-session -t ${SESSION} 2>/dev/null || true`)
  sh(`tmux new-session -d -s ${SESSION} -x ${COLS} -y ${ROWS} "env HOME=${DEMO_HOME} node ${ENTRY}"`)
  await sleep(2500)
  if (keys) { sh(`tmux send-keys -t ${SESSION} ${JSON.stringify(keys)}`); await sleep(1200) }
  const frame = sh(`tmux capture-pane -t ${SESSION} -e -p`).toString()
  sh(`tmux kill-session -t ${SESSION} 2>/dev/null || true`)

  const out = join(IMAGES, `${name}.png`)
  // freeze renders the frame from stdin; its file arg is ignored when stdin
  // isn't a TTY (as under execSync), so pipe the ANSI in directly
  sh(`freeze --language ansi -o ${out} --window --padding 20 --border.radius 8`, { input: normalize(frame) })
  sh(`sips --resampleWidth ${WIDTH} ${out}`)
  console.log(`wrote ${out}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const missing = ['tmux', 'freeze', 'sips'].filter((b) => !has(b))
if (missing.length) {
  console.error(`missing required tools: ${missing.join(', ')}`)
  console.error('install with: brew install tmux charmbracelet/tap/freeze   (sips ships with macOS)')
  process.exit(1)
}

await mkdir(IMAGES, { recursive: true })
await writeFixtures()
sh('tmux kill-server 2>/dev/null || true')
await shoot('demo', null)
await shoot('demo-dashboard', 't')
sh('tmux kill-server 2>/dev/null || true')
await rm(DEMO_HOME, { recursive: true, force: true })
console.log('done')
