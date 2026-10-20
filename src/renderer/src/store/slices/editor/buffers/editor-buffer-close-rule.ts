import type { OpenFile } from '../types/open-file'
import { flushPendingEditorChange } from '@/components/editor/editor-pending-flush'
import {
  flushEditorBufferViews,
  type EditorFlushState
} from '@/components/editor/editor-buffer-flush'
import { editorBufferViewIds, type EditorBufferIndex } from './editor-buffer-record'

type EditorBufferViewState = {
  openFiles: readonly OpenFile[]
  editorBufferIndex?: EditorBufferIndex
}

const NONE_CLOSING: ReadonlySet<string> = new Set()

function canSave(file: OpenFile): boolean {
  return file.readOnly !== true && file.csvPreviewOnly !== true
}

/**
 * Whether a tab that stays open can still save `fileId`'s unsaved edits after it closes.
 * `closing` are tabs already queued to close, which can't keep the edits.
 */
export function hasOtherSavingEditorView(
  state: EditorBufferViewState,
  fileId: string,
  closing: ReadonlySet<string> = NONE_CLOSING
): boolean {
  const others = new Set(editorBufferViewIds(state, fileId).slice(1))
  return (
    others.size > 0 &&
    state.openFiles.some((file) => others.has(file.id) && !closing.has(file.id) && canSave(file))
  )
}

/**
 * Only the last tab that can save the file asks to save it; earlier closes keep the edits.
 * Why flush first: a delayed editor's text must be in the draft before deciding, or a tab whose
 * only siblings are read-only would close without a prompt.
 */
export function needsSavePromptOnClose(
  getState: () => EditorBufferViewState,
  fileId: string,
  closing: ReadonlySet<string> = NONE_CLOSING
): boolean {
  flushPendingEditorChange(fileId)
  const state = getState()
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  return (
    file?.isDirty === true && canSave(file) && !hasOtherSavingEditorView(state, fileId, closing)
  )
}

/**
 * Why: a delayed editor (rich markdown, notebook, CSV) may hold text not yet in the shared draft;
 * once its tab leaves the record, its late commit is rejected and a sibling keeps old text.
 */
export function flushSharedEditorViewsBeforeClose(
  getState: () => EditorFlushState,
  fileIds: Iterable<string>
): void {
  for (const fileId of fileIds) {
    if (editorBufferViewIds(getState(), fileId).length > 1) {
      flushEditorBufferViews(getState, fileId)
    }
  }
}
