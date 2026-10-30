import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { EditorSaveTrigger } from './editor-save-disk-precondition'
import { canAutoSaveOpenFile } from './editor-autosave'

function hasCurrentProvenance(state: AppState, file: OpenFile): boolean {
  if (!file.operationProvenance) {
    return true
  }
  try {
    assertEditorFileOperationCurrent(state, file.worktreeId, file.operationProvenance)
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
  trigger: EditorSaveTrigger
): OpenFile | null {
  // CSV previews and read-only views cannot serve as record writers.
  const mayWrite = (view: OpenFile): boolean =>
    trigger === 'autosave' ? canAutoSaveOpenFile(view) : isEditorWritableView(view)
  for (const viewId of viewIds) {
    const view = state.openFiles.find((openFile) => openFile.id === viewId)
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
  trigger: EditorSaveTrigger
): OpenFile | null {
  return (
    state.openFiles.find((openFile) => openFile.id === viewId) ??
    firstEditorSaveWriter(state, recordViewIds, trigger)
  )
}

/** The first open view of `viewIds`, writable first: only a writable view can mark the record clean. */
export function liveEditorRecordView(state: AppState, viewIds: readonly string[]): OpenFile | null {
  const open = viewIds.flatMap((id) => state.openFiles.find((file) => file.id === id) ?? [])
  return open.find(isEditorWritableView) ?? open[0] ?? null
}
