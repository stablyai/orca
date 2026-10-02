import { translate } from '@/i18n/i18n'
import { showWorkspaceGoToToast, type WorkspaceGoToToastTarget } from '@/lib/workspace-go-to-toast'

/** Announces a create that finished after the user left its creation surface, instead of pulling them to it. */
export function showWorktreeCreationReadyToast(worktree: WorkspaceGoToToastTarget): void {
  showWorkspaceGoToToast(worktree, {
    title: ({ name, isFolder }) =>
      isFolder
        ? translate(
            'components.workspace.creation.workspaceReadyToast',
            'Workspace {{name}} is ready',
            {
              name
            }
          )
        : translate(
            'components.workspace.creation.worktreeReadyToast',
            'Worktree {{name}} is ready',
            {
              name
            }
          )
  })
}
