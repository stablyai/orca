import { describe, expect, it } from 'vitest'
import { buildGitLabIssueUrl, normalizeGitLabLinkQuery } from './gitlab-links'
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

describe('buildGitLabIssueUrl', () => {
  it('keeps the self-hosted host and nested groups', () => {
    expect(buildGitLabIssueUrl({ host: 'git.acme.dev', path: 'team/sub/app' }, 7)).toBe(
      'https://git.acme.dev/team/sub/app/-/issues/7'
    )
  })

  it('decodes percent-encoded segments before encoding them once', () => {
    expect(buildGitLabIssueUrl({ host: 'gitlab.com', path: '%73quad/app' }, 7)).toBe(
      'https://gitlab.com/squad/app/-/issues/7'
    )
  })
})
