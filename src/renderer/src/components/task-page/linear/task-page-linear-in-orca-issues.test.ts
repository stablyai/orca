import { describe, expect, it } from 'vitest'

import { collectLinkedLinearIssueRefsFromWorktrees } from './task-page-linear-in-orca-issues'

describe('collectLinkedLinearIssueRefsFromWorktrees', () => {
  it('dedupes linked Linear identifiers case-insensitively', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees([
        { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: 'ws-a' },
        { linkedLinearIssue: 'eng-1', linkedLinearIssueWorkspaceId: null },
        { linkedLinearIssue: 'ENG-2', linkedLinearIssueWorkspaceId: 'ws-b' },
        { linkedLinearIssue: null, linkedLinearIssueWorkspaceId: null },
        { linkedLinearIssue: '  ', linkedLinearIssueWorkspaceId: 'ws-a' }
      ])
    ).toEqual([
      { identifier: 'ENG-1', workspaceId: 'ws-a' },
      { identifier: 'ENG-2', workspaceId: 'ws-b' }
    ])
  })

  it('prefers a concrete workspace id when later worktrees provide one', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees([
        { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: null },
        { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: 'ws-a' }
      ])
    ).toEqual([{ identifier: 'ENG-1', workspaceId: 'ws-a' }])
  })

  it('keeps identical identifiers from different Linear workspaces distinct', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees([
        { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: 'ws-a' },
        { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: 'ws-b' }
      ])
    ).toEqual([
      { identifier: 'ENG-1', workspaceId: 'ws-a' },
      { identifier: 'ENG-1', workspaceId: 'ws-b' }
    ])
  })

  it('resolves URL organization scope and excludes archived worktrees', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees(
        [
          {
            linkedLinearIssue: 'https://linear.app/acme/issue/eng-1/title',
            linkedLinearIssueWorkspaceId: null
          },
          { linkedLinearIssue: 'ENG-2', isArchived: true }
        ],
        {
          workspaces: [{ id: 'ws-a', organizationUrlKey: 'acme' }]
        }
      )
    ).toEqual([{ identifier: 'ENG-1', workspaceId: 'ws-a', organizationUrlKey: 'acme' }])
  })

  it('filters by selected workspace when worktrees carry workspace ids', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees(
        [
          { linkedLinearIssue: 'ENG-1', linkedLinearIssueWorkspaceId: 'ws-a' },
          { linkedLinearIssue: 'ENG-2', linkedLinearIssueWorkspaceId: 'ws-b' },
          { linkedLinearIssue: 'ENG-3', linkedLinearIssueWorkspaceId: null }
        ],
        { workspaceId: 'ws-a' }
      )
    ).toEqual([
      { identifier: 'ENG-1', workspaceId: 'ws-a' },
      { identifier: 'ENG-3', workspaceId: null }
    ])
  })
})
