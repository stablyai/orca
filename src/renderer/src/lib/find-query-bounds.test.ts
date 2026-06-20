import { describe, expect, it } from 'vitest'

import { FIND_QUERY_MAX_BYTES, getFindRequestQuery, isFindQueryTooLarge } from './find-query-bounds'

describe('find query bounds', () => {
  it('keeps find queries within the byte budget', () => {
    expect(getFindRequestQuery('needle')).toBe('needle')
  })

  it('rejects oversized ASCII find queries', () => {
    const query = 'x'.repeat(FIND_QUERY_MAX_BYTES + 1)

    expect(isFindQueryTooLarge(query)).toBe(true)
    expect(getFindRequestQuery(query)).toBeNull()
  })

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    const query = 'é'.repeat(FIND_QUERY_MAX_BYTES / 2 + 1)

    expect(isFindQueryTooLarge(query)).toBe(true)
    expect(getFindRequestQuery(query)).toBeNull()
  })
})
