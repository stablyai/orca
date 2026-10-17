/** Code-editor (Monaco file tab) preferences, part of `GlobalSettings`. */
export type FileEditorSettings = {
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  editorMinimapEnabled: boolean
  /** Current-line git blame annotation. Absent on older profiles; treated as on. */
  editorGitLineBlameEnabled?: boolean
  /** Opt-in code-editor font; empty (the default) keeps following `terminalFontFamily`. */
  editorFontFamily?: string
  /** Defaults on for profiles saved before file-editor wrapping became configurable. */
  editorWordWrap?: boolean
}
