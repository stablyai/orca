import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { buildCollapsedChildAgentSignalStates } from './worktree-card-idle-child-agents'

function row(paneKey: string, state: DashboardAgentRow['state']): DashboardAgentRow {
  return {
    paneKey,
    state,
    agentType: 'claude',
    startedAt: 1,
    entry: {
      paneKey,
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: []
    },
    tab: {
      id: 'tab',
      ptyId: null,
      worktreeId: 'wt',
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }
}

describe('buildCollapsedChildAgentSignalStates', () => {
  it('surfaces live descendant work but stays quiet for idle or finished children', () => {
    const quiet = new Map([['p', [row('a', 'idle'), row('b', 'done')]]])
    expect(buildCollapsedChildAgentSignalStates(quiet).get('p')).toBeUndefined()
    // A waiting grandchild must still light its collapsed grandparent; the cycle back to p is ignored.
    const nested = new Map([
      ['p', [row('a', 'idle')]],
      ['a', [row('g', 'waiting')]],
      ['g', [row('p', 'working')]]
    ])
    expect(buildCollapsedChildAgentSignalStates(nested).get('p')).toBe('waiting')
  })
})
