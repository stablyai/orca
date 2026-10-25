import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Retain translation keys from the original module so existing translations remain usable.
function staleWorkspaceListToast(title: string): void {
  toast.info(title, {
    description: translate(
      'auto.components.sidebar.delete.worktree.flow.b81b4e40ca',
      'Refresh Space and try again if the workspace list looks stale.'
    )
  })
}

/** A delete target changed or vanished after the action was selected. */
export function showWorkspaceListChangedToast(): void {
  staleWorkspaceListToast(
    translate(
      'auto.components.sidebar.delete.worktree.flow.workspaceListChanged',
      'Workspace list changed'
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
