import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const IGNORE_LANGUAGE_ID = 'ignore'

export const ignoreLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [],
  autoClosingPairs: []
}

export const ignoreMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: 'string',
  tokenPostfix: '.ignore',
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      [/^\s*!/, 'keyword'],
      [/\\[#!*?[\]\\]/, 'string.escape'],
      [/\*\*/, 'regexp'],
      [/[?*]/, 'regexp'],
      [/\[[^\]]*\]/, 'regexp'],
      [/(^|\/)\/?(?=\S)/, 'delimiter'],
      [/\/$/, 'delimiter']
    ]
  }
}

const COMMON_PATTERNS = [
  { label: 'node_modules/', detail: 'Node.js dependencies' },
  { label: '.env', detail: 'Local environment variables' },
  { label: '.env.*', detail: 'Environment-specific variables' },
  { label: '!.env.example', detail: 'Keep the example environment file' },
  { label: 'dist/', detail: 'Build output' },
  { label: 'build/', detail: 'Build output' },
  { label: 'coverage/', detail: 'Test coverage output' },
  { label: '.DS_Store', detail: 'macOS Finder metadata' },
  { label: '*.log', detail: 'Log files' },
  { label: '.idea/', detail: 'JetBrains project settings' },
  { label: '.vscode/', detail: 'VS Code workspace settings' }
] as const

export function createIgnoreCompletionItems(
  monaco: MonacoModule,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Monaco.languages.CompletionItem[] {
  const word = model.getWordUntilPosition(position)
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
  return COMMON_PATTERNS.map(({ label, detail }) => ({
    label,
    detail,
    insertText: label,
    kind: monaco.languages.CompletionItemKind.Value,
    range
  }))
}

export function registerIgnoreLanguage(monaco: MonacoModule): void {
  if (monaco.languages.getLanguages().some((language) => language.id === IGNORE_LANGUAGE_ID)) {
    return
  }

  monaco.languages.register({
    id: IGNORE_LANGUAGE_ID,
    aliases: ['Ignore', 'gitignore'],
    filenames: [
      '.gitignore',
      '.ignore',
      '.dockerignore',
      '.eslintignore',
      '.npmignore',
      '.prettierignore',
      '.stylelintignore'
    ]
  })
  monaco.languages.setLanguageConfiguration(IGNORE_LANGUAGE_ID, ignoreLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(IGNORE_LANGUAGE_ID, ignoreMonarchLanguage)
  monaco.languages.registerCompletionItemProvider(IGNORE_LANGUAGE_ID, {
    triggerCharacters: ['!', '.', '*'],
    provideCompletionItems: (model, position) => ({
      suggestions: createIgnoreCompletionItems(monaco, model, position)
    })
  })
}
