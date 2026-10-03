import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspaceWindowMetadata } from '../../../shared/workspace-window-metadata'
import { findIndexedRepoOwnerForHost } from '../lib/worktree-runtime-owner-index'
import type { AppState } from './types'

type WorkspaceWindowMetadataState = Pick<
  AppState,
  | 'activePendingCreationId'
  | 'activeView'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'repos'
> & {
  pendingWorktreeCreations: Readonly<Record<string, unknown>>
  getKnownWorktreeById: (
    worktreeId: string,
    executionHostId?: ExecutionHostId
  ) =>
    | Pick<Worktree, 'displayName' | 'hostId' | 'path' | 'repoId' | 'runtimeOwnerEnvironmentId'>
    | undefined
}

const EMPTY_WORKSPACE_WINDOW_METADATA: WorkspaceWindowMetadata = {
  displayName: null,
  repoName: null,
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
  const repoHostId = worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : executionHostId
  const repo = findIndexedRepoOwnerForHost(state.repos, worktree.repoId, repoHostId)
  return {
    displayName: worktree.displayName,
    repoName: repo && isGitRepoKind(repo) ? repo.displayName : null,
    localPath: executionHostId === LOCAL_EXECUTION_HOST_ID ? worktree.path : null
  }
}
