import { describe, expect, it } from 'vitest'
import { normalizeCmdJPaletteQuery, tokenizeCmdJPaletteQuery } from './palette-query-tokens'

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
})
