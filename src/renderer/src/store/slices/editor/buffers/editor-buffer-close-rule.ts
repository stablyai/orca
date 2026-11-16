import type { OpenFile } from '../types/open-file'
import { isLastEditorBufferView, type EditorBufferViewIndex } from './editor-buffer-views'

/** Prompt only on dirty record’s last open view; per-view batch processing prompts once. */
export function needsSavePromptOnClose(
  state: { openFiles: readonly OpenFile[] } & EditorBufferViewIndex,
  viewId: string
): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === viewId)
  return file?.isDirty === true && isLastEditorBufferView(state, viewId)
}
