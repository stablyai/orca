import type {
  GitHubWorkItem,
  PersistedIssueSourcePreference,
  Worktree
} from '../../../shared/types'
import { basename } from './path'

type GitHubWorkItemType = GitHubWorkItem['type']

export function findGithubWorkItemWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  type: GitHubWorkItemType,
  number: number,
  issueSourcePreference?: PersistedIssueSourcePreference | null
): Worktree | null {
  if (!repoId) {
    return null
  }

  return (
    worktrees.find((worktree) => {
      if (worktree.repoId !== repoId || worktree.isArchived) {
        return false
      }

      if (type === 'pr') {
        return worktree.linkedPR === number
      }

      if (worktree.linkedIssue !== number) {
        return false
      }

      // Why: issue numbers can overlap between origin/upstream repos. When a
      // persisted source preference exists, keep attachment matching source-bound.
      return issueSourcePreference
        ? worktree.linkedIssueSourcePreference === issueSourcePreference
        : true
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
  issueNumber: number,
  issueSourcePreference?: PersistedIssueSourcePreference | null
): Worktree | null {
  return findGithubWorkItemWorkspaceAttachment(
    worktrees,
    repoId,
    'issue',
    issueNumber,
    issueSourcePreference
  )
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
