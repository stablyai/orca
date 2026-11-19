import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { WorktreeContextMenuDeleteIntent } from '../context-menu/worktree-context-menu-delete-intent'
import {
  isDeleteConfirmationOnScreen,
  requestSidebarWorkspaceDelete,
  workspaceDeleteIdentity
} from '../../worktree-list/navigation/use-sidebar-workspace-delete-keyboard'
import {
  cancelWorkspaceDeleteConfirmation,
  getArmedWorkspaceDeleteIdentity
} from './workspace-delete-confirmation'
import { runWorktreeDelete } from './delete-worktree-flow'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

type ActiveWorkspaceDeleteIntent = Exclude<WorktreeContextMenuDeleteIntent, { kind: 'batch' }>

/** The workspace open in the main view: never a hovered row (#40913) or a sidebar selection. */
export function selectActiveWorkspaceDeleteIntent(
  state: AppState
): ActiveWorkspaceDeleteIntent | null {
  if (
    state.activeView !== 'terminal' ||
    !state.activeWorktreeId ||
    selectWorktreeCreationSurfaceShown(state)
  ) {
    return null
  }
  const scope = parseWorkspaceKey(state.activeWorktreeId)
  if (scope?.type === 'folder') {
    const owner = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      state.activeWorkspaceExecutionHostId ?? undefined
    )
    return owner.kind === 'selected'
      ? {
          kind: 'folder',
          folderWorkspaceId: scope.folderWorkspaceId,
          executionHostId: owner.value.hostId
        }
      : null
  }
  const worktree = resolveQualifiedWorktreeExecutionOwner(
    selectWorktreesByRepo(state),
    state.repos,
    state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId
  )?.worktree
  if (
    !worktree ||
    worktree.isMainWorktree ||
    getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
  ) {
    return null
  }
  const { id, instanceId, hostId } = worktree
  return { kind: 'worktree', worktree: { id, instanceId, hostId } }
}

/** Null while a modal or popover owns the screen, so the chord is left to it. */
export function resolveActiveWorkspaceDeleteIntent(
  state: AppState = useAppStore.getState()
): ActiveWorkspaceDeleteIntent | null {
  if (
    state.activeModal !== 'none' ||
    hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' })
  ) {
    return null
  }
  return selectActiveWorkspaceDeleteIntent(state)
}

/**
 * Same press-again confirm as the sidebar list, but always asks: when the row prompt cannot show
 * (sidebar closed, row filtered or scrolled out), a worktree falls back to the dialog.
 */
export function requestActiveWorkspaceDelete(
  intent: ActiveWorkspaceDeleteIntent,
  defer: (callback: () => void) => void = (callback) => window.setTimeout(callback, 0)
): void {
  if (!requestSidebarWorkspaceDelete(intent)) {
    return
  }
  const identity = workspaceDeleteIdentity(intent)
  // Why defer: the prompt renders after this press; check it once React has committed.
  defer(() => {
    if (getArmedWorkspaceDeleteIdentity() !== identity || isDeleteConfirmationOnScreen(identity)) {
      return
    }
    cancelWorkspaceDeleteConfirmation()
    // Folders have no dialog (their files stay on disk), so an unseen folder is left alone.
    if (intent.kind === 'worktree') {
      runWorktreeDelete(intent.worktree.id, {
        alwaysAsk: true,
        expectedInstanceId: intent.worktree.instanceId,
        ...(intent.worktree.hostId ? { expectedHostId: intent.worktree.hostId } : {})
      })
    }
  })
}
