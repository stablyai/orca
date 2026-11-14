import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { getSelectedFolderTwinHostId } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { HostAuthority } from '../../../../../../shared/host-authority'
import { translate } from '@/i18n/i18n'
import {
  resolveOwner,
  runtimeEnvironmentIdForWorkspaceOwner
} from '@/lib/workspace/ownership/resolve-owner'
import '@/lib/workspace/ownership/connection-context'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { FileExplorerOperationOwner } from '../tree/file-explorer-types'
import type { WorktreeOperationRoute } from '@/lib/workspace/ownership/worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from '@/lib/workspace/ownership/worktree-operation-generation'

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

/** Use strict read/write ownership; refuse ambiguous twins and ignore focus, resolving app-owned folders through repos. */
export function getFileExplorerOperationOwnerFromState(
  state: FileExplorerOwnerState,
  worktreeId: string | null | undefined,
  /** Names a twin's host when `state` omits the selection that would. */
  hostId?: ExecutionHostId
): FileExplorerOperationOwner {
  if (!worktreeId) {
    return { kind: 'local' }
  }
  const match = resolveOwner(state, { workspaceId: worktreeId, ...(hostId ? { hostId } : {}) })
  if (match.kind === 'ambiguous') {
    return { kind: 'unresolved' }
  }
  if (parseWorkspaceKey(worktreeId)?.type !== 'folder') {
    return match.kind === 'resolved'
      ? operationOwnerFromAuthority(match.owner)
      : { kind: 'unresolved' }
  }
  if (match.kind === 'resolved') {
    return operationOwnerFromAuthority(match.owner)
  }
  return thisAppFolderOwner(state, worktreeId)
}

/** The file list's owner: host-less for a git id, the selected copy for a folder twin. */
export function useFileListOperationOwner(worktreeId: string | null): FileExplorerOperationOwner {
  const state = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      repos: s.repos,
      worktreesByRepo: selectWorktreesByRepo(s),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(s),
      folderWorkspaces: selectFolderWorkspaces(s),
      projectGroups: s.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: s.restoredRuntimeHostIdByWorkspaceSessionKey
    }))
  )
  const hostId = useAppStore((s) => getSelectedFolderTwinHostId(s, worktreeId))
  return useMemo(
    () => getFileExplorerOperationOwnerFromState(state, worktreeId, hostId),
    [hostId, state, worktreeId]
  )
}

/** Unstamped folders inherit repo ownership; the restoring server wins until its folder catalog arrives. */
function thisAppFolderOwner(
  state: FileExplorerOwnerState,
  workspaceId: string
): FileExplorerOperationOwner {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  const environmentId = owner.kind === 'resolved' ? owner.environmentId?.trim() : null
  if (environmentId) {
    return {
      kind: 'runtime',
      environmentId,
      executionHostId: toRuntimeExecutionHostId(environmentId)
    }
  }
  const connectionId = getConnectionIdFromState(state, workspaceId)
  if (connectionId === undefined) {
    return { kind: 'unresolved' }
  }
  return connectionId ? { kind: 'ssh', connectionId } : { kind: 'local' }
}

/** Preserve endpoint and nested SSH target so writes reach the owning host. */
function operationOwnerFromAuthority({ endpoint, at }: HostAuthority): FileExplorerOperationOwner {
  if (endpoint.kind === 'environment') {
    return {
      kind: 'runtime',
      environmentId: endpoint.environmentId,
      executionHostId: at === 'local' ? toRuntimeExecutionHostId(endpoint.environmentId) : at
    }
  }
  const host = parseExecutionHostId(at)
  return host?.kind === 'ssh' ? { kind: 'ssh', connectionId: host.targetId } : { kind: 'local' }
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
