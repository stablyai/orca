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
