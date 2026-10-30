import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const JSONL_LANGUAGE_ID = 'jsonl'

export const jsonlLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  brackets: [
    ['{', '}'],
    ['[', ']']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ]
}

// Reuse JSON colors without its whole-document language service, which would reject independent JSONL records after the first; no validation is intended.
export const jsonlMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.jsonl',

  tokenizer: {
    root: [
      { include: '@whitespace' },
      // Property key vs string value are both quoted; color keys distinctly.
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type.identifier'],
      // Enter escape-aware string state only with a same-line closing quote; otherwise truncated records would color every later line as one string.
      [/"(?=(?:[^"\\]|\\.)*")/, 'string', '@string'],
      [/"(?:[^"\\]|\\.)*\\?$/, 'string.invalid'],
      [/[{}[\]]/, '@brackets'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false)\b/, 'keyword'],
      [/\bnull\b/, 'keyword'],
      [/[:,]/, 'delimiter']
    ],

    whitespace: [[/[ \t\r\n]+/, 'white']],

    string: [
      [/[^"\\]+/, 'string'],
      [/\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop']
    ]
  }
}

export function registerJsonlLanguage(monaco: MonacoModule): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === JSONL_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: JSONL_LANGUAGE_ID,
    extensions: ['.jsonl'],
    aliases: ['JSON Lines', 'jsonl', 'ndjson']
  })
  monaco.languages.setLanguageConfiguration(JSONL_LANGUAGE_ID, jsonlLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(JSONL_LANGUAGE_ID, jsonlMonarchLanguage)
}
