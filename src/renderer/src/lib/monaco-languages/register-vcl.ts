import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const VCL_LANGUAGE_ID = 'vcl'
export const VCL_TEXTMATE_SCOPE = 'source.vcl'

export const vclLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#',
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

export async function loadVclTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== VCL_TEXTMATE_SCOPE) {
    return null
  }

  // Why: VCL highlighting uses the maintained TextMate grammar from
  // fastly/vscode-fastly-vcl (MIT; see textmate-grammars/vcl-LICENSE.txt).
  // Covers Fastly VCL and the shared core of open-source Varnish VCL.
  const grammarModule = await import('./textmate-grammars/vcl.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerVclLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: VCL_LANGUAGE_ID,
      extensions: ['.vcl'],
      aliases: ['VCL', 'vcl', 'Varnish Configuration Language']
    },
    configuration: vclLanguageConfiguration,
    scopeName: VCL_TEXTMATE_SCOPE,
    loadGrammar: loadVclTextMateGrammar
  })
}
