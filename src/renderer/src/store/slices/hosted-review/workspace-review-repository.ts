import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  resolveReviewRepository,
  reviewRepositoryMatchesWorkspace
} from '../../../lib/review-owner'
import { selectRepoByIdForActiveWorkspace } from '../../repos/active-workspace-repository'
import type { ActiveWorkspaceRepoState } from '../../repos/active-workspace-repository'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { linkedPRRepository } from '../../../../../shared/github/linked-pr-repository'
import type { AppState } from '../../types'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'

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

/** The repository of a linked GitHub PR, from the one workspace on this branch that links it. */
export function linkedGitHubPRRepositoryForBranch(
  state: AppState,
  repo: Repo,
  branch: string,
  prNumber: number
): GitHubOwnerRepo | undefined {
  const branchName = branch.replace(/^refs\/heads\//u, '')
  const worktrees = (selectWorktreesByRepo(state)?.[repo.id] ?? []).filter(
    (workspace) =>
      workspace.branch.replace(/^refs\/heads\//u, '') === branchName &&
      workspace.linkedPR === prNumber &&
      reviewRepositoryMatchesWorkspace(repo, workspace)
  )
  return worktrees.length === 1 ? linkedPRRepository(worktrees[0]) : undefined
}
