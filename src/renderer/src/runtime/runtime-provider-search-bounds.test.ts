import { describe, expect, it } from 'vitest'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'

describe('runtime provider search bounds', () => {
  it('accepts absent provider queries and small text', () => {
    expect(isRuntimeProviderSearchQueryWithinLimit(undefined)).toBe(true)
    expect(isRuntimeProviderSearchQueryWithinLimit(null)).toBe(true)
    expect(isRuntimeProviderSearchQueryWithinLimit('project = ORCA', 14)).toBe(true)
  })

  it('measures pasted provider search text as UTF-8 bytes', () => {
    expect(isRuntimeProviderSearchQueryWithinLimit('😀', 3)).toBe(false)
  })

  it('rejects oversized pasted provider search queries', () => {
    expect(isRuntimeProviderSearchQueryWithinLimit('x'.repeat(9 * 1024))).toBe(false)
  })
})
