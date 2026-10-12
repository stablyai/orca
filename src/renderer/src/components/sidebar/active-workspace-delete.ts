import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/scroll-to-current-workspace-status'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { runWorktreeDelete } from './delete-worktree-flow'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
import {
  armWorkspaceDeleteConfirmation,
  confirmWorkspaceDeleteConfirmation,
  type WorkspaceDeleteConfirmationDependencies
} from './workspace-delete-confirmation'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

const pendingFolderDeletes = new Set<string>()

export type ActiveWorkspaceDeleteState = Pick<
  AppState,
  | 'activeModal'
  | 'activeView'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'deleteStateByWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'setSidebarOpen'
  | 'worktreesByRepo'
>
type ActiveWorkspaceDeleteDependencies = {
  deleteWorktree: typeof runWorktreeDelete
  getCurrentState: () => AppState
  confirmationDependencies?: WorkspaceDeleteConfirmationDependencies
}
const defaultDependencies: ActiveWorkspaceDeleteDependencies = {
  deleteWorktree: runWorktreeDelete,
  getCurrentState: useAppStore.getState
}

export type ActiveWorkspaceDeleteTarget =
  | {
      kind: 'folder'
      executionHostId: ExecutionHostId
      folderWorkspaceId: string
      workspaceKey: string
      identity: string
    }
  | { kind: 'worktree'; worktree: Worktree; identity: string }

/** The active workspace as a delete target; the pointer plays no part. */
export function resolveActiveWorkspaceDeleteTarget(
  state: ActiveWorkspaceDeleteState,
  doc: Pick<Document, 'activeElement'> = document
): ActiveWorkspaceDeleteTarget | null {
  const activeId = state.activeWorktreeId
  if (
    !activeId ||
    // Why: the confirmation is drawn on a sidebar row, which only the terminal view shows.
    state.activeView !== 'terminal' ||
    state.activeModal !== 'none' ||
    (doc.activeElement && isEditableTarget(doc.activeElement))
  ) {
    return null
  }
  const hostId = state.activeWorkspaceExecutionHostId ?? undefined
  const workspaceScope = parseWorkspaceKey(activeId)
  if (workspaceScope?.type === 'folder') {
    // Why: same synthetic row (and host identity) the sidebar card renders with.
    const row = findKnownWorktreeById(state, activeId, hostId)
    return row
      ? {
          kind: 'folder',
          executionHostId: row.hostId ?? LOCAL_EXECUTION_HOST_ID,
          folderWorkspaceId: workspaceScope.folderWorkspaceId,
          workspaceKey: activeId,
          identity: getWorktreeHostIdentity(row)
        }
      : null
  }
  // Why: not findKnownWorktreeById — it also answers with detected-only and floating rows.
  const worktree = getWorktreeOnHostFromState(state, activeId, hostId)
  return worktree &&
    !worktree.isMainWorktree &&
    !getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
    ? { kind: 'worktree', worktree, identity: getWorktreeHostIdentity(worktree) }
    : null
}

/** First press arms the active row; a second press on the same row deletes it. */
export function requestActiveWorkspaceDelete(
  state: ActiveWorkspaceDeleteState,
  target: ActiveWorkspaceDeleteTarget | null = resolveActiveWorkspaceDeleteTarget(state),
  dependencies: ActiveWorkspaceDeleteDependencies = defaultDependencies
): boolean {
  if (!target) {
    return false
  }
  if (confirmWorkspaceDeleteConfirmation(target.identity)) {
    return deleteWorkspaceTarget(target, dependencies)
  }
  armWorkspaceDeleteConfirmation(target.identity, dependencies.confirmationDependencies)
  // Why: the confirmation is drawn on the row, so the row must be on screen.
  state.setSidebarOpen(true)
  requestScrollToCurrentWorkspaceReveal()
  return true
}

export function deleteWorkspaceTarget(
  target: ActiveWorkspaceDeleteTarget,
  dependencies: ActiveWorkspaceDeleteDependencies = defaultDependencies
): boolean {
  if (target.kind === 'folder') {
    const pendingIdentity = composeWorktreeHostIdentity(target.executionHostId, target.workspaceKey)
    if (pendingFolderDeletes.has(pendingIdentity)) {
      return false
    }
    const deletion = deleteFolderWorkspaceUnlessUnsaved(
      dependencies.getCurrentState,
      target.folderWorkspaceId,
      target.executionHostId
    )
    if (deletion) {
      pendingFolderDeletes.add(pendingIdentity)
      void deletion.finally(() => pendingFolderDeletes.delete(pendingIdentity))
    }
    return true
  }
  dependencies.deleteWorktree(target.worktree.id, {
    confirmed: true,
    expectedInstanceId: target.worktree.instanceId,
    ...(target.worktree.hostId ? { expectedHostId: target.worktree.hostId } : {})
  })
  return true
}
