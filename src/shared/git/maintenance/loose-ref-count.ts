import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LooseRefCount = {
  /** Loose ref files seen, never above `budget`. */
  count: number
  /** The walk stopped early, so `count` is a floor rather than the total. */
  saturated: boolean
}

// Bound visited directories and the pending queue so pathological ref trees cannot make admission unbounded.
const DIRECTORY_VISIT_CEILING = 4096

/** Budgeted admission probe, independent of backlog size. One readdir per directory avoids per-entry stat and streaming round trips:
 * 23ms vs 177ms median on 36,600 refs at threshold 1,000; retain only the widest directory’s dirents.
 * Strictly sequential to occupy at most one shared libuv slot. Abort between directories; a hung readdir is not interruptible but holds no Git lock. */
export async function countLooseRefs(
  refsDirectory: string,
  budget: number,
  signal?: AbortSignal
): Promise<LooseRefCount> {
  const pending = [refsDirectory]
  let count = 0
  let visited = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) {
      break
    }
    visited += 1
    // Cancellation returns a floor; callers already treat saturation as unknown cleanliness.
    if (
      signal?.aborted === true ||
      visited > DIRECTORY_VISIT_CEILING ||
      pending.length > DIRECTORY_VISIT_CEILING
    ) {
      return { count, saturated: true }
    }
    let entries: { name: string; isDirectory: () => boolean }[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // A missing or unreadable namespace contributes nothing to the count.
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name))
        continue
      }
      count += 1
      if (count >= budget) {
        return { count, saturated: true }
      }
    }
  }
  return { count, saturated: false }
}
