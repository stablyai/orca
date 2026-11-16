import { describe, expect, it } from 'vitest'
import { findUnicodeHighlights } from './pierre-diff-unicode-highlight'

describe('findUnicodeHighlights', () => {
  it('flags zero-width and bidi control characters', () => {
    expect(findUnicodeHighlights('const isAdmin​ = true', true)).toEqual([
      { start: 13, end: 14, kind: 'invisible' }
    ])
    expect(findUnicodeHighlights('if (role != "user‮ ⁦// admin⁩")', true)).toEqual([
      { start: 17, end: 18, kind: 'invisible' },
      { start: 19, end: 20, kind: 'invisible' },
      { start: 28, end: 29, kind: 'invisible' }
    ])
  })

  it('flags a Cyrillic letter hiding in a Latin word, not a Russian word', () => {
    expect(findUnicodeHighlights('const pаypal = 1', true)).toEqual([
      { start: 7, end: 8, kind: 'ambiguous' }
    ])
    expect(findUnicodeHighlights('// привет мир', true)).toEqual([])
  })

  it('skips confusables when ambiguous highlighting is off, and ignores CR', () => {
    expect(findUnicodeHighlights('const pаypal = 1\r', false)).toEqual([])
  })
})
