import type * as monaco from 'monaco-editor'

export type EditorThemeItem = {
  id: string
  name: string
  mode: 'dark' | 'light'
  data?: monaco.editor.IStandaloneThemeData
}

export const DARK_BASE_THEMES: EditorThemeItem[] = [
  {
    id: 'vs-dark',
    name: 'VS Code Dark (Default)',
    mode: 'dark'
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff79c6' },
        { token: 'string', foreground: 'f1fa8c' },
        { token: 'number', foreground: 'bd93f9' },
        { token: 'regexp', foreground: 'ffb86c' },
        { token: 'type', foreground: '8be9fd' },
        { token: 'class', foreground: '8be9fd' },
        { token: 'function', foreground: '50fa7b' },
        { token: 'variable', foreground: 'f8f8f2' },
        { token: 'variable.predefined', foreground: 'bd93f9' },
        { token: 'operator', foreground: 'ff79c6' },
        { token: 'delimiter', foreground: 'f8f8f2' },
        { token: 'tag', foreground: 'ff79c6' },
        { token: 'attribute.name', foreground: '50fa7b' },
        { token: 'attribute.value', foreground: 'f1fa8c' }
      ],
      colors: {
        'editor.background': '#282a36',
        'editor.foreground': '#f8f8f2',
        'editor.selectionBackground': '#44475a',
        'editor.lineHighlightBackground': '#44475a44',
        'editorCursor.foreground': '#f8f8f0',
        'editorWhitespace.foreground': '#6272a466',
        'editorLineNumber.foreground': '#6272a4',
        'editorLineNumber.activeForeground': '#f8f8f2',
        'diffEditor.insertedTextBackground': '#50fa7b22',
        'diffEditor.removedTextBackground': '#ff555522'
      }
    }
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c678dd' },
        { token: 'string', foreground: '98c379' },
        { token: 'number', foreground: 'd19a66' },
        { token: 'regexp', foreground: '56b6c2' },
        { token: 'type', foreground: 'e5c07b' },
        { token: 'class', foreground: 'e5c07b' },
        { token: 'function', foreground: '61afef' },
        { token: 'variable', foreground: 'abb2bf' },
        { token: 'operator', foreground: '56b6c2' },
        { token: 'delimiter', foreground: 'abb2bf' },
        { token: 'tag', foreground: 'e06c75' },
        { token: 'attribute.name', foreground: 'd19a66' },
        { token: 'attribute.value', foreground: '98c379' }
      ],
      colors: {
        'editor.background': '#282c34',
        'editor.foreground': '#abb2bf',
        'editor.selectionBackground': '#3e4451',
        'editor.lineHighlightBackground': '#2c313a',
        'editorCursor.foreground': '#528bff',
        'editorWhitespace.foreground': '#5c637044',
        'editorLineNumber.foreground': '#4b5263',
        'editorLineNumber.activeForeground': '#abb2bf',
        'diffEditor.insertedTextBackground': '#98c37920',
        'diffEditor.removedTextBackground': '#e06c7520'
      }
    }
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8b949e', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff7b72' },
        { token: 'string', foreground: 'a5d6ff' },
        { token: 'number', foreground: '79c0ff' },
        { token: 'regexp', foreground: '7ee787' },
        { token: 'type', foreground: 'ffa657' },
        { token: 'class', foreground: 'ffa657' },
        { token: 'function', foreground: 'd2a8ff' },
        { token: 'variable', foreground: 'c9d1d9' },
        { token: 'operator', foreground: 'ff7b72' },
        { token: 'delimiter', foreground: 'c9d1d9' },
        { token: 'tag', foreground: '7ee787' },
        { token: 'attribute.name', foreground: '79c0ff' },
        { token: 'attribute.value', foreground: 'a5d6ff' }
      ],
      colors: {
        'editor.background': '#0d1117',
        'editor.foreground': '#c9d1d9',
        'editor.selectionBackground': '#58a6ff33',
        'editor.lineHighlightBackground': '#161b22',
        'editorCursor.foreground': '#58a6ff',
        'editorWhitespace.foreground': '#484f58',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#f0f6fc',
        'diffEditor.insertedTextBackground': '#2ea04326',
        'diffEditor.removedTextBackground': '#f8514926'
      }
    }
  }
]
