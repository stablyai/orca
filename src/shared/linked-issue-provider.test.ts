import { describe, expect, it } from 'vitest'

import { inferIssueLinkProvider, inferIssueProvider } from './linked-issue-provider'

const gitLabIssueItem = {
  provider: 'gitlab',
  type: 'issue',
  number: 7,
  title: 't',
  url: 'https://gitlab.com/a/b/-/issues/7'
} as const

describe('inferIssueLinkProvider', () => {
  it('names the slot that holds a link', () => {
    expect(inferIssueLinkProvider({ linkedIssue: 1 })).toBe('github')
    expect(inferIssueLinkProvider({ linkedGitLabIssue: 1 })).toBe('gitlab')
    expect(inferIssueLinkProvider({ linkedLinearIssue: 'STA-1' })).toBe('linear')
  })

  it('treats undefined and null slots as empty', () => {
    expect(inferIssueLinkProvider({ linkedIssue: undefined, linkedGitLabIssue: null })).toBe(
      'github'
    )
  })

  it('delegates the tie to the linked work item, exactly as the template resolver does', () => {
    expect(
      inferIssueLinkProvider({
        linkedIssue: 1,
        linkedGitLabIssue: 2,
        linkedWorkItem: gitLabIssueItem
      })
    ).toBe('gitlab')
    // The shared rule refuses to guess; only the UI wrapper picks a default.
    expect(inferIssueProvider({ linkedIssue: 1, linkedGitLabIssue: 2 })).toBeNull()
    expect(inferIssueLinkProvider({ linkedIssue: 1, linkedGitLabIssue: 2 })).toBe('github')
  })

  it('defaults an empty field to GitLab on a workspace that already tracks GitLab work', () => {
    expect(inferIssueLinkProvider({ linkedGitLabMR: 5 })).toBe('gitlab')
    expect(inferIssueLinkProvider({ linkedWorkItem: gitLabIssueItem })).toBe('gitlab')
    expect(inferIssueLinkProvider({})).toBe('github')
  })
})
