import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { CombinedDiffFileTreeMode } from './combined-diff-file-tree-model'

/**
 * Fallback filtering for combined-diff tabs that were opened before the
 * snapshot field existed. When a snapshot is present the caller should use it
 * directly (after filtering out unresolved conflicts) instead of calling this.
 */
export function getCombinedUncommittedEntries(
  liveEntries: GitStatusEntry[],
  areaFilter: OpenFile['combinedAreaFilter']
): GitStatusEntry[] {
  return liveEntries.filter((entry) => {
    if (entry.conflictStatus === 'unresolved') {
      return false
    }
    return areaFilter === undefined || entry.area === areaFilter
  })
}

export function getCombinedBranchEntries(
  snapshotEntries: readonly GitBranchChangeEntry[] | undefined,
  liveEntries: readonly GitBranchChangeEntry[]
): GitBranchChangeEntry[] {
  // Why: an explicitly empty tab snapshot should stay empty instead of drifting
  // to later Source Control refreshes.
  return [...(snapshotEntries ?? liveEntries)]
}

export function shouldAutoReloadCombinedDiffFromGitStatus({
  mode,
  hasUncommittedEntriesSnapshot
}: {
  mode: CombinedDiffFileTreeMode
  hasUncommittedEntriesSnapshot: boolean
}): boolean {
  // Why: snapshot-backed tabs intentionally preserve the tab-open diff while
  // staging/commit status churns; targeted editor-write reloads still refresh.
  return mode === 'uncommitted' && !hasUncommittedEntriesSnapshot
}
