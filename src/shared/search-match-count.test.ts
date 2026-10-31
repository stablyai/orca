import { describe, expect, it } from 'vitest'
import { normalizeSearchFileMatchCount, normalizeSearchResult } from './search-match-count'
import type { SearchFileResult } from './code-search-types'

const match = { line: 1, column: 1, matchLength: 3, lineContent: 'foo' }

function makeFile(overrides: Partial<SearchFileResult> = {}): SearchFileResult {
  return {
    filePath: '/r/a.ts',
    relativePath: 'a.ts',
    matches: [match],
    ...overrides
  }
}

describe('normalizeSearchFileMatchCount', () => {
  it('falls back to matches length when matchCount is omitted', () => {
    expect(normalizeSearchFileMatchCount(makeFile({ matches: [match, match] }))).toBe(2)
  })

  it('repairs invalid and too-low counts', () => {
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: 0 }))).toBe(1)
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: -1 }))).toBe(1)
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: Number.NaN }))).toBe(1)
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: Number.POSITIVE_INFINITY }))).toBe(
      1
    )
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: 1.5 }))).toBe(1)
    expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: legacy wire input deliberately supplies a non-number count.
      normalizeSearchFileMatchCount(makeFile({ matchCount: 'invalid' as unknown as number }))
    ).toBe(1)
  })

  it('preserves valid counts greater than preview rows', () => {
    expect(normalizeSearchFileMatchCount(makeFile({ matchCount: 5 }))).toBe(5)
  })
})

describe('normalizeSearchResult', () => {
  it('drops empty file rows while preserving and normalizing populated rows', () => {
    const result = normalizeSearchResult({
      files: [
        makeFile({ matchCount: 3, matches: [] }),
        makeFile({
          filePath: '/r/kept.ts',
          relativePath: 'kept.ts',
          matches: [match, match],
          matchCount: 0
        })
      ],
      totalMatches: 2,
      truncated: true
    })

    expect(result).toEqual({
      files: [
        {
          filePath: '/r/kept.ts',
          relativePath: 'kept.ts',
          matches: [match, match],
          matchCount: 2
        }
      ],
      totalMatches: 2,
      truncated: true
    })
  })
})
