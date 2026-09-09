import type * as Monaco from 'monaco-editor'
import { translate } from '@/i18n/i18n'

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
      [/\/+/, 'delimiter']
    ]
  }
}

function getCommonPatterns(): { pattern: string; detail: string }[] {
  const buildOutput = translate('gitignore.completions.buildOutput', 'Build output')
  return [
    {
      pattern: 'node_modules/',
      detail: translate('gitignore.completions.dependencies', 'Node.js dependencies')
    },
    {
      pattern: '.env',
      detail: translate('gitignore.completions.localEnvironment', 'Local environment variables')
    },
    {
      pattern: '.env.*',
      detail: translate(
        'gitignore.completions.environmentSpecific',
        'Environment-specific variables'
      )
    },
    {
      pattern: '!.env.example',
      detail: translate(
        'gitignore.completions.keepEnvironmentExample',
        'Keep the example environment file'
      )
    },
    { pattern: 'dist/', detail: buildOutput },
    { pattern: 'build/', detail: buildOutput },
    {
      pattern: 'coverage/',
      detail: translate('gitignore.completions.coverageOutput', 'Test coverage output')
    },
    {
      pattern: '.DS_Store',
      detail: translate('gitignore.completions.finderMetadata', 'macOS Finder metadata')
    },
    { pattern: '*.log', detail: translate('gitignore.completions.logFiles', 'Log files') },
    {
      pattern: '.idea/',
      detail: translate('gitignore.completions.jetbrainsSettings', 'JetBrains project settings')
    },
    {
      pattern: '.vscode/',
      detail: translate('gitignore.completions.vscodeSettings', 'VS Code workspace settings')
    }
  ]
}

export function createIgnoreCompletionItems(
  monaco: MonacoModule,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Monaco.languages.CompletionItem[] {
  const word = model.getWordUntilPosition(position)
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
  return getCommonPatterns().map(({ pattern, detail }) => ({
    label: pattern,
    detail,
    insertText: pattern,
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
