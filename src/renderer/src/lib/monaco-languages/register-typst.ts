import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
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

export async function loadTypstTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== TYPST_TEXTMATE_SCOPE) {
    return null
  }

  // Why: Keep grammar loading lazy; it comes from Typst's maintained TextMate
  // grammar (Apache-2.0; see textmate-grammars/typst-LICENSE.txt).
  const grammarModule = await import('./textmate-grammars/typst.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerTypstLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: TYPST_LANGUAGE_ID,
      extensions: ['.typ'],
      aliases: ['Typst', 'typst']
    },
    configuration: typstLanguageConfiguration,
    scopeName: TYPST_TEXTMATE_SCOPE,
    loadGrammar: loadTypstTextMateGrammar
  })
}
