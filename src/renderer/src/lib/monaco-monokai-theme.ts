import type * as Monaco from 'monaco-editor'

// Why: Monaco has no built-in Monokai theme (only 'vs', 'vs-dark', 'hc-black',
// 'hc-light'). Colors mirror the well-known Monokai palette also used for
// Orca's terminal theme (see lib/terminal-themes/popular-dark-core.ts) so the
// editor and terminal read as one coherent dark theme when both are set to
// Monokai.
export const MONACO_MONOKAI_THEME_NAME = 'monokai'

const MONOKAI_BACKGROUND = '#272822'
const MONOKAI_FOREGROUND = '#f8f8f2'
const MONOKAI_COMMENT = '#75715e'
const MONOKAI_KEYWORD = '#f92672'
const MONOKAI_STRING = '#e6db74'
const MONOKAI_FUNCTION = '#a6e22e'
const MONOKAI_CONSTANT = '#ae81ff'
const MONOKAI_TYPE = '#66d9ef'
const MONOKAI_VARIABLE = '#fd971f'
const MONOKAI_SELECTION = '#49483e'
const MONOKAI_LINE_HIGHLIGHT = '#3e3d32'
const MONOKAI_CURSOR = '#f8f8f0'
const MONOKAI_GUTTER_FOREGROUND = '#90908a'

export const MONACO_MONOKAI_THEME_DATA: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: MONOKAI_COMMENT.slice(1), fontStyle: 'italic' },
    { token: 'keyword', foreground: MONOKAI_KEYWORD.slice(1) },
    { token: 'keyword.control', foreground: MONOKAI_KEYWORD.slice(1) },
    { token: 'string', foreground: MONOKAI_STRING.slice(1) },
    { token: 'string.escape', foreground: MONOKAI_CONSTANT.slice(1) },
    { token: 'number', foreground: MONOKAI_CONSTANT.slice(1) },
    { token: 'constant', foreground: MONOKAI_CONSTANT.slice(1) },
    { token: 'constant.language', foreground: MONOKAI_CONSTANT.slice(1) },
    { token: 'regexp', foreground: MONOKAI_STRING.slice(1) },
    { token: 'type', foreground: MONOKAI_TYPE.slice(1) },
    { token: 'type.identifier', foreground: MONOKAI_TYPE.slice(1) },
    { token: 'delimiter', foreground: MONOKAI_FOREGROUND.slice(1) },
    { token: 'tag', foreground: MONOKAI_KEYWORD.slice(1) },
    { token: 'attribute.name', foreground: MONOKAI_FUNCTION.slice(1) },
    { token: 'attribute.value', foreground: MONOKAI_STRING.slice(1) },
    { token: 'function', foreground: MONOKAI_FUNCTION.slice(1) },
    { token: 'variable', foreground: MONOKAI_VARIABLE.slice(1) },
    { token: 'variable.parameter', foreground: MONOKAI_VARIABLE.slice(1) },
    { token: 'identifier', foreground: MONOKAI_FOREGROUND.slice(1) },
    { token: 'class', foreground: MONOKAI_TYPE.slice(1) },
    { token: 'operator', foreground: MONOKAI_KEYWORD.slice(1) }
  ],
  colors: {
    'editor.background': MONOKAI_BACKGROUND,
    'editor.foreground': MONOKAI_FOREGROUND,
    'editorCursor.foreground': MONOKAI_CURSOR,
    'editor.lineHighlightBackground': MONOKAI_LINE_HIGHLIGHT,
    'editor.selectionBackground': MONOKAI_SELECTION,
    'editor.inactiveSelectionBackground': MONOKAI_SELECTION,
    'editorLineNumber.foreground': MONOKAI_GUTTER_FOREGROUND,
    'editorLineNumber.activeForeground': MONOKAI_FOREGROUND,
    'editorGutter.background': MONOKAI_BACKGROUND,
    'editorWhitespace.foreground': MONOKAI_SELECTION,
    'editorIndentGuide.background1': MONOKAI_SELECTION,
    'editorIndentGuide.activeBackground1': MONOKAI_COMMENT,
    'diffEditor.insertedTextBackground': '#a6e22e33',
    'diffEditor.removedTextBackground': '#f9267233'
  }
}

let registered = false

/** Idempotent: safe to call on every editor mount, only defines the theme once. */
export function registerMonacoMonokaiTheme(monacoInstance: typeof Monaco): void {
  if (registered) {
    return
  }
  monacoInstance.editor.defineTheme(MONACO_MONOKAI_THEME_NAME, MONACO_MONOKAI_THEME_DATA)
  registered = true
}
