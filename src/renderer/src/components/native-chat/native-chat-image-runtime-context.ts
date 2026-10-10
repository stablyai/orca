import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  runtimeTargetForOwnerEnvironment,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import {
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
  | 'structuredSessionLaunchDirectoryByTabId'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
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
    structuredSessionLaunchDirectoryByTabId: state.structuredSessionLaunchDirectoryByTabId,
    projectGroups: state.projectGroups,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    sshConnectionStates: state.sshConnectionStates,
    sshStateByEnvironment: state.sshStateByEnvironment,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree
  }
}

// Why: floating has no catalog row for the route resolver to find, and it always runs locally.
const FLOATING_WORKSPACE_ROUTE: WorktreeOperationRouteResolution = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
}

// Why stable: consumers compare by identity, so an unrelated store update must not read as a
// new image owner.
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }
const environmentTargets = new Map<string, RuntimeClientTarget>()

function stableTargetForRoute(runtimeEnvironmentId: string | null): RuntimeClientTarget {
  if (!runtimeEnvironmentId) {
    return LOCAL_TARGET
  }
  let target = environmentTargets.get(runtimeEnvironmentId)
  if (!target) {
    target = runtimeTargetForOwnerEnvironment(runtimeEnvironmentId)
    environmentTargets.set(runtimeEnvironmentId, target)
  }
  return target
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
    target: stableTargetForRoute(route.runtimeEnvironmentId),
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
