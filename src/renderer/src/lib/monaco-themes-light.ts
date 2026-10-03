import type { EditorThemeItem } from './monaco-themes-dark'

export const LIGHT_EDITOR_THEMES: EditorThemeItem[] = [
  {
    id: 'vs',
    name: 'VS Code Light (Default)',
    mode: 'light'
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'cf222e' },
        { token: 'string', foreground: '0a3069' },
        { token: 'number', foreground: '0550ae' },
        { token: 'regexp', foreground: '116329' },
        { token: 'type', foreground: '953800' },
        { token: 'class', foreground: '953800' },
        { token: 'function', foreground: '8250df' },
        { token: 'variable', foreground: '24292f' },
        { token: 'operator', foreground: '0550ae' },
        { token: 'delimiter', foreground: '24292f' },
        { token: 'tag', foreground: '116329' },
        { token: 'attribute.name', foreground: '0550ae' },
        { token: 'attribute.value', foreground: '0a3069' }
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#24292f',
        'editor.selectionBackground': '#b6e3ff',
        'editor.lineHighlightBackground': '#f6f8fa',
        'editorCursor.foreground': '#0969da',
        'editorWhitespace.foreground': '#afb8c1',
        'editorLineNumber.foreground': '#8c959f',
        'editorLineNumber.activeForeground': '#24292f',
        'diffEditor.insertedTextBackground': '#2ea0431a',
        'diffEditor.removedTextBackground': '#cf222e1a'
      }
    }
  },
  {
    id: 'one-light',
    name: 'One Light',
    mode: 'light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: 'a0a1a7', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'a626a4' },
        { token: 'string', foreground: '50a14f' },
        { token: 'number', foreground: '986801' },
        { token: 'regexp', foreground: '0184bc' },
        { token: 'type', foreground: 'c18401' },
        { token: 'class', foreground: 'c18401' },
        { token: 'function', foreground: '4078f2' },
        { token: 'variable', foreground: '383a42' },
        { token: 'operator', foreground: '0184bc' },
        { token: 'delimiter', foreground: '383a42' },
        { token: 'tag', foreground: 'e45649' },
        { token: 'attribute.name', foreground: '986801' },
        { token: 'attribute.value', foreground: '50a14f' }
      ],
      colors: {
        'editor.background': '#fafafa',
        'editor.foreground': '#383a42',
        'editor.selectionBackground': '#e5e5e6',
        'editor.lineHighlightBackground': '#f0f0f1',
        'editorCursor.foreground': '#526fff',
        'editorWhitespace.foreground': '#a0a1a744',
        'editorLineNumber.foreground': '#9d9d9f',
        'editorLineNumber.activeForeground': '#383a42',
        'diffEditor.insertedTextBackground': '#50a14f1a',
        'diffEditor.removedTextBackground': '#e456491a'
      }
    }
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '9ca0b0', fontStyle: 'italic' },
        { token: 'keyword', foreground: '8839ef' },
        { token: 'string', foreground: '40a02b' },
        { token: 'number', foreground: 'fe640b' },
        { token: 'regexp', foreground: 'ea76cb' },
        { token: 'type', foreground: 'df8e1d' },
        { token: 'class', foreground: 'df8e1d' },
        { token: 'function', foreground: '1e66f5' },
        { token: 'variable', foreground: '4c4f69' },
        { token: 'operator', foreground: '04a5e5' },
        { token: 'delimiter', foreground: '4c4f69' },
        { token: 'tag', foreground: '8839ef' },
        { token: 'attribute.name', foreground: 'df8e1d' },
        { token: 'attribute.value', foreground: '40a02b' }
      ],
      colors: {
        'editor.background': '#eff1f5',
        'editor.foreground': '#4c4f69',
        'editor.selectionBackground': '#acb0be66',
        'editor.lineHighlightBackground': '#e6e9ef',
        'editorCursor.foreground': '#dc8a78',
        'editorWhitespace.foreground': '#9ca0b044',
        'editorLineNumber.foreground': '#9ca0b0',
        'editorLineNumber.activeForeground': '#4c4f69',
        'diffEditor.insertedTextBackground': '#40a02b1a',
        'diffEditor.removedTextBackground': '#d20f391a'
      }
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '93a1a1', fontStyle: 'italic' },
        { token: 'keyword', foreground: '859900' },
        { token: 'string', foreground: '2aa198' },
        { token: 'number', foreground: 'd33682' },
        { token: 'regexp', foreground: 'dc322f' },
        { token: 'type', foreground: 'b58900' },
        { token: 'class', foreground: 'b58900' },
        { token: 'function', foreground: '268bd2' },
        { token: 'variable', foreground: '657b83' },
        { token: 'operator', foreground: '859900' },
        { token: 'delimiter', foreground: '657b83' },
        { token: 'tag', foreground: '268bd2' },
        { token: 'attribute.name', foreground: '93a1a1' },
        { token: 'attribute.value', foreground: '2aa198' }
      ],
      colors: {
        'editor.background': '#fdf6e3',
        'editor.foreground': '#657b83',
        'editor.selectionBackground': '#eee8d5',
        'editor.lineHighlightBackground': '#eee8d5',
        'editorCursor.foreground': '#657b83',
        'editorWhitespace.foreground': '#93a1a144',
        'editorLineNumber.foreground': '#93a1a1',
        'editorLineNumber.activeForeground': '#586e75',
        'diffEditor.insertedTextBackground': '#8599001a',
        'diffEditor.removedTextBackground': '#dc322f1a'
      }
    }
  }
]
