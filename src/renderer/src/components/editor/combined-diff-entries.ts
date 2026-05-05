import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/types'

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
    if (areaFilter) {
      return entry.area === areaFilter
    }
    return entry.area !== 'untracked'
  })
}
