import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  buildCollapsedChildAgentSignalStates,
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

  it('visits each pane once on a deep chain', () => {
    class CountingMap<K, V> extends Map<K, V> {
      gets = 0
      override get(key: K): V | undefined {
        this.gets++
        return super.get(key)
      }
    }
    const depth = 500
    const chain = new CountingMap<string, DashboardAgentRow[]>()
    for (let i = 0; i < depth; i++) {
      chain.set(`n${i}`, [row(`n${i + 1}`, i === depth - 1 ? 'blocked' : 'idle')])
    }
    const signals = buildCollapsedChildAgentSignalStates(chain)
    expect(signals.get('n0')).toBe('blocked')
    expect(signals.get(`n${depth - 1}`)).toBe('blocked')
    expect(chain.gets).toBeLessThanOrEqual(depth + 1)
  })
})
