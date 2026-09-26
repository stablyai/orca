import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LooseObjectScan = {
  /** Loose objects seen, never above `budget`. */
  count: number
  /** The walk stopped early, so `count` is a floor rather than the total. */
  saturated: boolean
  /** Object ids for exactly the objects counted, in fan-out order. */
  ids: string[]
}

/**
 * `objects/` holds at most 256 two-hex-digit fan-out directories. Everything
 * else in there -- `pack`, `info`, `incoming-*`, a stray `tmp_` file -- is not
 * a fan-out directory and is never descended into, which is what bounds the
 * walk to a fixed shape no matter how large the repository is.
 */
const FANOUT_DIRECTORY = /^[0-9a-f]{2}$/
/**
 * The object id minus its two-character fan-out prefix: 38 hex digits for
 * SHA-1, 62 for SHA-256. Anything else in a fan-out directory is not an object
 * -- notably `tmp_obj_*`, the file a concurrent writer renames into place once
 * it is complete, which must never be packed or counted.
 */
const OBJECT_ID_SUFFIX = /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/

/**
 * Count (and name) loose objects under a repository's `objects/` directory,
 * stopping at `budget`.
 *
 * Deliberately budgeted, and deliberately not a Git subprocess: callers use this
 * both as an admission gate and as the input list for a bounded pack, so the
 * cost has to be bounded by what the caller asked for and not by the size of the
 * backlog it is asking about. `git count-objects` would walk all 256 fan-out
 * directories to completion every time, on a repository whose whole problem is
 * that the store is enormous.
 *
 * One `readdir` per directory, dirents only -- no `stat` per entry. Strictly
 * sequential, so it can never occupy more than one of libuv's four thread-pool
 * slots and cannot stall unrelated main-process filesystem work.
 *
 * `signal` stops the walk between directories. A single hung `readdir` is not
 * interruptible, but it holds no Git lock, so it delays only maintenance.
 */
export async function scanLooseObjects(
  objectsDirectory: string,
  budget: number,
  signal?: AbortSignal
): Promise<LooseObjectScan> {
  let fanout: string[]
  try {
    fanout = (await readdir(objectsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && FANOUT_DIRECTORY.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A repository with no object store of its own contributes nothing.
    return { count: 0, saturated: false, ids: [] }
  }
  // Fixed order so a batch always starts where the store starts, and a caller
  // comparing two scans is comparing the same walk.
  fanout.sort()
  const ids: string[] = []
  for (const prefix of fanout) {
    if (signal?.aborted === true) {
      // A cancelled walk reports what it saw as a floor rather than throwing; callers
      // already have to treat a saturated result as "not known to be clean".
      return { count: ids.length, saturated: true, ids }
    }
    let entries: { name: string; isDirectory: () => boolean }[]
    try {
      entries = await readdir(join(objectsDirectory, prefix), { withFileTypes: true })
    } catch {
      // An unreadable fan-out directory contributes nothing to the count.
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() || !OBJECT_ID_SUFFIX.test(entry.name)) {
        continue
      }
      ids.push(`${prefix}${entry.name}`)
      if (ids.length >= budget) {
        return { count: ids.length, saturated: true, ids }
      }
    }
  }
  return { count: ids.length, saturated: false, ids }
}
