import type { AppState } from '../../store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '../../store/selectors'
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
    ? (getWorktreeMapFromState(state).get(state.activeWorktreeId) ?? null)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = getRepoMapFromState(state).get(activeWorktree.repoId)
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
