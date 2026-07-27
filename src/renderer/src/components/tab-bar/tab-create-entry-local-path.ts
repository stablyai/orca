import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

type TabEntryAbsolutePathOwnerState = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
>

export function isTabEntryAbsolutePathAllowed(
  context: Pick<RuntimeFileOperationArgs, 'connectionId' | 'settings'>
): boolean {
  return !isLocalPathOpenBlocked(context.settings, { connectionId: context.connectionId })
}

export function getTabEntryAllowAbsolutePaths(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return false
  }
  const workspaceKey = parseWorkspaceKey(worktreeId)
  if (workspaceKey?.type === 'folder') {
    return (
      getResolvedExecutionHostIdForWorktree(state, worktreeId) === 'local' &&
      getFolderWorkspaceConnectionId(state, workspaceKey.folderWorkspaceId) === null
    )
  }
  try {
    const runtimeContext = getEditorFileOperationContext(state, { worktreeId }, worktree.path)
    return isTabEntryAbsolutePathAllowed(runtimeContext)
  } catch {
    return false
  }
}

export function getTabEntryFileOperationContext(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  worktreePath: string
): RuntimeFileOperationArgs {
  const workspaceKey = parseWorkspaceKey(worktreeId)
  if (workspaceKey?.type === 'folder') {
    if (
      getResolvedExecutionHostIdForWorktree(state, worktreeId) === 'local' &&
      getFolderWorkspaceConnectionId(state, workspaceKey.folderWorkspaceId) === null
    ) {
      return {
        settings: state.settings
          ? { ...state.settings, activeRuntimeEnvironmentId: null }
          : { activeRuntimeEnvironmentId: null },
        worktreeId,
        worktreePath,
        expectedExecutionHostId: 'local'
      }
    }
  }
  return getEditorFileOperationContext(state, { worktreeId }, worktreePath)
}

export function createTabEntryAllowAbsolutePathsSelector(
  worktreeId: string,
  { skip = false }: { skip?: boolean } = {}
): (state: ReturnType<typeof useAppStore.getState>) => boolean {
  let previousSlices: TabEntryAbsolutePathOwnerState | null = null
  let previousResult = false
  return (state) => {
    if (skip) {
      return false
    }
    if (
      previousSlices?.settings === state.settings &&
      previousSlices.repos === state.repos &&
      previousSlices.worktreesByRepo === state.worktreesByRepo &&
      previousSlices.detectedWorktreesByRepo === state.detectedWorktreesByRepo &&
      previousSlices.folderWorkspaces === state.folderWorkspaces &&
      previousSlices.projectGroups === state.projectGroups &&
      previousSlices.runtimeEnvironments === state.runtimeEnvironments &&
      previousSlices.runtimeEnvironmentCatalogHydrated ===
        state.runtimeEnvironmentCatalogHydrated &&
      previousSlices.removedRuntimeEnvironmentIds === state.removedRuntimeEnvironmentIds &&
      previousSlices.restoredRuntimeHostIdByWorkspaceSessionKey ===
        state.restoredRuntimeHostIdByWorkspaceSessionKey &&
      previousSlices.sshConnectionStates === state.sshConnectionStates &&
      previousSlices.sshStateByEnvironment === state.sshStateByEnvironment
    ) {
      return previousResult
    }
    previousSlices = {
      settings: state.settings,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      sshConnectionStates: state.sshConnectionStates,
      sshStateByEnvironment: state.sshStateByEnvironment
    }
    previousResult = getTabEntryAllowAbsolutePaths(state, worktreeId)
    return previousResult
  }
}
