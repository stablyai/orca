import { describe, expect, it } from 'vitest'
import { isGitLabIssueAlreadyStarted } from './useGitLabAssigneeAutoStart'

describe('isGitLabIssueAlreadyStarted', () => {
  const worktrees = [
    { repoId: 'repo-1', linkedGitLabIssue: 42 },
    { repoId: 'repo-1', linkedGitLabIssue: null },
    { repoId: 'repo-2', linkedGitLabIssue: 42 }
  ]

  it('is true when a workspace is already linked to the issue (durable dedup)', () => {
    expect(
      isGitLabIssueAlreadyStarted({
        worktrees,
        inFlight: new Set(),
        repoId: 'repo-1',
        issueNumber: 42
      })
    ).toBe(true)
  })

  it('is false when no workspace links the issue and nothing is in flight', () => {
    expect(
      isGitLabIssueAlreadyStarted({
        worktrees,
        inFlight: new Set(),
        repoId: 'repo-1',
        issueNumber: 99
      })
    ).toBe(false)
  })

  it('scopes the link match to the same repo (same issue number, other repo)', () => {
    expect(
      isGitLabIssueAlreadyStarted({
        worktrees: [{ repoId: 'repo-2', linkedGitLabIssue: 42 }],
        inFlight: new Set(),
        repoId: 'repo-1',
        issueNumber: 42
      })
    ).toBe(false)
  })

  it('is true when a launch is in flight this session (worktree not yet created)', () => {
    expect(
      isGitLabIssueAlreadyStarted({
        worktrees: [],
        inFlight: new Set(['repo-1:42']),
        repoId: 'repo-1',
        issueNumber: 42
      })
    ).toBe(true)
  })

  it('does not treat a worktree with no linked issue as a match', () => {
    expect(
      isGitLabIssueAlreadyStarted({
        worktrees: [{ repoId: 'repo-1', linkedGitLabIssue: null }],
        inFlight: new Set(),
        repoId: 'repo-1',
        issueNumber: 42
      })
    ).toBe(false)
  })
})
