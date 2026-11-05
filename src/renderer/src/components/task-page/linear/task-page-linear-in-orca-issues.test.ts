import { describe, expect, it } from 'vitest'

import {
  collectLinkedLinearIssueRefsFromWorktrees,
  filterLinearIssuesForInOrcaWorkspace
} from './task-page-linear-in-orca-issues'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

function issue(
  partial: Partial<LinearIssue> & Pick<LinearIssue, 'id' | 'identifier'>
): LinearIssue {
  return {
    title: partial.title ?? partial.identifier,
    url: partial.url ?? `https://linear.app/acme/issue/${partial.identifier}`,
    state: partial.state ?? { name: 'Todo', type: 'unstarted', color: '#000' },
    team: partial.team ?? { id: 'team-1', name: 'Eng', key: 'ENG' },
    labels: partial.labels ?? [],
    labelIds: partial.labelIds ?? [],
    priority: partial.priority ?? 0,
    updatedAt: partial.updatedAt ?? '2026-01-01T00:00:00.000Z',
    workspaceId: partial.workspaceId,
    assignee: partial.assignee,
    ...partial
  }
}

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

describe('filterLinearIssuesForInOrcaWorkspace', () => {
  it('keeps issues without workspace metadata when a workspace is selected', () => {
    const issues = [
      issue({ id: '1', identifier: 'ENG-1', workspaceId: 'ws-a' }),
      issue({ id: '2', identifier: 'ENG-2', workspaceId: 'ws-b' }),
      issue({ id: '3', identifier: 'ENG-3' })
    ]
    expect(
      filterLinearIssuesForInOrcaWorkspace(issues, 'ws-a').map((item) => item.identifier)
    ).toEqual(['ENG-1', 'ENG-3'])
  })
})
