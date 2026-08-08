import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why: keys keep their original `delete.worktree.flow` namespace so the existing
// translations are not orphaned by the move out of that module.
function staleWorkspaceListToast(title: string): void {
  toast.info(title, {
    description: translate(
      'auto.components.sidebar.delete.worktree.flow.b81b4e40ca',
      'Refresh Space and try again if the workspace list looks stale.'
    )
  })
}

/** A delete target that is no longer in the store: a refreshing/stale list, not a bad click. */
export function showWorkspaceNoLongerListedToast(): void {
  staleWorkspaceListToast(
    translate(
      'auto.components.sidebar.delete.worktree.flow.workspaceNoLongerListed',
      'Workspace is no longer listed'
    )
  )
}

/** A multi-select delete whose selection resolved to nothing deletable. */
export function showNoDeletableWorkspacesToast(): void {
  staleWorkspaceListToast(
    translate(
      'auto.components.sidebar.delete.worktree.flow.7243145cd6',
      'No deletable workspaces selected'
    )
  )
}
