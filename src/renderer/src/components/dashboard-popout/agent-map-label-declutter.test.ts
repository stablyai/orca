import { describe, expect, it } from 'vitest'
import { selectVisibleAgentMapLabels } from './agent-map-label-declutter'
import type { AgentMapLayout, AgentMapProjectRing, AgentMapWorktreeRing } from './agent-map-layout'
import {
  agentMapQuietCount,
  emptyAgentMapStatusCounts,
  type AgentMapStatusCounts
} from './agent-map-node-metadata'

function statusCounts(overrides: Partial<AgentMapStatusCounts> = {}): AgentMapStatusCounts {
  return { ...emptyAgentMapStatusCounts(), ...overrides }
}

function worktree(overrides: Partial<AgentMapWorktreeRing> = {}): AgentMapWorktreeRing {
  const counts = overrides.statusCounts ?? statusCounts({ working: 1 })
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return {
    id: 'worktree-a',
    worktreeId: 'worktree-a',
    executionHostId: undefined,
    name: 'alpha',
    workspaceKind: 'worktree',
    x: 0,
    y: 0,
    radius: 62,
    // Sparse placeholders keep tests that only care about label-to-label collisions concise.
    agents: Array.from({ length: total }) as AgentMapWorktreeRing['agents'],
    statusCounts: counts,
    quiet: agentMapQuietCount(counts) === total,
    ...overrides
  }
}

function layoutOf(
  worktrees: AgentMapWorktreeRing[],
  project: Partial<AgentMapProjectRing> = {}
): AgentMapLayout {
  return {
    projects: [
      {
        id: 'project-1',
        name: 'orca',
        x: 0,
        // Parked far above the workspaces so the project label is not itself
        // the thing under test unless a case moves it.
        y: -4_000,
        radius: 100,
        worktrees,
        agentCount: worktrees.reduce((sum, item) => sum + item.agents.length, 0),
        ...project
      }
    ],
    width: 900,
    height: 560,
    topologyKey: 'test'
  }
}

describe('selectVisibleAgentMapLabels', () => {
  it('keeps both labels when they are far enough apart', () => {
    const layout = layoutOf([
      worktree({ id: 'a', x: -400, y: 0 }),
      worktree({ id: 'b', name: 'beta', x: 400, y: 0 })
    ])

    const { worktreeIds } = selectVisibleAgentMapLabels(layout, 1, 1)

    expect([...worktreeIds].sort()).toEqual(['a', 'b'])
  })

  it('drops the lower-priority label when two would overlap', () => {
    // Same anchor point: the two labels are drawn on top of each other.
    const layout = layoutOf([
      worktree({ id: 'busy', x: 0, y: 0, statusCounts: statusCounts({ working: 3 }) }),
      worktree({ id: 'calm', name: 'beta', x: 0, y: 0, statusCounts: statusCounts({ done: 1 }) })
    ])

    const { worktreeIds } = selectVisibleAgentMapLabels(layout, 1, 1)

    expect([...worktreeIds]).toEqual(['busy'])
  })

  it('hides a workspace title that would cover an agent', () => {
    const coveringAgent = { x: 0, y: -48, radius: 20 }
    const covered = worktree({
      id: 'covered',
      agents: [coveringAgent] as AgentMapWorktreeRing['agents']
    })

    const labels = selectVisibleAgentMapLabels(layoutOf([covered]), 1, 1)

    expect(labels.worktreeIds.size).toBe(0)
  })

  it('lets a blocked workspace outrank a busier neighbour for the surviving label', () => {
    const layout = layoutOf([
      worktree({ id: 'blocked', x: 0, y: 0, statusCounts: statusCounts({ blocked: 1 }) }),
      worktree({
        id: 'working',
        name: 'beta',
        x: 0,
        y: 0,
        statusCounts: statusCounts({ working: 9 })
      })
    ])

    const { worktreeIds } = selectVisibleAgentMapLabels(layout, 1, 1)

    expect([...worktreeIds]).toEqual(['blocked'])
  })

  it('hides all-idle workspace labels until the ring is large on screen', () => {
    const idle = worktree({ id: 'idle', x: 0, y: 0, statusCounts: statusCounts({ idle: 2 }) })

    expect(selectVisibleAgentMapLabels(layoutOf([idle]), 1, 0.5).worktreeIds.size).toBe(0)
    expect([...selectVisibleAgentMapLabels(layoutOf([idle]), 1, 1).worktreeIds]).toEqual(['idle'])
  })

  it('drops the project count rather than a workspace name when they collide', () => {
    // The workspace ring's name lands on the project's count line.
    const layout = layoutOf([worktree({ id: 'a', x: 0, y: 42 })], {
      x: 0,
      y: 0,
      radius: 40,
      agentCount: 1
    })

    const { worktreeIds, projectCountIds } = selectVisibleAgentMapLabels(layout, 1, 1)

    expect([...worktreeIds]).toEqual(['a'])
    expect(projectCountIds.size).toBe(0)
  })

  it('keeps the project count when nothing is in its way', () => {
    const layout = layoutOf([worktree({ id: 'a', x: 0, y: 0 })])

    expect([...selectVisibleAgentMapLabels(layout, 1, 1).projectCountIds]).toEqual(['project-1'])
  })

  it('admits more labels as zooming in shrinks their world footprint', () => {
    const worktrees = Array.from({ length: 6 }, (_unused, index) =>
      worktree({ id: `w-${index}`, name: `workspace-${index}`, x: index * 90, y: 0 })
    )

    const zoomedOut = selectVisibleAgentMapLabels(layoutOf(worktrees), 4, 0.25).worktreeIds
    const zoomedIn = selectVisibleAgentMapLabels(layoutOf(worktrees), 1, 1).worktreeIds

    expect(zoomedOut.size).toBeLessThan(zoomedIn.size)
    expect(zoomedIn.size).toBe(6)
  })
})
