import { describe, expect, it } from 'vitest'

import { RUNTIME_PROVIDER_SEARCH_QUERY_MAX_BYTES } from '@/runtime/runtime-provider-search-bounds'

import { getLinearProjectSearchRequestQuery } from './linear-project-search-query'

describe('getLinearProjectSearchRequestQuery', () => {
  it('keeps project queries within the provider search budget', () => {
    expect(getLinearProjectSearchRequestQuery('roadmap')).toBe('roadmap')
  })

  it('rejects oversized ASCII project queries before provider lookup', () => {
    const query = 'x'.repeat(RUNTIME_PROVIDER_SEARCH_QUERY_MAX_BYTES + 1)

    expect(getLinearProjectSearchRequestQuery(query)).toBeNull()
  })

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    const query = 'é'.repeat(RUNTIME_PROVIDER_SEARCH_QUERY_MAX_BYTES / 2 + 1)

    expect(getLinearProjectSearchRequestQuery(query)).toBeNull()
  })
})
