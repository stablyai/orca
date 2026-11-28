import type { Worktree } from '../../../../../../shared/worktree/types'
import { branchName } from '@/lib/source-control/branches/branch-name'

export const detachedHeadAutoDerivedDisplayNames = new Map<string, string>()

export function forgetDetachedHeadAutoDerivedDisplayName(worktreeId: string): void {
  detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
}

/** Re-derive automatic titles on a branch/head patch the way a full listing would; records detach-time names. */
export function deriveGitIdentityDisplayName(
  worktree: Worktree,
  worktreeId: string,
  nextBranch: string,
  identityBranch: string | null | undefined
): string {
  const currentBranchName = branchName(worktree.branch)
  const wasAutoDerived =
    worktree.displayNameMode === 'automatic' ||
    (worktree.displayNameMode === undefined &&
      worktree.cliProvenance?.kind !== 'created-by-cli' &&
      worktree.displayName === currentBranchName)
  const wasDetachedAutoDerived =
    worktree.displayNameMode !== 'fixed' &&
    worktree.branch === '' &&
    nextBranch !== '' &&
    detachedHeadAutoDerivedDisplayNames.get(worktreeId) === worktree.displayName
  const nextDisplayName =
    (wasAutoDerived || wasDetachedAutoDerived) && nextBranch
      ? branchName(nextBranch)
      : worktree.displayName
  if (identityBranch === null && wasAutoDerived) {
    detachedHeadAutoDerivedDisplayNames.set(worktreeId, worktree.displayName)
  } else if (identityBranch !== undefined) {
    detachedHeadAutoDerivedDisplayNames.delete(worktreeId)
  }
  return nextDisplayName
}
