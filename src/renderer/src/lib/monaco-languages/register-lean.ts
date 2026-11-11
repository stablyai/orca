import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

export async function loadLeanTextMateGrammar(): Promise<LanguageRegistration> {
  const { default: grammars } = await import('shiki/langs/lean.mjs')
  const grammar = grammars[0]
  const repository = Object.assign({}, grammar.repository)
  // TextMate drops this rule when its only pattern includes the unbundled Lean Markdown grammar.
  repository.dashComment = { ...repository.dashComment, patterns: [] }
  return { ...grammar, repository }
}

export function registerLeanLanguage(monaco: typeof Monaco): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'lean',
      extensions: ['.lean'],
      aliases: ['Lean 4', 'Lean', 'lean', 'lean4']
    },
    loadGrammar: loadLeanTextMateGrammar
  })
}
