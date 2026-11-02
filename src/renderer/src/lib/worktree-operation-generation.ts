import { parseExecutionHostId } from '../../../shared/execution-host'
import { authorityKey, type HostAuthority } from '../../../shared/host-authority'
import {
  getEnvironmentSshStateGeneration,
  getEnvironmentSshTargetConnectionGeneration
} from '@/store/slices/runtime-environment-ssh'
import { getLocalSshTargetConnectionGeneration } from '@/store/slices/ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from './worktree-operation-route'

type OperationRouteState = Parameters<typeof resolveWorktreeOperationRoute>[0]

export type WorktreeOperationGenerationGuard = {
  assertCurrent: () => WorktreeOperationRoute
}

export type WorktreeOperationGenerationSnapshot = {
  route: WorktreeOperationRoute
  authority?: HostAuthority
  runtimeConnectionGeneration: number | null
  runtimePairingRevision: number | undefined
  runtimeSshGeneration: number | null
  nestedSshGeneration: number | null
  directSshGeneration: number | null
}

export function captureWorktreeOperationGenerationSnapshot(
  expectedRoute: WorktreeOperationRoute,
  authority?: HostAuthority
): WorktreeOperationGenerationSnapshot {
  const environmentId = expectedRoute.runtimeEnvironmentId
  const executionHost = parseExecutionHostId(authority?.at ?? expectedRoute.executionHostId)
  return {
    route: expectedRoute,
    ...(authority ? { authority: { endpoint: { ...authority.endpoint }, at: authority.at } } : {}),
    runtimeConnectionGeneration: environmentId
      ? getRuntimeEnvironmentConnectionGeneration(environmentId)
      : null,
    runtimePairingRevision: environmentId
      ? getRuntimeEnvironmentRevision(environmentId)
      : undefined,
    runtimeSshGeneration: environmentId ? getEnvironmentSshStateGeneration(environmentId) : null,
    nestedSshGeneration:
      environmentId && executionHost?.kind === 'ssh'
        ? getEnvironmentSshTargetConnectionGeneration(environmentId, executionHost.targetId)
        : null,
    directSshGeneration:
      !environmentId && executionHost?.kind === 'ssh'
        ? getLocalSshTargetConnectionGeneration(executionHost.targetId)
        : null
  }
}

export function assertWorktreeOperationGenerationSnapshotCurrent(
  getState: () => OperationRouteState,
  worktreeId: string,
  snapshot: WorktreeOperationGenerationSnapshot,
  createError: () => Error,
  resolveCurrentRoute?: () => WorktreeOperationRoute | null,
  resolveCurrentAuthority?: () => HostAuthority | undefined
): WorktreeOperationRoute {
  const environmentId = snapshot.route.runtimeEnvironmentId
  const executionHost = parseExecutionHostId(
    snapshot.authority?.at ?? snapshot.route.executionHostId
  )
  const currentRoute = resolveCurrentRoute
    ? resolveCurrentRoute()
    : resolveWorktreeOperationRoute(getState(), worktreeId)
  const currentAuthority = snapshot.authority ? resolveCurrentAuthority?.() : undefined
  if (
    JSON.stringify(currentRoute) !== JSON.stringify(snapshot.route) ||
    (snapshot.authority &&
      (!currentAuthority || authorityKey(currentAuthority) !== authorityKey(snapshot.authority))) ||
    (environmentId &&
      getRuntimeEnvironmentConnectionGeneration(environmentId) !==
        snapshot.runtimeConnectionGeneration) ||
    (environmentId &&
      getRuntimeEnvironmentRevision(environmentId) !== snapshot.runtimePairingRevision) ||
    (environmentId &&
      getEnvironmentSshStateGeneration(environmentId) !== snapshot.runtimeSshGeneration) ||
    (environmentId &&
      executionHost?.kind === 'ssh' &&
      getEnvironmentSshTargetConnectionGeneration(environmentId, executionHost.targetId) !==
        snapshot.nestedSshGeneration) ||
    (!environmentId &&
      executionHost?.kind === 'ssh' &&
      getLocalSshTargetConnectionGeneration(executionHost.targetId) !==
        snapshot.directSshGeneration)
  ) {
    throw createError()
  }
  return snapshot.route
}

export function captureWorktreeOperationGenerationGuard(
  getState: () => OperationRouteState,
  worktreeId: string,
  expectedRoute: WorktreeOperationRoute,
  createError: () => Error,
  resolveCurrentRoute?: () => WorktreeOperationRoute | null
): WorktreeOperationGenerationGuard {
  const snapshot = captureWorktreeOperationGenerationSnapshot(expectedRoute)

  return {
    assertCurrent: () =>
      assertWorktreeOperationGenerationSnapshotCurrent(
        getState,
        worktreeId,
        snapshot,
        createError,
        resolveCurrentRoute
      )
  }
}
