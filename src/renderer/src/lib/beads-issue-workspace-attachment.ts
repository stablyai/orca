import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeAttachmentLabel } from './worktree-attachment-label'

/** Beads issues have no numbers, so attachment matches on the linked item's beadsIdentifier. */
export function findBeadsIssueWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  beadsIssueId: string
): Worktree | null {
  if (!repoId) {
    return null
  }

  return (
    worktrees.find((worktree) => {
      if (worktree.repoId !== repoId || worktree.isArchived) {
        return false
      }
      const linked = worktree.linkedWorkItem
      return linked?.provider === 'beads' && linked.beadsIdentifier === beadsIssueId
    }) ?? null
  )
}

export function getBeadsIssueWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorktreeAttachmentLabel(worktree)
}
