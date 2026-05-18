import { describe, expect, it } from 'vitest'
import {
  normalizeGitHubLinkQuery,
  parseGitHubIssueOrPRLink,
  parseGitHubIssueOrPRNumber
} from './github-links'

describe('parseGitHubIssueOrPRNumber', () => {
  it('parses plain issue numbers and GitHub pull request URLs', () => {
    expect(parseGitHubIssueOrPRNumber('42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('#42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('https://github.com/stablyai/orca/pull/123')).toBe(123)
    expect(parseGitHubIssueOrPRNumber('https://github.com/stablyai/orca/issues/923')).toBe(923)
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
    expect(parseGitHubIssueOrPRNumber('https://example.com/stablyai/orca/pull/123')).toBeNull()
    expect(
      parseGitHubIssueOrPRNumber('https://github.example.com/stablyai/orca/pull/123')
    ).toBeNull()
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
      slug: { owner: 'stablyai', repo: 'orca' },
      number: 123,
      type: 'pr'
    })
    expect(parseGitHubIssueOrPRLink('https://github.com/stablyai/orca/issues/923')).toEqual({
      slug: { owner: 'stablyai', repo: 'orca' },
      number: 923,
      type: 'issue'
    })
  })

  it('derives item type from the route segment when trailing segments are present', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/1965/changes')).toEqual({
      slug: { owner: 'o', repo: 'r' },
      number: 1965,
      type: 'pr'
    })
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/923/comments')).toEqual({
      slug: { owner: 'o', repo: 'r' },
      number: 923,
      type: 'issue'
    })
  })

  it('accepts query, fragment, and repeated trailing slashes', () => {
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/pull/1965/files?plain=1#diff')).toEqual(
      {
        slug: { owner: 'o', repo: 'r' },
        number: 1965,
        type: 'pr'
      }
    )
    expect(parseGitHubIssueOrPRLink('https://github.com/o/r/issues/923/comments///')).toEqual({
      slug: { owner: 'o', repo: 'r' },
      number: 923,
      type: 'issue'
    })
  })

  it('rejects non-GitHub and malformed item URLs', () => {
    expect(parseGitHubIssueOrPRLink('https://example.com/o/r/pull/1965/changes')).toBeNull()
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
      directNumber: 923
    })
  })
})
