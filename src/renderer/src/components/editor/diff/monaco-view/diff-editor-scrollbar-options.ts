import type { editor } from 'monaco-editor'

const DIFF_EDITOR_SCROLLBAR_SIZE = 20

// Use wider scrollbars so dense diff decorations leave a comfortable drag target.
export const diffEditorScrollbarOptions = {
  verticalScrollbarSize: DIFF_EDITOR_SCROLLBAR_SIZE,
  horizontalScrollbarSize: DIFF_EDITOR_SCROLLBAR_SIZE,
  verticalSliderSize: DIFF_EDITOR_SCROLLBAR_SIZE,
  horizontalSliderSize: DIFF_EDITOR_SCROLLBAR_SIZE
} satisfies editor.IEditorScrollbarOptions

export const combinedDiffSectionScrollbarOptions = {
  ...diffEditorScrollbarOptions,
  vertical: 'hidden',
  handleMouseWheel: false
} satisfies editor.IEditorScrollbarOptions
