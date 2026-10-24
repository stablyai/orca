import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from 'shiki/core'
import { registerTextMateLanguage } from './textmate-language-registration'

export async function loadLatexTextMateGrammars(): Promise<LanguageRegistration[]> {
  const { default: grammars } = await import('shiki/langs/latex.mjs')
  return grammars
}

export function registerLatexLanguage(monaco: typeof Monaco): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'latex',
      extensions: ['.tex', '.ltx', '.sty'],
      aliases: ['LaTeX', 'latex']
    },
    loadGrammar: loadLatexTextMateGrammars
  })
}
