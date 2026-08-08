import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco
type GlimmerBaseLanguage = 'typescript' | 'javascript'

// Glimmer `.gjs`/`.gts` are JS/TS files with embedded `<template>` blocks.
// Inverts the Astro model: the script is the persistent background embed and
// `<template>` is a Handlebars island. Every return to `@script` routes through
// `@scriptReenter` to re-push the base embed, avoiding Monaco's "cannot pop an
// embed we never pushed" error (see register-astro.ts).
function createGlimmerMonarchLanguage(
  baseLanguage: GlimmerBaseLanguage
): Monaco.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    tokenPostfix: baseLanguage === 'typescript' ? '.gts' : '.gjs',
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
      { open: '<', close: '>', token: 'delimiter.angle' }
    ],
    tokenizer: {
      root: [[/(?=.)/, { token: '@rematch', switchTo: '@scriptReenter' }]],
      scriptReenter: [
        [/(?=[\s\S])/, { token: '@rematch', switchTo: '@script', nextEmbedded: baseLanguage }]
      ],
      script: [
        [/<template\s*>/, { token: 'tag', switchTo: '@templateEnter', nextEmbedded: '@pop' }]
      ],
      templateEnter: [
        [/(?=[\s\S])/, { token: '@rematch', switchTo: '@templateBody', nextEmbedded: 'handlebars' }]
      ],
      templateBody: [
        [/<\/template\s*>/, { token: 'tag', switchTo: '@scriptReenter', nextEmbedded: '@pop' }]
      ]
    }
  }
}

export const glimmerTsMonarchLanguage = createGlimmerMonarchLanguage('typescript')
export const glimmerJsMonarchLanguage = createGlimmerMonarchLanguage('javascript')

export const glimmerLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
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
    { open: '`', close: '`' }
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

type GlimmerRegistration = {
  id: string
  extension: string
  alias: string
  monarchLanguage: Monaco.languages.IMonarchLanguage
}

const GLIMMER_REGISTRATIONS: GlimmerRegistration[] = [
  {
    id: 'glimmer-ts',
    extension: '.gts',
    alias: 'Glimmer TS',
    monarchLanguage: glimmerTsMonarchLanguage
  },
  {
    id: 'glimmer-js',
    extension: '.gjs',
    alias: 'Glimmer JS',
    monarchLanguage: glimmerJsMonarchLanguage
  }
]

export function registerGlimmerLanguages(monaco: MonacoModule): void {
  for (const registration of GLIMMER_REGISTRATIONS) {
    const alreadyRegistered = monaco.languages
      .getLanguages()
      .some((language) => language.id === registration.id)
    if (alreadyRegistered) {
      continue
    }

    monaco.languages.register({
      id: registration.id,
      extensions: [registration.extension],
      aliases: [registration.alias]
    })
    monaco.languages.setMonarchTokensProvider(registration.id, registration.monarchLanguage)
    monaco.languages.setLanguageConfiguration(registration.id, glimmerLanguageConfiguration)
  }
}
