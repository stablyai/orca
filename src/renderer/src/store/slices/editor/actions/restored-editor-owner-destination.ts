import type { AppState } from '../../../types'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'
import { buildOwnedEditorFileId } from '../file-ids/editor-file-ids'
import type { OpenFile } from '../types/open-file'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from '../types/restored-editor-owner'

export type RestoredEditorOwnerFail = {
  ok: false
  reason: Extract<RestoredEditorOwnerResult, { ok: false }>['reason']
  patch: Pick<AppState, 'openFiles'>
}

export type RestoredEditorOwnerReady = {
  ok: true
  source: OpenFile
  newFileId: string
  previewIdMigrations: Map<string, string>
  operationProvenance: RestoredEditorOwnerMigration['targetOperationProvenance']
}

export function resolveRestoredEditorOwnerDestination(
  s: AppState,
  args: RestoredEditorOwnerMigration
): RestoredEditorOwnerFail | RestoredEditorOwnerReady {
  const source = s.openFiles.find((file) => file.id === args.fileId)
  if (!source) {
    return { ok: false, reason: 'stale', patch: { openFiles: s.openFiles } }
  }

  try {
    const currentRoute = assertEditorFileOperationCurrent(
      s,
      args.targetWorktreeId,
      args.targetOperationProvenance
    )
    if (
      currentRoute.executionHostId !== args.targetExecutionHostId ||
      currentRoute.runtimeEnvironmentId !== args.targetRuntimeEnvironmentId
    ) {
      throw new Error('owner changed')
    }
  } catch {
    return {
      ok: false,
      reason: 'owner-changed',
      patch: {
        openFiles: s.openFiles.map((file) =>
          file.id === args.fileId ? { ...file, pendingOwnerMigration: undefined } : file
        )
      }
    }
  }
  const operationProvenance = args.targetOperationProvenance

  const destinationCollision = s.openFiles.some(
    (file) =>
      file.id !== source.id &&
      file.filePath === source.filePath &&
      file.worktreeId === args.targetWorktreeId &&
      (file.runtimeEnvironmentId?.trim() || null) === args.targetRuntimeEnvironmentId
  )
  const newFileId = buildOwnedEditorFileId(
    source.filePath,
    args.targetWorktreeId,
    args.targetRuntimeEnvironmentId
  )
  const dependentPreviews = s.openFiles.filter(
    (file) => file.markdownPreviewSourceFileId === source.id
  )
  const previewIdMigrations = new Map(
    dependentPreviews.map((preview) => [preview.id, `markdown-preview::${newFileId}`])
  )
  const destinationIds = new Set([newFileId, ...previewIdMigrations.values()])
  if (
    destinationCollision ||
    s.openFiles.some(
      (file) =>
        destinationIds.has(file.id) && file.id !== source.id && !previewIdMigrations.has(file.id)
    )
  ) {
    return {
      ok: false,
      reason: 'collision',
      patch: {
        openFiles: s.openFiles.map((file) =>
          file.id === args.fileId ? { ...file, pendingOwnerMigration: undefined } : file
        )
      }
    }
  }

  return { ok: true, source, newFileId, previewIdMigrations, operationProvenance }
}
