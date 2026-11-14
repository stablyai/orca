import {
  resolveReviewRepository,
  reviewRepositoryMatchesWorkspace
} from '../../../lib/source-control/review/review-owner'
import { selectRepoByIdForActiveWorkspace } from '../../repos/active-workspace-repository'
import type { ActiveWorkspaceRepoState } from '../../repos/active-workspace-repository'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'

export function selectReviewRepositoryForWorkspace(
  state: ActiveWorkspaceRepoState,
  workspace: Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'> | null
): Repo | null {
  if (!workspace) {
    return null
  }
  const selectedRepo = selectRepoByIdForActiveWorkspace(state, workspace.repoId)
  return resolveReviewRepository(
    state.repos,
    workspace,
    selectedRepo && reviewRepositoryMatchesWorkspace(selectedRepo, workspace)
      ? selectedRepo
      : undefined
  )
}
