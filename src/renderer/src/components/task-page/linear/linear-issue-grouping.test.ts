import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import {
  compareLinearIssues,
  findLinearWorkflowStateForStatus,
  getLinearIssueGridTemplate,
  getLinearPriorityRank,
  getLinearStatusSectionState,
  groupLinearIssues,
  mergeLinearCollectionResults
} from './linear-issue-grouping'

function issue(
  overrides: Partial<LinearIssue> & Pick<LinearIssue, 'id' | 'identifier'>
): LinearIssue {
  return {
    title: overrides.title ?? overrides.identifier,
    url: 'https://linear.app/issue',
    priority: 0,
    updatedAt: '2026-01-02T00:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted', color: '#000' },
    team: { id: 'team-1', name: 'Core', key: 'COR' },
    ...overrides
  } as LinearIssue
}

describe('getLinearPriorityRank', () => {
  it('sorts no-priority after numbered priorities', () => {
    expect(getLinearPriorityRank(0)).toBe(5)
    expect(getLinearPriorityRank(1)).toBe(1)
  })
})

describe('compareLinearIssues', () => {
  it('orders by identifier numerically', () => {
    const newer = issue({ id: '2', identifier: 'COR-12', updatedAt: '2026-01-01T00:00:00.000Z' })
    const older = issue({ id: '1', identifier: 'COR-3', updatedAt: '2026-02-01T00:00:00.000Z' })
    expect(compareLinearIssues(newer, older, 'identifier')).toBeGreaterThan(0)
  })
})

describe('groupLinearIssues', () => {
  it('keeps a single Issues section when groupBy is none', () => {
    const sections = groupLinearIssues([issue({ id: '1', identifier: 'COR-1' })], 'none', 'updated')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.key).toBe('all')
    expect(sections[0]?.issues).toHaveLength(1)
  })

  it('groups by status name', () => {
    const sections = groupLinearIssues(
      [
        issue({
          id: '1',
          identifier: 'COR-1',
          state: { name: 'Todo', type: 'unstarted', color: '#0' }
        }),
        issue({
          id: '2',
          identifier: 'COR-2',
          state: { name: 'Done', type: 'completed', color: '#1' }
        })
      ],
      'status',
      'identifier'
    )
    expect(sections.map((section) => section.key)).toEqual(['status:Todo', 'status:Done'])
  })
})

describe('getLinearStatusSectionState', () => {
  it('reads state from a status section', () => {
    const state = { name: 'Todo', type: 'unstarted' as const, color: '#0' }
    expect(
      getLinearStatusSectionState({
        key: 'status:Todo',
        label: 'Todo',
        issues: [issue({ id: '1', identifier: 'COR-1', state })]
      })
    ).toEqual(state)
  })

  it('returns null for non-status sections', () => {
    expect(
      getLinearStatusSectionState({
        key: 'team:1',
        label: 'Core',
        issues: [issue({ id: '1', identifier: 'COR-1' })]
      })
    ).toBeNull()
  })
})

describe('findLinearWorkflowStateForStatus', () => {
  const states = [
    { id: 'ws-1', name: 'In Progress', type: 'started', color: '#000', position: 1 },
    { id: 'ws-2', name: 'In Progress', type: 'unstarted', color: '#111', position: 2 }
  ]

  it('prefers the state matching both name and type', () => {
    expect(
      findLinearWorkflowStateForStatus(states, {
        name: 'In Progress',
        type: 'unstarted',
        color: '#111'
      })
    ).toEqual(states[1])
  })

  it('falls back to a name-only match when no type matches', () => {
    expect(
      findLinearWorkflowStateForStatus(states, {
        name: 'In Progress',
        type: 'completed',
        color: '#222'
      })
    ).toEqual(states[0])
  })

  it('returns undefined when the name is absent', () => {
    expect(
      findLinearWorkflowStateForStatus(states, { name: 'Done', type: 'completed', color: '#333' })
    ).toBeUndefined()
  })
})

describe('mergeLinearCollectionResults', () => {
  it('flattens items and preserves hasMore plus errors', () => {
    expect(
      mergeLinearCollectionResults([
        { items: [1], hasMore: false },
        {
          items: [2],
          hasMore: true,
          errors: [{ workspaceId: 'ws-1', type: 'unknown', message: 'late' }]
        }
      ])
    ).toEqual({
      items: [1, 2],
      errors: [{ workspaceId: 'ws-1', type: 'unknown', message: 'late' }],
      hasMore: true
    })
  })
})

describe('getLinearIssueGridTemplate', () => {
  it('always includes identifier, title, and worktrees columns', () => {
    expect(getLinearIssueGridTemplate(new Set())).toBe('96px minmax(240px,1.55fr) 64px')
  })

  it('inserts optional columns in display order', () => {
    expect(getLinearIssueGridTemplate(new Set(['labels', 'state', 'updated']))).toBe(
      '96px minmax(240px,1.55fr) minmax(168px,0.9fr) 138px 104px 64px'
    )
  })
})
