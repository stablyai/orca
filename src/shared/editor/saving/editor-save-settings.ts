import type { EditorEndOfLine } from './editor-end-of-line'

export type EditorSaveSettings = {
  editorFormatOnSave?: boolean
  editorInsertFinalNewline?: boolean
  /** Line ending for files with no line breaks yet; absent means auto. */
  editorEndOfLine?: EditorEndOfLine
}
