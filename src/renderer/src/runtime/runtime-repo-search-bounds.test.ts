import { describe, expect, it } from 'vitest'
import { isRuntimeRepoRefSearchQueryWithinLimit } from './runtime-repo-search-bounds'

describe('runtime repo ref search bounds', () => {
  it('measures branch search query limits as UTF-8 bytes', () => {
    expect(isRuntimeRepoRefSearchQueryWithinLimit('abc', 3)).toBe(true)
    expect(isRuntimeRepoRefSearchQueryWithinLimit('😀', 3)).toBe(false)
  })

  it('rejects oversized pasted branch search queries', () => {
    expect(isRuntimeRepoRefSearchQueryWithinLimit('x'.repeat(3 * 1024))).toBe(false)
  })
})
