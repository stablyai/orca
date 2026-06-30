import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const astroLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['<', '>']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ]
}

export function registerAstroLanguage(monaco: MonacoModule): void {
  const astroAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'astro')
  if (!astroAlreadyRegistered) {
    monaco.languages.register({
      id: 'astro',
      extensions: ['.astro'],
      aliases: ['Astro']
    })
  }

  monaco.languages.setLanguageConfiguration('astro', astroLanguageConfiguration)
}
