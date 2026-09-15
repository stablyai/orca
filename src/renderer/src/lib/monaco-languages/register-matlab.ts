import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const MATLAB_LANGUAGE_ID = 'matlab'
export const MATLAB_TEXTMATE_SCOPE = 'source.matlab'

export const matlabLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '%'
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
    { open: "'", close: "'" },
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: "'", close: "'" },
    { open: '"', close: '"' }
  ]
}

export async function loadMatlabTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== MATLAB_TEXTMATE_SCOPE) {
    return null
  }

  // Why: MathWorks MATLAB TextMate grammar (BSD-style; see matlab-LICENSE.txt).
  const grammarModule = await import('./textmate-grammars/matlab.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerMatlabLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: MATLAB_LANGUAGE_ID,
      // Why: issue #10363 — .m files currently have no mapping and render as
      // plaintext. Prefer MATLAB over Monaco's unused objective-c registration.
      extensions: ['.m'],
      aliases: ['MATLAB', 'matlab']
    },
    configuration: matlabLanguageConfiguration,
    scopeName: MATLAB_TEXTMATE_SCOPE,
    loadGrammar: loadMatlabTextMateGrammar
  })
}
