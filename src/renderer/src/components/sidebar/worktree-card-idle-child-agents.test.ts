import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  collapsedChildAgentsSignalState,
  partitionIdleChildAgents
} from './worktree-card-idle-child-agents'

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

describe('partitionIdleChildAgents', () => {
  it('folds two or more idle children and keeps the rest in order', () => {
    const { activeChildren, idleChildren } = partitionIdleChildAgents([
      row('idle-a', 'idle'),
      row('busy', 'working'),
      row('idle-b', 'idle')
    ])
    expect(activeChildren.map((agent) => agent.paneKey)).toEqual(['busy'])
    expect(idleChildren.map((agent) => agent.paneKey)).toEqual(['idle-a', 'idle-b'])
  })

  it('leaves a lone idle child inline', () => {
    const children = [row('idle', 'idle'), row('busy', 'working')]
    expect(partitionIdleChildAgents(children)).toEqual({
      activeChildren: children,
      idleChildren: []
    })
  })
})

describe('collapsedChildAgentsSignalState', () => {
  it('surfaces live descendant work but stays quiet for idle or finished children', () => {
    const quiet = new Map([['p', [row('a', 'idle'), row('b', 'done')]]])
    expect(collapsedChildAgentsSignalState(quiet, 'p')).toBeUndefined()
    // A waiting grandchild must still light its collapsed grandparent; the cycle back to p is ignored.
    const nested = new Map([
      ['p', [row('a', 'idle')]],
      ['a', [row('g', 'waiting')]],
      ['g', [row('p', 'working')]]
    ])
    expect(collapsedChildAgentsSignalState(nested, 'p')).toBe('waiting')
  })
})
