import type { editor as MonacoEditorNS } from 'monaco-editor'

/**
 * Minimal palette description shared by editor themes — the same ANSI-style
 * roles used by terminal themes (lib/terminal-themes), so editor palettes can
 * be derived from (or kept visually consistent with) their terminal
 * counterparts.
 */
export type EditorThemePalette = {
  background: string
  foreground: string
  comment: string
  keyword: string
  string: string
  function: string
  constant: string
  type: string
  variable: string
  selection: string
  lineHighlight: string
  cursor: string
  gutterForeground: string
  /** 'dark' picks the 'vs-dark' Monaco base (default token colors, borders);
   *  'light' picks 'vs'. */
  base: 'dark' | 'light'
}

function bare(hex: string): string {
  return hex.startsWith('#') ? hex.slice(1) : hex
}

/** Builds a Monaco `IStandaloneThemeData` from a minimal named-role palette,
 *  so every editor theme gets the same consistent token → color mapping
 *  without hand-writing a full TextMate rule set per theme. */
export function buildMonacoThemeFromPalette(
  palette: EditorThemePalette
): MonacoEditorNS.IStandaloneThemeData {
  const {
    background,
    foreground,
    comment,
    keyword,
    string,
    function: fn,
    constant,
    type,
    variable,
    selection,
    lineHighlight,
    cursor,
    gutterForeground,
    base
  } = palette

  return {
    base: base === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(keyword) },
      { token: 'keyword.control', foreground: bare(keyword) },
      { token: 'string', foreground: bare(string) },
      { token: 'string.escape', foreground: bare(constant) },
      { token: 'number', foreground: bare(constant) },
      { token: 'constant', foreground: bare(constant) },
      { token: 'constant.language', foreground: bare(constant) },
      { token: 'regexp', foreground: bare(string) },
      { token: 'type', foreground: bare(type) },
      { token: 'type.identifier', foreground: bare(type) },
      { token: 'delimiter', foreground: bare(foreground) },
      { token: 'tag', foreground: bare(keyword) },
      { token: 'attribute.name', foreground: bare(fn) },
      { token: 'attribute.value', foreground: bare(string) },
      { token: 'function', foreground: bare(fn) },
      { token: 'support.function', foreground: bare(fn) },
      { token: 'variable', foreground: bare(variable) },
      { token: 'variable.parameter', foreground: bare(variable) },
      { token: 'identifier', foreground: bare(foreground) },
      { token: 'class', foreground: bare(type) },
      { token: 'operator', foreground: bare(keyword) }
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorCursor.foreground': cursor,
      'editor.lineHighlightBackground': lineHighlight,
      'editor.selectionBackground': selection,
      'editor.inactiveSelectionBackground': selection,
      'editorLineNumber.foreground': gutterForeground,
      'editorLineNumber.activeForeground': foreground,
      'editorGutter.background': background,
      'editorWhitespace.foreground': selection,
      'editorIndentGuide.background1': selection,
      'editorIndentGuide.activeBackground1': comment
    }
  }
}
