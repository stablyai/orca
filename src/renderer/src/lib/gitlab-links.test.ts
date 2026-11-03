import { describe, expect, it } from 'vitest'
import { normalizeGitLabLinkQuery } from './gitlab-links'
import { WORK_ITEM_LINK_QUERY_MAX_BYTES } from './work-item-link-query-bounds'

describe('normalizeGitLabLinkQuery', () => {
  it('rejects oversized pasted link queries without echoing their content', () => {
    const secret = 'gitlab-link-secret'
    const result = normalizeGitLabLinkQuery(secret + 'x'.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES))

    expect(result).toEqual({ query: '', directNumber: null, tooLarge: true })
  })

  it('rejects oversized whitespace before trimming link queries', () => {
    expect(normalizeGitLabLinkQuery(' '.repeat(WORK_ITEM_LINK_QUERY_MAX_BYTES + 1))).toEqual({
      query: '',
      directNumber: null,
      tooLarge: true
    })
  })
})
