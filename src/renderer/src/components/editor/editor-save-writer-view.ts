import { editorSaveResourceKey } from '@/store/slices/editor/buffers/editor-buffer-identity'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  captureEditorFileOperationForOwner,
  acquireEditorFileOperation
} from '@/lib/editor-file-operation-owner'
import { editorTabFileAccess } from '@/lib/local-file-access'
import type { AppStoreApi } from './editor-save-queue'
import type { EditorSaveAcquisition } from './editor-save-slots'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { EditorSaveTrigger } from './editor-save-disk-precondition'
import { canAutoSaveOpenFile } from './editor-autosave'

export function sameEditorSaveResource(state: AppState, source: OpenFile, view: OpenFile): boolean {
  const key = editorSaveResourceKey(source, state)
  return key !== null && key === editorSaveResourceKey(view, state)
}

function hasCurrentProvenance(state: AppState, file: OpenFile): boolean {
  if (!file.operationProvenance) {
    return true
  }
  try {
    captureEditorFileOperationForOwner(state, file, file.operationProvenance)
    return true
  } catch {
    return false
  }
}

export function isEditorWritableView(view: OpenFile): boolean {
  return view.readOnly !== true && view.csvPreviewOnly !== true
}

export function firstEditorSaveWriter(
  state: AppState,
  viewIds: readonly string[],
  trigger: EditorSaveTrigger,
  views: readonly OpenFile[] = state.openFiles
): OpenFile | null {
  // CSV previews and read-only views cannot serve as record writers.
  const mayWrite = (view: OpenFile): boolean =>
    trigger === 'autosave' ? canAutoSaveOpenFile(view) : isEditorWritableView(view)
  for (const viewId of viewIds) {
    const view = views.find((openFile) => openFile.id === viewId)
    if (view && mayWrite(view) && hasCurrentProvenance(state, view)) {
      return view
    }
  }
  return null
}

/** Explicit saves retain the asking view; autosave/restart choose a writable view with current ownership. */
export function editorSaveWriterView(
  state: AppState,
  fileId: string,
  trigger: EditorSaveTrigger
): OpenFile | null {
  const asked = state.openFiles.find((openFile) => openFile.id === fileId) ?? null
  if (trigger === 'user' || trigger === 'convert' || trigger === 'overwrite') {
    return asked
  }
  const writer = firstEditorSaveWriter(state, editorBufferSiblingViewIds(state, fileId), trigger)
  // Why: restart keeps the asking view so its owner error explains the refusal.
  return writer ?? (trigger === 'autosave' ? null : asked)
}

/** After the asking view closes, save through a surviving view of its original record. */
export function liveEditorSaveWriter(
  state: AppState,
  viewId: string,
  recordViewIds: readonly string[],
  trigger: EditorSaveTrigger,
  source: OpenFile
): OpenFile | null {
  const entitled = state.openFiles.filter((file) => sameEditorSaveResource(state, source, file))
  if (trigger === 'autosave' || trigger === 'restart') {
    return firstEditorSaveWriter(state, [viewId, ...recordViewIds], trigger, entitled)
  }
  const asked = entitled.find((file) => file.id === viewId)
  return (
    (asked && isEditorWritableView(asked) ? asked : null) ??
    firstEditorSaveWriter(state, recordViewIds, trigger, entitled)
  )
}

/** The first open view of `viewIds`, writable first: only a writable view can mark the record clean. */
export function liveEditorRecordView(state: AppState, viewIds: readonly string[]): OpenFile | null {
  const open = viewIds.flatMap((id) => state.openFiles.find((file) => file.id === id) ?? [])
  return open.find(isEditorWritableView) ?? open[0] ?? null
}

export function captureEditorSave(
  store: AppStoreApi,
  file: OpenFile,
  trigger: EditorSaveTrigger
): EditorSaveAcquisition {
  try {
    if (file.csvPreviewOnly === true) {
      throw new Error('Large CSV previews are read-only.')
    }
    const writer = editorSaveWriterView(store.getState(), file.id, trigger) ?? file
    const operation = acquireEditorFileOperation(store.getState, writer)
    return { operation, access: editorTabFileAccess(store.getState(), operation.file) }
  } catch (error) {
    return { error }
  }
}
