import type { Worktree } from '../../../shared/types'
import { basename } from './path'

export function findGithubPrWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  prNumber: number
): Worktree | null {
  if (!repoId) {
    return null
  }

  return (
    worktrees.find(
      (worktree) =>
        worktree.repoId === repoId && worktree.linkedPR === prNumber && !worktree.isArchived
    ) ?? null
  )
}

export function getGithubPrWorkspaceAttachmentLabel(worktree: Worktree): string {
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
