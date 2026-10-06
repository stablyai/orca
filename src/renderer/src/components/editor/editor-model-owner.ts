import type { OpenFile } from '@/store/slices/editor'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'

export function getEditorModelOwnerKey(file: OpenFile, state: WorktreeOperationRouteState): string {
  const captured = file.operationProvenance?.generation.route
  const route =
    captured ??
    resolveWorktreeOperationRoute(
      state.activeWorktreeId === file.worktreeId ? { ...state, activeWorktreeId: null } : state,
      file.worktreeId
    )
  const environmentId = captured
    ? captured.runtimeEnvironmentId
    : file.runtimeEnvironmentId !== undefined
      ? file.runtimeEnvironmentId?.trim() || null
      : (route?.runtimeEnvironmentId ?? null)
  const hostId = captured
    ? captured.executionHostId
    : file.externalSshTargetId
      ? toSshExecutionHostId(file.externalSshTargetId)
      : route &&
          (file.runtimeEnvironmentId === undefined ||
            (file.runtimeEnvironmentId || null) === route.runtimeEnvironmentId)
        ? route.executionHostId
        : environmentId
          ? toRuntimeExecutionHostId(environmentId)
          : null
  if (hostId === 'local' && !environmentId) {
    return ''
  }
  // Unresolved owners must not borrow another host's retained text.
  return JSON.stringify(
    hostId ? [environmentId, hostId] : [environmentId, 'unresolved', file.worktreeId, file.id]
  )
}
