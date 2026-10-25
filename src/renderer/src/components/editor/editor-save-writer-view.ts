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

/** The first open view of `viewIds` a save of `trigger` may write through, on a current owner. */
export function firstEditorSaveWriter(
  state: AppState,
  viewIds: readonly string[],
  trigger: EditorSaveTrigger
): OpenFile | null {
  // Why: the record's first view may be a CSV preview or read-only; writing through it throws.
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

/**
 * The view a save writes through. An explicit save uses the view that asked; autosave and restart
 * use the first writable view whose owner is still current (one opened before a reconnect isn't).
 */
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

/**
 * `viewId` while it is open, else the writer among the views its record had: a save outlives the
 * tab that asked, but the record's other views still hold its text.
 */
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
