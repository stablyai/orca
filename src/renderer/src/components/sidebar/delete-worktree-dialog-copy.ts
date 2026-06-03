import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo, Worktree } from '../../../../shared/types'

type WorktreeRepoRef = Pick<Worktree, 'repoId'>

export function isFolderWorkspaceDelete(
  repoMap: ReadonlyMap<string, Repo>,
  worktree: WorktreeRepoRef | null | undefined
): boolean {
  if (!worktree) {
    return false
  }
  const repo = repoMap.get(worktree.repoId)
  return repo ? isFolderRepo(repo) : false
}

export function countFolderWorkspaceDeletes(
  repoMap: ReadonlyMap<string, Repo>,
  worktrees: readonly WorktreeRepoRef[]
): number {
  return worktrees.filter((item) => isFolderWorkspaceDelete(repoMap, item)).length
}

export function getDeleteWorktreeDialogCopy(args: {
  isBatchDelete: boolean
  worktree: Pick<Worktree, 'displayName'> | null
  worktreeCount: number
  folderWorkspaceDeleteCount: number
  isFolderWorkspaceDelete: boolean
}): {
  targetLabel: string | undefined
  targetClassName: string
  descriptionSuffix: string
  mainWorktreeBlocker: string
} {
  const allFolderWorkspaceDeletes =
    args.isBatchDelete &&
    args.worktreeCount > 0 &&
    args.folderWorkspaceDeleteCount === args.worktreeCount
  const mixedFolderWorkspaceDeletes =
    args.isBatchDelete &&
    args.folderWorkspaceDeleteCount > 0 &&
    args.folderWorkspaceDeleteCount < args.worktreeCount
  return {
    targetLabel: args.isBatchDelete
      ? `${args.worktreeCount} workspaces`
      : args.worktree?.displayName,
    targetClassName: args.isBatchDelete
      ? 'font-medium text-foreground'
      : 'break-all font-medium text-foreground',
    descriptionSuffix: args.isBatchDelete
      ? allFolderWorkspaceDeletes
        ? 'from Orca. Project folders on disk will not be deleted.'
        : mixedFolderWorkspaceDeletes
          ? 'from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
          : 'from git and delete their workspace folders.'
      : args.isFolderWorkspaceDelete
        ? 'from Orca. The project folder on disk will not be deleted.'
        : 'from git and delete its workspace folder.',
    mainWorktreeBlocker: args.isFolderWorkspaceDelete
      ? 'Remove the folder project instead of deleting this workspace.'
      : 'Git does not allow removing the main worktree.'
  }
}

export function getDeleteWorktreeLineageDialogCopy(args: {
  childWorkspaceCount: number
  deleteTargetCount: number
  folderWorkspaceDeleteCount: number
}): {
  childTargetLabel: string
  descriptionSuffix: string
} {
  const allFolderWorkspaceDeletes =
    args.deleteTargetCount > 0 && args.folderWorkspaceDeleteCount === args.deleteTargetCount
  const mixedFolderWorkspaceDeletes =
    args.folderWorkspaceDeleteCount > 0 && args.folderWorkspaceDeleteCount < args.deleteTargetCount

  return {
    childTargetLabel:
      args.childWorkspaceCount === 1
        ? '1 child workspace'
        : `${args.childWorkspaceCount} child workspaces`,
    descriptionSuffix: allFolderWorkspaceDeletes
      ? 'from Orca. Project folders on disk will not be deleted.'
      : mixedFolderWorkspaceDeletes
        ? 'from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
        : 'from git and delete their workspace folders.'
  }
}
