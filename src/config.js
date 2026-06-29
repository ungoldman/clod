import { readFile, writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Preferences persisted local to the clod install (gitignored), not the session
// cwd — the linked bin runs from anywhere, so resolve relative to this module.
const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.clod.json')

const SORT_MODES = new Set(['recent', 'lexic', 'directory'])

export async function loadConfig() {
  try {
    const c = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    return { sortMode: SORT_MODES.has(c.sortMode) ? c.sortMode : 'recent' }
  } catch {
    return { sortMode: 'recent' }
  }
}

export async function saveConfig(config) {
  try {
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
  } catch {}
}
