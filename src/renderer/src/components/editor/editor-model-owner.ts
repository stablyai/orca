import type { OpenFile } from '@/store/slices/editor'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveWorktreeOperationRoute } from '@/lib/worktree-operation-route'
import {
  isDetachedEditorBufferId,
  type EditorBufferViewIndex
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'

export type EditorModelOwner = { environmentId: string | null; hostId: string | null }

export function resolveEditorModelOwner(
  file: Pick<
    OpenFile,
    'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
  >,
  state: WorktreeOperationRouteState
): EditorModelOwner {
  const captured = file.operationProvenance?.generation.route
  const route =
    captured ??
    // Use focus-independent write ownership so retained text stays keyed to the file’s actual host.
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
  return { environmentId, hostId }
}

/** The owner key of a resolved owner; null while its host is unknown. */
export function resolvedEditorModelOwnerKey({
  environmentId,
  hostId
}: EditorModelOwner): string | null {
  if (!hostId) {
    return null
  }
  return hostId === 'local' && !environmentId ? '' : JSON.stringify([environmentId, hostId])
}

export function getEditorModelOwnerKey(
  file: OpenFile,
  state: WorktreeOperationRouteState & Partial<EditorBufferViewIndex>
): string {
  const owner = resolveEditorModelOwner(file, state)
  // Unresolved owners must not borrow another host's retained text.
  const ownerKey =
    resolvedEditorModelOwnerKey(owner) ??
    JSON.stringify([owner.environmentId, 'unresolved', file.worktreeId, file.id])
  const recordId = state.editorBufferIdOf?.[file.id]
  // Detached records need separate models from their file’s other record; retain host ownership to isolate identical record IDs across hosts.
  return recordId !== undefined && isDetachedEditorBufferId(recordId)
    ? JSON.stringify(['detached', recordId, ownerKey])
    : ownerKey
}
