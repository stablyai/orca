import { describe, expect, it } from 'vitest'
import {
  githubIssueBlockedByCount,
  githubIssueBlockedStatusLabel,
  isGitHubIssueBlocked
} from './github-issue-blocked-presentation'

describe('github issue blocked presentation', () => {
  it('treats only issues with open blockers as blocked', () => {
    expect(isGitHubIssueBlocked({ type: 'issue', blockedByCount: 2 })).toBe(true)
    expect(isGitHubIssueBlocked({ type: 'issue', blockedByCount: 0 })).toBe(false)
    expect(isGitHubIssueBlocked({ type: 'pr', blockedByCount: 2 })).toBe(false)
  })

  it('prefers blockedByCount over blockedBy length', () => {
    expect(
      githubIssueBlockedByCount({
        blockedByCount: 3,
        blockedBy: [{ number: 1, title: 'a', url: 'https://example.com/1' }]
      })
    ).toBe(3)
  })

  it('labels a single blocker with its title for linking', () => {
    expect(
      githubIssueBlockedStatusLabel({
        blockedByCount: 1,
        blockedBy: [{ number: 36, title: 'Freeze report', url: 'https://example.com/36' }]
      })
    ).toEqual({
      kind: 'single',
      count: 1,
      title: 'Freeze report',
      linkRef: { number: 36, title: 'Freeze report', url: 'https://example.com/36' }
    })
  })

  it('labels multiple blockers with a count and no link', () => {
    expect(
      githubIssueBlockedStatusLabel({
        blockedByCount: 2,
        blockedBy: [
          { number: 1, title: 'a', url: 'https://example.com/1' },
          { number: 2, title: 'b', url: 'https://example.com/2' }
        ]
      })
    ).toEqual({ kind: 'count', count: 2, title: null, linkRef: null })
  })
})
