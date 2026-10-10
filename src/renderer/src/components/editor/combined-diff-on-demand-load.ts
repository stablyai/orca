import { hasBinaryFileExtension } from '../../../../shared/binary-file-extensions'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

// Line counts come from independent passes that fail independently: one numstat
// per staging area, the untracked scan, and the compare diff.
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

/**
 * Why a deferred row was deferred. Uncounted rows are deferred because their
 * size is unknown, not because it is over the limit — the prompt must not
 * claim otherwise. Mirrors the uncounted branch of the predicate below.
 */
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
  // True when another row in the SAME counting pass carried line counts, so
  // counting ran and this row is uncounted for a reason of its own. A sibling
  // from another pass proves nothing: passes fail independently.
  hasCountedSiblings?: boolean
}): boolean {
  if (added === undefined && removed === undefined) {
    // A submodule diffs to a "Subproject commit" line or two whatever it
    // contains, and numstat reports nothing at all for one whose only change is
    // untracked content inside it.
    if (submodule !== undefined || hasBinaryFileExtension(path)) {
      return false
    }
    // Counting ran for this pass, so a tracked row is uncounted only because
    // numstat called it binary ('-'). Untracked rows are also uncounted when
    // the scan skipped them past MAX_UNTRACKED_LINE_COUNT_BYTES, so those stay
    // deferred — their size is exactly what is unknown.
    if (hasCountedSiblings === true && area !== 'untracked') {
      return false
    }
    // Otherwise the size is unknown, not zero: an oversized untracked file, a
    // pass that skipped counting entirely (entry cap hit, numstat failed), or a
    // lone row with no sibling to prove counting ran. Numstat's binary marker
    // would settle the last case, but it never leaves the host. Defer them all:
    // Monaco would open unbounded text.
    return true
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
