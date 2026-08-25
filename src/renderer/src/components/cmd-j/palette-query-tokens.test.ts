import { describe, expect, it } from 'vitest'
import {
  isCmdJPaletteQueryOverTokenLimit,
  normalizeCmdJPaletteQuery,
  tokenizeCmdJPaletteQuery
} from './palette-query-tokens'
import { normalizePaletteText } from '@/lib/palette-match/normalized-text'
import { PALETTE_QUERY_MAX_TOKENS } from '@/lib/palette-match/palette-query'

describe('Cmd+J palette query normalization', () => {
  it('lowercases supplementary-plane characters as whole code points', () => {
    // Why: code-unit iteration split '\u{10400}' into surrogate halves, which lowercase to
    // themselves, so the query never matched its lowercase counterpart.
    expect(normalizeCmdJPaletteQuery('\u{10400} HELLO')).toBe('\u{10428} hello')
    expect(tokenizeCmdJPaletteQuery('\u{10400} HELLO')).toEqual(['\u{10428}', 'hello'])
  })

  it('collapses surrounding and repeated whitespace', () => {
    expect(normalizeCmdJPaletteQuery('  New\n\tTerminal  ')).toBe('new terminal')
  })

  it('folds CJK, accented, and non-breaking-space text exactly like the shared matcher', () => {
    // Why: Cmd+J sections that fold a query differently disagree about what the user typed.
    const query = ' CAFE\u0301 系统\u3000ÉCOLE\u00a0Test '

    expect(normalizeCmdJPaletteQuery(query)).toBe('café 系统 école test')
    expect(tokenizeCmdJPaletteQuery(query)).toEqual(['café', '系统', 'école', 'test'])
    for (const token of normalizeCmdJPaletteQuery(query).split(' ')) {
      expect(normalizePaletteText(token).normalized).toBe(token)
    }
  })
})

describe('Cmd+J palette query token ceiling', () => {
  const tokens = Array.from({ length: PALETTE_QUERY_MAX_TOKENS }, (_, index) => `token${index}`)

  it('accepts the shared ceiling and counts unique tokens only', () => {
    expect(isCmdJPaletteQueryOverTokenLimit(tokens.join(' '))).toBe(false)
    expect(isCmdJPaletteQueryOverTokenLimit([...tokens, tokens[0]].join(' '))).toBe(false)
  })

  it('rejects one token past the shared ceiling', () => {
    expect(isCmdJPaletteQueryOverTokenLimit([...tokens, 'extra'].join(' '))).toBe(true)
  })

  it('counts punctuation-bearing tokens as one top-level token', () => {
    // Why: this file's scoring tokenizer splits `1.4.182` into three, but the ceiling is a
    // whitespace-split query rule shared with the entity sections.
    expect(isCmdJPaletteQueryOverTokenLimit('08-13 1.4.182 orca/main #123')).toBe(false)
  })
})
