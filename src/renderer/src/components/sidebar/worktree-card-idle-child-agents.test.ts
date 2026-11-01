import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  collapsedChildAgentsSignalState,
  partitionIdleChildAgents
} from './worktree-card-idle-child-agents'

function row(paneKey: string, state: DashboardAgentRow['state']): DashboardAgentRow {
  // SAFETY: dot-state derivation reads only `state` and the entry's verdict fields.
  return { paneKey, state, entry: { state: 'working' } } as unknown as DashboardAgentRow
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
  it('surfaces live child work but stays quiet for idle or finished children', () => {
    expect(collapsedChildAgentsSignalState([row('a', 'idle'), row('b', 'working')])).toBe('working')
    expect(collapsedChildAgentsSignalState([row('a', 'idle'), row('b', 'done')])).toBeUndefined()
  })
})
