import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const svelteLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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

export function registerSvelteLanguage(monaco: MonacoModule): void {
  const svelteAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'svelte')
  if (!svelteAlreadyRegistered) {
    monaco.languages.register({
      id: 'svelte',
      extensions: ['.svelte'],
      aliases: ['Svelte']
    })
  }

  monaco.languages.setLanguageConfiguration('svelte', svelteLanguageConfiguration)
}
