import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Whether a POSIX permission mode means anything on this host.
 *
 *  Windows maps `chmod` onto a single read-only attribute: 0600 reads back as
 *  0666, and the owner can read a file left at 0000. A case that asserts a
 *  tightened mode, or that a read is refused, has nothing to test there.
 *
 *  Asked by trying rather than inferred from the platform, so the same suite
 *  still runs anywhere the bits are honoured. */

let enforced: boolean | undefined

export function permissionBitsAreEnforced(): boolean {
  if (enforced !== undefined) {
    return enforced
  }
  let directory: string | null = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'orca-mode-probe-'))
    const file = join(directory, 'probe')
    writeFileSync(file, 'x')
    chmodSync(file, 0o600)
    enforced = (statSync(file).mode & 0o777) === 0o600
  } catch {
    enforced = false
  } finally {
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  return enforced
}
