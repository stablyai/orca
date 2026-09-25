import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { runWorktreeDelete } from './delete-worktree-flow'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

const pendingFolderDeletes = new Set<string>()

type DeleteWorktree = typeof runWorktreeDelete
type HoveredWorkspaceDeleteState = Pick<
  AppState,
  | 'activeModal'
  | 'activeWorktreeId'
  | 'deleteFolderWorkspace'
  | 'deleteStateByWorktreeId'
  | 'worktreesByRepo'
>
type CurrentWorkspaceState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'setActiveWorktree'
>
type HoveredWorkspaceDeleteDependencies = {
  deleteWorktree: DeleteWorktree
  getCurrentState: () => CurrentWorkspaceState
}
type HoveredWorkspaceDocument = Pick<Document, 'activeElement' | 'querySelectorAll'>

export type HoveredWorkspaceDeleteTarget =
  | {
      kind: 'folder'
      executionHostId: ExecutionHostId
      folderWorkspaceId: string
      workspaceKey: string
    }
  | { kind: 'worktree'; worktree: Worktree }

export function getHoveredWorkspaceIdentity(
  doc: HoveredWorkspaceDocument = document
): { hostIdentity: string; workspaceId: string } | null {
  const hoveredRows = doc.querySelectorAll<HTMLElement>(
    '[data-worktree-sidebar] [role="option"][data-worktree-id]:hover'
  )
  const row = hoveredRows.item(hoveredRows.length - 1)
  const workspaceId = row?.dataset.worktreeId
  const hostIdentity = row?.dataset.worktreeHostIdentity
  return workspaceId && hostIdentity ? { workspaceId, hostIdentity } : null
}

export function resolveHoveredWorkspaceDeleteTarget(
  state: HoveredWorkspaceDeleteState,
  doc: HoveredWorkspaceDocument = document
): HoveredWorkspaceDeleteTarget | null {
  if (state.activeModal !== 'none' || (doc.activeElement && isEditableTarget(doc.activeElement))) {
    return null
  }
  const hovered = getHoveredWorkspaceIdentity(doc)
  if (!hovered) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(hovered.workspaceId)
  if (workspaceScope?.type === 'folder') {
    const executionHostId = getExecutionHostIdFromWorktreeHostIdentity(hovered.hostIdentity)
    if (!executionHostId) {
      return null
    }
    return {
      kind: 'folder',
      executionHostId,
      folderWorkspaceId: workspaceScope.folderWorkspaceId,
      workspaceKey: hovered.workspaceId
    }
  }
  const worktree = getAllWorktreesFromState(state).find(
    (candidate) =>
      candidate.id === hovered.workspaceId &&
      getWorktreeHostIdentity(candidate) === hovered.hostIdentity
  )
  return worktree &&
    !worktree.isMainWorktree &&
    !getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
    ? { kind: 'worktree', worktree }
    : null
}

export function deleteHoveredWorkspaceImmediately(
  state: HoveredWorkspaceDeleteState,
  target: HoveredWorkspaceDeleteTarget | null = resolveHoveredWorkspaceDeleteTarget(state),
  dependencies: HoveredWorkspaceDeleteDependencies = {
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
      .deleteFolderWorkspace(target.folderWorkspaceId, {
        executionHostId: target.executionHostId
      })
      .then((deleted) => {
        const current = dependencies.getCurrentState()
        if (
          deleted &&
          current.activeWorktreeId === target.workspaceKey &&
          current.activeWorkspaceExecutionHostId === target.executionHostId
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
