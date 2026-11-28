import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/collections/structural-value-equality'
import { catalogRowsEqual } from '../../../../lib/catalog-reconciliation/catalog-row-reconciliation'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'

/** True when the rows match in place except for `sortOrder`, which an order save rewrites. */
export function worktreesDifferOnlyInSortOrder(
  current: readonly Worktree[] | undefined,
  next: readonly Worktree[]
): boolean {
  if (!current || current.length !== next.length) {
    return false
  }
  for (let index = 0; index < current.length; index++) {
    const row = current[index]
    const incoming = next[index]
    if (row === incoming) {
      continue
    }
    if (row.id !== incoming.id) {
      return false
    }
    const equalIgnoringSortOrder =
      row.sortOrder === incoming.sortOrder
        ? structuralValuesEqualIgnoringUndefined(row, incoming)
        : structuralValuesEqualIgnoringUndefined(
            { ...row, sortOrder: 0 },
            { ...incoming, sortOrder: 0 }
          )
    if (!equalIgnoringSortOrder) {
      return false
    }
  }
  return true
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
  return { ...base, displayName: base.displayName || resolveWorktreeDisplayName(base) }
}
