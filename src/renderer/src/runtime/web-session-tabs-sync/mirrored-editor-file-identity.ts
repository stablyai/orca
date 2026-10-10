import type { Tab } from '../../../../shared/tab-types'
import type { OpenFile } from '../../store/slices/editor'
import {
  resolveEditorFileIdForOwner,
  runtimeOwnerKey
} from '../../store/slices/editor/file-ids/editor-file-ids'
import type { ReadyEditorSurface } from './state'

type FileIndex = {
  byId: Map<string, OpenFile>
  byOwner: Map<string, OpenFile>
  reservedSourceIds: Map<string, OpenFile>
}
const indexes = new WeakMap<readonly OpenFile[], FileIndex>()

function ownerKey(
  filePath: string,
  worktreeId: string,
  environmentId: string | null | undefined,
  mode: OpenFile['mode']
): string {
  return JSON.stringify([worktreeId, runtimeOwnerKey(environmentId), mode ?? 'edit', filePath])
}

function fileIndex(files: readonly OpenFile[]): FileIndex {
  const cached = indexes.get(files)
  if (cached) {
    return cached
  }
  const index: FileIndex = { byId: new Map(), byOwner: new Map(), reservedSourceIds: new Map() }
  for (const file of files) {
    if (!index.byId.has(file.id)) {
      index.byId.set(file.id, file)
    }
    const key = ownerKey(file.filePath, file.worktreeId, file.runtimeEnvironmentId, file.mode)
    if (!index.byOwner.has(key)) {
      index.byOwner.set(key, file)
    }
    if (
      file.markdownPreviewSourceFileId &&
      !index.reservedSourceIds.has(file.markdownPreviewSourceFileId)
    ) {
      index.reservedSourceIds.set(file.markdownPreviewSourceFileId, file)
    }
  }
  indexes.set(files, index)
  return index
}

export function createMirroredEditorFileResolver(
  files: readonly OpenFile[],
  worktreeId: string,
  environmentId: string
) {
  const index = fileIndex(files)
  const retainedFiles = new Map<string, OpenFile>()
  const ownedFile = (filePath: string, mode: OpenFile['mode']) =>
    index.byOwner.get(ownerKey(filePath, worktreeId, environmentId, mode))
  const editFileId = (filePath: string): string => {
    const existing = ownedFile(filePath, 'edit')
    if (existing) {
      return existing.id
    }
    const previewSourceId = ownedFile(filePath, 'markdown-preview')?.markdownPreviewSourceFileId
    if (previewSourceId) {
      return previewSourceId
    }
    const reserved = index.byId.get(filePath) ?? index.reservedSourceIds.get(filePath)
    return resolveEditorFileIdForOwner(
      { openFiles: reserved ? [reserved] : [] },
      filePath,
      worktreeId,
      environmentId,
      ['edit']
    )
  }
  return (tab: ReadyEditorSurface, existingTab: Tab | null) => {
    const mode = tab.type === 'markdown' ? tab.mode : 'edit'
    const key = ownerKey(tab.filePath, worktreeId, environmentId, mode)
    const retained = existingTab ? index.byId.get(existingTab.entityId) : undefined
    // Retained relay tabs must cross the save-quiesce fence before changing file ownership;
    // live ones carry route provenance and may hold an unsaved draft keyed by their current ID.
    const preservesOwner =
      retained &&
      existingTab?.id === tab.id &&
      retained.worktreeId === worktreeId &&
      retained.filePath === tab.filePath &&
      (retained.mode ?? 'edit') === mode &&
      !retained.runtimeEnvironmentId?.trim()
    if (preservesOwner) {
      retainedFiles.set(key, retained)
    }
    const pendingFile = retainedFiles.get(key)
    if (pendingFile) {
      return {
        fileId: pendingFile.id,
        existingFile: pendingFile,
        sourceFileId: pendingFile.markdownPreviewSourceFileId,
        preservesOwner: true
      }
    }
    const sourceFileId =
      mode === 'markdown-preview' && tab.type === 'markdown'
        ? editFileId(tab.sourceFilePath)
        : undefined
    const existingFile = ownedFile(tab.filePath, mode)
    const fileId =
      existingFile?.id ??
      (sourceFileId ? `markdown-preview::${sourceFileId}` : editFileId(tab.filePath))
    return {
      fileId,
      sourceFileId,
      preservesOwner: false,
      existingFile
    }
  }
}
