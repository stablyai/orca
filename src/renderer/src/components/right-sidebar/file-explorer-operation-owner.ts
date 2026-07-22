import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
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
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
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
      return operationOwnerFromHostId(route.executionHostId)
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
  return connectionId ? { kind: 'ssh', connectionId } : { kind: 'local' }
}

export function getFileExplorerOperationOwner(
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  return getFileExplorerOperationOwnerFromState(useAppStore.getState(), worktreeId)
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

export function requireFileExplorerOperationRoute(
  worktreeId: string | null | undefined
): FileExplorerOperationRoute {
  const route = getFileExplorerOperationRoute(getFileExplorerOperationOwner(worktreeId))
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  return route
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

function operationOwnerFromHostId(hostId: ExecutionHostId): FileExplorerOperationOwner {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return { kind: 'local' }
    case 'ssh':
      return { kind: 'ssh', connectionId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', environmentId: parsed.environmentId, executionHostId: hostId }
    case undefined:
      return { kind: 'unresolved' }
  }
}
