import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { getRuntimePathBasename } from '../cross-platform-path'
import {
  buildWorkspaceRowComparator,
  type WorkspaceSortBy
} from '../workspace-view/workspace-row-sort'
import { compareCodePoints, compareSidebarText } from './text-order'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { compareSmartStamps, recentStamp } from './stamp-order'

export type SortBy = WorkspaceSortBy

export type WorktreeSortLabelInput = Pick<Worktree, 'displayName' | 'path' | 'id' | 'hostId'>

export function getWorktreeSortLabel(worktree: WorktreeSortLabelInput): string {
  const displayName = typeof worktree.displayName === 'string' ? worktree.displayName.trim() : ''
  if (displayName) {
    return displayName
  }

  // Why: persisted or remote worktree state can briefly omit displayName after
  // a custom workspace name is removed; sorting must stay render-safe.
  const pathLabel =
    typeof worktree.path === 'string' ? getRuntimePathBasename(worktree.path).trim() : ''
  return pathLabel || worktree.id
}

/**
 * Sort labels precomputed once per sort, so the O(N log N) comparator does O(1)
 * lookups instead of re-deriving both labels on every comparison.
 *
 * Why keyed on the row and not its id: a two-host id collision (STA-4343) puts
 * two rows with different paths under one id, and an id key would hand one of
 * them the other's label.
 */
export type WorktreeSortLabels = ReadonlyMap<WorktreeSortLabelInput, string>

export function buildWorktreeSortLabels<T extends WorktreeSortLabelInput>(
  worktrees: readonly T[]
): Map<WorktreeSortLabelInput, string> {
  const labels = new Map<WorktreeSortLabelInput, string>()
  for (const worktree of worktrees) {
    labels.set(worktree, getWorktreeSortLabel(worktree))
  }
  return labels
}

export function compareWorktreeSortLabel(
  a: WorktreeSortLabelInput,
  b: WorktreeSortLabelInput,
  labels?: WorktreeSortLabels
): number {
  return (
    compareSidebarText(
      labels?.get(a) ?? getWorktreeSortLabel(a),
      labels?.get(b) ?? getWorktreeSortLabel(b)
    ) || compareCodePoints(getWorktreeHostIdentity(a), getWorktreeHostIdentity(b))
  )
}

function worktreeSortReads(
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  labels: WorktreeSortLabels | undefined
) {
  return {
    label: (worktree: Worktree): string => labels?.get(worktree) ?? getWorktreeSortLabel(worktree),
    identity: getWorktreeHostIdentity,
    repoLabel: (worktree: Worktree) => repoMap.get(worktree.repoId)?.displayName ?? '',
    // Why fallback to sortOrder: existing users have a persisted smart-sort snapshot but no
    // manualOrder yet, so Manual starts from that order instead of alphabetizing.
    manualRank: (worktree: Worktree) => worktree.manualOrder ?? worktree.sortOrder
  }
}

/** Orders rows by the owning hosts' stamps, reading no clock. */
export function buildWorktreeStampComparator(
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  labels: WorktreeSortLabels | undefined
): (a: Worktree, b: Worktree) => number {
  return buildWorkspaceRowComparator<Worktree>(sortBy, {
    ...worktreeSortReads(repoMap, labels),
    recentActivity: recentStamp,
    compareSmart: compareSmartStamps
  })
}

/** Sorts in place by the owning hosts' stamps, reading no clock: the order every stamp reader shares. */
export function sortWorktreesByStamps<W extends Worktree>(
  worktrees: W[],
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>
): W[] {
  return worktrees.sort(
    buildWorktreeStampComparator(sortBy, repoMap, buildWorktreeSortLabels(worktrees))
  )
}
