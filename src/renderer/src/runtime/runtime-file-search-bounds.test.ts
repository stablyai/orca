import { describe, expect, it } from 'vitest'
import {
  createEmptyRuntimeFileSearchResult,
  getRuntimeFileSearchRejectedField,
  isRuntimeFileSearchTextWithinLimit
} from './runtime-file-search-bounds'

describe('runtime file search bounds', () => {
  it('measures query limits as UTF-8 bytes without splitting emoji', () => {
    expect(isRuntimeFileSearchTextWithinLimit('abc', 3)).toBe(true)
    expect(isRuntimeFileSearchTextWithinLimit('😀', 3)).toBe(false)
  })

  it('rejects oversized pasted query and glob fields before search execution', () => {
    expect(
      getRuntimeFileSearchRejectedField({
        query: 'needle',
        includePattern: 'x'.repeat(9 * 1024),
        excludePattern: 'dist/**'
      })
    ).toBe('includePattern')

    expect(
      getRuntimeFileSearchRejectedField({
        query: 'x'.repeat(9 * 1024)
      })
    ).toBe('query')
  })

  it('returns metadata-only empty results for rejected searches', () => {
    const result = createEmptyRuntimeFileSearchResult()

    expect(result).toEqual({ files: [], totalMatches: 0, truncated: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
