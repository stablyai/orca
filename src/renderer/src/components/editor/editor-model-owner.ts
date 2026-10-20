import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'

export type EditorModelOwner = { environmentId: string | null; hostId: string | null }

export function resolveEditorModelOwner(
  file: OpenFile,
  state: WorktreeOperationRouteState
): EditorModelOwner {
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
  return { environmentId, hostId }
}

export function editorModelOwnerKeyFor(file: OpenFile, owner: EditorModelOwner): string {
  if (owner.hostId === 'local' && !owner.environmentId) {
    return ''
  }
  // Unresolved owners must not borrow another host's retained text.
  return JSON.stringify(
    owner.hostId
      ? [owner.environmentId, owner.hostId]
      : [owner.environmentId, 'unresolved', file.worktreeId, file.id]
  )
}

export function getEditorModelOwnerKey(file: OpenFile, state: WorktreeOperationRouteState): string {
  return editorModelOwnerKeyFor(file, resolveEditorModelOwner(file, state))
}

/** Store fields an unpinned tab's owner is resolved from. */
const EDITOR_MODEL_OWNER_INPUTS = [
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds',
  'runtimeEnvironments',
  'settings',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId'
] as const satisfies readonly (keyof AppState)[]

type EditorModelOwnerInputs = Partial<Record<(typeof EDITOR_MODEL_OWNER_INPUTS)[number], unknown>>

/** Whether `next` (a full state or a partial write) changes any owner input of `previous`. */
export function editorModelOwnerInputsChanged(
  previous: EditorModelOwnerInputs,
  next: EditorModelOwnerInputs
): boolean {
  return EDITOR_MODEL_OWNER_INPUTS.some((key) => key in next && next[key] !== previous[key])
}
