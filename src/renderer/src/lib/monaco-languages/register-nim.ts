import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const NIM_LANGUAGE_ID = 'nim'
export const NIM_TEXTMATE_SCOPE = 'source.nim'

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

export async function loadNimTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== NIM_TEXTMATE_SCOPE) {
    return null
  }

  // Why: Nim highlighting uses the maintained VS Code TextMate grammar from
  // nim-lang/vscode-nim (MIT; see textmate-grammars/nim-LICENSE.txt).
  const grammarModule = await import('./textmate-grammars/nim.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerNimLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: NIM_LANGUAGE_ID,
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    },
    configuration: nimLanguageConfiguration,
    scopeName: NIM_TEXTMATE_SCOPE,
    loadGrammar: loadNimTextMateGrammar
  })
}
