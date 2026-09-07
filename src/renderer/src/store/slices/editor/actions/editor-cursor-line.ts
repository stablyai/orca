import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'

export function createEditorCursorLine(
  set: EditorSet,
  _get: EditorGet
): Pick<EditorSlice, 'editorCursorLine' | 'setEditorCursorLine'> {
  return {
    editorCursorLine: {},
    setEditorCursorLine: (fileId, line) =>
      set((s) => ({
        editorCursorLine: { ...s.editorCursorLine, [fileId]: line }
      }))
  }
}
