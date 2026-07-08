import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CliAction = 'help' | 'version' | 'launch'

// The linked bin runs from anywhere, so resolve relative to this module.
const PACKAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

export function parseArgs(argv: string[]): CliAction {
  if (argv.includes('-h') || argv.includes('--help')) return 'help'
  if (argv.includes('-v') || argv.includes('--version')) return 'version'
  return 'launch'
}

export async function readPackage(
  file: string = PACKAGE_FILE
): Promise<{ version: string; description: string; homepage: string }> {
  const pkg = JSON.parse(await readFile(file, 'utf8')) as {
    version: string
    description: string
    homepage: string
  }
  return { version: pkg.version, description: pkg.description, homepage: pkg.homepage }
}

export function helpText(pkg: { description: string; homepage: string }): string {
  return `clod - ${pkg.description}

Usage: clod [options]

Options:
  -h, --help     Show help
  -v, --version  Show version

Run with no arguments to launch the session browser.
Keybindings and usage: ${pkg.homepage}`
}
