import { EMPTY_NARROWED_BY_KEY } from './graph-state'
import { narrowedEntriesEqual } from './mobile-session-capture'
import type { TabKeyedPartition, TerminalTabOwnershipIndex } from './types'

/**
 * Groups one tab-keyed store record by owning worktree, reusing every unchanged worktree's bucket.
 *
 * Why bucket identity: a single OSC title frame replaces the whole record, so its slice reference
 * cannot tell the untouched worktrees from the one that changed, and the publication loop rebuilt
 * all of them. A preserved bucket reference distinguishes them for one pass over the record instead
 * of one narrowing scan per worktree.
 *
 * Each call site gets its own partitioner because the cache holds exactly one record's grouping.
 */
export function createTabKeyedRecordPartitioner<T>(): (
  source: Record<string, T> | undefined,
  owners: TerminalTabOwnershipIndex
) => TabKeyedPartition<T> {
  let cachedSource: Record<string, T> | undefined | null = null
  let cachedOwners: TerminalTabOwnershipIndex | null = null
  let cachedPartition: TabKeyedPartition<T> | null = null

  return (source, owners) => {
    if (cachedPartition && cachedSource === source && cachedOwners === owners) {
      return cachedPartition
    }
    const previous = cachedPartition
    const built = new Map<string, Map<string, T>>()
    for (const tabId of Object.keys(source ?? {})) {
      const value = source?.[tabId]
      const worktreeId = owners.worktreeIdByTabId.get(tabId)
      if (value === undefined || worktreeId === undefined) {
        continue
      }
      let bucket = built.get(worktreeId)
      if (!bucket) {
        bucket = new Map<string, T>()
        built.set(worktreeId, bucket)
      }
      bucket.set(tabId, value)
    }
    const partition = new Map<string, ReadonlyMap<string, T>>(built)
    for (const [worktreeId, bucket] of built) {
      const previousBucket = previous?.get(worktreeId)
      if (previousBucket && narrowedEntriesEqual(previousBucket, bucket)) {
        partition.set(worktreeId, previousBucket)
      }
    }
    cachedSource = source
    cachedOwners = owners
    cachedPartition = partition
    return partition
  }
}

/** Absent buckets must be the same empty map the narrowing helpers return, not a fresh one. */
export function tabKeyedRecordBucket<T>(
  partition: TabKeyedPartition<T>,
  worktreeId: string
): ReadonlyMap<string, T> {
  return partition.get(worktreeId) ?? EMPTY_NARROWED_BY_KEY
}
