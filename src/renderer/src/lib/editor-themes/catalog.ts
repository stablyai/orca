import type { EditorThemePalette } from './palette'

export type EditorThemeCatalogEntry = {
  label: string
  palette: EditorThemePalette
}

/** Editor theme catalog — palettes chosen to visually match their terminal
 *  counterparts of the same name (see lib/terminal-themes) so users who pick
 *  "Monokai" (etc.) get a consistent look across terminal and editor. */
export const EDITOR_THEME_CATALOG = {
  monokai: {
    label: 'Monokai',
    palette: {
      background: '#272822',
      foreground: '#f8f8f2',
      comment: '#75715e',
      keyword: '#f92672',
      string: '#e6db74',
      function: '#a6e22e',
      constant: '#ae81ff',
      type: '#66d9ef',
      variable: '#fd971f',
      selection: '#49483e',
      lineHighlight: '#3e3d32',
      cursor: '#f8f8f0',
      gutterForeground: '#90908a',
      base: 'dark'
    }
  },
  dracula: {
    label: 'Dracula',
    palette: {
      background: '#282a36',
      foreground: '#f8f8f2',
      comment: '#6272a4',
      keyword: '#ff79c6',
      string: '#f1fa8c',
      function: '#50fa7b',
      constant: '#bd93f9',
      type: '#8be9fd',
      variable: '#ffb86c',
      selection: '#44475a',
      lineHighlight: '#343746',
      cursor: '#f8f8f2',
      gutterForeground: '#6272a4',
      base: 'dark'
    }
  },
  'one-dark': {
    label: 'One Dark',
    palette: {
      background: '#282c34',
      foreground: '#abb2bf',
      comment: '#5c6370',
      keyword: '#c678dd',
      string: '#98c379',
      function: '#61afef',
      constant: '#d19a66',
      type: '#e5c07b',
      variable: '#e06c75',
      selection: '#3e4451',
      lineHighlight: '#2c313a',
      cursor: '#528bff',
      gutterForeground: '#636d83',
      base: 'dark'
    }
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    palette: {
      background: '#002b36',
      foreground: '#839496',
      comment: '#586e75',
      keyword: '#859900',
      string: '#2aa198',
      function: '#268bd2',
      constant: '#d33682',
      type: '#b58900',
      variable: '#cb4b16',
      selection: '#073642',
      lineHighlight: '#073642',
      cursor: '#839496',
      gutterForeground: '#586e75',
      base: 'dark'
    }
  },
  'solarized-light': {
    label: 'Solarized Light',
    palette: {
      background: '#fdf6e3',
      foreground: '#657b83',
      comment: '#93a1a1',
      keyword: '#859900',
      string: '#2aa198',
      function: '#268bd2',
      constant: '#d33682',
      type: '#b58900',
      variable: '#cb4b16',
      selection: '#eee8d5',
      lineHighlight: '#eee8d5',
      cursor: '#657b83',
      gutterForeground: '#93a1a1',
      base: 'light'
    }
  }
} satisfies Record<string, EditorThemeCatalogEntry>

export type EditorThemeCatalogId = keyof typeof EDITOR_THEME_CATALOG
