import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const GROOVY_LANGUAGE_ID = 'groovy'
export const GROOVY_TEXTMATE_SCOPE = 'source.groovy'

export const groovyLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
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
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export async function loadGroovyTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== GROOVY_TEXTMATE_SCOPE) {
    return null
  }

  // Lazy upstream grammar; provenance and license are in groovy-LICENSE.txt.
  const grammarModule = await import('./textmate-grammars/groovy.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate injects the $self/$base repository entries required by IRawGrammar; real tokenization tests validate this vendored JSON.
  return grammarModule.default as unknown as IRawGrammar
}

export function registerGroovyLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: GROOVY_LANGUAGE_ID,
      extensions: ['.groovy', '.gvy', '.gy', '.gsh', '.gradle', '.jenkinsfile'],
      filenames: ['Jenkinsfile'],
      aliases: ['Groovy', 'groovy']
    },
    configuration: groovyLanguageConfiguration,
    scopeName: GROOVY_TEXTMATE_SCOPE,
    loadGrammar: loadGroovyTextMateGrammar
  })
}
