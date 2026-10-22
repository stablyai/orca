import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { EditorSaveTrigger } from './editor-save-disk-precondition'

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
  if (trigger === 'user' || trigger === 'overwrite') {
    return asked
  }
  for (const viewId of editorBufferSiblingViewIds(state, fileId)) {
    const view = state.openFiles.find((openFile) => openFile.id === viewId)
    if (view && view.readOnly !== true && hasCurrentProvenance(state, view)) {
      return view
    }
  }
  // Why: restart keeps the asking view so its owner error explains the refusal.
  return trigger === 'autosave' ? null : asked
}
