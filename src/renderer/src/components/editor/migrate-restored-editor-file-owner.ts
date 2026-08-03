import { useAppStore } from '@/store'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { requestEditorSaveQuiesce } from './editor-autosave'

export type RestoredEditorOwnerMigrationResult =
  | { ok: true; fileId: string }
  | { ok: false; reason: 'collision' | 'owner-changed' | 'stale' }

export async function migrateRestoredEditorFileOwner(
  fileId: string,
  route: RuntimeWorkspaceFileRoute,
  runtimeEnvironmentId: string | null
): Promise<RestoredEditorOwnerMigrationResult> {
  const state = useAppStore.getState()
  if (!state.setRestoredEditorOwnerMigrationPending(fileId, true)) {
    return { ok: false, reason: 'stale' }
  }

  await requestEditorSaveQuiesce({ fileId })
  return useAppStore.getState().reparentRestoredEditorFileOwner({
    fileId,
    targetWorktreeId: route.worktreeId,
    targetRelativePath: route.relativePath,
    targetExecutionHostId: route.executionHostId,
    targetRuntimeEnvironmentId: runtimeEnvironmentId
  })
}
