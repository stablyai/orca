import type { GitHubWorkItem, Worktree } from '../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getWorktreeAttachmentLabel } from './worktree-attachment-label'

type GitHubWorkItemType = GitHubWorkItem['type']

export function findGithubWorkItemWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  type: GitHubWorkItemType,
  number: number,
  executionHostId?: ExecutionHostId
): Worktree | null {
  if (!repoId) {
    return null
  }

  return (
    worktrees.find((worktree) => {
      if (
        worktree.repoId !== repoId ||
        worktree.isArchived ||
        (executionHostId &&
          (normalizeExecutionHostId(worktree.hostId) ?? LOCAL_EXECUTION_HOST_ID) !==
            executionHostId)
      ) {
        return false
      }

      return type === 'pr' ? worktree.linkedPR === number : worktree.linkedIssue === number
    }) ?? null
  )
}

export function findGithubPrWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  prNumber: number,
  executionHostId?: ExecutionHostId
): Worktree | null {
  return findGithubWorkItemWorkspaceAttachment(worktrees, repoId, 'pr', prNumber, executionHostId)
}

export function findGithubIssueWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  issueNumber: number,
  executionHostId?: ExecutionHostId
): Worktree | null {
  return findGithubWorkItemWorkspaceAttachment(
    worktrees,
    repoId,
    'issue',
    issueNumber,
    executionHostId
  )
}

export function getGithubWorkItemWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorktreeAttachmentLabel(worktree)
}

export function getGithubPrWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorktreeAttachmentLabel(worktree)
}
