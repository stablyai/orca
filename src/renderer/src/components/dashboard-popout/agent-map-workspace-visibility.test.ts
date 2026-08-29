import { describe, expect, it } from 'vitest'
import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import { EMPTY_DASHBOARD_FILTERS } from './agent-board-filtering'
import { selectAgentlessMapWorkspaces } from './agent-map-workspace-visibility'

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: null,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'occupied',
    tabId: 'tab-1',
    leafId: null,
    repoName: 'Orca',
    worktreeName: 'Occupied',
    executionHostId: 'local',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

function workspace(overrides: Partial<DashboardWorkspace> = {}): DashboardWorkspace {
  return {
    repoId: 'repo-1',
    worktreeId: 'empty',
    repoName: 'Orca',
    worktreeName: 'Empty child',
    hostKind: 'local',
    executionHostId: 'local',
    workspaceKind: 'worktree',
    workspaceStatusId: 'planned',
    ...overrides
  }
}

describe('agent map workspace visibility', () => {
  it('returns only workspaces that have no dashboard card on the same host', () => {
    const result = selectAgentlessMapWorkspaces({
      cards: [card()],
      workspaces: [
        workspace({ worktreeId: 'occupied', worktreeName: 'Occupied' }),
        workspace(),
        workspace({
          worktreeId: 'occupied',
          worktreeName: 'Remote twin',
          hostKind: 'ssh',
          executionHostId: 'ssh:build-box'
        })
      ],
      query: '',
      filters: EMPTY_DASHBOARD_FILTERS
    })

    expect(result.map((item) => item.worktreeName)).toEqual(['Empty child', 'Remote twin'])
  })

  it('applies search and workspace filters to agentless workspaces', () => {
    const result = selectAgentlessMapWorkspaces({
      cards: [],
      workspaces: [
        workspace({ worktreeName: 'Listener security', review: { number: 42, state: 'open' } }),
        workspace({ worktreeId: 'other', worktreeName: 'Unrelated', workspaceStatusId: 'active' })
      ],
      query: 'listener',
      filters: {
        projects: ['repo-1'],
        workspaceStatuses: ['planned'],
        reviewStates: ['open']
      }
    })

    expect(result.map((item) => item.worktreeName)).toEqual(['Listener security'])
  })
})
