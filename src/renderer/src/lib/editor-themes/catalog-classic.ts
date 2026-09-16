import type { EditorThemeCatalogEntry } from './types'

/** Editor counterparts of DEFAULT_TERMINAL_THEMES and CLASSIC_TERMINAL_THEMES. */
export const CLASSIC_EDITOR_THEMES = {
  'ghostty-default-style-dark': {
    label: 'Ghostty Default Style Dark',
    palette: {
      background: '#282c34',
      foreground: '#ffffff',
      comment: '#666666',
      keyword: '#b294bb',
      string: '#b5bd68',
      function: '#81a2be',
      constant: '#f0c674',
      type: '#8abeb7',
      variable: '#cc6666',
      selection: '#5a7898',
      lineHighlight: '#393d44',
      cursor: '#ffffff',
      gutterForeground: '#666666',
      base: 'dark'
    }
  },
  'builtin-tango-light': {
    label: 'Builtin Tango Light',
    palette: {
      background: '#ffffff',
      foreground: '#2e3434',
      comment: '#6a6a6a',
      keyword: '#75507b',
      string: '#4e9a06',
      function: '#3465a4',
      constant: '#8e7700',
      type: '#05727e',
      variable: '#cc0000',
      selection: '#accef7',
      lineHighlight: '#f5f5f5',
      cursor: '#2e3434',
      gutterForeground: '#6a6a6a',
      base: 'light'
    }
  },
  'tango-dark': {
    label: 'Tango Dark',
    palette: {
      background: '#000000',
      foreground: '#d3d7cf',
      comment: '#555753',
      keyword: '#ad7fa8',
      string: '#8ae234',
      function: '#729fcf',
      constant: '#fce94f',
      type: '#34e2e2',
      variable: '#ef2929',
      selection: '#555753',
      lineHighlight: '#111111',
      cursor: '#d3d7cf',
      gutterForeground: '#555753',
      base: 'dark'
    }
  },
  homebrew: {
    label: 'Homebrew',
    palette: {
      background: '#000000',
      foreground: '#00ff00',
      comment: '#666666',
      keyword: '#00d900',
      string: '#e5e500',
      function: '#00e5e5',
      constant: '#e500e5',
      type: '#00a6b2',
      variable: '#e50000',
      selection: '#005500',
      lineHighlight: '#001400',
      cursor: '#00ff00',
      gutterForeground: '#666666',
      base: 'dark'
    }
  },
  snazzy: {
    label: 'Snazzy',
    palette: {
      background: '#282a36',
      foreground: '#eff0eb',
      comment: '#686868',
      keyword: '#ff6ac1',
      string: '#f3f99d',
      function: '#5af78e',
      constant: '#57c7ff',
      type: '#9aedfe',
      variable: '#ff5c57',
      selection: '#3e404a',
      lineHighlight: '#383a44',
      cursor: '#97979b',
      gutterForeground: '#686868',
      base: 'dark'
    }
  }
} satisfies Record<string, EditorThemeCatalogEntry>
