import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useAppStore } from '@/store'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { AppState } from '@/store/types'
import { isEditableTarget, isNativeChatPromptTarget } from '@/lib/text-input/focus/editable-target'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { runWorktreeDelete } from './delete-worktree-flow'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

const pendingFolderDeletes = new Set<string>()

type DeleteWorktree = typeof runWorktreeDelete
type ActiveWorkspaceDeleteState = Pick<
  AppState,
  | 'activeModal'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeView'
  | 'activePendingCreationId'
  | 'pendingWorktreeCreations'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'deleteStateByWorktreeId'
  | 'worktreesByRepo'
>
type ActiveWorkspaceDeleteDependencies = {
  deleteWorktree: DeleteWorktree
  getCurrentState: () => AppState
}
type ActiveWorkspaceDocument = Pick<Document, 'activeElement'>

export type ActiveWorkspaceDeleteTarget =
  | {
      kind: 'folder'
      executionHostId: ExecutionHostId
      folderWorkspaceId: string
      workspaceKey: string
    }
  | { kind: 'worktree'; worktree: Worktree }

export function selectActiveWorkspaceDeleteTarget(
  state: ActiveWorkspaceDeleteState
): ActiveWorkspaceDeleteTarget | null {
  if (
    state.activeView !== 'terminal' ||
    !state.activeWorktreeId ||
    selectWorktreeCreationSurfaceShown(state)
  ) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(state.activeWorktreeId)
  if (workspaceScope?.type === 'folder') {
    const owner = resolveQualifiedIndexedFolderWorkspace(
      state,
      workspaceScope.folderWorkspaceId,
      state.activeWorkspaceExecutionHostId ?? undefined
    )
    return owner.kind === 'selected'
      ? {
          kind: 'folder',
          executionHostId: owner.value.hostId,
          folderWorkspaceId: workspaceScope.folderWorkspaceId,
          workspaceKey: state.activeWorktreeId
        }
      : null
  }
  const worktree = resolveQualifiedWorktreeExecutionOwner(
    selectWorktreesByRepo(state),
    state.repos,
    state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId
  )?.worktree
  return worktree &&
    !worktree.isMainWorktree &&
    !getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
    ? { kind: 'worktree', worktree }
    : null
}

export function resolveActiveWorkspaceDeleteTarget(
  state: ActiveWorkspaceDeleteState,
  doc: ActiveWorkspaceDocument = document
): ActiveWorkspaceDeleteTarget | null {
  if (
    state.activeModal !== 'none' ||
    hasVisibleOverlay({ ignoreMatches: '[role="listbox"], [role="menu"]' }) ||
    (doc.activeElement &&
      isEditableTarget(doc.activeElement) &&
      !isNativeChatPromptTarget(doc.activeElement))
  ) {
    return null
  }
  return selectActiveWorkspaceDeleteTarget(state)
}

export function deleteActiveWorkspaceFromShortcut(
  state: ActiveWorkspaceDeleteState,
  target: ActiveWorkspaceDeleteTarget | null = resolveActiveWorkspaceDeleteTarget(state),
  dependencies: ActiveWorkspaceDeleteDependencies = {
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
    expectedInstanceId: target.worktree.instanceId,
    ...(target.worktree.hostId ? { expectedHostId: target.worktree.hostId } : {})
  })
  return true
}
