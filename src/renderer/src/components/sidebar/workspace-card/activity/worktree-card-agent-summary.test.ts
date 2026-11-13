import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { buildSummaryAgentGroups } from './worktree-card-agent-summary'

function row(paneKey: string, state: 'done' | 'working' | 'waiting'): DashboardAgentRow {
  return {
    paneKey,
    agentType: 'codex',
    state,
    entry: { state }
  } as unknown as DashboardAgentRow
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

  it('omits the unread group without an unread predicate', () => {
    const groups = buildSummaryAgentGroups([row('a', 'done')])
    expect(groups).toEqual([{ state: 'done', agents: [expect.objectContaining({ paneKey: 'a' })] }])
  })
})
