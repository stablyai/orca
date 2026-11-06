import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/structural-value-equality'
import { catalogRowsEqual } from '../../worktree-catalog-reconciliation'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'

export function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  return catalogRowsEqual(current, next)
}

/** True when the rows match in place except for `sortOrder`, which an order save rewrites. */
export function worktreesDifferOnlyInSortOrder(
  current: readonly Worktree[] | undefined,
  next: readonly Worktree[]
): boolean {
  if (!current || current.length !== next.length) {
    return false
  }
  return current.every((row, index) => {
    const incoming = next[index]
    return (
      row === incoming ||
      (row.id === incoming.id &&
        structuralValuesEqualIgnoringUndefined(
          { ...row, sortOrder: 0 },
          { ...incoming, sortOrder: 0 }
        ))
    )
  })
}

export function areDetectedWorktreeResultsEqual(
  current: DetectedWorktreeListResult | undefined,
  next: DetectedWorktreeListResult
): boolean {
  return Boolean(
    current &&
    current.repoId === next.repoId &&
    current.authoritative === next.authoritative &&
    current.source === next.source &&
    current.unavailableReason === next.unavailableReason &&
    current.failureKind === next.failureKind &&
    current.wslDistroStopped?.distro === next.wslDistroStopped?.distro &&
    current.wslDistroStopped?.state === next.wslDistroStopped?.state &&
    catalogRowsEqual(current.worktrees, next.worktrees)
  )
}

export function toVisibleWorktree(
  worktree: DetectedWorktreeListResult['worktrees'][number]
): Worktree {
  const {
    ownership: _ownership,
    selectedCheckout: _selectedCheckout,
    visible: _visible,
    ...base
  } = worktree
  return base
}
