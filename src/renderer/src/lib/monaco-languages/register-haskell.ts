import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

const HASKELL_SCOPE = 'source.haskell'

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

function mapHaskellTokenScopes(scopes: readonly string[]): string {
  if (scopes.some((scope) => scope.startsWith('comment.'))) {
    return 'comment.haskell'
  }
  const scope = scopes.at(-1) ?? HASKELL_SCOPE
  if (scope.startsWith('constant.numeric.')) {
    return 'number.haskell'
  }
  if (scope.startsWith('constant.character.escape.')) {
    return 'string.escape.haskell'
  }
  if (scope.startsWith('entity.name.function.')) {
    return 'type.identifier.haskell'
  }
  if (scope.startsWith('storage.type.')) {
    return 'type.haskell'
  }
  if (scope.startsWith('variable.other.generic-type.')) {
    return 'variable.parameter.haskell'
  }
  return scope
}

export async function loadHaskellTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== HASKELL_SCOPE) {
    return null
  }
  // BSD-3-Clause grammar; provenance and license ship in resources/licenses/language-haskell.
  const grammarModule = await import('./textmate-grammars/haskell.tmLanguage.json')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TextMate adds the required $self/$base repository entries; real tokenizer tests validate this generated upstream grammar.
  return grammarModule.default as unknown as IRawGrammar
}

export function registerHaskellLanguage(monaco: Pick<typeof Monaco, 'languages'>): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: 'haskell',
      extensions: ['.hs', '.hsig', '.hs-boot'],
      aliases: ['Haskell', 'haskell']
    },
    configuration: haskellLanguageConfiguration,
    scopeName: HASKELL_SCOPE,
    loadGrammar: loadHaskellTextMateGrammar,
    mapTokenScopes: mapHaskellTokenScopes
  })
}
