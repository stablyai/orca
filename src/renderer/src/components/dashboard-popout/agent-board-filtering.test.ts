import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  EMPTY_DASHBOARD_FILTERS,
  filterDashboardCards,
  toggleDashboardFilter
} from './agent-board-filtering'

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: 'pane',
    ptyId: null,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: null,
    repoName: 'Orca',
    worktreeName: 'dashboard',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

describe('agent board filtering', () => {
  it('searches visible names, messages, review numbers, and subagent names', () => {
    const cards = [
      card({ paneKey: 'conversation', conversationName: 'Sparse-checkout parser' }),
      card({ paneKey: 'messages', lastAgentMessage: 'Relay authentication repaired' }),
      card({ paneKey: 'review', review: { number: 11012, state: 'open' } }),
      card({
        paneKey: 'subagent',
        subagents: [{ id: 'child', name: 'terminal orphan cleanup', dotState: 'working' }]
      })
    ]

    expect(filterDashboardCards(cards, 'sparse-checkout', EMPTY_DASHBOARD_FILTERS)[0].paneKey).toBe(
      'conversation'
    )
    expect(filterDashboardCards(cards, 'authentication', EMPTY_DASHBOARD_FILTERS)[0].paneKey).toBe(
      'messages'
    )
    expect(filterDashboardCards(cards, '#11012', EMPTY_DASHBOARD_FILTERS)[0].paneKey).toBe('review')
    expect(filterDashboardCards(cards, 'orphan cleanup', EMPTY_DASHBOARD_FILTERS)[0].paneKey).toBe(
      'subagent'
    )
  })

  it('combines filter categories while treating values within a category as alternatives', () => {
    const cards = [
      card({
        paneKey: 'match',
        repoId: 'orca',
        workspaceStatusId: 'in-review',
        review: { number: 1, state: 'open' }
      }),
      card({
        paneKey: 'wrong-status',
        repoId: 'orca',
        workspaceStatusId: 'todo',
        review: { number: 2, state: 'open' }
      })
    ]

    const result = filterDashboardCards(cards, '', {
      projects: ['orca', 'relay'],
      workspaceStatuses: ['in-review'],
      reviewStates: ['open']
    })

    expect(result.map((candidate) => candidate.paneKey)).toEqual(['match'])
  })

  it('supports the synthesized no-review filter and immutable toggles', () => {
    const cards = [
      card({ paneKey: 'none' }),
      card({ paneKey: 'open', review: { number: 1, state: 'open' } }),
      card({ paneKey: 'linked-uncached', hasReview: true })
    ]

    expect(
      filterDashboardCards(cards, '', {
        ...EMPTY_DASHBOARD_FILTERS,
        reviewStates: ['none']
      }).map((candidate) => candidate.paneKey)
    ).toEqual(['none'])
    expect(toggleDashboardFilter(['open'], 'draft')).toEqual(['open', 'draft'])
    expect(toggleDashboardFilter(['open', 'draft'], 'open')).toEqual(['draft'])
  })
})
