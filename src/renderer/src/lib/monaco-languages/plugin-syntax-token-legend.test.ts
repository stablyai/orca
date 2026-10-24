import { vs, vs_dark } from 'monaco-editor/esm/vs/editor/standalone/common/themes.js'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_SYNTAX_TOKEN_TYPES,
  encodePluginSyntaxTokens,
  pluginSyntaxTokenType
} from './plugin-syntax-token-legend'

const name = (scopes: string[]) => {
  const index = pluginSyntaxTokenType(scopes)
  return index === null ? null : PLUGIN_SYNTAX_TOKEN_TYPES[index]
}

describe('plugin syntax token legend', () => {
  it.each([
    ['light', vs],
    ['dark', vs_dark]
  ])('names only tokens the built-in %s theme styles', (_label, theme) => {
    for (const token of PLUGIN_SYNTAX_TOKEN_TYPES) {
      // Monaco matches rules by dotted prefix, so a rule for the token or a parent styles it.
      const styled = theme.rules.some(
        (rule) =>
          rule.token !== '' &&
          (token === rule.token || token.startsWith(`${rule.token}.`)) &&
          Boolean(rule.foreground ?? rule.fontStyle)
      )
      expect(styled, token).toBe(true)
    }
  })

  it('picks the innermost styled scope and skips punctuation', () => {
    expect(name(['source.gleam', 'comment.line.gleam', 'punctuation.definition.comment'])).toBe(
      'comment'
    )
    expect(
      name(['source.x', 'string.quoted.double.x', 'punctuation.definition.string.begin'])
    ).toBe('string')
    expect(name(['source.x', 'meta.function.x', 'entity.name.type.x'])).toBe('type')
    expect(name(['source.x', 'constant.numeric.integer.x'])).toBe('number')
    expect(name(['source.x', 'keyword.control.flow.x'])).toBe('keyword.flow')
    expect(name(['source.x', 'storage.type.x'])).toBe('keyword')
    expect(name(['source.x', 'meta.brace.x', 'punctuation.section.block.x'])).toBe('delimiter')
    expect(name(['source.x', 'meta.function.x', 'entity.name.function.x'])).toBeNull()
  })

  it('delta-encodes absolute quads as Monaco semantic tokens', () => {
    expect([
      ...encodePluginSyntaxTokens(new Uint32Array([0, 0, 3, 5, 0, 4, 1, 1, 2, 2, 5, 0]))
    ]).toEqual([0, 0, 3, 5, 0, 0, 4, 1, 1, 0, 2, 2, 5, 0, 0])
  })
})
