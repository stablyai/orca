import { describe, expect, it } from 'vitest'
import {
  cmdJPaletteTokenScore,
  isCmdJPaletteQueryOverTokenLimit,
  normalizeCmdJPaletteQuery,
  tokenizeCmdJPaletteQuery
} from './palette-query-tokens'
import { PALETTE_QUERY_MAX_TOKENS } from '../../../../shared/palette-match/palette-query'

describe('Cmd+J palette query normalization', () => {
  it('folds CJK, accented, and non-breaking-space text exactly like the shared matcher', () => {
    const query = ' CAFE\u0301 系统\u3000ÉCOLE\u00a0Test '

    expect(normalizeCmdJPaletteQuery(query)).toBe('café 系统 école test')
    expect(tokenizeCmdJPaletteQuery(query)).toEqual(['café', '系统', 'école', 'test'])
  })
})

describe('Cmd+J palette token scoring', () => {
  it('matches a CJK compound query against its keyword parts', () => {
    expect(cmdJPaletteTokenScore(['终端设置'], ['终端', '设置'])).toBeGreaterThan(0)
    expect(cmdJPaletteTokenScore(['终端'], ['终端', '设置'])).toBeGreaterThan(0)
  })

  it('does not score a Latin keyword merely contained in the query token', () => {
    expect(cmdJPaletteTokenScore(['database'], ['base'])).toBe(0)
    expect(cmdJPaletteTokenScore(['worktree'], ['tree'])).toBe(0)
  })

  it('rejects a query whose punctuation split blows past the ceiling', () => {
    // Whitespace-split counting saw one token; the scoring tokenizer saw hundreds.
    const punctuationHeavy = Array.from(
      { length: PALETTE_QUERY_MAX_TOKENS + 1 },
      (_, i) => `t${i}`
    ).join('.')
    expect(isCmdJPaletteQueryOverTokenLimit(punctuationHeavy)).toBe(true)
  })
})
