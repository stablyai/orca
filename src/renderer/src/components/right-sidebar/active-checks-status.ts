import type { AppState } from '../../store/types'
import { findWorktreeById } from '../../store/slices/worktree-helpers'
import type { CheckStatus } from '../../../../shared/types'

type ActiveChecksStatusState = Pick<
  AppState,
  'activeWorktreeId' | 'worktreesByRepo' | 'repos' | 'prCache'
>

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function getActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const activeWorktree = state.activeWorktreeId
    ? findWorktreeById(state.worktreesByRepo, state.activeWorktreeId)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = state.repos.find((repo) => repo.id === activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  // Why: PR refreshes are written under repo-id scoped keys so repo path
  // changes and legacy duplicates cannot leave the activity indicator stale.
  const prCacheKey = `${activeRepo.id}::${branch}`
  return state.prCache[prCacheKey]?.data?.checksStatus ?? null
}
