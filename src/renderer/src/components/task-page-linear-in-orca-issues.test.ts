import { describe, expect, it } from 'vitest'

import {
  collectLinkedLinearIssueRefsFromWorktrees,
  filterLinearIssuesBySearchQuery,
  filterLinearIssuesForInOrcaWorkspace,
  linkedLinearIssueRefsSignature,
  readLinkedLinearIssuesWithLimit
} from './task-page-linear-in-orca-issues'
import type { LinearIssue } from '../../../shared/types'

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

  it('normalizes URL-valued and lower-cased links to bare upper-case identifiers', () => {
    expect(
      collectLinkedLinearIssueRefsFromWorktrees([
        {
          linkedLinearIssue: 'https://linear.app/acme/issue/eng-7/fix-it',
          linkedLinearIssueWorkspaceId: null
        },
        { linkedLinearIssue: 'eng-8', linkedLinearIssueWorkspaceId: null }
      ])
    ).toEqual([
      { identifier: 'ENG-7', workspaceId: null, organizationUrlKey: 'acme' },
      { identifier: 'ENG-8', workspaceId: null }
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

describe('filterLinearIssuesBySearchQuery', () => {
  it('matches identifier, title, team, and assignee', () => {
    const issues = [
      issue({
        id: '1',
        identifier: 'ENG-1',
        title: 'Fix login',
        team: { id: 't1', name: 'Platform', key: 'ENG' },
        assignee: { id: 'u1', displayName: 'Ada' }
      }),
      issue({ id: '2', identifier: 'ENG-2', title: 'Other' })
    ]
    expect(filterLinearIssuesBySearchQuery(issues, 'login').map((item) => item.id)).toEqual(['1'])
    expect(filterLinearIssuesBySearchQuery(issues, 'platform').map((item) => item.id)).toEqual([
      '1'
    ])
    expect(filterLinearIssuesBySearchQuery(issues, 'ada').map((item) => item.id)).toEqual(['1'])
    expect(filterLinearIssuesBySearchQuery(issues, 'eng-2').map((item) => item.id)).toEqual(['2'])
  })
})

describe('linkedLinearIssueRefsSignature', () => {
  it('is stable regardless of input order', () => {
    expect(
      linkedLinearIssueRefsSignature([
        { identifier: 'ENG-2', workspaceId: 'b' },
        { identifier: 'eng-1', workspaceId: 'a' }
      ])
    ).toBe(
      linkedLinearIssueRefsSignature([
        { identifier: 'ENG-1', workspaceId: 'a' },
        { identifier: 'ENG-2', workspaceId: 'b' }
      ])
    )
  })
})

describe('readLinkedLinearIssuesWithLimit', () => {
  it('preserves input order while bounding concurrent reads', async () => {
    let active = 0
    let maxActive = 0
    const refs = Array.from({ length: 9 }, (_, index) => ({
      identifier: `ENG-${index + 1}`,
      workspaceId: null
    }))
    const results = await readLinkedLinearIssuesWithLimit(
      refs,
      async (ref) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return issue({ id: ref.identifier, identifier: ref.identifier })
      },
      3
    )

    expect(maxActive).toBe(3)
    expect(results.map((item) => item?.identifier)).toEqual(refs.map((ref) => ref.identifier))
  })
})
