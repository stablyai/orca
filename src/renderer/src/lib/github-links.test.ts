import { describe, expect, it } from 'vitest'
import { normalizeGitHubLinkQuery, parseGitHubIssueOrPRNumber } from './github-links'

describe('parseGitHubIssueOrPRNumber', () => {
  it('parses plain issue numbers and GitHub pull request URLs', () => {
    expect(parseGitHubIssueOrPRNumber('42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('#42')).toBe(42)
    expect(parseGitHubIssueOrPRNumber('https://github.com/stablyai/orca/pull/123')).toBe(123)
  })

  it('rejects non-GitHub URLs', () => {
    expect(parseGitHubIssueOrPRNumber('https://example.com/stablyai/orca/pull/123')).toBeNull()
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
