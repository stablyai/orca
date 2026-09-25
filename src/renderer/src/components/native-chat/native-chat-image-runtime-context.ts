import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  settingsForWorktreeOperationRoute,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution
} from '@/lib/worktree-operation-route'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

/** The transcript must not read until ownership and its path are both known. */
export type NativeChatImageRuntimeContext = RuntimeFileOperationArgs | null

type OwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'structuredSessionWorkspacePathByTabId'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'getKnownWorktreeById'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

// Keep the subscription limited to fields that can change image ownership. The
// derived context is computed during render, after Zustand has filtered updates.
export function selectNativeChatImageOwnerState(state: AppState): OwnerState {
  return {
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    floatingWorkspacePath: state.floatingWorkspacePath,
    structuredSessionWorkspacePathByTabId: state.structuredSessionWorkspacePathByTabId,
    projectGroups: state.projectGroups,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    sshConnectionStates: state.sshConnectionStates,
    sshStateByEnvironment: state.sshStateByEnvironment,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    getKnownWorktreeById: state.getKnownWorktreeById,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree
  }
}

// Why: floating has no catalog row for the route resolver to find, and it always runs locally.
const FLOATING_WORKSPACE_ROUTE: WorktreeOperationRouteResolution = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
}

// Route settings are cloned for the runtime operation contract. Reuse that
// clone while the store's source settings and selected runtime are unchanged so
// consumers do not treat an unrelated store update as a new image owner.
const settingsBySource = new WeakMap<object, Map<string, AppState['settings']>>()

function stableSettingsForRoute(
  settings: AppState['settings'],
  runtimeEnvironmentId: string | null
): AppState['settings'] {
  if (!settings) {
    return settingsForWorktreeOperationRoute(settings, {
      executionHostId: null,
      runtimeEnvironmentId
    })
  }
  const source = settings as object
  let byRuntime = settingsBySource.get(source)
  if (!byRuntime) {
    byRuntime = new Map()
    settingsBySource.set(source, byRuntime)
  }
  const cacheKey = runtimeEnvironmentId ?? ''
  const cached = byRuntime.get(cacheKey)
  if (cached) {
    return cached
  }
  const resolved = settingsForWorktreeOperationRoute(settings, {
    executionHostId: null,
    runtimeEnvironmentId
  })
  byRuntime.set(cacheKey, resolved)
  return resolved
}

export function resolveNativeChatImageRuntimeContext(
  state: OwnerState,
  tabId: string
): NativeChatImageRuntimeContext {
  const linkContext = resolveNativeChatFileLinkContext(state, tabId)
  if (!linkContext) {
    return null
  }
  const routeResolution = isFloatingWorkspaceId(linkContext.worktreeId)
    ? FLOATING_WORKSPACE_ROUTE
    : resolveWorktreeOperationRouteResult(state, linkContext.worktreeId)
  if (routeResolution.kind !== 'resolved') {
    return null
  }
  const route = routeResolution.route
  const executionHostId =
    route.executionHostId ??
    (route.runtimeEnvironmentId ? toRuntimeExecutionHostId(route.runtimeEnvironmentId) : null)
  if (!executionHostId) {
    return null
  }
  const worktreePath = resolveNativeChatTabDirectory(
    state,
    tabId,
    linkContext.worktreeId,
    executionHostId
  )
  if (!worktreePath) {
    return null
  }
  const host = parseExecutionHostId(executionHostId)
  if (!host) {
    return null
  }
  const context: RuntimeFileOperationArgs = {
    settings: stableSettingsForRoute(state.settings, route.runtimeEnvironmentId),
    worktreeId: linkContext.worktreeId,
    worktreePath,
    expectedExecutionHostId: host.kind === 'ssh' ? host.id : 'local'
  }
  if (host.kind === 'ssh') {
    try {
      const expectation = captureDirectSshMutationExpectation(
        state,
        host.targetId,
        route.runtimeEnvironmentId
      )
      context.expectedSshTargetId = expectation.expectedSshTargetId
      context.expectedSshConnectionGeneration = expectation.expectedSshConnectionGeneration
      if (!route.runtimeEnvironmentId) {
        context.connectionId = host.targetId
        context.expectedExternalSshTargetId = host.targetId
      }
    } catch {
      return null
    }
  }
  return context
}

export function useNativeChatImageRuntimeContext(tabId: string): NativeChatImageRuntimeContext {
  const ownerState = useAppStore(useShallow(selectNativeChatImageOwnerState))
  return useMemo(() => resolveNativeChatImageRuntimeContext(ownerState, tabId), [ownerState, tabId])
}
