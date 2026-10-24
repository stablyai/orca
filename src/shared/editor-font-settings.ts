export type EditorFontSettings = {
  /** Opt-in code-editor font; empty (the default) keeps following `terminalFontFamily`. */
  editorFontFamily?: string
  /** Opt-in code-editor font size in px; unset (the default) keeps following `terminalFontSize`. */
  editorFontSize?: number
}
