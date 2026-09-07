import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Worktree } from '../../../shared/worktree/types'

type GitHubWorkItemType = GitHubWorkItem['type']

export function findGithubWorkItemWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  type: GitHubWorkItemType,
  number: number
): Worktree | null {
  if (!repoId) {
    return null
  }

  return (
    worktrees.find((worktree) => {
      if (worktree.repoId !== repoId || worktree.isArchived) {
        return false
      }

      return type === 'pr' ? worktree.linkedPR === number : worktree.linkedIssue === number
    }) ?? null
  )
}

export function findGithubPrWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  prNumber: number
): Worktree | null {
  return findGithubWorkItemWorkspaceAttachment(worktrees, repoId, 'pr', prNumber)
}

export function findGithubIssueWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  issueNumber: number
): Worktree | null {
  return findGithubWorkItemWorkspaceAttachment(worktrees, repoId, 'issue', issueNumber)
}
