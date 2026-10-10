import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'
import { haskellFunctionThemeColors, mapHaskellTokenScopes } from './haskell-token-scopes'

type MonacoModule = typeof Monaco

export const HASKELL_LANGUAGE_ID = 'haskell'
export const HASKELL_TEXTMATE_SCOPE = 'source.haskell'

export const haskellLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '--', blockComment: ['{-', '-}'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

/** Lazily loads the vendored Haskell grammar, returning null for unrelated scopes. */
export async function loadHaskellTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== HASKELL_TEXTMATE_SCOPE) {
    return null
  }

  // Lazy upstream grammar; provenance and BSD-3-Clause license are in haskell-LICENSE.txt.
  const grammarModule = await import('./textmate-grammars/haskell.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate injects the $self/$base entries required by IRawGrammar; tokenization tests validate the vendored JSON.
  return grammarModule.default as unknown as IRawGrammar
}

/** Registers Haskell once with lazy tokenization and light/dark function colors. */
export function registerHaskellLanguage(monaco: MonacoModule): void {
  if (monaco.languages.getLanguages().some(({ id }) => id === HASKELL_LANGUAGE_ID)) {
    return
  }
  for (const base of ['vs', 'vs-dark'] as const) {
    monaco.editor.defineTheme(base, {
      base,
      inherit: true,
      rules: [
        { token: 'entity.name.function.haskell', foreground: haskellFunctionThemeColors[base] }
      ],
      colors: {}
    })
  }
  registerTextMateLanguage(monaco, {
    language: {
      id: HASKELL_LANGUAGE_ID,
      extensions: ['.hs', '.hsig', '.hs-boot'],
      aliases: ['Haskell', 'haskell']
    },
    configuration: haskellLanguageConfiguration,
    scopeName: HASKELL_TEXTMATE_SCOPE,
    loadGrammar: loadHaskellTextMateGrammar,
    mapTokenScopes: mapHaskellTokenScopes
  })
}
