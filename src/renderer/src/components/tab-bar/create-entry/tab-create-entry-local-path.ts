import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getFolderWorkspaceConnectionId } from '@/lib/workspace/ownership/folder-workspace-connection'
import {
  getLocalPathOpenOwnerForRoute,
  isLocalPathOpenBlocked
} from '@/lib/files/os-open/local-path-open-guard'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { useAppStore } from '@/store/index'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { isWslHostRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { selectFileListWorktree } from '@/store/workspaces/selection/known-worktree-selection'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { TabEntryLocalPlatform } from './tab-create-entry-path-validation'

export type TabEntryAbsolutePathPolicy = {
  allowAbsolutePaths: boolean
  platform: TabEntryLocalPlatform | undefined
}

const SKIPPED_ABSOLUTE_PATH_POLICY: TabEntryAbsolutePathPolicy = {
  allowAbsolutePaths: false,
  platform: undefined
}

type TabEntryAbsolutePathOwnerState = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'settings'
  | 'repos'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
>

function getLocalTabEntryPlatform(): TabEntryLocalPlatform {
  return getRendererAppPlatform() === 'win32' ? 'windows' : 'posix'
}

export function isTabEntryAbsolutePathAllowed(
  context: Pick<RuntimeFileOperationArgs, 'connectionId' | 'target'>
): boolean {
  if (context.target.kind === 'environment' && !context.connectionId) {
    return true
  }
  return !isLocalPathOpenBlocked(
    getLocalPathOpenOwnerForRoute({
      runtimeEnvironmentId: runtimeTargetEnvironmentId(context.target),
      connectionId: context.connectionId
    })
  )
}

function getTabEntryAbsolutePathContext(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): Pick<RuntimeFileOperationArgs, 'connectionId' | 'target'> | null {
  const worktree = selectFileListWorktree(state, worktreeId)
  if (!worktree) {
    return null
  }
  const workspaceKey = parseWorkspaceKey(worktreeId)
  if (
    workspaceKey?.type === 'folder' &&
    getResolvedExecutionHostIdForWorktree(state, worktreeId) === 'local' &&
    getFolderWorkspaceConnectionId(state, workspaceKey.folderWorkspaceId) === null
  ) {
    return { target: { kind: 'local' } }
  }
  try {
    return getEditorFileOperationContext(state, { worktreeId }, worktree.path)
  } catch {
    return null
  }
}

export function getTabEntryAllowAbsolutePaths(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
  const context = getTabEntryAbsolutePathContext(state, worktreeId)
  return context !== null && isTabEntryAbsolutePathAllowed(context)
}

export function getTabEntryAbsolutePathPolicy(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): TabEntryAbsolutePathPolicy {
  const context = getTabEntryAbsolutePathContext(state, worktreeId)
  if (!context || !isTabEntryAbsolutePathAllowed(context)) {
    return { allowAbsolutePaths: false, platform: getLocalTabEntryPlatform() }
  }
  if (context.target.kind !== 'environment') {
    return { allowAbsolutePaths: true, platform: getLocalTabEntryPlatform() }
  }
  const environmentId = context.target.environmentId
  const hostPlatform = lastVerifiedRuntimeStatus(
    state.runtimeStatusByEnvironmentId.get(environmentId)
  )?.hostPlatform
  if (hostPlatform) {
    return {
      allowAbsolutePaths: true,
      platform: hostPlatform === 'win32' ? 'windows' : 'posix'
    }
  }
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return {
    allowAbsolutePaths: true,
    platform: environment && isWslHostRuntimeEnvironment(environment) ? 'posix' : undefined
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
        target: { kind: 'local' },
        worktreeId,
        worktreePath,
        expectedExecutionHostId: 'local'
      }
    }
  }
  return getEditorFileOperationContext(state, { worktreeId }, worktreePath)
}

export function createTabEntryAbsolutePathPolicySelector(
  worktreeId: string,
  { skip = false }: { skip?: boolean } = {}
): (state: ReturnType<typeof useAppStore.getState>) => TabEntryAbsolutePathPolicy {
  let previousSlices: TabEntryAbsolutePathOwnerState | null = null
  let previousResult: TabEntryAbsolutePathPolicy = SKIPPED_ABSOLUTE_PATH_POLICY
  return (state) => {
    if (skip) {
      return SKIPPED_ABSOLUTE_PATH_POLICY
    }
    if (
      previousSlices?.settings === state.settings &&
      previousSlices.repos === state.repos &&
      previousSlices.activeWorktreeId === state.activeWorktreeId &&
      previousSlices.activeWorkspaceExecutionHostId === state.activeWorkspaceExecutionHostId &&
      selectWorktreesByRepo(previousSlices) === selectWorktreesByRepo(state) &&
      selectDetectedWorktreesByRepo(previousSlices) === selectDetectedWorktreesByRepo(state) &&
      selectFolderWorkspaces(previousSlices) === selectFolderWorkspaces(state) &&
      previousSlices.projectGroups === state.projectGroups &&
      previousSlices.runtimeEnvironments === state.runtimeEnvironments &&
      previousSlices.runtimeStatusByEnvironmentId === state.runtimeStatusByEnvironmentId &&
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
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      worktreesByRepo: selectWorktreesByRepo(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      sshConnectionStates: state.sshConnectionStates,
      sshStateByEnvironment: state.sshStateByEnvironment
    }
    previousResult = getTabEntryAbsolutePathPolicy(state, worktreeId)
    return previousResult
  }
}
