import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'

export function workspacePassesFilters(
  worktree: Worktree,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[]
): boolean {
  const identity = getWorktreeHostIdentity(worktree)
  return (
    worktrees.some((candidate) => getWorktreeHostIdentity(candidate) === identity) ||
    folderWorkspaces.some((workspace) => folderWorkspaceKey(workspace.id) === worktree.id)
  )
}

export function confirmRevealHiddenWorkspace(
  confirm: ConfirmationDialogContextValue
): Promise<boolean> {
  return confirm({
    initialFocus: 'confirm',
    title: translate('sidebar.revealFiltered.title', 'Reveal hidden workspace?'),
    description: translate(
      'sidebar.revealFiltered.description',
      'The active workspace is hidden in the sidebar. Revealing it will adjust only the filters hiding it.'
    ),
    confirmLabel: translate('sidebar.revealFiltered.confirm', 'Adjust & reveal'),
    cancelLabel: translate('sidebar.revealFiltered.cancel', 'Keep filters')
  })
}
