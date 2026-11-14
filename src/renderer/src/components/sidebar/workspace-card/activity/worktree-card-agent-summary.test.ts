import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildSummaryAgentGroups } from './worktree-card-agent-summary'

function row(paneKey: string, state: 'done' | 'working' | 'waiting'): DashboardAgentRow {
  return {
    paneKey,
    agentType: 'codex',
    state,
    startedAt: 1,
    entry: {
      paneKey,
      state,
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: []
    },
    tab: {
      id: 'tab',
      ptyId: null,
      worktreeId: 'wt',
      title: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }
}

describe('buildSummaryAgentGroups', () => {
  it('splits unread done agents into a leading unread group', () => {
    const agents = [row('a', 'done'), row('b', 'working'), row('c', 'done'), row('d', 'waiting')]
    const groups = buildSummaryAgentGroups(agents, (agent) => agent.paneKey === 'c')

    expect(groups.map((g) => [g.state, g.unread ?? false, g.agents.map((a) => a.paneKey)])).toEqual(
      [
        ['done', true, ['c']],
        ['waiting', false, ['d']],
        ['working', false, ['b']],
        ['done', false, ['a']]
      ]
    )
  })

  it('keeps unread live agents in their own state group', () => {
    const agents = [row('a', 'working'), row('b', 'done')]
    const groups = buildSummaryAgentGroups(agents, () => true)

    expect(groups.map((g) => [g.state, g.unread ?? false])).toEqual([
      ['done', true],
      ['working', false]
    ])
  })
})
