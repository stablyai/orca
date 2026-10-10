import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'

const ownerUnresolved = (): Error => new Error(getFileExplorerOwnerUnresolvedMessage())

export type FileExplorerOperationRoute = {
  target: RuntimeClientTarget
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
> &
  Partial<Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>>

export function getFileExplorerOperationOwnerFromState(
  state: FileExplorerOwnerState,
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  const floatingRoute = worktreeId ? getFloatingWorkspaceOperationRoute(worktreeId) : null
  if (floatingRoute?.executionHostId) {
    return operationOwnerFromHostId(floatingRoute.executionHostId)
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
          route.executionHostId ?? toRuntimeExecutionHostId(route.runtimeEnvironmentId)
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
  // Why: inferred SSH ownership outranks a projected runtime owner, but an explicit
  // workspace runtime still owns its files.
  const runtimeEnvironmentId =
    connectionId && explicitRuntimeEnvironmentId === null
      ? null
      : getRuntimeEnvironmentIdForWorktree(state, worktreeId)?.trim()
  if (runtimeEnvironmentId) {
    return {
      kind: 'runtime',
      environmentId: runtimeEnvironmentId,
      executionHostId: toRuntimeExecutionHostId(runtimeEnvironmentId)
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
        target: { kind: 'local' },
        expectedExecutionHostId: 'local'
      }
    case 'ssh':
      return {
        target: { kind: 'local' },
        connectionId: owner.connectionId,
        expectedExecutionHostId: toSshExecutionHostId(owner.connectionId)
      }
    case 'runtime': {
      const host = parseExecutionHostId(owner.executionHostId)
      return {
        target: { kind: 'environment', environmentId: owner.environmentId },
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
    throw ownerUnresolved()
  }
  const currentOwner = getFileExplorerOperationOwner(worktreeId)
  if (JSON.stringify(currentOwner) !== JSON.stringify(expectedOwner)) {
    throw ownerUnresolved()
  }
  const route = getFileExplorerOperationRoute(expectedOwner)
  if (!route) {
    throw ownerUnresolved()
  }
  return route
}

export function captureFileExplorerOperationGuard(
  worktreeId: string | null | undefined,
  expectedOwner: FileExplorerOperationOwner | undefined
): FileExplorerOperationGuard {
  if (!worktreeId) {
    throw ownerUnresolved()
  }
  const route = requireMatchingFileExplorerOperationRoute(worktreeId, expectedOwner)
  const operationRoute = getFileExplorerGenerationRoute(expectedOwner)
  if (!operationRoute) {
    throw ownerUnresolved()
  }
  const generationGuard = captureWorktreeOperationGenerationGuard(
    useAppStore.getState,
    worktreeId,
    operationRoute,
    ownerUnresolved,
    () => getFileExplorerGenerationRoute(getFileExplorerOperationOwner(worktreeId))
  )
  const expectedSshConnectionGeneration = getExpectedSshConnectionGeneration(
    useAppStore.getState(),
    operationRoute
  )
  const operationHost = parseExecutionHostId(operationRoute.executionHostId)
  if (!operationHost) {
    throw ownerUnresolved()
  }
  if (operationHost.kind === 'ssh' && expectedSshConnectionGeneration === undefined) {
    throw ownerUnresolved()
  }
  const guardedRoute: FileExplorerOperationRoute = {
    ...route,
    expectedExecutionHostId: operationHost.kind === 'ssh' ? operationHost.id : 'local',
    ...(operationHost.kind === 'ssh' ? { expectedSshTargetId: operationHost.targetId } : {}),
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
        throw ownerUnresolved()
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
        executionHostId: toSshExecutionHostId(owner.connectionId),
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

export function getFileExplorerOperationExecutionHostId(
  owner: FileExplorerOperationOwner | undefined
): ExecutionHostId | null {
  return getFileExplorerGenerationRoute(owner)?.executionHostId ?? null
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
