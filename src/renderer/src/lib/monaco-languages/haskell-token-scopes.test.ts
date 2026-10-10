import { describe, expect, it } from 'vitest'
import { TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js'
import { TokenMetadata } from 'monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'
import { vs, vs_dark } from 'monaco-editor/esm/vs/editor/standalone/common/themes.js'
import { haskellFunctionThemeColors, mapHaskellTokenScopes } from './haskell-token-scopes'

describe('mapHaskellTokenScopes', () => {
  it.each([
    ['vs-dark', vs_dark, ['DCDCAA', '569CD6', 'B5CEA8', 'D4D4D4']],
    ['vs', vs, ['795E26', '0000FF', '098658', '000000']]
  ] as const)(
    'resolves functions, types, numbers, and constructors with the %s theme',
    (base, theme, expected) => {
      const tokens = TokenTheme.createFromRawTokenTheme(
        [
          ...theme.rules,
          { token: 'entity.name.function.haskell', foreground: haskellFunctionThemeColors[base] }
        ],
        []
      )
      const colors = tokens.getColorMap()
      const scopes = [
        'entity.name.function.haskell',
        'storage.type.haskell',
        'constant.numeric.integral.decimal.haskell',
        'constant.other.haskell'
      ]
      expect(
        scopes.map((scope) =>
          colors[TokenMetadata.getForeground(tokens.match(1, mapHaskellTokenScopes([scope])))]
            .toString()
            .slice(1)
            .toUpperCase()
        )
      ).toEqual(expected)
    }
  )

  it.each([
    ['entity.name.function.haskell', 'entity.name.function.haskell'],
    ['entity.name.function.infix.haskell', 'entity.name.function.haskell'],
    ['storage.type.haskell', 'keyword.haskell'],
    ['storage.type.operator.infix.haskell', 'keyword.haskell'],
    ['variable.other.generic-type.haskell', 'variable.parameter.haskell'],
    ['constant.other.haskell', 'identifier.haskell'],
    ['constant.other.operator.infix.haskell', 'identifier.haskell'],
    ['constant.numeric.integral.decimal.haskell', 'number.haskell'],
    ['constant.numeric.floating.hexadecimal.haskell', 'number.haskell'],
    ['constant.character.escape.haskell', 'string.escape.haskell'],
    ['keyword.operator.double-colon.haskell', 'operator.haskell'],
    ['keyword.operator.arrow.haskell', 'operator.haskell'],
    ['string.quoted.double.haskell', 'string.quoted.double.haskell']
  ])('maps %s to the Monaco style %s', (scope, expected) => {
    expect(mapHaskellTokenScopes(['source.haskell', scope])).toBe(expected)
  })

  it('preserves comment color for nested delimiter and documentation scopes', () => {
    expect(
      mapHaskellTokenScopes([
        'source.haskell',
        'comment.block.haskell',
        'punctuation.definition.comment.haskell'
      ])
    ).toBe('comment.haskell')
  })

  it('leaves ordinary identifiers and unknown scopes on their existing style', () => {
    expect(mapHaskellTokenScopes(['source.haskell'])).toBe('source.haskell')
    expect(mapHaskellTokenScopes([])).toBe('source.haskell')
  })
})
