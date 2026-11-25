import type * as Monaco from 'monaco-editor'
import { restOfLineWithinEmbedBudget } from './monarch-embed-entry-budget'

type GlimmerMonaco = {
  languages: Pick<
    typeof Monaco.languages,
    'getLanguages' | 'register' | 'setLanguageConfiguration' | 'setMonarchTokensProvider'
  >
}
type GlimmerBaseLanguage = 'typescript' | 'javascript'

// Script is the background embed and each `<template>` a Handlebars island; returning through root re-pushes the script embed so `@pop` never runs without one. Like Vue/Svelte, a literal `<template>` in a JS string or comment still switches embeds.
function createGlimmerMonarchLanguage(
  baseLanguage: GlimmerBaseLanguage
): Monaco.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    tokenPostfix: baseLanguage === 'typescript' ? '.gts' : '.gjs',
    tokenizer: {
      // Zero-width transitions require @rematch or Monarch silently drops nextEmbedded.
      root: [
        [
          restOfLineWithinEmbedBudget,
          { token: '@rematch', switchTo: '@script', nextEmbedded: baseLanguage }
        ],
        [/(?=.)/, { token: '@rematch', switchTo: '@scriptPlain' }]
      ],
      script: [
        [/<template\s*>/, { token: 'tag', switchTo: '@templateEnter', nextEmbedded: '@pop' }]
      ],
      // Over-budget lines keep island boundaries without embeds to bound recursion; re-embed once the rest fits.
      scriptPlain: [
        [/<template\s*>/, { token: 'tag', switchTo: '@templateEnter' }],
        [
          restOfLineWithinEmbedBudget,
          { token: '@rematch', switchTo: '@script', nextEmbedded: baseLanguage }
        ],
        [/[^<]+/, ''],
        [/./, '']
      ],
      templateEnter: [
        [
          restOfLineWithinEmbedBudget,
          { token: '@rematch', switchTo: '@templateBody', nextEmbedded: 'handlebars' }
        ],
        [/(?=.)/, { token: '@rematch', switchTo: '@templatePlain' }]
      ],
      templateBody: [
        [/<\/template\s*>/, { token: 'tag', switchTo: '@root', nextEmbedded: '@pop' }]
      ],
      templatePlain: [
        [/<\/template\s*>/, { token: 'tag', switchTo: '@root' }],
        [
          restOfLineWithinEmbedBudget,
          { token: '@rematch', switchTo: '@templateBody', nextEmbedded: 'handlebars' }
        ],
        [/[^<]+/, ''],
        [/./, '']
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

const GLIMMER_LANGUAGES = [
  { id: 'glimmer-ts', extension: '.gts', alias: 'Glimmer TS', language: glimmerTsMonarchLanguage },
  { id: 'glimmer-js', extension: '.gjs', alias: 'Glimmer JS', language: glimmerJsMonarchLanguage }
]

export function registerGlimmerLanguages(monaco: GlimmerMonaco): void {
  const registeredIds = new Set(monaco.languages.getLanguages().map((language) => language.id))
  for (const { id, extension, alias, language } of GLIMMER_LANGUAGES) {
    if (registeredIds.has(id)) {
      continue
    }
    monaco.languages.register({ id, extensions: [extension], aliases: [alias] })
    monaco.languages.setMonarchTokensProvider(id, language)
    monaco.languages.setLanguageConfiguration(id, glimmerLanguageConfiguration)
  }
}
