import type { OpenFile } from '../types/open-file'
import { isLastEditorBufferView, type EditorBufferViewIndex } from './editor-buffer-views'

/**
 * Whether closing `viewId` now must ask to save: its record is dirty and it is the record's last
 * open view. Batches ask per view as they process it, so the record's last view prompts once.
 */
export function needsSavePromptOnClose(
  state: { openFiles: readonly OpenFile[] } & EditorBufferViewIndex,
  viewId: string
): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === viewId)
  return file?.isDirty === true && isLastEditorBufferView(state, viewId)
}
