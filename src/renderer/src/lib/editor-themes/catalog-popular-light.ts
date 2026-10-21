import type { EditorThemeCatalogEntry } from './types'

/** Editor counterparts of POPULAR_LIGHT_TERMINAL_THEMES. */
export const POPULAR_LIGHT_EDITOR_THEMES = {
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
  },
  'one-light': {
    label: 'One Light',
    palette: {
      background: '#fafafa',
      foreground: '#383a42',
      comment: '#a0a1a7',
      keyword: '#a626a4',
      string: '#50a14f',
      function: '#4078f2',
      constant: '#c18401',
      type: '#0184bc',
      variable: '#e45649',
      selection: '#e5e5e6',
      lineHighlight: '#f0f0f1',
      cursor: '#526fff',
      gutterForeground: '#a0a1a7',
      base: 'light'
    }
  },
  'catppuccin-latte': {
    label: 'Catppuccin Latte',
    palette: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      comment: '#6c6f85',
      // Catppuccin mauve, not the terminal palette's pink: pink on Latte's background is unreadable.
      keyword: '#8839ef',
      string: '#40a02b',
      function: '#1e66f5',
      constant: '#df8e1d',
      type: '#179299',
      variable: '#d20f39',
      selection: '#acb0be',
      lineHighlight: '#e7e9ee',
      cursor: '#dc8a78',
      gutterForeground: '#acb0be',
      base: 'light'
    }
  },
  'github-light': {
    label: 'GitHub Light',
    palette: {
      background: '#ffffff',
      foreground: '#24292e',
      comment: '#6a737d',
      keyword: '#d73a49',
      string: '#005cc5',
      function: '#5a32a3',
      constant: '#0366d6',
      type: '#22863a',
      variable: '#b08800',
      selection: '#c8c8fa',
      lineHighlight: '#f4f4f5',
      cursor: '#044289',
      gutterForeground: '#959da5',
      base: 'light'
    }
  },
  'rose-pine-dawn': {
    label: 'Rose Pine Dawn',
    palette: {
      background: '#faf4ed',
      foreground: '#575279',
      comment: '#9893a5',
      keyword: '#286983',
      string: '#ea9d34',
      function: '#d7827e',
      constant: '#907aa9',
      type: '#56949f',
      variable: '#b4637a',
      selection: '#dfdad9',
      lineHighlight: '#f2ece7',
      cursor: '#9893a5',
      gutterForeground: '#9893a5',
      base: 'light'
    }
  },
  'gruvbox-light': {
    label: 'Gruvbox Light',
    palette: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      comment: '#928374',
      keyword: '#9d0006',
      string: '#79740e',
      function: '#427b58',
      constant: '#8f3f71',
      type: '#b57614',
      variable: '#076678',
      selection: '#ebdbb2',
      lineHighlight: '#f1e8c0',
      cursor: '#3c3836',
      gutterForeground: '#928374',
      base: 'light'
    }
  },
  'tokyo-night-light': {
    label: 'Tokyo Night Light',
    palette: {
      background: '#d5d6db',
      foreground: '#343b58',
      comment: '#9699a3',
      keyword: '#5a4a78',
      string: '#485e30',
      function: '#34548a',
      constant: '#8f5e15',
      type: '#0f4b6e',
      variable: '#8c4351',
      selection: '#9699a3',
      lineHighlight: '#cdced4',
      cursor: '#343b58',
      gutterForeground: '#9699a3',
      base: 'light'
    }
  },
  'everforest-light': {
    label: 'Everforest Light',
    palette: {
      background: '#fdf6e3',
      foreground: '#5c6a72',
      comment: '#939f91',
      keyword: '#f85552',
      string: '#8da101',
      function: '#3a94c5',
      constant: '#df69ba',
      type: '#dfa000',
      variable: '#35a77c',
      selection: '#e6e2cc',
      lineHighlight: '#f5efdd',
      cursor: '#5c6a72',
      gutterForeground: '#939f91',
      base: 'light'
    }
  }
} satisfies Record<string, EditorThemeCatalogEntry>
