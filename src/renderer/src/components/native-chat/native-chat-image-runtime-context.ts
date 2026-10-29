import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution
} from '@/lib/worktree-operation-route'
import {
  createNativeChatTabOwnerSelector,
  findNativeChatTabOwnerWorktreeId,
  resolveNativeChatFileLinkContextForOwner
} from './native-chat-file-link'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

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

type RouteState = Omit<OwnerState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>

// Subscribe only to ownership inputs; derive context after Zustand filters unrelated updates.
function selectNativeChatImageRouteState(state: AppState): RouteState {
  return {
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    folderWorkspaces: selectFolderWorkspaces(state),
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
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

export function selectNativeChatImageOwnerState(state: AppState): OwnerState {
  return {
    ...selectNativeChatImageRouteState(state),
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree
  }
}

// Why: floating has no catalog row for the route resolver to find, and it always runs locally.
const FLOATING_WORKSPACE_ROUTE: WorktreeOperationRouteResolution = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
}

// Keep target identity stable so unrelated store changes cannot look like an image-owner change.
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
  return resolveNativeChatImageRuntimeContextForOwner(
    state,
    tabId,
    findNativeChatTabOwnerWorktreeId(state, tabId)
  )
}

export function resolveNativeChatImageRuntimeContextForOwner(
  state: RouteState & Pick<OwnerState, 'unifiedTabsByWorktree'>,
  tabId: string,
  owner: string | null
): NativeChatImageRuntimeContext {
  const linkContext = resolveNativeChatFileLinkContextForOwner(state, tabId, owner)
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
  // Why: an `ssh:` host is served only through its paired server; without one there is no route.
  if (!host || (host.kind === 'ssh' && !route.runtimeEnvironmentId)) {
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
    } catch {
      return null
    }
  }
  return context
}

/** Ordinary workspace directories need only the selected owner; floating also needs its tab list. */
export function createNativeChatImageOwnerSelector(tabId: string) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  return (state: AppState) => {
    const owner = selectOwner(state)
    return {
      ...selectNativeChatImageRouteState(state),
      owner,
      floatingTabs:
        owner && isFloatingWorkspaceId(owner) && Object.hasOwn(state.unifiedTabsByWorktree, owner)
          ? state.unifiedTabsByWorktree[owner]
          : undefined
    }
  }
}

export function useNativeChatImageRuntimeContext(tabId: string): NativeChatImageRuntimeContext {
  const selectOwnerState = useMemo(() => createNativeChatImageOwnerSelector(tabId), [tabId])
  const ownerState = useAppStore(useShallow(selectOwnerState))
  return useMemo(() => {
    // This view serves only the existing floating-directory predicate, never an owner index.
    const unifiedTabsByWorktree =
      ownerState.owner && ownerState.floatingTabs
        ? { [ownerState.owner]: ownerState.floatingTabs }
        : {}
    return resolveNativeChatImageRuntimeContextForOwner(
      {
        ...ownerState,
        unifiedTabsByWorktree
      },
      tabId,
      ownerState.owner
    )
  }, [ownerState, tabId])
}
