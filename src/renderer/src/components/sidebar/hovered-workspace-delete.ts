import { getLineageInputs } from './visible-worktree-indexes'
import {
  findWorktreeLineageRow,
  getWorktreeLineageSelection
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import {
  toWorktreeDeleteIdentities,
  createWorktreeDeleteAdmission
} from './worktree-delete-request'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isEditableTarget } from '@/lib/editable-target'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { runWorktreeDelete } from './delete-worktree-flow'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
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
  | 'folderWorkspaces'
>
type HoveredWorkspaceDeleteDependencies = {
  deleteWorktree: DeleteWorktree
  getCurrentState: () => AppState
}
type HoveredWorkspaceDocument = Pick<Document, 'activeElement' | 'querySelectorAll'>

export type HoveredWorkspaceDeleteTarget =
  | {
      kind: 'folder'
      worktree: Worktree
      executionHostId: ExecutionHostId
      folderWorkspaceId: string
      workspaceKey: string
    }
  | { kind: 'worktree'; worktree: Worktree }

export function getHoveredWorkspaceIdentity(
  doc: HoveredWorkspaceDocument = document
): { hostIdentity: string; workspaceId: string; selection?: string } | null {
  const hoveredRows = doc.querySelectorAll<HTMLElement>(
    '[data-worktree-sidebar] [role="option"][data-worktree-id]:hover'
  )
  const row = hoveredRows.item(hoveredRows.length - 1)
  const workspaceId = row?.dataset.worktreeId
  const hostIdentity = row?.dataset.worktreeHostIdentity
  return workspaceId && hostIdentity
    ? {
        workspaceId,
        hostIdentity,
        ...(row.dataset.worktreeLineageSelection
          ? { selection: row.dataset.worktreeLineageSelection }
          : {})
      }
    : null
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
  const worktree = findWorktreeLineageRow(
    getLineageInputs(state).worktreeMap,
    hovered.selection ?? hovered.hostIdentity
  )
  if (!worktree) {
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
      worktree,
      executionHostId,
      folderWorkspaceId: workspaceScope.folderWorkspaceId,
      workspaceKey: hovered.workspaceId
    }
  }
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
    try {
      createWorktreeDeleteAdmission(target.worktree)()
    } catch {
      return false
    }
    const pendingIdentity = getWorktreeLineageSelection(target.worktree)
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
    expectedIdentity: toWorktreeDeleteIdentities([target.worktree])[0],
    expectedInstanceId: target.worktree.instanceId,
    ...(target.worktree.hostId ? { expectedHostId: target.worktree.hostId } : {})
  })
  return true
}
