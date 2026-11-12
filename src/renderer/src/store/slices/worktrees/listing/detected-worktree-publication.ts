import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { recordArrayChanges, replaceRecordEntries } from '../../../keyed-record-transitions'

/** Accepted listing replacement; positions preserve duplicate rows and publication order. */
export function replaceDetectedWorktreeListing(
  previous: Record<string, DetectedWorktreeListResult>,
  repoId: string,
  listing: DetectedWorktreeListResult
): Record<string, DetectedWorktreeListResult> {
  const before = previous[repoId]?.worktrees
  const after = listing.worktrees
  if (before && before !== after) {
    const positions: number[] = []
    for (let position = 0; position < Math.max(before.length, after.length); position++) {
      if (before[position] !== after[position]) {
        positions.push(position)
      }
    }
    recordArrayChanges(before, after, positions)
  }
  return replaceRecordEntries(previous, [[repoId, listing]])
}
