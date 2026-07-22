import { describe, expect, it } from 'vitest'
import {
  buildGitHubRepoUrl,
  normalizeGitHubLinkQuery,
  parseGitHubIssueOrPRLink,
  parseGitHubIssueOrPRNumber
} from './github-links'
import { WORK_ITEM_LINK_QUERY_MAX_BYTES } from './work-item-link-query-bounds'

describe('buildGitHubRepoUrl', () => {
  it('builds a GitHub repository URL from an owner/repo slug', () => {
    expect(buildGitHubRepoUrl({ owner: 'stablyai', repo: 'orca' })).toBe(
      'https://github.com/stablyai/orca'
    )
  })

  it('encodes path segments', () => {
    expect(buildGitHubRepoUrl({ owner: 'stably ai', repo: 'orca/tools' })).toBe(
      'https://github.com/stably%20ai/orca%2Ftools'
    )
  })

  it('links hosted slugs to their GitHub Enterprise server', () => {
    expect(buildGitHubRepoUrl({ owner: 'team', repo: 'orca', host: 'github.acme-corp.com' })).toBe(
      'https://github.acme-corp.com/team/orca'
    )
  })
})

describe('parseGitHubIssueOrPRNumber', () => {
  it('parses plain issue numbers and GitHub pull request URLs', () => {
    expect(parseGitHubIssueOrPRNumber('42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('#42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('https://github.com/stablyai/orca/pull/123')).toBe(123)
    expect(parseGitHubIssueOrPRNumber('https://github.com/stablyai/orca/issues/923')).toBe(923)
    expect(parseGitHubIssueOrPRNumber('https://github.my-company.net/MyOrg/my_repo/pull/395')).toBe(
      395
    )
  })

  it('parses GitHub item URLs with trailing page segments', () => {
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/1965/changes')).toBe(1965)
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/1965/files')).toBe(1965)
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/1965/commits')).toBe(1965)
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/issues/923/comments')).toBe(923)
  })

  it('parses trailing segments with query, fragment, and repeated slashes', () => {
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/1965/changes?diff=split')).toBe(
      1965
    )
    expect(
      parseGitHubIssueOrPRNumber('https://github.com/o/r/issues/923/comments#issuecomment-1')
    ).toBe(923)
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/1965//changes///')).toBe(1965)
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/issues/923///')).toBe(923)
  })

  it('rejects invalid GitHub item URLs', () => {
    expect(parseGitHubIssueOrPRNumber('0')).toBeNull()
    expect(parseGitHubIssueOrPRNumber('#0')).toBeNull()
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/0')).toBeNull()
    expect(
      parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/not-a-number/changes')
    ).toBeNull()
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/pull/')).toBeNull()
    expect(parseGitHubIssueOrPRNumber('https://github.com/o/r/issues/123abc')).toBeNull()
    expect(parseGitHubIssueOrPRNumber('https://github.com/owner/repo/pulls/123')).toBeNull()
  })
})

describe('parseGitHubIssueOrPRLink', () => {
  it('parses slug, number, and type for direct item URLs', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/stablyai/orca/pull/123')).toEqual({
      slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      number: 123,
      type: 'pr'
    })

    expect(
      parseGitHubIssueOrPRLink('https://github.my-company.net/MyOrg/my_repo/pull/395')
    ).toEqual({
      slug: { owner: 'MyOrg', repo: 'my_repo', host: 'github.my-company.net' },
      number: 395,
      type: 'pr'
    })

    expect(parseGitHubIssueOrPRLink('https://git.corp.com/MyOrg/my_repo/pull/395')).toEqual({
      slug: { owner: 'MyOrg', repo: 'my_repo', host: 'git.corp.com' },
      number: 395,
      type: 'pr'
    })
    expect(parseGitHubIssueOrPRLink('https://github.com/stablyai/orca/issues/923')).toEqual({
      slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
      number: 923,
      type: 'issue'
    })
  })

  it('derives item type from the route segment when trailing segments are present', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/1965/changes')).toEqual({
      slug: { owner: 'o', repo: 'r', host: 'github.com' },
      number: 1965,
      type: 'pr'
    })
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/923/comments')).toEqual({
      slug: { owner: 'o', repo: 'r', host: 'github.com' },
      number: 923,
      type: 'issue'
    })
  })

  it('accepts query, fragment, and repeated trailing slashes', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/1965/files?plain=1#diff')).toEqual(
      {
        slug: { owner: 'o', repo: 'r', host: 'github.com' },
        number: 1965,
        type: 'pr'
      }
    )
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/923/comments///')).toEqual({
      slug: { owner: 'o', repo: 'r', host: 'github.com' },
      number: 923,
      type: 'issue'
    })
  })

  it('rejects non-GitHub and malformed item URLs', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/0')).toBeNull()
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/0')).toBeNull()
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/not-a-number/changes')).toBeNull()
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/')).toBeNull()
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/123abc')).toBeNull()
    expect(parseGitHubIssueOrPRLink('https://github.com/owner/repo/pulls/123')).toBeNull()
  })
})

describe('normalizeGitHubLinkQuery', () => {
  it('accepts full GitHub URLs whose slug differs from the selected repo slug', () => {
    expect(normalizeGitHubLinkQuery('https://github.com/stablyai/orca/issues/923')).toEqual({
      query: 'https://github.com/stablyai/orca/issues/923',
      directNumber: 923,
      directLink: {
        slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        number: 923,
        type: 'issue'
      }
    })
  })

  it('preserves PR route intent for full GitHub URLs', () => {
    expect(normalizeGitHubLinkQuery('https://github.com/stablyai/orca/pull/6934')).toEqual({
      query: 'https://github.com/stablyai/orca/pull/6934',
      directNumber: 6934,
      directLink: {
        slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        number: 6934,
        type: 'pr'
      }
    })
  })

  it('preserves route intent for URLs with uppercase schemes', () => {
    expect(normalizeGitHubLinkQuery('HTTPS://github.com/stablyai/orca/pull/6934')).toEqual({
      query: 'HTTPS://github.com/stablyai/orca/pull/6934',
      directNumber: 6934,
      directLink: {
        slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        number: 6934,
        type: 'pr'
      }
    })
  })

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
