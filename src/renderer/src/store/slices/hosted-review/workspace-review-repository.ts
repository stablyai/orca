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

// Store arrays are replaced on change, so one index per array serves a whole refresh sweep.
const linkedWorkspaceIndexes = new WeakMap<readonly Worktree[], Map<string, Worktree[]>>()

function linkedBranchKey(branch: string, prNumber: number): string {
  return `${prNumber}\0${branch.replace(/^refs\/heads\//u, '')}`
}

function workspacesLinkingPROnBranch(
  worktrees: readonly Worktree[],
  branch: string,
  prNumber: number
): Worktree[] {
  let index = linkedWorkspaceIndexes.get(worktrees)
  if (!index) {
    index = new Map()
    for (const workspace of worktrees) {
      if (workspace.linkedPR != null) {
        const key = linkedBranchKey(workspace.branch, workspace.linkedPR)
        index.set(key, [...(index.get(key) ?? []), workspace])
      }
    }
    linkedWorkspaceIndexes.set(worktrees, index)
  }
  return index.get(linkedBranchKey(branch, prNumber)) ?? []
}

/** The repository of a linked GitHub PR, from the one workspace on this branch that links it. */
export function linkedGitHubPRRepositoryForBranch(
  state: AppState,
  repo: Repo,
  branch: string,
  prNumber: number
): GitHubOwnerRepo | undefined {
  const worktrees = workspacesLinkingPROnBranch(
    selectWorktreesByRepo(state)?.[repo.id] ?? [],
    branch,
    prNumber
  ).filter((workspace) => reviewRepositoryMatchesWorkspace(repo, workspace))
  return worktrees.length === 1 ? linkedPRRepository(worktrees[0]) : undefined
}
