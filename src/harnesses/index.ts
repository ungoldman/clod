import type { Harness, HarnessId, Message, Session, SessionFile } from '../sessions.ts'
import { claude } from './claude.ts'
import { omp } from './omp.ts'

export const HARNESSES: readonly Harness[] = [claude, omp]

const byId = Object.fromEntries(HARNESSES.map((h) => [h.id, h])) as Record<HarnessId, Harness>

export const harnessOf = (s: { harness: HarnessId }): Harness => byId[s.harness]

// Every harness's session files, merged newest-first so the first batch the
// UI parses is the most recent across all of them.
export async function listSessionFiles(
  harnesses: readonly Harness[] = HARNESSES
): Promise<SessionFile[]> {
  const lists = await Promise.all(harnesses.map((h) => h.listFiles()))
  return lists.flat().sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
}

export async function parseSessions(files: SessionFile[]): Promise<Session[]> {
  const sessions = await Promise.all(files.map((f) => harnessOf(f).parse(f)))
  return sessions.filter((s): s is Session => s !== null)
}

export async function loadSessions(): Promise<Session[]> {
  const sessions = await parseSessions(await listSessionFiles())
  return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
}

export const getSessionMessages = (s: Session): Promise<Message[]> => harnessOf(s).messages(s)
export const renameSession = (s: Session, title: string): Promise<void> =>
  harnessOf(s).rename(s, title)
export const deleteSession = (s: Session): Promise<void> => harnessOf(s).delete(s)
