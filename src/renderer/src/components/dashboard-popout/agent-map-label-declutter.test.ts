import { describe, expect, it } from 'vitest'
import {
  agentMapProjectLabelBoxes,
  agentMapProjectLabelFrameWidth,
  selectVisibleAgentMapLabels
} from './agent-map-label-declutter'
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

describe('agentMapProjectLabelBoxes', () => {
  it('bounds long project names to the rendered label frame', () => {
    const shortName = layoutOf([], { name: 'orca', x: 100, y: 200, radius: 80 })
    const longName = layoutOf([], { name: 'x'.repeat(1_024), x: 100, y: 200, radius: 80 })

    const [shortBox] = agentMapProjectLabelBoxes(shortName, 2, 0.5)
    const [longBox] = agentMapProjectLabelBoxes(longName, 2, 0.5)

    expect(longBox.right - longBox.left).toBe(156)
    expect(shortBox.right - shortBox.left).toBeLessThan(longBox.right - longBox.left)
  })

  it.each([
    [0.5, 80],
    [1, 160],
    [2, 160],
    [4, 160]
  ])('uses a local frame width of %s scale without compounding zoom', (mapScale, expectedWidth) => {
    expect(agentMapProjectLabelFrameWidth(80, mapScale)).toBe(expectedWidth)
  })

  it('keeps project obstacles linear above unit map scale', () => {
    const layout = layoutOf([], { name: 'x'.repeat(1_024), radius: 80 })
    const screenWidths = [1, 2, 4].map((mapScale) => {
      const [box] = agentMapProjectLabelBoxes(layout, 1, mapScale)
      return (box.right - box.left) * mapScale
    })

    expect(screenWidths[1] / screenWidths[0]).toBe(2)
    expect(screenWidths[2] / screenWidths[0]).toBe(4)
  })

  it('includes unique host badges and their flex gaps in project obstacles', () => {
    const firstHost = worktree({
      id: 'ssh-a',
      executionHostId: 'ssh:shared',
      hostKind: 'ssh'
    })
    const duplicateHost = worktree({
      id: 'ssh-a-copy',
      executionHostId: 'ssh:shared',
      hostKind: 'ssh'
    })
    const secondHost = worktree({
      id: 'remote-b',
      executionHostId: 'runtime:other',
      hostKind: 'remote'
    })
    const boxWidth = (worktrees: AgentMapWorktreeRing[]): number => {
      const [box] = agentMapProjectLabelBoxes(layoutOf(worktrees, { name: 'a', radius: 200 }), 1, 1)
      return box.right - box.left
    }
    const withoutHosts = boxWidth([])
    const oneHost = boxWidth([firstHost])

    expect(oneHost - withoutHosts).toBe(16)
    expect(boxWidth([firstHost, duplicateHost])).toBe(oneHost)
    expect(boxWidth([firstHost, secondHost]) - oneHost).toBe(16)
  })

  it('models badge overflow when fixed project content exceeds the frame', () => {
    const hosts = ['a', 'b', 'c'].map((id) =>
      worktree({ id, executionHostId: `ssh:${id}`, hostKind: 'ssh' })
    )
    const layout = layoutOf(hosts, { name: 'a', radius: 20 })
    const [box] = agentMapProjectLabelBoxes(layout, 1, 1)

    expect(box.right - box.left).toBe(70)
    expect(box.right - box.left).toBeGreaterThan(agentMapProjectLabelFrameWidth(20, 1))
  })
})

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

  it('hides optional labels behind occupied agent label bounds', () => {
    const layout = layoutOf([worktree({ id: 'covered' })])
    const occupied = [{ left: -80, right: 80, top: -60, bottom: -30 }]

    const labels = selectVisibleAgentMapLabels(layout, 1, 1, occupied)

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

  it('keeps workspace labels out of rendered host badge space', () => {
    const nearProjectLabel = worktree({ id: 'near', name: 'w', x: 25, y: -138 })
    const project = { x: 0, y: 0, radius: 200, name: 'a' }
    const localLayout = layoutOf([nearProjectLabel], project)
    const hostedLayout = layoutOf(
      [
        {
          ...nearProjectLabel,
          executionHostId: 'ssh:host',
          hostKind: 'ssh'
        }
      ],
      project
    )

    expect([...selectVisibleAgentMapLabels(localLayout, 1, 1).worktreeIds]).toEqual(['near'])
    expect(selectVisibleAgentMapLabels(hostedLayout, 1, 1).worktreeIds.size).toBe(0)
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
