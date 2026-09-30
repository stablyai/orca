import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ORCAD_BUILD_HASH_LENGTH = 16
const APPLICATION_FILENAME = 'orcad-app.js'

/** Keep legacy identities stable; split builds must identify the application as well. */
export function readOrcadBuildHash(entryPath: string): string {
  const entry = readFileSync(entryPath)
  let application: Buffer
  try {
    application = readFileSync(join(dirname(entryPath), APPLICATION_FILENAME))
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      !entry.includes('orcad-app')
    ) {
      return createHash('sha256').update(entry).digest('hex').slice(0, ORCAD_BUILD_HASH_LENGTH)
    }
    throw error
  }
  return createHash('sha256')
    .update(`orcad-split-build\0${entry.length}\0`)
    .update(entry)
    .update(`\0${application.length}\0`)
    .update(application)
    .digest('hex')
    .slice(0, ORCAD_BUILD_HASH_LENGTH)
}
