import { hasBinaryFileExtension } from '../../../../shared/binary-file-extensions'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

// Staging-area numstats, untracked scans and compare diffs count independently and can fail independently.
export function getCombinedDiffCountingPassKey(
  entry: GitStatusEntry | GitBranchChangeEntry
): string {
  return 'area' in entry ? entry.area : 'compare'
}

/** Passes that counted at least one row, so counting demonstrably ran for them. */
export function collectCountedCombinedDiffPasses(
  entries: readonly (GitStatusEntry | GitBranchChangeEntry)[]
): ReadonlySet<string> {
  const countedPasses = new Set<string>()
  for (const entry of entries) {
    if (entry.added !== undefined || entry.removed !== undefined) {
      countedPasses.add(getCombinedDiffCountingPassKey(entry))
    }
  }
  return countedPasses
}

/** Uncounted rows have unknown size; deferral alone cannot justify calling them large. */
export function isCombinedDiffSizeUnknown({
  added,
  removed
}: {
  added?: number
  removed?: number
}): boolean {
  return added === undefined && removed === undefined
}

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed,
  path,
  area,
  submodule,
  hasCountedSiblings
}: {
  added?: number
  removed?: number
  path?: string
  area?: GitStatusEntry['area']
  submodule?: GitStatusEntry['submodule']
  // Only counted siblings in this same pass prove counting ran; other passes fail independently.
  hasCountedSiblings?: boolean
}): boolean {
  if (added === undefined && removed === undefined) {
    // Submodule content stays a tiny commit diff; untracked-only changes produce no numstat row.
    if (submodule !== undefined || hasBinaryFileExtension(path)) {
      return false
    }
    // Counted siblings prove a tracked row is binary; untracked rows can instead have exceeded the scan’s byte limit.
    if (hasCountedSiblings === true && area !== 'untracked') {
      return false
    }
    // No counts means unknown size, never zero. Binary markers stay on the host, so defer rather than open unbounded text.
    return true
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
