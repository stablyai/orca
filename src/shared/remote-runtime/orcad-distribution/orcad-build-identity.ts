import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ORCAD_LAUNCHER_FILENAME, ORCAD_SERVER_ENTRY_FILENAME } from './orcad-artifacts'

export const ORCAD_BUILD_HASH_LENGTH = 16

/** The launcher embeds its server digest, keeping the hash older clients calculate. */
export function hashOrcadLauncher(entryPath: string): string {
  const entry = realpathSync(entryPath)
  const launcher =
    basename(entry) === ORCAD_SERVER_ENTRY_FILENAME
      ? join(dirname(entry), ORCAD_LAUNCHER_FILENAME)
      : entry
  return createHash('sha256')
    .update(readFileSync(launcher))
    .digest('hex')
    .slice(0, ORCAD_BUILD_HASH_LENGTH)
}
