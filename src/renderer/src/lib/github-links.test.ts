import { describe, expect, it } from 'vitest'
import { parseGitHubIssueOrPRNumber } from './github-links'

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
