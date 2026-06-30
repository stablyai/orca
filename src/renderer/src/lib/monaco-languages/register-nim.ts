import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const NIM_LANGUAGE_ID = 'nim'

export const nimLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#',
    blockComment: ['#[', ']#']
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export function registerNimLanguage(monaco: MonacoModule): void {
  const nimAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === NIM_LANGUAGE_ID)
  if (!nimAlreadyRegistered) {
    monaco.languages.register({
      id: NIM_LANGUAGE_ID,
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    })
  }

  monaco.languages.setLanguageConfiguration(NIM_LANGUAGE_ID, nimLanguageConfiguration)
}
