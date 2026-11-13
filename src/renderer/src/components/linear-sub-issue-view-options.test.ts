import { describe, expect, it } from 'vitest'
import type { LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import { orderLinearSubIssues } from './linear-sub-issue-view-options'

function subIssue(
  identifier: string,
  fields: Omit<LinearIssueChildSummary, 'id' | 'identifier' | 'title' | 'url'>
): LinearIssueChildSummary {
  return { id: identifier, identifier, title: identifier, url: '', ...fields }
}

function state(type: string, position: number): LinearIssueChildSummary['state'] {
  return { name: type, type, color: '#000000', position }
}

const subIssues = [
  subIssue('A', {
    subIssueSortOrder: 3,
    priority: 3,
    state: state('completed', 0),
    createdAt: '2026-01-01T00:00:00.000Z'
  }),
  subIssue('B', {
    subIssueSortOrder: 1,
    priority: 0,
    state: state('started', 1),
    createdAt: '2026-01-03T00:00:00.000Z'
  }),
  subIssue('C', {
    subIssueSortOrder: 2,
    priority: 1,
    state: state('backlog', 0),
    createdAt: '2026-01-02T00:00:00.000Z'
  }),
  subIssue('D', { subIssueSortOrder: 0, priority: 3, state: state('started', 0) }),
  subIssue('E', {})
]

function identifiers(
  orderBy: Parameters<typeof orderLinearSubIssues>[1]['orderBy'],
  showCompleted = true
): string[] {
  return orderLinearSubIssues(subIssues, { orderBy, showCompleted }).map((item) => item.identifier)
}

describe('orderLinearSubIssues', () => {
  it('follows Linear manual order and keeps sub-issues without one last', () => {
    expect(identifiers('manual')).toEqual(['D', 'B', 'C', 'A', 'E'])
  })

  it('orders by workflow type, then position within the type', () => {
    expect(identifiers('status')).toEqual(['C', 'D', 'B', 'A', 'E'])
  })

  it('puts no-priority last and breaks ties with manual order', () => {
    expect(identifiers('priority')).toEqual(['C', 'D', 'A', 'B', 'E'])
  })

  it('orders newest created first and keeps missing dates last', () => {
    expect(identifiers('created')).toEqual(['B', 'C', 'A', 'D', 'E'])
  })

  it('hides completed and canceled sub-issues when asked', () => {
    expect(identifiers('manual', false)).toEqual(['D', 'B', 'C', 'E'])
  })
})
