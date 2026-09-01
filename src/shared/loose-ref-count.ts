import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

export type LooseRefCount = {
  /** Loose ref files seen, never above `budget`. */
  count: number
  /** The walk stopped early, so `count` is a floor rather than the total. */
  saturated: boolean
}

// Why: a ref tree is shallow and wide; this bounds both the directories visited
// and the queue holding those still to visit, so neither a symlink loop nor a
// pathological repo turns a gate probe into an unbounded walk.
const DIRECTORY_VISIT_CEILING = 4096

/**
 * Count loose refs under a repository's `refs/` directory, stopping at `budget`.
 *
 * Deliberately budgeted: callers use this as an admission gate, so the cost has
 * to be bounded by the threshold being tested and not by the size of the
 * backlog it is testing for. Reads dirents only -- no `stat` per entry -- so the
 * cost is one directory read per ref namespace, which stays cheap over a WSL
 * UNC share where per-file round trips would not.
 */
export async function countLooseRefs(
  refsDirectory: string,
  budget: number
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
    if (visited > DIRECTORY_VISIT_CEILING || pending.length > DIRECTORY_VISIT_CEILING) {
      return { count, saturated: true }
    }
    let entries: AsyncIterable<{ name: string; isDirectory: () => boolean }>
    try {
      entries = await opendir(directory)
    } catch {
      // A missing or unreadable namespace contributes nothing to the count.
      continue
    }
    // The async iterator closes the handle on normal completion and on early return.
    for await (const entry of entries) {
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
