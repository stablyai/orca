import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getGitHubPRCacheKey } from '../../github-cache-key'
import { findRepoForHost } from '../../repo-host-identity'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

export function queuedReviewPushTargetNumber(
  state: AppState,
  worktree: Worktree
): number | undefined {
  if (worktree.linkedPR != null || worktree.linkedGitLabMR != null) {
    return undefined
  }
  const repo = findRepoForHost(state.repos, worktree.repoId, {
    hostId: worktree.hostId,
    settings: state.settings
  })
  const identity = getWorktreeGitIdentityDisplay(worktree)
  if (!repo || identity?.kind !== 'branch') {
    return undefined
  }
  const key = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    identity.branchName,
    state.settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  return state.prCache?.[key]?.data?.number
}
