import { describe, expect, it } from 'vitest'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import { sortMantisBTIssues } from './mantisbt-issue-sorter'

function issue(overrides: Partial<MantisBTIssue> & { id: string }): MantisBTIssue {
  return {
    summary: 'Issue',
    url: `https://example.com/view.php?id=${overrides.id}`,
    project: { id: '1', siteId: 'site-1', name: 'Alpha', subProjects: [] },
    status: { id: '10', name: 'new', label: 'new' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    siteId: 'site-1',
    siteName: 'Example',
    ...overrides
  }
}

describe('sortMantisBTIssues', () => {
  it('sorts by title alphabetically in both directions', () => {
    const issues = [issue({ id: '1', summary: 'Zebra' }), issue({ id: '2', summary: 'Apple' })]
    expect(sortMantisBTIssues(issues, 'title', 'asc').map((i) => i.summary)).toEqual([
      'Apple',
      'Zebra'
    ])
    expect(sortMantisBTIssues(issues, 'title', 'desc').map((i) => i.summary)).toEqual([
      'Zebra',
      'Apple'
    ])
  })

  it('ranks status by the fixed numeric MantisBT status id', () => {
    const issues = [
      issue({ id: '1', status: { id: '90', name: 'closed', label: 'closed' } }),
      issue({ id: '2', status: { id: '10', name: 'new', label: 'new' } }),
      issue({ id: '3', status: { id: '50', name: 'assigned', label: 'assigned' } })
    ]
    expect(sortMantisBTIssues(issues, 'status', 'asc').map((i) => i.status.name)).toEqual([
      'new',
      'assigned',
      'closed'
    ])
  })

  it('ranks priority by the fixed numeric MantisBT priority id, missing priority lowest', () => {
    const issues = [
      issue({ id: '1', priority: { id: '60', name: 'immediate', label: 'immediate' } }),
      issue({ id: '2' }),
      issue({ id: '3', priority: { id: '20', name: 'low', label: 'low' } })
    ]
    expect(
      sortMantisBTIssues(issues, 'priority', 'asc').map((i) => i.priority?.name ?? 'none')
    ).toEqual(['none', 'low', 'immediate'])
  })

  it('sorts by handler display name, unassigned first when ascending', () => {
    const issues = [
      issue({ id: '1', handler: { id: '1', name: 'wally', realName: 'Wally' } }),
      issue({ id: '2' }),
      issue({ id: '3', handler: { id: '2', name: 'anna', realName: 'Anna' } })
    ]
    expect(
      sortMantisBTIssues(issues, 'handler', 'asc').map(
        (i) => i.handler?.realName ?? i.handler?.name ?? ''
      )
    ).toEqual(['', 'Anna', 'Wally'])
  })

  it('sorts by updatedAt with most recent first when descending', () => {
    const issues = [
      issue({ id: '1', updatedAt: '2026-01-01T00:00:00.000Z' }),
      issue({ id: '2', updatedAt: '2026-03-01T00:00:00.000Z' })
    ]
    expect(sortMantisBTIssues(issues, 'updated', 'desc').map((i) => i.id)).toEqual(['2', '1'])
  })
})
