import { isFolderRepo } from '../../../../../../shared/repo-kind'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

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

type DeleteRemovalScope = 'folder' | 'mixed' | 'git'

function getDeleteRemovalScope(deleteCount: number, folderDeleteCount: number): DeleteRemovalScope {
  if (deleteCount > 0 && folderDeleteCount === deleteCount) {
    return 'folder'
  }
  return folderDeleteCount > 0 && folderDeleteCount < deleteCount ? 'mixed' : 'git'
}

// Templates use <target/> (filled with the workspace name) or <target>…</target> and <descendants>…</descendants>.
function getBatchDeleteDescription(
  count: number,
  scope: DeleteRemovalScope,
  t: Translate = translate
): string {
  if (scope === 'folder') {
    return t(
      'auto.components.sidebar.DeleteWorktreeDialog.removeBatchFolder',
      'Remove <target>{{count}} workspaces</target> from Orca. Project folders on disk will not be deleted.',
      {
        count,
        defaultValue_one:
          'Remove <target>{{count}} workspace</target> from Orca. Project folders on disk will not be deleted.'
      }
    )
  }
  if (scope === 'mixed') {
    return t(
      'auto.components.sidebar.DeleteWorktreeDialog.removeBatchMixed',
      'Remove <target>{{count}} workspaces</target> from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.',
      {
        count,
        defaultValue_one:
          'Remove <target>{{count}} workspace</target> from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
      }
    )
  }
  return t(
    'auto.components.sidebar.DeleteWorktreeDialog.removeBatchGit',
    'Remove <target>{{count}} workspaces</target> from git and delete their workspace folders.',
    {
      count,
      defaultValue_one:
        'Remove <target>{{count}} workspace</target> from git and delete its workspace folder.'
    }
  )
}

export function getDeleteWorktreeDialogCopy(
  args: {
    isBatchDelete: boolean
    worktreeCount: number
    folderWorkspaceDeleteCount: number
    isFolderWorkspaceDelete: boolean
  },
  t: Translate = translate
): {
  targetClassName: string
  description: string
  mainWorktreeBlocker: string
} {
  return {
    targetClassName: args.isBatchDelete
      ? 'font-medium text-foreground'
      : 'break-all font-medium text-foreground',
    description: args.isBatchDelete
      ? getBatchDeleteDescription(
          args.worktreeCount,
          getDeleteRemovalScope(args.worktreeCount, args.folderWorkspaceDeleteCount),
          t
        )
      : args.isFolderWorkspaceDelete
        ? t(
            'auto.components.sidebar.DeleteWorktreeDialog.removeSingleFolderFromOrca',
            'Removes it from Orca. The folder on disk is kept.'
          )
        : t(
            'auto.components.sidebar.DeleteWorktreeDialog.deleteSingleWorktreeAndBranch',
            'Deletes the worktree and its branch (kept if unmerged).'
          ),
    mainWorktreeBlocker: args.isFolderWorkspaceDelete
      ? t(
          'auto.components.sidebar.DeleteWorktreeDialog.removeFolderProjectInstead',
          'Remove the folder project instead of deleting this workspace.'
        )
      : t(
          'auto.components.sidebar.DeleteWorktreeDialog.gitBlocksMainWorktree',
          'Git does not allow removing the main worktree.'
        )
  }
}

export function getDeleteWorktreeLineageDialogDescription(
  args: {
    childWorkspaceCount: number
    deleteTargetCount: number
    folderWorkspaceDeleteCount: number
  },
  t: Translate = translate
): string {
  const count = args.childWorkspaceCount
  const scope = getDeleteRemovalScope(args.deleteTargetCount, args.folderWorkspaceDeleteCount)
  if (scope === 'folder') {
    return t(
      'auto.components.sidebar.DeleteWorktreeDialog.removeWithChildrenFolder',
      'Remove <target/> and <descendants>{{count}} child workspaces</descendants> from Orca. Project folders on disk will not be deleted.',
      {
        count,
        defaultValue_one:
          'Remove <target/> and <descendants>{{count}} child workspace</descendants> from Orca. Project folders on disk will not be deleted.'
      }
    )
  }
  if (scope === 'mixed') {
    return t(
      'auto.components.sidebar.DeleteWorktreeDialog.removeWithChildrenMixed',
      'Remove <target/> and <descendants>{{count}} child workspaces</descendants> from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.',
      {
        count,
        defaultValue_one:
          'Remove <target/> and <descendants>{{count}} child workspace</descendants> from Orca. Git worktrees will also be removed from git and disk; folder workspaces will only remove the Orca workspace entry.'
      }
    )
  }
  return t(
    'auto.components.sidebar.DeleteWorktreeDialog.removeWithChildrenGit',
    'Remove <target/> and <descendants>{{count}} child workspaces</descendants> from git and delete their workspace folders.',
    {
      count,
      defaultValue_one:
        'Remove <target/> and <descendants>{{count}} child workspace</descendants> from git and delete their workspace folders.'
    }
  )
}
