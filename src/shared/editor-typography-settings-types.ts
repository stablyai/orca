/** Opt-in code-editor typography; every unset key keeps the rendering Orca had before it existed. */
export type EditorTypographySettings = {
  /** Opt-in code-editor font; empty (the default) keeps following `terminalFontFamily`. */
  editorFontFamily?: string
  /** Opt-in code-editor base size in px; unset keeps following `terminalFontSize`. */
  editorFontSize?: number
  /** Opt-in code-editor weight (100–900); unset keeps Monaco's regular weight. */
  editorFontWeight?: number
  /** Opt-in line-height multiplier of the editor font size; unset keeps Monaco's automatic spacing. */
  editorLineHeight?: number
  /** Same semantics as `terminalLigatures`, judged against the editor font; unset is off. */
  editorLigatures?: 'auto' | 'on' | 'off'
  /** macOS-only glyph smoothing for terminals and code editors; unset keeps the app-wide grayscale. */
  codeFontSmoothing?: 'grayscale' | 'native'
}
