import { describe, expect, it, vi } from 'vitest'
import {
  ORCA_MONACO_DARK_THEME,
  ORCA_MONACO_DARK_THEME_RULES,
  ORCA_MONACO_LIGHT_THEME,
  ORCA_MONACO_LIGHT_THEME_RULES,
  registerOrcaMonacoTheme
} from './orca-monaco-theme'

function getRuleTokens(rules: { token: string }[]): string[] {
  return rules.map((rule) => rule.token)
}

describe('registerOrcaMonacoTheme', () => {
  it('registers both internal Orca Monaco themes', () => {
    const defineTheme = vi.fn()
    const monaco = { editor: { defineTheme } }

    registerOrcaMonacoTheme(monaco as never)

    expect(defineTheme).toHaveBeenCalledWith(
      ORCA_MONACO_LIGHT_THEME,
      expect.objectContaining({ base: 'vs', rules: ORCA_MONACO_LIGHT_THEME_RULES })
    )
    expect(defineTheme).toHaveBeenCalledWith(
      ORCA_MONACO_DARK_THEME,
      expect.objectContaining({ base: 'vs-dark', rules: ORCA_MONACO_DARK_THEME_RULES })
    )
  })

  it('covers representative lexical TextMate scopes without broad noisy scopes', () => {
    const lightTokens = getRuleTokens(ORCA_MONACO_LIGHT_THEME_RULES)
    const darkTokens = getRuleTokens(ORCA_MONACO_DARK_THEME_RULES)
    const expectedTokens = [
      'variable.other.property',
      'entity.other.attribute-name',
      'constant.character.escape',
      'string.regexp',
      'keyword.operator',
      'markup.heading',
      'markup.inline.raw',
      'punctuation.definition.string',
      'punctuation.definition.comment'
    ]

    expect(lightTokens).toEqual(expect.arrayContaining(expectedTokens))
    expect(darkTokens).toEqual(expect.arrayContaining(expectedTokens))

    for (const token of ['meta', 'source', 'text', 'punctuation']) {
      expect(lightTokens).not.toContain(token)
      expect(darkTokens).not.toContain(token)
    }
  })
})
