import type { editor } from 'monaco-editor'

const DIFF_EDITOR_SCROLLBAR_SIZE = 20

// Why: diff panes are dense review surfaces; Monaco's default scrollbar is
// too narrow to grab comfortably beside line decorations and change gutters.
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
