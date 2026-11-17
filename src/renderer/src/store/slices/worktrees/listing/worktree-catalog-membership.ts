import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'

export type ReplacedWorktreeRow = { before: Worktree; after: Worktree }

type MembershipRow = Pick<Worktree, 'id' | 'hostId' | 'isArchived'>

function sameMembershipRow(row: MembershipRow, before: MembershipRow): boolean {
  return (
    row.id === before.id && row.hostId === before.hostId && row.isArchived === before.isArchived
  )
}

/** For a replaced row (same id, host, archive state): true when lineage, cycle, and surface structure is unchanged, e.g. a title-only write. */
export function sameWorktreeStructure(row: Worktree, before: Worktree): boolean {
  return (
    row.path === before.path && row.instanceId === before.instanceId && row.repoId === before.repoId
  )
}

/** Rows a write replaced in place without moving any id, host, or archive state; null when membership changed. Unchanged rows are compared by identity only. */
export function replacedWorktreeRows(
  next: AppState['worktreesByRepo'],
  previous: AppState['worktreesByRepo']
): ReplacedWorktreeRow[] | null {
  if (next === previous) {
    return []
  }
  const repoIds = Object.keys(next)
  if (repoIds.length !== Object.keys(previous).length) {
    return null
  }
  const replaced: ReplacedWorktreeRow[] = []
  for (const repoId of repoIds) {
    const rows = next[repoId]
    const previousRows = previous[repoId]
    if (rows === previousRows) {
      continue
    }
    if (!previousRows || rows.length !== previousRows.length) {
      return null
    }
    for (const [index, row] of rows.entries()) {
      const before = previousRows[index]
      if (row === before) {
        continue
      }
      if (!sameMembershipRow(row, before)) {
        return null
      }
      replaced.push({ before, after: row })
    }
  }
  return replaced
}

function sameDetectedResultMembership(
  result: DetectedWorktreeListResult,
  before: DetectedWorktreeListResult
): boolean {
  const { worktrees, ...facts } = result
  const { worktrees: previousWorktrees, ...previousFacts } = before
  const previousFactsByKey = new Map(Object.entries(previousFacts))
  const factEntries = Object.entries(facts)
  return (
    factEntries.length === previousFactsByKey.size &&
    factEntries.every(
      ([key, value]) => previousFactsByKey.has(key) && previousFactsByKey.get(key) === value
    ) &&
    worktrees.length === previousWorktrees.length &&
    worktrees.every(
      (row, index) =>
        row === previousWorktrees[index] || sameMembershipRow(row, previousWorktrees[index])
    )
  )
}

/** Detected-row twin of {@link replacedWorktreeRows}: true when no row or listing fact moved. */
export function sameDetectedWorktreeMembership(
  next: AppState['detectedWorktreesByRepo'],
  previous: AppState['detectedWorktreesByRepo']
): boolean {
  if (next === previous) {
    return true
  }
  const repoIds = Object.keys(next)
  return (
    repoIds.length === Object.keys(previous).length &&
    repoIds.every((repoId) => {
      const result = next[repoId]
      const before = previous[repoId]
      return result === before || (!!before && sameDetectedResultMembership(result, before))
    })
  )
}
