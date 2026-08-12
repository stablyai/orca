import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type LiveEntriesByWorktreeCache = {
  tabsByWorktree: AppState['tabsByWorktree']
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
  entriesByWorktree: Map<string, AgentStatusEntry[]>
}

// Why: test-only observability — proves same-key entry updates (per-ping
// setAgentStatus map churn) take the O(changed) patch path, not a full rebuild.
let liveEntriesFullRebuildCount = 0
export function getLiveEntriesFullRebuildCountForTests(): number {
  return liveEntriesFullRebuildCount
}
export function recordLiveEntriesFullRebuild(): void {
  liveEntriesFullRebuildCount += 1
}

// Why: keep early attributed child rows, but hide completed rows once their tab is gone.
export function liveEntryWorktreeId(
  paneKey: string,
  entry: AgentStatusEntry,
  tabIdToWorktreeId: Map<string, string>
): string | undefined {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return undefined
  }
  const tabWorktreeId = tabIdToWorktreeId.get(parsed.tabId)
  return tabWorktreeId ?? (entry.state === 'done' ? undefined : entry.worktreeId)
}

/**
 * Patches the cached by-worktree index in place of a full rebuild when the
 * live map changed only by replacing entries under existing pane keys with
 * the same bucketing (worktree attribution and done-ness).
 *
 * Why: setAgentStatus mints a new agentStatusByPaneKey on EVERY status ping,
 * including same-state working prompt/tool updates. Rebuilding the whole
 * index (parsePaneKey + bucketing across all live agents) per ping is the
 * dominant selector cost under parallel agents; a within-state ping only
 * needs the owning worktree's bucket refreshed.
 *
 * Invariant this relies on: no map producer reorders existing pane keys
 * without also changing an entry reference or the key set. All current
 * writers hold this (updates spread-overwrite in place; the only reorderer,
 * movePaneKeyedRecord, deletes+re-adds so the new key trips the added-key
 * bail). A future producer that rebuilt the map in a new key order with
 * identical entry refs would need to invalidate this cache instead.
 */
export function patchLiveEntriesByWorktree(
  cache: LiveEntriesByWorktreeCache,
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'],
  tabIdToWorktreeId: Map<string, string>
): Map<string, AgentStatusEntry[]> | null {
  const previousMap = cache.agentStatusByPaneKey
  const changed: { paneKey: string; entry: AgentStatusEntry }[] = []
  let keyCount = 0
  for (const paneKey in agentStatusByPaneKey) {
    keyCount += 1
    const entry = agentStatusByPaneKey[paneKey]
    const previous = previousMap[paneKey]
    if (previous === entry) {
      continue
    }
    // Why: bail on added keys or bucket-determinant changes — the bucket rule
    // depends only on paneKey, the (reference-equal) tab index, worktree
    // attribution, and done-ness, so equal determinants mean the same bucket.
    if (
      previous === undefined ||
      previous.worktreeId !== entry.worktreeId ||
      (previous.state === 'done') !== (entry.state === 'done')
    ) {
      return null
    }
    changed.push({ paneKey, entry })
  }
  if (keyCount !== Object.keys(previousMap).length) {
    // Why: removed keys need buckets dropped; leave that to the full rebuild.
    return null
  }
  if (changed.length === 0) {
    return cache.entriesByWorktree
  }

  const entriesByWorktree = new Map(cache.entriesByWorktree)
  const clonedBuckets = new Set<string>()
  for (const { paneKey, entry } of changed) {
    const worktreeId = liveEntryWorktreeId(paneKey, entry, tabIdToWorktreeId)
    if (!worktreeId) {
      continue
    }
    const bucket = entriesByWorktree.get(worktreeId)
    const index = bucket?.indexOf(previousMap[paneKey]) ?? -1
    if (!bucket || index < 0) {
      return null
    }
    const nextBucket = clonedBuckets.has(worktreeId) ? bucket : bucket.slice()
    // Why: in-position replacement preserves iteration order, matching what a
    // full rebuild would produce (spread updates keep object insertion order).
    nextBucket[index] = entry
    if (!clonedBuckets.has(worktreeId)) {
      clonedBuckets.add(worktreeId)
      entriesByWorktree.set(worktreeId, nextBucket)
    }
  }
  return entriesByWorktree
}
