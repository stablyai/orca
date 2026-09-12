import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getSettingsForWorktreeRuntimeOwner
} from '@/lib/worktree-runtime-owner'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

export type FileExplorerOperationRoute = {
  settings: { activeRuntimeEnvironmentId: string | null }
  connectionId?: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

export type FileExplorerOperationGuard = {
  route: FileExplorerOperationRoute
  assertCurrent: () => FileExplorerOperationRoute
}

export type FileExplorerOwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function getFileExplorerOperationOwnerFromState(
  state: FileExplorerOwnerState,
  worktreeId: string | null | undefined,
  // Why: a browser web client has no local host, so a `local`-owned worktree on
  // a headless `orca serve` must be operated through the connected server runtime
  // instead of the (nonexistent) browser-local host. Injected for testability;
  // the store-backed getFileExplorerOperationOwner passes isWebClientLocation().
  isWebClient: boolean = false
): FileExplorerOperationOwner {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { kind: 'local' }
  }
  const parsedWorkspace = worktreeId ? parseWorkspaceKey(worktreeId) : null
  if (worktreeId && parsedWorkspace?.type !== 'folder') {
    const route = resolveWorktreeOperationRoute(state, worktreeId)
    if (!route) {
      return { kind: 'unresolved' }
    }
    if (route.runtimeEnvironmentId) {
      return {
        kind: 'runtime',
        environmentId: route.runtimeEnvironmentId,
        executionHostId:
          route.executionHostId ?? `runtime:${encodeURIComponent(route.runtimeEnvironmentId)}`
      }
    }
    if (route.executionHostId) {
      return operationOwnerFromHostId(route.executionHostId, state, isWebClient)
    }
  }

  const connectionId = getConnectionIdFromState(state, worktreeId ?? null)
  const explicitRuntimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: global runtime focus is not ownership evidence while SSH/local
  // metadata is unresolved; destructive actions must wait for explicit provenance.
  if (connectionId === undefined && explicitRuntimeEnvironmentId === null) {
    return { kind: 'unresolved' }
  }
  const settings = getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  // Why: inferred SSH ownership outranks global runtime focus, but an explicit
  // workspace runtime still owns its files.
  const runtimeEnvironmentId =
    connectionId && explicitRuntimeEnvironmentId === null
      ? null
      : settings.activeRuntimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return {
      kind: 'runtime',
      environmentId: runtimeEnvironmentId,
      executionHostId: `runtime:${encodeURIComponent(runtimeEnvironmentId)}`
    }
  }
  if (connectionId === undefined) {
    return { kind: 'unresolved' }
  }
  return connectionId
    ? { kind: 'ssh', connectionId }
    : localOrConnectedRuntimeOwner(state, isWebClient)
}

export function getFileExplorerOperationOwner(
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  return getFileExplorerOperationOwnerFromState(
    useAppStore.getState(),
    worktreeId,
    isWebClientLocation()
  )
}

export function getFileExplorerOperationRoute(
  owner: FileExplorerOperationOwner
): FileExplorerOperationRoute | null {
  switch (owner.kind) {
    case 'local':
      return {
        settings: { activeRuntimeEnvironmentId: null },
        expectedExecutionHostId: 'local'
      }
    case 'ssh':
      return {
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: owner.connectionId,
        expectedExecutionHostId: `ssh:${encodeURIComponent(owner.connectionId)}`
      }
    case 'runtime': {
      const host = parseExecutionHostId(owner.executionHostId)
      return {
        settings: { activeRuntimeEnvironmentId: owner.environmentId },
        ...(host?.kind === 'ssh'
          ? { expectedExecutionHostId: host.id }
          : { expectedExecutionHostId: 'local' as const })
      }
    }
    case 'unresolved':
      return null
  }
}

export function requireMatchingFileExplorerOperationRoute(
  worktreeId: string | null | undefined,
  expectedOwner: FileExplorerOperationOwner | undefined
): FileExplorerOperationRoute {
  if (!expectedOwner || expectedOwner.kind === 'unresolved') {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const currentOwner = getFileExplorerOperationOwner(worktreeId)
  if (JSON.stringify(currentOwner) !== JSON.stringify(expectedOwner)) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const route = getFileExplorerOperationRoute(expectedOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  return route
}

export function captureFileExplorerOperationGuard(
  worktreeId: string | null | undefined,
  expectedOwner: FileExplorerOperationOwner | undefined
): FileExplorerOperationGuard {
  if (!worktreeId) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const route = requireMatchingFileExplorerOperationRoute(worktreeId, expectedOwner)
  const operationRoute = getFileExplorerGenerationRoute(expectedOwner)
  if (!operationRoute) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const generationGuard = captureWorktreeOperationGenerationGuard(
    useAppStore.getState,
    worktreeId,
    operationRoute,
    () => new Error(getFileExplorerOwnerUnresolvedMessage()),
    () => getFileExplorerGenerationRoute(getFileExplorerOperationOwner(worktreeId))
  )
  const expectedSshConnectionGeneration = getExpectedSshConnectionGeneration(
    useAppStore.getState(),
    operationRoute
  )
  const operationHost = parseExecutionHostId(operationRoute.executionHostId)
  if (!operationHost) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  if (operationHost?.kind === 'ssh' && expectedSshConnectionGeneration === undefined) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const guardedRoute: FileExplorerOperationRoute = {
    ...route,
    expectedExecutionHostId: operationHost.kind === 'ssh' ? operationHost.id : 'local',
    ...(operationHost?.kind === 'ssh' ? { expectedSshTargetId: operationHost.targetId } : {}),
    ...(expectedSshConnectionGeneration === undefined ? {} : { expectedSshConnectionGeneration })
  }
  return {
    route: guardedRoute,
    assertCurrent: () => {
      generationGuard.assertCurrent()
      if (
        getExpectedSshConnectionGeneration(useAppStore.getState(), operationRoute) !==
        expectedSshConnectionGeneration
      ) {
        throw new Error(getFileExplorerOwnerUnresolvedMessage())
      }
      return guardedRoute
    }
  }
}

function getExpectedSshConnectionGeneration(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  route: WorktreeOperationRoute
): number | undefined {
  const host = parseExecutionHostId(route.executionHostId)
  if (host?.kind !== 'ssh') {
    return undefined
  }
  return route.runtimeEnvironmentId
    ? state.sshStateByEnvironment
        .get(route.runtimeEnvironmentId)
        ?.connectionStates.get(host.targetId)?.connectionGeneration
    : state.sshConnectionStates.get(host.targetId)?.connectionGeneration
}

function getFileExplorerGenerationRoute(
  owner: FileExplorerOperationOwner | undefined
): WorktreeOperationRoute | null {
  switch (owner?.kind) {
    case 'local':
      return { executionHostId: 'local', runtimeEnvironmentId: null }
    case 'ssh':
      return {
        executionHostId: `ssh:${encodeURIComponent(owner.connectionId)}`,
        runtimeEnvironmentId: null
      }
    case 'runtime':
      return {
        executionHostId: owner.executionHostId,
        runtimeEnvironmentId: owner.environmentId
      }
    case 'unresolved':
    case undefined:
      return null
  }
}

export function getFileExplorerOwnerUnresolvedMessage(): string {
  return translate(
    'auto.components.right.sidebar.fileExplorerOperationOwner.unresolved',
    "Couldn't determine which host owns this workspace. Check the connection and try again."
  )
}

function operationOwnerFromHostId(
  hostId: ExecutionHostId,
  state: FileExplorerOwnerState,
  isWebClient: boolean
): FileExplorerOperationOwner {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return localOrConnectedRuntimeOwner(state, isWebClient)
    case 'ssh':
      return { kind: 'ssh', connectionId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', environmentId: parsed.environmentId, executionHostId: hostId }
    case undefined:
      return { kind: 'unresolved' }
  }
}

// Why: on a browser web client there is no local host, so a `local`-owned
// worktree can only be operated through the server the client is connected to.
// The connected server's runtime env is the client's activeRuntimeEnvironmentId
// (set to the connected environment id on web startup). Resolving to it lets
// file listing, deletion, and terminals work for local worktrees on a headless
// `orca serve`, and it is per-connection so different browsers/devices each use
// their own server. On desktop (isWebClient=false) behavior is unchanged.
function localOrConnectedRuntimeOwner(
  state: FileExplorerOwnerState,
  isWebClient: boolean
): FileExplorerOperationOwner {
  if (isWebClient) {
    const connectedEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
    if (connectedEnvironmentId) {
      return {
        kind: 'runtime',
        environmentId: connectedEnvironmentId,
        executionHostId: `runtime:${encodeURIComponent(connectedEnvironmentId)}`
      }
    }
  }
  return { kind: 'local' }
}
