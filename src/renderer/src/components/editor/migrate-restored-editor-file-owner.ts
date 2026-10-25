import { useAppStore } from '@/store'
import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  type EditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import { requestEditorSaveQuiesce } from './editor-autosave'
import type { RestoredEditorOwnerResult } from '@/store/slices/editor'
import { contentRekeyOutcome } from '@/runtime/layout-owner-content-rekeys'
import { afterPendingEntityTabs } from '@/runtime/layout-owner-pending-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export type RestoredEditorOwnerMigrationResult = RestoredEditorOwnerResult

export async function migrateRestoredEditorFileOwner(
  fileId: string,
  route: RuntimeWorkspaceFileRoute,
  runtimeEnvironmentId: string | null
): Promise<RestoredEditorOwnerMigrationResult> {
  const state = useAppStore.getState()
  const source = state.openFiles.find((file) => file.id === fileId)
  const initialRoute = source
    ? findWorkspaceFileRoute(state, route.executionHostId, source.filePath)
    : null
  if (!source || !routesMatch(initialRoute, route)) {
    return { ok: false, reason: 'stale' }
  }
  let targetOperationProvenance: EditorFileOperationProvenance
  try {
    targetOperationProvenance = captureEditorFileOperationProvenance(
      state,
      route.worktreeId,
      runtimeEnvironmentId,
      true
    )
  } catch {
    return { ok: false, reason: 'owner-changed' }
  }
  if (!state.setRestoredEditorOwnerMigrationPending(fileId, true)) {
    return { ok: false, reason: 'stale' }
  }

  try {
    await requestEditorSaveQuiesce({ fileId })
  } catch (error) {
    useAppStore.getState().setRestoredEditorOwnerMigrationPending(fileId, false)
    throw error
  }
  // Switch point: main moves only the tabs it drew; one it has yet to draw would keep the old id.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await pendingTabsOfFileAnswered(source.worktreeId, fileId)
  }
  const currentState = useAppStore.getState()
  const currentSource = currentState.openFiles.find((file) => file.id === fileId)
  const currentRoute = currentSource
    ? findWorkspaceFileRoute(currentState, route.executionHostId, currentSource.filePath)
    : null
  try {
    if (
      currentSource?.filePath !== source.filePath ||
      !routesMatch(currentRoute, route) ||
      assertEditorFileOperationCurrent(currentState, route.worktreeId, targetOperationProvenance)
        .runtimeEnvironmentId !== runtimeEnvironmentId
    ) {
      throw new Error('stale route')
    }
  } catch {
    currentState.setRestoredEditorOwnerMigrationPending(fileId, false)
    return { ok: false, reason: 'owner-changed' }
  }
  const result = currentState.reparentRestoredEditorFileOwner({
    fileId,
    targetWorktreeId: route.worktreeId,
    targetRelativePath: route.relativePath,
    targetExecutionHostId: route.executionHostId,
    targetRuntimeEnvironmentId: runtimeEnvironmentId,
    targetOperationProvenance
  })
  // Switch point: the move is main's; its frame moves the file, or main refused it.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && result.ok && !(await contentRekeyOutcome([result.fileId]))) {
    return { ok: false, reason: 'owner-changed' }
  }
  return result
}

/** Resolves once main answered every open or close in flight for the file's tabs and its previews'. */
function pendingTabsOfFileAnswered(worktreeId: string, fileId: string): Promise<void> {
  const entityIds = [
    fileId,
    ...useAppStore
      .getState()
      .openFiles.filter((file) => file.markdownPreviewSourceFileId === fileId)
      .map((file) => file.id)
  ]
  return Promise.all(
    entityIds.map(
      (entityId) =>
        new Promise<void>((resolve) => afterPendingEntityTabs(worktreeId, entityId, resolve))
    )
  ).then(() => {})
}

function routesMatch(
  current: RuntimeWorkspaceFileRoute | null,
  expected: RuntimeWorkspaceFileRoute
): boolean {
  return (
    current?.worktreeId === expected.worktreeId &&
    current.relativePath === expected.relativePath &&
    current.executionHostId === expected.executionHostId
  )
}
