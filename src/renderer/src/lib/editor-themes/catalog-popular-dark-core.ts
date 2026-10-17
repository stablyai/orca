import type { EditorThemeCatalogEntry } from './types'

/** Editor counterparts of POPULAR_DARK_CORE_TERMINAL_THEMES — same names, same
 *  background/foreground/cursor/selection, syntax roles mapped from each
 *  theme's own ANSI accents. */
export const POPULAR_DARK_CORE_EDITOR_THEMES = {
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
  nord: {
    label: 'Nord',
    palette: {
      background: '#2e3440',
      foreground: '#d8dee9',
      comment: '#4c566a',
      keyword: '#81a1c1',
      string: '#a3be8c',
      function: '#88c0d0',
      constant: '#b48ead',
      type: '#8fbcbb',
      variable: '#bf616a',
      selection: '#434c5e',
      lineHighlight: '#3c424e',
      cursor: '#d8dee9',
      gutterForeground: '#4c566a',
      base: 'dark'
    }
  },
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
  'tokyo-night': {
    label: 'Tokyo Night',
    palette: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      comment: '#414868',
      keyword: '#bb9af7',
      string: '#9ece6a',
      function: '#7aa2f7',
      constant: '#e0af68',
      type: '#7dcfff',
      variable: '#f7768e',
      selection: '#33467c',
      lineHighlight: '#272937',
      cursor: '#c0caf5',
      gutterForeground: '#414868',
      base: 'dark'
    }
  },
  'gruvbox-dark': {
    label: 'Gruvbox Dark',
    palette: {
      background: '#282828',
      foreground: '#ebdbb2',
      comment: '#928374',
      keyword: '#fb4934',
      string: '#b8bb26',
      function: '#8ec07c',
      constant: '#d3869b',
      type: '#fabd2f',
      variable: '#83a598',
      selection: '#504945',
      lineHighlight: '#383633',
      cursor: '#ebdbb2',
      gutterForeground: '#928374',
      base: 'dark'
    }
  },
  'catppuccin-mocha': {
    label: 'Catppuccin Mocha',
    palette: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      comment: '#585b70',
      keyword: '#f5c2e7',
      string: '#a6e3a1',
      function: '#89b4fa',
      constant: '#f9e2af',
      type: '#94e2d5',
      variable: '#f38ba8',
      selection: '#585b70',
      lineHighlight: '#2c2d3e',
      cursor: '#f5e0dc',
      gutterForeground: '#585b70',
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
  }
} satisfies Record<string, EditorThemeCatalogEntry>
