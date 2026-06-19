import { describe, expect, it } from 'vitest'
import {
  normalizeGitLabLinkQuery,
  parseGitLabIssueOrMRLink,
  parseGitLabIssueOrMRNumber
} from './gitlab-links'

describe('parseGitLabIssueOrMRNumber', () => {
  it('parses bare numbers, # prefix, and ! prefix', () => {
    expect(parseGitLabIssueOrMRNumber('42')).toBe(42)
    expect(parseGitLabIssueOrMRNumber('#42')).toBe(42)
    expect(parseGitLabIssueOrMRNumber('!42')).toBe(42)
  })

  it('parses gitlab.com issue and MR URLs', () => {
    expect(parseGitLabIssueOrMRNumber('https://gitlab.com/stablyai/orca/-/issues/923')).toBe(923)
    expect(
      parseGitLabIssueOrMRNumber('https://gitlab.com/stablyai/orca/-/merge_requests/123')
    ).toBe(123)
  })

  it('parses URLs from self-hosted GitLab instances', () => {
    expect(parseGitLabIssueOrMRNumber('https://gitlab.example.com/team/api/-/issues/7')).toBe(7)
  })

  it('parses URLs with nested group paths', () => {
    expect(
      parseGitLabIssueOrMRNumber('https://gitlab.com/group/subgroup/project/-/merge_requests/55')
    ).toBe(55)
  })

  it('parses issue and MR URLs with trailing page segments', () => {
    expect(parseGitLabIssueOrMRNumber('https://gitlab.com/g/p/-/merge_requests/77/diffs')).toBe(77)
    expect(
      parseGitLabIssueOrMRNumber('https://gitlab.com/g/p/-/merge_requests/77/diffs.diff?diff_id=1')
    ).toBe(77)
    expect(parseGitLabIssueOrMRNumber('https://gitlab.com/g/p/-/issues/923/designs')).toBe(923)
  })

  it('rejects GitHub URLs (no /-/ separator)', () => {
    expect(parseGitLabIssueOrMRNumber('https://github.com/stablyai/orca/issues/923')).toBeNull()
    expect(parseGitLabIssueOrMRNumber('https://github.com/stablyai/orca/pull/123')).toBeNull()
  })

  it('rejects unparseable input', () => {
    expect(parseGitLabIssueOrMRNumber('')).toBeNull()
    expect(parseGitLabIssueOrMRNumber('  ')).toBeNull()
    expect(parseGitLabIssueOrMRNumber('not-a-url')).toBeNull()
  })
})

describe('parseGitLabIssueOrMRLink', () => {
  it('extracts slug + number + type for issues and MRs', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/-/issues/923')).toEqual({
      slug: { host: 'gitlab.com', path: 'stablyai/orca' },
      number: 923,
      type: 'issue'
    })
    expect(
      parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/-/merge_requests/77')
    ).toEqual({ slug: { host: 'gitlab.com', path: 'stablyai/orca' }, number: 77, type: 'mr' })
  })

  it('preserves self-hosted GitLab hosts in the slug', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.internal/team/api/-/merge_requests/8')).toEqual(
      {
        slug: { host: 'gitlab.internal', path: 'team/api' },
        number: 8,
        type: 'mr'
      }
    )
  })

  it('preserves explicit ports on self-hosted GitLab hosts', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.example.com:8443/team/api/-/issues/7')).toEqual(
      {
        slug: { host: 'gitlab.example.com:8443', path: 'team/api' },
        number: 7,
        type: 'issue'
      }
    )
  })

  it('preserves full nested group paths in the slug', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/g/sub/proj/-/issues/1')).toEqual({
      slug: { host: 'gitlab.com', path: 'g/sub/proj' },
      number: 1,
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

  it('returns null for single-segment paths (no project)', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/foo/-/issues/1')).toBeNull()
  })

  it('returns null for non-GitLab URL shapes', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/issues/123')).toBeNull()
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/-/issues/123abc')).toBeNull()
  })
})

describe('normalizeGitLabLinkQuery', () => {
  it('routes a bare number to directNumber', () => {
    expect(normalizeGitLabLinkQuery('42')).toEqual({ query: '42', directNumber: 42 })
  })

  it('routes a full URL to query + directNumber', () => {
    expect(normalizeGitLabLinkQuery('https://gitlab.com/stablyai/orca/-/issues/923')).toEqual({
      query: 'https://gitlab.com/stablyai/orca/-/issues/923',
      directNumber: 923
    })
  })

  it('routes full URLs with trailing page segments to directNumber', () => {
    expect(
      normalizeGitLabLinkQuery('https://gitlab.com/stablyai/orca/-/merge_requests/77/diffs')
    ).toEqual({
      query: 'https://gitlab.com/stablyai/orca/-/merge_requests/77/diffs',
      directNumber: 77
    })
  })

  it('returns the query alone for non-numeric, non-URL input', () => {
    expect(normalizeGitLabLinkQuery('search me')).toEqual({
      query: 'search me',
      directNumber: null
    })
  })

  it('returns empty for empty input', () => {
    expect(normalizeGitLabLinkQuery('   ')).toEqual({ query: '', directNumber: null })
  })
})
