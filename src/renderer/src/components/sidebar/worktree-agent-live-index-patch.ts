import { resolveAgentStatusWorktreeId } from '../../../../shared/agent-status-worktree-attribution'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

export type LiveEntriesByWorktreeCache = {
  tabsByWorktree: AppState['tabsByWorktree']
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] | undefined
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
  entriesByWorktree: Map<string, AgentStatusEntry[]>
}

// Count full rebuilds to verify same-key status pings take the incremental path.
let liveEntriesFullRebuildCount = 0
export function getLiveEntriesFullRebuildCountForTests(): number {
  return liveEntriesFullRebuildCount
}
export function recordLiveEntriesFullRebuild(): void {
  liveEntriesFullRebuildCount += 1
}

// Local completed orphans stay hidden; remote rows await host retraction, not tab hydration.
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
  const remote = Boolean(entry.connectionId) || isWebTerminalSurfaceTabId(parsed.tabId)
  if (remote) {
    return resolveAgentStatusWorktreeId(entry, tabIdToWorktreeId) ?? undefined
  }
  return tabWorktreeId ?? (entry.state === 'done' && !remote ? undefined : entry.worktreeId)
}

/** Patch unchanged buckets on status pings; producers must not reorder keys without entry/key changes, or must invalidate this cache. */
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
    // Added keys or changes to worktree, remote presence or done-ness require rebucketing.
    if (
      previous === undefined ||
      previous.worktreeId !== entry.worktreeId ||
      Boolean(previous.connectionId) !== Boolean(entry.connectionId) ||
      (previous.state === 'done') !== (entry.state === 'done')
    ) {
      return null
    }
    changed.push({ paneKey, entry })
  }
  if (keyCount !== Object.keys(previousMap).length) {
    // Removed keys require bucket cleanup through a full rebuild.
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
    // Replace in place to retain the iteration order a full rebuild would produce.
    nextBucket[index] = entry
    if (!clonedBuckets.has(worktreeId)) {
      clonedBuckets.add(worktreeId)
      entriesByWorktree.set(worktreeId, nextBucket)
    }
  }
  return entriesByWorktree
}
