import { describe, expect, it } from 'vitest'
import { createRipgrepOffsetReader, ripgrepMatchRanges } from './ripgrep-match-offsets'

describe('ripgrep match offsets', () => {
  it('converts ordered ASCII, accented, CJK and astral boundaries to UTF16', () => {
    const text = 'aé日😀z'
    const read = createRipgrepOffsetReader(text)
    expect([0, 1, 3, 6, 10, 11].map(read)).toEqual([0, 1, 2, 3, 5, 6])
    expect(read(11)).toBe(6)
  })

  it('rejects invalid, backwards and partial codepoint offsets', () => {
    const read = createRipgrepOffsetReader('é😀')
    expect(read(-1)).toBeNull()
    expect(read(0.5)).toBeNull()
    expect(read(1)).toBeNull()
    expect(read(2)).toBe(1)
    expect(read(0)).toBeNull()
    expect(read(6)).toBe(3)
    expect(read(7)).toBeNull()
  })

  it('handles many adjacent matches in one pass', () => {
    const read = createRipgrepOffsetReader('😀x'.repeat(10_000))
    for (let index = 0; index < 10_000; index++) {
      expect(read(index * 5)).toBe(index * 3)
      expect(read(index * 5 + 4)).toBe(index * 3 + 2)
    }
  })

  it('preserves zero-length matches and whole-codepoint line fallbacks', () => {
    expect([...ripgrepMatchRanges('😀é', [{ start: 4, end: 4 }])]).toEqual([{ start: 2, end: 2 }])
    expect([...ripgrepMatchRanges('😀é', [])]).toEqual([{ start: 0, end: 2 }])
    expect([...ripgrepMatchRanges('', [])]).toEqual([{ start: 0, end: 0 }])
  })
})
