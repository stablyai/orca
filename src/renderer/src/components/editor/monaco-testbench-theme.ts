import type Monaco from 'monaco-editor'

/**
 * Test Bench Monaco themes.
 *
 * Why: stock `vs-dark`/`vs` ship a `#1e1e1e`/white canvas, blue selection and
 * default syntax hues that clash with the app's slate/putty surfaces and the
 * four-trace channel palette. These themes bind Monaco to the same design
 * tokens as the rest of the shell:
 *   - canvas = --editor-surface (slate #171B23 / putty #FBFAF7)
 *   - selection + cursor = Ch2 trace cyan (matches focus rings everywhere)
 *   - syntax rides the channel family: keywords Ch3 magenta, strings Ch4
 *     green, functions Ch2 cyan, numbers Ch1 amber, types violet.
 */

export const MONACO_THEME_DARK = 'mcode-testbench-dark'
export const MONACO_THEME_LIGHT = 'mcode-testbench-light'

const DARK_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6B7686', fontStyle: 'italic' },
  { token: 'string', foreground: '7DDFA3' },
  { token: 'string.escape', foreground: 'A8EBC2' },
  { token: 'keyword', foreground: 'E06CA8' },
  { token: 'keyword.json', foreground: 'E06CA8' },
  { token: 'number', foreground: 'E3B341' },
  { token: 'constant', foreground: 'E3B341' },
  { token: 'type', foreground: '9E86FF' },
  { token: 'type.identifier', foreground: '9E86FF' },
  { token: 'function', foreground: '53C6D8' },
  { token: 'method', foreground: '53C6D8' },
  { token: 'tag', foreground: 'E06CA8' },
  { token: 'attribute.name', foreground: 'E3B341' },
  { token: 'attribute.value', foreground: '7DDFA3' },
  { token: 'variable', foreground: 'E9EDF2' },
  { token: 'variable.predefined', foreground: '9E86FF' },
  { token: 'operator', foreground: '9BA5B4' },
  { token: 'delimiter', foreground: '9BA5B4' },
  { token: 'namespace', foreground: '53C6D8' },
  { token: 'key', foreground: '9BA5B4' }
]

const LIGHT_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '8A919E', fontStyle: 'italic' },
  { token: 'string', foreground: '1A7F42' },
  { token: 'string.escape', foreground: '0F5C2E' },
  { token: 'keyword', foreground: 'C2317F' },
  { token: 'number', foreground: '8A6A00' },
  { token: 'constant', foreground: '8A6A00' },
  { token: 'type', foreground: '664DC0' },
  { token: 'type.identifier', foreground: '664DC0' },
  { token: 'function', foreground: '0E7C90' },
  { token: 'method', foreground: '0E7C90' },
  { token: 'tag', foreground: 'C2317F' },
  { token: 'attribute.name', foreground: '8A6A00' },
  { token: 'attribute.value', foreground: '1A7F42' },
  { token: 'variable', foreground: '191C21' },
  { token: 'variable.predefined', foreground: '664DC0' },
  { token: 'operator', foreground: '5B6270' },
  { token: 'delimiter', foreground: '5B6270' },
  { token: 'namespace', foreground: '0E7C90' },
  { token: 'key', foreground: '5B6270' }
]

/** Idempotent: safe to call from every editor's beforeMount. */
export function defineTestBenchThemes(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(MONACO_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: DARK_RULES,
    colors: {
      'editor.background': '#171B23',
      'editor.foreground': '#E9EDF2',
      'editorGutter.background': '#171B23',
      'editorLineNumber.foreground': '#4A5563',
      'editorLineNumber.activeForeground': '#9BA5B4',
      'editor.selectionBackground': '#53C6D842',
      'editor.inactiveSelectionBackground': '#53C6D826',
      'editorCursor.foreground': '#53C6D8',
      'editor.lineHighlightBackground': '#23293659',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#262D3B',
      'editorIndentGuide.activeBackground1': '#3A4354',
      'editorWidget.background': '#1A1F28',
      'editorWidget.border': '#262D3B',
      'editorSuggestWidget.background': '#1A1F28',
      'editorSuggestWidget.selectedBackground': '#242B3A',
      'editorHoverWidget.background': '#1A1F28',
      'input.background': '#12151B',
      'focusBorder': '#53C6D866',
      'editorBracketHighlight.foreground1': '#53C6D8',
      'editorBracketHighlight.foreground2': '#E3B341',
      'editorBracketHighlight.foreground3': '#E06CA8',
      'scrollbarSlider.background': '#3A43545C',
      'scrollbarSlider.hoverBackground': '#3A435480'
    }
  })

  monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: LIGHT_RULES,
    colors: {
      'editor.background': '#FBFAF7',
      'editor.foreground': '#191C21',
      'editorGutter.background': '#FBFAF7',
      'editorLineNumber.foreground': '#B4B2A8',
      'editorLineNumber.activeForeground': '#5B6270',
      'editor.selectionBackground': '#0E7C9030',
      'editor.inactiveSelectionBackground': '#0E7C901C',
      'editorCursor.foreground': '#0E7C90',
      'editor.lineHighlightBackground': '#E7E6DF73',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#DBDAD2',
      'editorIndentGuide.activeBackground1': '#CFCEC6',
      'editorWidget.background': '#FFFFFF',
      'editorWidget.border': '#DBDAD2',
      'editorSuggestWidget.background': '#FFFFFF',
      'editorSuggestWidget.selectedBackground': '#E3E2DA',
      'editorHoverWidget.background': '#FFFFFF',
      'input.background': '#FBFAF7',
      'focusBorder': '#0E7C9066',
      'editorBracketHighlight.foreground1': '#0E7C90',
      'editorBracketHighlight.foreground2': '#8A6A00',
      'editorBracketHighlight.foreground3': '#C2317F',
      'scrollbarSlider.background': '#CFCEC65C',
      'scrollbarSlider.hoverBackground': '#CFCEC680'
    }
  })
}
