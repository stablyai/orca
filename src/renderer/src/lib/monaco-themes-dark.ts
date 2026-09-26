import { DARK_BASE_THEMES, type EditorThemeItem } from './monaco-themes-dark-base'

export { DARK_BASE_THEMES, type EditorThemeItem }

export const DARK_EDITOR_THEMES: EditorThemeItem[] = [
  ...DARK_BASE_THEMES,
  {
    id: 'monokai',
    name: 'Monokai',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'f92672' },
        { token: 'string', foreground: 'e6db74' },
        { token: 'number', foreground: 'ae81ff' },
        { token: 'regexp', foreground: 'e6db74' },
        { token: 'type', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'class', foreground: 'a6e22e' },
        { token: 'function', foreground: 'a6e22e' },
        { token: 'variable', foreground: 'f8f8f2' },
        { token: 'operator', foreground: 'f92672' },
        { token: 'delimiter', foreground: 'f8f8f2' },
        { token: 'tag', foreground: 'f92672' },
        { token: 'attribute.name', foreground: 'a6e22e' },
        { token: 'attribute.value', foreground: 'e6db74' }
      ],
      colors: {
        'editor.background': '#272822',
        'editor.foreground': '#f8f8f2',
        'editor.selectionBackground': '#49483e',
        'editor.lineHighlightBackground': '#3e3d32',
        'editorCursor.foreground': '#f8f8f0',
        'editorWhitespace.foreground': '#75715e44',
        'editorLineNumber.foreground': '#90908a',
        'editorLineNumber.activeForeground': '#f8f8f2',
        'diffEditor.insertedTextBackground': '#a6e22e22',
        'diffEditor.removedTextBackground': '#f9267222'
      }
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'bb9af7' },
        { token: 'string', foreground: '9ece6a' },
        { token: 'number', foreground: 'ff9e64' },
        { token: 'regexp', foreground: 'b4f9f8' },
        { token: 'type', foreground: '2ac3de' },
        { token: 'class', foreground: 'c0caf5' },
        { token: 'function', foreground: '7aa2f7' },
        { token: 'variable', foreground: 'c0caf5' },
        { token: 'operator', foreground: '89ddff' },
        { token: 'delimiter', foreground: 'c0caf5' },
        { token: 'tag', foreground: 'f7768e' },
        { token: 'attribute.name', foreground: 'bb9af7' },
        { token: 'attribute.value', foreground: '9ece6a' }
      ],
      colors: {
        'editor.background': '#1a1b26',
        'editor.foreground': '#c0caf5',
        'editor.selectionBackground': '#33467c',
        'editor.lineHighlightBackground': '#292e42',
        'editorCursor.foreground': '#c0caf5',
        'editorWhitespace.foreground': '#565f8944',
        'editorLineNumber.foreground': '#363b54',
        'editorLineNumber.activeForeground': '#737aa2',
        'diffEditor.insertedTextBackground': '#9ece6a20',
        'diffEditor.removedTextBackground': '#f7768e20'
      }
    }
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6c7086', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'cba6f7' },
        { token: 'string', foreground: 'a6e3a1' },
        { token: 'number', foreground: 'fab387' },
        { token: 'regexp', foreground: 'f5c2e7' },
        { token: 'type', foreground: 'f9e2af' },
        { token: 'class', foreground: 'f9e2af' },
        { token: 'function', foreground: '89b4fa' },
        { token: 'variable', foreground: 'cdd6f4' },
        { token: 'operator', foreground: '89dceb' },
        { token: 'delimiter', foreground: 'cdd6f4' },
        { token: 'tag', foreground: 'cba6f7' },
        { token: 'attribute.name', foreground: 'f9e2af' },
        { token: 'attribute.value', foreground: 'a6e3a1' }
      ],
      colors: {
        'editor.background': '#1e1e2e',
        'editor.foreground': '#cdd6f4',
        'editor.selectionBackground': '#585b7066',
        'editor.lineHighlightBackground': '#313244',
        'editorCursor.foreground': '#f5e0dc',
        'editorWhitespace.foreground': '#6c708644',
        'editorLineNumber.foreground': '#6c7086',
        'editorLineNumber.activeForeground': '#cdd6f4',
        'diffEditor.insertedTextBackground': '#a6e3a122',
        'diffEditor.removedTextBackground': '#f38ba822'
      }
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '616e88', fontStyle: 'italic' },
        { token: 'keyword', foreground: '81a1c1' },
        { token: 'string', foreground: 'a3be8c' },
        { token: 'number', foreground: 'b48ead' },
        { token: 'regexp', foreground: 'ebcb8b' },
        { token: 'type', foreground: '8fbcbb' },
        { token: 'class', foreground: '8fbcbb' },
        { token: 'function', foreground: '88c0d0' },
        { token: 'variable', foreground: 'd8dee9' },
        { token: 'operator', foreground: '81a1c1' },
        { token: 'delimiter', foreground: 'eceff4' },
        { token: 'tag', foreground: '81a1c1' },
        { token: 'attribute.name', foreground: '8fbcbb' },
        { token: 'attribute.value', foreground: 'a3be8c' }
      ],
      colors: {
        'editor.background': '#2e3440',
        'editor.foreground': '#d8dee9',
        'editor.selectionBackground': '#434c5e',
        'editor.lineHighlightBackground': '#3b4252',
        'editorCursor.foreground': '#d8dee9',
        'editorWhitespace.foreground': '#4c566a',
        'editorLineNumber.foreground': '#4c566a',
        'editorLineNumber.activeForeground': '#d8dee9',
        'diffEditor.insertedTextBackground': '#a3be8c22',
        'diffEditor.removedTextBackground': '#bf616a22'
      }
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
        { token: 'keyword', foreground: '859900' },
        { token: 'string', foreground: '2aa198' },
        { token: 'number', foreground: 'd33682' },
        { token: 'regexp', foreground: 'dc322f' },
        { token: 'type', foreground: 'b58900' },
        { token: 'class', foreground: 'b58900' },
        { token: 'function', foreground: '268bd2' },
        { token: 'variable', foreground: '839496' },
        { token: 'operator', foreground: '859900' },
        { token: 'delimiter', foreground: '839496' },
        { token: 'tag', foreground: '268bd2' },
        { token: 'attribute.name', foreground: '93a1a1' },
        { token: 'attribute.value', foreground: '2aa198' }
      ],
      colors: {
        'editor.background': '#002b36',
        'editor.foreground': '#839496',
        'editor.selectionBackground': '#073642',
        'editor.lineHighlightBackground': '#073642',
        'editorCursor.foreground': '#839496',
        'editorWhitespace.foreground': '#586e7544',
        'editorLineNumber.foreground': '#586e75',
        'editorLineNumber.activeForeground': '#93a1a1',
        'diffEditor.insertedTextBackground': '#85990022',
        'diffEditor.removedTextBackground': '#dc322f22'
      }
    }
  }
]
