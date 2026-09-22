import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readWorktreeJumpPaletteSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}
