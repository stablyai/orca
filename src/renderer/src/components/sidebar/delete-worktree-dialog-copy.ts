import { sharesProjectCheckout } from '../../../../shared/workspace-instance-worktree'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

type WorktreeRepoRef = Pick<Worktree, 'id' | 'repoId'>

/** Deleting a folder workspace or a terminal group drops the Orca record only — no git, no disk. */
export function preservesCheckoutOnDelete(
  repoMap: ReadonlyMap<string, Repo>,
  worktree: WorktreeRepoRef | null | undefined
): boolean {
  if (!worktree) {
    return false
  }
  return sharesProjectCheckout(repoMap.get(worktree.repoId), worktree.id)
}

export function countCheckoutPreservingDeletes(
  repoMap: ReadonlyMap<string, Repo>,
  worktrees: readonly WorktreeRepoRef[]
): number {
  return worktrees.filter((item) => preservesCheckoutOnDelete(repoMap, item)).length
}

export function getDeleteWorktreeDialogCopy(args: {
  isBatchDelete: boolean
  worktree: Pick<Worktree, 'displayName'> | null
  worktreeCount: number
  checkoutPreservingDeleteCount: number
  preservesCheckout: boolean
}): {
  targetLabel: string | undefined
  targetClassName: string
  descriptionSuffix: string
  mainWorktreeBlocker: string
} {
  const allCheckoutPreservingDeletes =
    args.isBatchDelete &&
    args.worktreeCount > 0 &&
    args.checkoutPreservingDeleteCount === args.worktreeCount
  const mixedCheckoutPreservingDeletes =
    args.isBatchDelete &&
    args.checkoutPreservingDeleteCount > 0 &&
    args.checkoutPreservingDeleteCount < args.worktreeCount
  return {
    targetLabel: args.isBatchDelete
      ? `${args.worktreeCount} workspaces`
      : args.worktree?.displayName,
    targetClassName: args.isBatchDelete
      ? 'font-medium text-foreground'
      : 'break-all font-medium text-foreground',
    descriptionSuffix: args.isBatchDelete
      ? allCheckoutPreservingDeletes
        ? 'from Orca. Project folders on disk will not be deleted.'
        : mixedCheckoutPreservingDeletes
          ? 'from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
          : 'from git and delete their workspace folders.'
      : args.preservesCheckout
        ? 'from Orca. The project folder on disk will not be deleted.'
        : 'from git and delete its workspace folder.',
    mainWorktreeBlocker: args.preservesCheckout
      ? 'Remove the folder project instead of deleting this workspace.'
      : 'Git does not allow removing the main worktree.'
  }
}

export function getDeleteWorktreeLineageDialogCopy(args: {
  childWorkspaceCount: number
  deleteTargetCount: number
  checkoutPreservingDeleteCount: number
}): {
  childTargetLabel: string
  descriptionSuffix: string
} {
  const allCheckoutPreservingDeletes =
    args.deleteTargetCount > 0 && args.checkoutPreservingDeleteCount === args.deleteTargetCount
  const mixedCheckoutPreservingDeletes =
    args.checkoutPreservingDeleteCount > 0 &&
    args.checkoutPreservingDeleteCount < args.deleteTargetCount

  return {
    childTargetLabel:
      args.childWorkspaceCount === 1
        ? '1 child workspace'
        : `${args.childWorkspaceCount} child workspaces`,
    descriptionSuffix: allCheckoutPreservingDeletes
      ? 'from Orca. Project folders on disk will not be deleted.'
      : mixedCheckoutPreservingDeletes
        ? 'from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
        : 'from git and delete their workspace folders.'
  }
}
