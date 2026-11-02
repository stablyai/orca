import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES,
  findTextMatchRanges,
  isMarkdownPreviewSearchQueryTooLarge
} from './markdown-preview-search'

describe('findTextMatchRanges', () => {
  it('preserves code-point folding and offsets for Unicode around ASCII matches', () => {
    expect(findTextMatchRanges('ΟΣ οσ ος', 'οσ')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
    expect(findTextMatchRanges('😀Before İneedle 😀NEEDLE', 'needle')).toEqual([
      { start: 10, end: 16 },
      { start: 19, end: 25 }
    ])
    expect(findTextMatchRanges('ABCİDEF', 'i\u0307d')).toEqual([{ start: 3, end: 5 }])
  })

  it('folds uppercase Greek queries the same way as the indexed text', () => {
    expect(findTextMatchRanges('ΟΣ οσ ος', 'ΟΣ')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
    expect(findTextMatchRanges('ΟΣ οσ', 'ΟΣ', { matchCase: true })).toEqual([{ start: 0, end: 2 }])
  })

  it('maps locale-lowercase search matches back to original text offsets', () => {
    const ranges = findTextMatchRanges('İstanbul', 'stan')

    expect(ranges).toEqual([{ start: 1, end: 5 }])
    expect(ranges.map((range) => 'İstanbul'.slice(range.start, range.end))).toEqual(['stan'])
  })

  it('checks whole-word boundaries around astral letters by code point', () => {
    const text = '𐐀cat cat𐐀 cat'

    expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([{ start: 12, end: 15 }])
  })

  it('rejects oversized pasted queries before indexing preview text', () => {
    const oversizedQuery = 'secret-preview-search'.repeat(MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES)
    const throwingText = {
      [Symbol.iterator](): IterableIterator<string> {
        throw new Error('oversized markdown preview searches must not scan text')
      }
    } as string

    expect(isMarkdownPreviewSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(findTextMatchRanges(throwingText, oversizedQuery)).toEqual([])
  })
})
