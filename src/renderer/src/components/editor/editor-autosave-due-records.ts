import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { canAutoSaveOpenFile, isAutosaveSuspendedForFile } from './editor-autosave'

export type EditorAutoSaveDue = { file: OpenFile; draft: string }

/** Choose the first autosave-capable view per record; read-only/preview siblings must not cancel that record’s timer. */
export function editorAutoSaveDueRecords(
  state: AppState,
  isHeld: (state: AppState, file: OpenFile) => boolean
): Map<string, EditorAutoSaveDue> {
  const due = new Map<string, EditorAutoSaveDue>()
  if (!state.settings?.editorAutoSave) {
    return due
  }
  const decided = new Set<string>()
  for (const file of state.openFiles) {
    const key = editorBufferIdOfView(state, file.id)
    if (decided.has(key) || !canAutoSaveOpenFile(file)) {
      continue
    }
    decided.add(key)
    const draft = state.editorDrafts[file.id]
    if (
      file.isDirty &&
      draft !== undefined &&
      // Why: suspension holds until the user picks a side via the banner (or saves manually).
      !isAutosaveSuspendedForFile(file) &&
      !isHeld(state, file)
    ) {
      due.set(key, { file, draft })
    }
  }
  return due
}
