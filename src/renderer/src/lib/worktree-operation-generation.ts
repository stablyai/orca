import { parseExecutionHostId } from '../../../shared/execution-host'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getEnvironmentSshTargetConnectionGeneration } from '@/store/slices/runtime-environment-ssh'
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
  runtimeConnectionGeneration: number | null
  runtimePairingRevision: number | undefined
  runtimeSshGeneration: number | null
  nestedSshGeneration: number | null
  directSshGeneration: number | null
}

export function captureWorktreeOperationGenerationSnapshot(
  expectedRoute: WorktreeOperationRoute
): WorktreeOperationGenerationSnapshot {
  const environmentId = expectedRoute.runtimeEnvironmentId
  const executionHost = parseExecutionHostId(expectedRoute.executionHostId)
  return {
    route: expectedRoute,
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
  resolveCurrentRoute?: () => WorktreeOperationRoute | null
): WorktreeOperationRoute {
  const environmentId = snapshot.route.runtimeEnvironmentId
  const executionHost = parseExecutionHostId(snapshot.route.executionHostId)
  const currentRoute = resolveCurrentRoute
    ? resolveCurrentRoute()
    : resolveWorktreeOperationRoute(getState(), worktreeId)
  if (
    JSON.stringify(currentRoute) !== JSON.stringify(snapshot.route) ||
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
