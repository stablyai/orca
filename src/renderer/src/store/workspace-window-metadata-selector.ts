import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceWindowMetadata } from '../../../shared/workspace-window-metadata'
import type { AppState } from './types'

type WorkspaceWindowMetadataState = Pick<
  AppState,
  'activePendingCreationId' | 'activeView' | 'activeWorkspaceExecutionHostId' | 'activeWorktreeId'
> & {
  pendingWorktreeCreations: Readonly<Record<string, unknown>>
  getKnownWorktreeById: (
    worktreeId: string,
    executionHostId?: ExecutionHostId
  ) => Pick<Worktree, 'displayName' | 'hostId' | 'path'> | undefined
}

const EMPTY_WORKSPACE_WINDOW_METADATA: WorkspaceWindowMetadata = {
  displayName: null,
  localPath: null
}

export function selectWorkspaceWindowMetadata(
  state: WorkspaceWindowMetadataState
): WorkspaceWindowMetadata {
  const hasActivePendingCreation =
    state.activePendingCreationId !== null &&
    state.pendingWorktreeCreations[state.activePendingCreationId] !== undefined
  if (state.activeView !== 'terminal' || !state.activeWorktreeId || hasActivePendingCreation) {
    return EMPTY_WORKSPACE_WINDOW_METADATA
  }

  const worktree = state.getKnownWorktreeById(
    state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId ?? undefined
  )
  if (!worktree) {
    return EMPTY_WORKSPACE_WINDOW_METADATA
  }

  const executionHostId =
    state.activeWorkspaceExecutionHostId ?? worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  return {
    displayName: worktree.displayName,
    localPath: executionHostId === LOCAL_EXECUTION_HOST_ID ? worktree.path : null
  }
}
