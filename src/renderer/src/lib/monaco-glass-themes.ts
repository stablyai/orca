import type * as monaco from 'monaco-editor'

/**
 * Glass Light Monaco theme. Background is transparent so the underlying
 * CSS surface (which sits at --editor-surface ~85% opacity over the macOS
 * desktop vibrancy layer) shows through. Syntax colors are tuned for
 * legibility on a warm cream backdrop.
 */
export const ORCA_GLASS_LIGHT_THEME_NAME = 'orca-glass-light'
export const orcaGlassLightTheme: monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a5430', fontStyle: 'italic' },
    { token: 'string', foreground: '8a5a00' },
    { token: 'keyword', foreground: '8b1a8b' },
    { token: 'number', foreground: 'aa3300' },
    { token: 'type', foreground: '176c45' },
    { token: 'function', foreground: '4a3aab' }
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#281910',
    'editorLineNumber.foreground': '#28191055',
    'editorLineNumber.activeForeground': '#28191099',
    'editor.lineHighlightBackground': '#28191010',
    'editorIndentGuide.background': '#28191015',
    'editorIndentGuide.activeBackground': '#28191033',
    'editor.selectionBackground': '#28191033',
    'editor.inactiveSelectionBackground': '#28191020'
  }
}

/**
 * Glass Dark Monaco theme. Same approach — transparent background, syntax
 * colors tuned for a cool midnight blue backdrop.
 */
export const ORCA_GLASS_DARK_THEME_NAME = 'orca-glass-dark'
export const orcaGlassDarkTheme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: 'a0b4dc', fontStyle: 'italic' },
    { token: 'string', foreground: 'ffc97a' },
    { token: 'keyword', foreground: 'd97aff' },
    { token: 'number', foreground: 'ff9b78' },
    { token: 'type', foreground: '6ee7b7' },
    { token: 'function', foreground: '8fb3ff' }
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#dce6fa',
    'editorLineNumber.foreground': '#dce6fa55',
    'editorLineNumber.activeForeground': '#dce6fa99',
    'editor.lineHighlightBackground': '#dce6fa12',
    'editorIndentGuide.background': '#dce6fa18',
    'editorIndentGuide.activeBackground': '#dce6fa33',
    'editor.selectionBackground': '#5a78ff55',
    'editor.inactiveSelectionBackground': '#5a78ff33'
  }
}
