import { describe, expect, it } from 'vitest'
import { groupIssuesByKanbanColumn, mapIssueToKanbanColumn } from './issue-kanban'
import type { IssueInfo } from '../pull-requests/pull-request-types'

function issue(overrides: Partial<IssueInfo> & { number: number }): IssueInfo {
  return {
    title: `issue ${overrides.number}`,
    state: 'open',
    url: `https://example.test/${overrides.number}`,
    labels: [],
    ...overrides
  }
}

describe('issue-kanban', () => {
  it('routes closed issues to done regardless of labels', () => {
    expect(
      mapIssueToKanbanColumn(issue({ number: 1, state: 'closed', labels: ['in progress'] }))
    ).toBe('done')
  })

  it('prefers review over doing when both labels match', () => {
    expect(mapIssueToKanbanColumn(issue({ number: 2, labels: ['WIP', 'needs review'] }))).toBe(
      'review'
    )
    expect(mapIssueToKanbanColumn(issue({ number: 3, labels: ['In Progress'] }))).toBe('doing')
    expect(mapIssueToKanbanColumn(issue({ number: 4, labels: ['bug'] }))).toBe('todo')
  })

  it('groups issues preserving fetch order within columns', () => {
    const grouped = groupIssuesByKanbanColumn([
      issue({ number: 1, labels: ['bug'] }),
      issue({ number: 2, state: 'closed' }),
      issue({ number: 3, labels: ['in-progress'] }),
      issue({ number: 4, labels: ['needs-review'] })
    ])
    expect(grouped.todo.map((entry) => entry.number)).toEqual([1])
    expect(grouped.doing.map((entry) => entry.number)).toEqual([3])
    expect(grouped.review.map((entry) => entry.number)).toEqual([4])
    expect(grouped.done.map((entry) => entry.number)).toEqual([2])
  })
})
