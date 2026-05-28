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
      slug: { path: 'stablyai/orca' },
      number: 923,
      type: 'issue'
    })
    expect(
      parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/-/merge_requests/77')
    ).toEqual({ slug: { path: 'stablyai/orca' }, number: 77, type: 'mr' })
  })

  it('preserves full nested group paths in the slug', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/g/sub/proj/-/issues/1')).toEqual({
      slug: { path: 'g/sub/proj' },
      number: 1,
      type: 'issue'
    })
  })

  it('returns null for single-segment paths (no project)', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/foo/-/issues/1')).toBeNull()
  })

  it('returns null for non-GitLab URL shapes', () => {
    expect(parseGitLabIssueOrMRLink('https://gitlab.com/stablyai/orca/issues/123')).toBeNull()
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
