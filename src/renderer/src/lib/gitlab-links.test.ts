import { describe, expect, it } from 'vitest'
import { normalizeGitLabLinkQuery, parseGitLabIssueOrMRLink } from './gitlab-links'
import { WORK_ITEM_LINK_QUERY_MAX_BYTES } from './work-item-link-query-bounds'

describe('parseGitLabIssueOrMRLink', () => {
  it('preserves explicit ports on self-hosted GitLab hosts', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.example.com:8443/team/api/-/issues/7')).toEqual(
      {
        slug: { host: 'gitlab.example.com:8443', path: 'team/api' },
        number: 7,
        type: 'issue'
      }
    )
  })

  it('treats /-/work_items/<iid> as an issue work item', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/-/work_items/923')).toEqual({
      slug: { host: 'gitlab.com', path: 'stablyai/orca' },
      number: 923,
      type: 'issue'
    })
    expect(
      parseGitLabIssueOrMRLink('https://gitlab.example.com:8443/team/api/-/work_items/7')
    ).toEqual({
      slug: { host: 'gitlab.example.com:8443', path: 'team/api' },
      number: 7,
      type: 'issue'
    })
  })

  it('extracts slug, number, and type from URLs with trailing page segments', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/g/p/-/merge_requests/77/diffs')).toEqual({
      slug: { host: 'gitlab.com', path: 'g/p' },
      number: 77,
      type: 'mr'
    })
    expect(
      parseGitLabIssueOrMRLink('https://gitlab.com/g/p/-/merge_requests/77/diffs.diff?diff_id=1')
    ).toEqual({
      slug: { host: 'gitlab.com', path: 'g/p' },
      number: 77,
      type: 'mr'
    })
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/g/p/-/issues/923/designs')).toEqual({
      slug: { host: 'gitlab.com', path: 'g/p' },
      number: 923,
      type: 'issue'
    })
  })
})

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
