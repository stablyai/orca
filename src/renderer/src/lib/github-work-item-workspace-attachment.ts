import type { GitHubWorkItem, Worktree } from '../../../shared/types'
import { basename } from './path'

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

export function getGithubWorkItemWorkspaceAttachmentLabel(worktree: Worktree): string {
  const displayName = worktree.displayName.trim()
  if (displayName) {
    return displayName
  }

  const branch = getBranchLabel(worktree.branch)
  if (branch) {
    return branch
  }

  return basename(worktree.path) || worktree.path
}

export function getGithubPrWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getGithubWorkItemWorkspaceAttachmentLabel(worktree)
}

function getBranchLabel(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length)
  }

  return trimmed
}
