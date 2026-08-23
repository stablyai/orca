import { rmSync } from 'node:fs'

/** Removes a capability probe's scratch directory, never at the cost of the answer.
 *
 *  The probes are called at `describe.skipIf(...)` scope, so a throw out of their
 *  `finally` is not a failed test — it is a failed file collection, zero tests
 *  reported. `force` swallows only ENOENT, and Windows still raises EPERM/EBUSY
 *  when unlinking a junction that points at the directory being removed. */
export function removeProbeScratchDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    // A leaked temp directory is the smaller of the two problems.
  }
}
