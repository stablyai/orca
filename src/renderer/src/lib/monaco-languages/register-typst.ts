import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const TYPST_LANGUAGE_ID = 'typst'
export const TYPST_TEXTMATE_SCOPE = 'source.typst'

export const typstLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/']
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
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ]
}

export async function loadTypstTextMateGrammar(): Promise<LanguageRegistration> {
  // Lazy upstream grammar; provenance and Apache-2.0 license are in typst-LICENSE.txt.
  const grammarModule = await import('./textmate-grammars/typst.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate injects the $self/$base repository entries a registration's type requires; real tokenization tests validate this vendored JSON.
  const grammar = grammarModule.default as unknown as LanguageRegistration
  return { ...grammar, name: TYPST_LANGUAGE_ID }
}

export function registerTypstLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: TYPST_LANGUAGE_ID,
      extensions: ['.typ'],
      aliases: ['Typst', 'typst']
    },
    configuration: typstLanguageConfiguration,
    loadGrammar: loadTypstTextMateGrammar
  })
}
