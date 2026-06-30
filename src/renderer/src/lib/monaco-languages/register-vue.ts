import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

export const vueLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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

export function registerVueLanguage(monaco: MonacoModule): void {
  const vueAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'vue')
  if (!vueAlreadyRegistered) {
    monaco.languages.register({
      id: 'vue',
      extensions: ['.vue'],
      aliases: ['Vue']
    })
  }

  monaco.languages.setLanguageConfiguration('vue', vueLanguageConfiguration)
}
