import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { runWorktreeDelete } from './delete-worktree-flow'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

const pendingFolderDeletes = new Set<string>()

type DeleteWorktree = typeof runWorktreeDelete
type CurrentWorkspaceDeleteState = Pick<
  AppState,
  | 'activeModal'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'deleteFolderWorkspace'
  | 'deleteStateByWorktreeId'
  | 'worktreesByRepo'
>
type CurrentWorkspaceState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'setActiveWorktree'
>
type CurrentWorkspaceDeleteDependencies = {
  deleteWorktree: DeleteWorktree
  getCurrentState: () => CurrentWorkspaceState
}
type CurrentWorkspaceDocument = Pick<Document, 'activeElement'>

export type CurrentWorkspaceDeleteTarget =
  | {
      kind: 'folder'
      executionHostId: ExecutionHostId | undefined
      folderWorkspaceId: string
      workspaceKey: string
    }
  | { kind: 'worktree'; worktree: Worktree }

/**
 * The workspace the delete shortcut acts on: the one selected in the sidebar (store state), never
 * the row under the pointer. `:hover` lingers on whichever row the mouse last crossed — it goes
 * stale when the pointer sits over a native browser view or the list shifts under it — so a
 * hover-derived target silently deletes a workspace other than the highlighted one.
 */
export function resolveCurrentWorkspaceDeleteTarget(
  state: CurrentWorkspaceDeleteState,
  doc: CurrentWorkspaceDocument = document
): CurrentWorkspaceDeleteTarget | null {
  if (state.activeModal !== 'none' || (doc.activeElement && isEditableTarget(doc.activeElement))) {
    return null
  }
  const workspaceId = state.activeWorktreeId
  if (!workspaceId) {
    return null
  }
  const executionHostId = state.activeWorkspaceExecutionHostId ?? undefined
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    return {
      kind: 'folder',
      executionHostId,
      folderWorkspaceId: workspaceScope.folderWorkspaceId,
      workspaceKey: workspaceId
    }
  }
  // Why: same host-qualified lookup as runWorktreeDelete — one row per host can share a path.
  const worktree = getWorktreeOnHostFromState(state, workspaceId, executionHostId)
  return worktree &&
    !worktree.isMainWorktree &&
    !getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
    ? { kind: 'worktree', worktree }
    : null
}

export function deleteCurrentWorkspaceImmediately(
  state: CurrentWorkspaceDeleteState,
  target: CurrentWorkspaceDeleteTarget | null = resolveCurrentWorkspaceDeleteTarget(state),
  dependencies: CurrentWorkspaceDeleteDependencies = {
    deleteWorktree: runWorktreeDelete,
    getCurrentState: useAppStore.getState
  }
): boolean {
  if (!target) {
    return false
  }
  if (target.kind === 'folder') {
    const pendingIdentity = composeWorktreeHostIdentity(target.executionHostId, target.workspaceKey)
    if (pendingFolderDeletes.has(pendingIdentity)) {
      return false
    }
    pendingFolderDeletes.add(pendingIdentity)
    void state
      .deleteFolderWorkspace(
        target.folderWorkspaceId,
        target.executionHostId ? { executionHostId: target.executionHostId } : undefined
      )
      .then((deleted) => {
        const current = dependencies.getCurrentState()
        if (
          deleted &&
          current.activeWorktreeId === target.workspaceKey &&
          (!target.executionHostId ||
            current.activeWorkspaceExecutionHostId === target.executionHostId)
        ) {
          current.setActiveWorktree(null)
        }
      })
      .finally(() => pendingFolderDeletes.delete(pendingIdentity))
    return true
  }
  dependencies.deleteWorktree(target.worktree.id, {
    expectedInstanceId: target.worktree.instanceId,
    ...(target.worktree.hostId ? { expectedHostId: target.worktree.hostId } : {})
  })
  return true
}
