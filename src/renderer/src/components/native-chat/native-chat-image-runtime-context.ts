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
  findNativeChatTabOwnerWorktreeId
} from './native-chat-file-link'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import { resolveOwner } from '@/lib/resolve-owner'
import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { firstRegisteredStructuredChatTab } from '@/lib/structured-chat-tab-index'
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

// Catalog routing is independent of the addressed launch pin and SSH generation.
function selectNativeChatImageRouteState(state: AppState) {
  return {
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    folderWorkspaces: selectFolderWorkspaces(state),
    floatingWorkspacePath: state.floatingWorkspacePath,
    projectGroups: state.projectGroups,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

export function selectNativeChatImageOwnerState(state: AppState): OwnerState {
  return {
    ...selectNativeChatImageRouteState(state),
    sshConnectionStates: state.sshConnectionStates,
    sshStateByEnvironment: state.sshStateByEnvironment,
    structuredSessionLaunchDirectoryByTabId: state.structuredSessionLaunchDirectoryByTabId,
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
  return withSshExpectation(state, resolveNativeChatImageRouteContext(state, tabId, owner))
}

function resolveNativeChatImageRouteContext(
  state: Omit<RouteState, 'sshConnectionStates' | 'sshStateByEnvironment'> &
    Pick<OwnerState, 'unifiedTabsByWorktree'>,
  tabId: string,
  owner: string | null
): NativeChatImageRuntimeContext {
  if (!owner || !resolveNativeChatTabDirectory(state, tabId, owner)) {
    return null
  }
  const routeResolution = isFloatingWorkspaceId(owner)
    ? FLOATING_WORKSPACE_ROUTE
    : resolveWorktreeOperationRouteResult(state, owner)
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
  const worktreePath = resolveNativeChatTabDirectory(state, tabId, owner, executionHostId)
  if (!worktreePath) {
    return null
  }
  const match = resolveOwner(
    { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null },
    { workspaceId: owner, hostId: executionHostId }
  )
  const authority = match.kind === 'resolved' ? match.owner : undefined
  if (
    authority &&
    (authority.endpoint.kind === 'environment' ? authority.endpoint.environmentId : null) !==
      route.runtimeEnvironmentId
  ) {
    return null
  }
  const host = parseExecutionHostId(authority?.at ?? executionHostId)
  // Why: an `ssh:` host is served only through its paired server; without one there is no route.
  if (!host || (host.kind === 'ssh' && !route.runtimeEnvironmentId)) {
    return null
  }
  const context: RuntimeFileOperationArgs = {
    target: stableTargetForRoute(route.runtimeEnvironmentId),
    worktreeId: owner,
    worktreePath,
    expectedExecutionHostId: host.kind === 'ssh' ? host.id : 'local'
  }
  return context
}

function withSshExpectation(
  state: Pick<OwnerState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  context: NativeChatImageRuntimeContext
): NativeChatImageRuntimeContext {
  const host = parseExecutionHostId(context?.expectedExecutionHostId)
  if (context && host?.kind === 'ssh') {
    try {
      const expectation = captureDirectSshMutationExpectation(
        state,
        host.targetId,
        context.target.kind === 'environment' ? context.target.environmentId : null
      )
      return { ...context, ...expectation }
    } catch {
      return null
    }
  }
  return context
}

/** Floating pins are addressed by both tab and session identity. */
export function createNativeChatImageOwnerSelector(tabId: string) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  return (state: AppState) => {
    const owner = selectOwner(state)
    const floatingTab =
      owner && isFloatingWorkspaceId(owner)
        ? firstRegisteredStructuredChatTab(state.unifiedTabsByWorktree[owner], tabId)
        : undefined
    return {
      ...selectNativeChatImageRouteState(state),
      owner,
      floatingTab,
      pin: floatingTab ? state.structuredSessionLaunchDirectoryByTabId[tabId] : undefined
    }
  }
}

/** Keep equal resolved contexts stable without re-deriving routes for unrelated owner inputs. */
export function createNativeChatImageRuntimeContextSelector(tabId: string) {
  const selectOwner = createNativeChatImageOwnerSelector(tabId)
  let previousInputs: ReturnType<typeof selectOwner> | undefined
  let baseRoute: NativeChatImageRuntimeContext = null
  let context: NativeChatImageRuntimeContext = null
  return (state: AppState): NativeChatImageRuntimeContext => {
    const ownerState = selectOwner(state)
    if (!previousInputs || !shallow(previousInputs, ownerState)) {
      previousInputs = ownerState
      const unifiedTabsByWorktree =
        ownerState.owner && ownerState.floatingTab
          ? { [ownerState.owner]: [ownerState.floatingTab] }
          : {}
      baseRoute = resolveNativeChatImageRouteContext(
        {
          ...ownerState,
          unifiedTabsByWorktree,
          structuredSessionLaunchDirectoryByTabId: ownerState.pin ? { [tabId]: ownerState.pin } : {}
        },
        tabId,
        ownerState.owner
      )
    }
    const resolved = withSshExpectation(state, baseRoute)
    context = shallow(context, resolved) ? context : resolved
    return context
  }
}

export function useNativeChatImageRuntimeContext(tabId: string): NativeChatImageRuntimeContext {
  const selectContext = useMemo(() => createNativeChatImageRuntimeContextSelector(tabId), [tabId])
  return useAppStore(selectContext)
}
