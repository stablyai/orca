import { catalogRowsEqual } from '../../worktree-catalog-reconciliation'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'

export function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  return catalogRowsEqual(current, next)
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
    catalogRowsEqual(current.worktrees, next.worktrees)
  )
}

export function toVisibleTabType(contentType: string): WorkspaceVisibleTabType {
  if (contentType === 'browser' || contentType === 'terminal' || contentType === 'simulator') {
    return contentType
  }
  return 'editor'
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
