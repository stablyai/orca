import { describe, expect, it } from 'vitest'
import { normalizeGitHubLinkQuery } from './github-links'
import { WORK_ITEM_LINK_QUERY_MAX_BYTES } from './work-item-link-query-bounds'

describe('normalizeGitHubLinkQuery', () => {
  it('rejects oversized pasted link queries without echoing their content', () => {
    const secret = 'github-link-secret'
    const result = normalizeGitHubLinkQuery(secret + 'x'.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES))

    expect(result).toEqual({ query: '', directNumber: null, tooLarge: true })
  })

  it('rejects oversized whitespace before trimming link queries', () => {
    expect(normalizeGitHubLinkQuery(' '.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES + 1))).toEqual({
      query: '',
      directNumber: null,
      tooLarge: true
    })
  })
})
