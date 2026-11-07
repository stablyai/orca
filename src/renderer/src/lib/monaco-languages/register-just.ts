import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = Pick<typeof Monaco, 'languages'>

export const JUST_LANGUAGE_ID = 'just'

export const justLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#'
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

async function loadJustGrammars(): Promise<LanguageRegistration[]> {
  const { default: grammars } = await import('shiki/langs/just.mjs')
  return grammars
}

export async function loadJustTextMateGrammar(): Promise<LanguageRegistration> {
  const grammars = await loadJustGrammars()
  const grammar = grammars.find((entry) => entry.name === JUST_LANGUAGE_ID)
  if (!grammar) {
    throw new Error('shiki does not ship a just grammar')
  }
  return grammar
}

/** The just grammar embeds other languages by scope; TextMate skips an include it cannot resolve. */
export async function loadJustGrammarDependencies(): Promise<LanguageRegistration[]> {
  const grammars = await loadJustGrammars()
  const byScope = new Map<string, LanguageRegistration>()
  for (const grammar of grammars) {
    if (grammar.name !== JUST_LANGUAGE_ID && !byScope.has(grammar.scopeName)) {
      byScope.set(grammar.scopeName, grammar)
    }
  }
  return [...byScope.values()]
}

export function registerJustLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: JUST_LANGUAGE_ID,
      extensions: ['.just'],
      aliases: ['Just', 'just']
    },
    configuration: justLanguageConfiguration,
    loadGrammar: loadJustTextMateGrammar,
    loadDependencies: loadJustGrammarDependencies
  })
}
