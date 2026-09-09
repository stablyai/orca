import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Whether this machine can render an Office document at all.
 *
 * The render half of the preview genuinely needs the binary, and a mocked host would only prove
 * our plumbing calls itself. The unrenderable-format half needs nothing and is never skipped.
 */
export async function hasOfficecliInstalled(): Promise<boolean> {
  try {
    await run('officecli', ['--version'], { timeout: 10_000 })
    return true
  } catch {
    // A stripped PATH under Playwright is common; the documented user-bin location is not.
    try {
      await access(join(homedir(), '.local', 'bin', 'officecli'), constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}
