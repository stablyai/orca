import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'

export function getWorkspaceSpaceGitStatusRefreshCandidates(
  rows: readonly WorkspaceSpaceWorktree[],
  options: {
    activeWorktreeId?: string | null
    activeExecutionHostId?: string | null
    visibleWorktreeIdentities?: ReadonlySet<string>
  } = {}
): WorkspaceSpaceWorktree[] {
  const candidates = rows.filter(
    (worktree) => worktree.canDelete && worktree.status === 'ok' && !worktree.isMainWorktree
  )
  const rank = (worktree: WorkspaceSpaceWorktree): number => {
    const isActive =
      worktree.worktreeId === options.activeWorktreeId &&
      (!options.activeExecutionHostId || worktree.executionHostId === options.activeExecutionHostId)
    if (isActive) {
      return 0
    }
    return options.visibleWorktreeIdentities?.has(getWorkspaceSpaceWorktreeIdentity(worktree))
      ? 1
      : 2
  }
  return candidates
    .map((worktree, index) => ({ worktree, index, rank: rank(worktree) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ worktree }) => worktree)
}
