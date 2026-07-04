import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SortMode = 'recent' | 'lexic' | 'directory'

// Persisted local to the clod install (gitignored). The linked bin runs from
// anywhere, so resolve relative to this module, not the cwd.
const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.clod.json')

const SORT_MODES = new Set<SortMode>(['recent', 'lexic', 'directory'])

function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && SORT_MODES.has(value as SortMode)
}

export async function loadConfig(file: string = CONFIG_FILE): Promise<{ sortMode: SortMode }> {
  try {
    const c: unknown = JSON.parse(await readFile(file, 'utf8'))
    const sortMode = (c as { sortMode?: unknown })?.sortMode
    return { sortMode: isSortMode(sortMode) ? sortMode : 'recent' }
  } catch {
    return { sortMode: 'recent' }
  }
}

export async function saveConfig(
  config: { sortMode: SortMode },
  file: string = CONFIG_FILE
): Promise<void> {
  try {
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
  } catch {}
}
