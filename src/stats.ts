import { type Session, throughputOf } from './sessions.ts'

const SPARK = ' ▁▂▃▄▅▆▇█'

export function bar(value: number, max: number, width: number): string {
  const n = max > 0 ? Math.round((value / max) * width) : 0
  return '█'.repeat(n)
}

export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values)
  return values
    .map((v) => (max > 0 && v > 0 ? SPARK[Math.min(8, Math.ceil((v / max) * 8))] : SPARK[0]))
    .join('')
}

export function computeStats(sessions: Session[]) {
  const breakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  let totalThroughput = 0
  const byModel: Record<string, { throughput: number }> = {}
  const byProject = new Map<string, { cwd: string; throughput: number }>()
  const byDay = new Map<string, number>()

  for (const s of sessions) {
    const t = s.totals
    breakdown.input += t.input
    breakdown.output += t.output
    breakdown.cacheWrite += t.cacheWrite
    breakdown.cacheRead += t.cacheRead
    totalThroughput += s.throughput || 0

    for (const k in s.models) {
      byModel[k] ??= { throughput: 0 }
      byModel[k].throughput += throughputOf(s.models[k])
    }
    const p = byProject.get(s.cwd) ?? { cwd: s.cwd, throughput: 0 }
    p.throughput += s.throughput || 0
    byProject.set(s.cwd, p)

    const d = new Date(s.lastTimestamp)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    byDay.set(key, (byDay.get(key) ?? 0) + (s.throughput || 0))
  }

  // last 30 days of throughput, oldest first
  const now = new Date()
  const days: { date: Date; tokens: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    days.push({ date: d, tokens: byDay.get(key) ?? 0 })
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
    days
  }
}
