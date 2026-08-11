import { describe, expect, it } from 'vitest'
import { getUtf8ChunkEndIndex, isUtf8ByteLengthWithinLimit } from './utf8-byte-limits'

describe('getUtf8ChunkEndIndex', () => {
  it.each([
    { name: 'ASCII', text: 'abcdef', maxBytes: 3, endIndex: 3 },
    { name: 'multibyte characters', text: 'aé中z', maxBytes: 6, endIndex: 3 }
  ])('respects the byte budget for $name', ({ text, maxBytes, endIndex }) => {
    expect(getUtf8ChunkEndIndex(text, 0, maxBytes)).toBe(endIndex)
  })

  it('never splits valid surrogate pairs', () => {
    expect(getUtf8ChunkEndIndex('a😀b', 0, 4)).toBe(1)
    expect(getUtf8ChunkEndIndex('a😀b', 1, 4)).toBe(3)
  })

  it.each(['\ud800a', '\udc00a'])('counts a lone surrogate as three bytes', (text) => {
    expect(getUtf8ChunkEndIndex(text, 0, 3)).toBe(1)
  })

  it('starts measuring at the requested offset', () => {
    expect(getUtf8ChunkEndIndex('skipé中tail', 4, 5)).toBe(6)
  })

  it('returns the starting index when no text remains', () => {
    expect(getUtf8ChunkEndIndex('', 0, 1)).toBe(0)
    expect(getUtf8ChunkEndIndex('abc', 3, 1)).toBe(3)
  })

  it.each([0, -1])('consumes one code point when the %s-byte budget is exceeded', (maxBytes) => {
    expect(getUtf8ChunkEndIndex('😀a', 0, maxBytes)).toBe(2)
  })

  it('preserves raw non-finite budget comparisons', () => {
    expect(getUtf8ChunkEndIndex('abc', 0, Number.NaN)).toBe(3)
    expect(getUtf8ChunkEndIndex('abc', 0, Number.POSITIVE_INFINITY)).toBe(3)
    expect(getUtf8ChunkEndIndex('abc', 0, Number.NEGATIVE_INFINITY)).toBe(1)
  })
})

describe('isUtf8ByteLengthWithinLimit', () => {
  it.each([
    { name: 'ASCII at a finite limit', text: 'abc', maxBytes: 3, expected: true },
    { name: 'ASCII over a finite limit', text: 'abcd', maxBytes: 3, expected: false },
    { name: 'multibyte text at its limit', text: 'é中', maxBytes: 5, expected: true },
    { name: 'multibyte text over its limit', text: 'é中', maxBytes: 4, expected: false },
    { name: 'empty text with a negative limit', text: '', maxBytes: -1, expected: true },
    {
      name: 'nonempty text with negative infinity',
      text: 'a',
      maxBytes: -Infinity,
      expected: false
    },
    { name: 'text with a NaN limit', text: '😀', maxBytes: Number.NaN, expected: true },
    { name: 'text with positive infinity', text: '😀', maxBytes: Infinity, expected: true }
  ])('$name', ({ text, maxBytes, expected }) => {
    expect(isUtf8ByteLengthWithinLimit(text, maxBytes)).toBe(expected)
  })
})
