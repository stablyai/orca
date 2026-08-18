import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type * as AgentMapAgentLabelLayoutModule from './agent-map-agent-label-layout'

const labelPlacementCall = vi.hoisted(() => vi.fn())
vi.mock('./agent-map-agent-label-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentMapAgentLabelLayoutModule>()
  return {
    ...actual,
    agentMapAgentLabelPlacements: (
      ...args: Parameters<typeof actual.agentMapAgentLabelPlacements>
    ) => {
      labelPlacementCall()
      return actual.agentMapAgentLabelPlacements(...args)
    }
  }
})

import type { AgentMapLayout } from './agent-map-layout'
import { agentMapBaseWidth } from './agent-map-canvas-zoom'
import { PRIORITY_WORKTREE_LABEL_PROJECT_LIMIT } from './agent-map-label-declutter'

function layout(agentCount: number, key: string): AgentMapLayout {
  const agents = Array.from({ length: agentCount }, (_, index) => ({
    card: {
      paneKey: `pane-${index}`,
      agentType: 'codex',
      orchestrationDisplayName: `Agent ${index}`,
      stateChangedAt: 1
    } as DashboardCard,
    x: 80 + (index % 40) * 20,
    y: 80 + Math.floor(index / 40) * 20,
    radius: 20,
    durationMinutes: 1,
    status: 'working' as const
  }))
  return {
    projects: [
      {
        id: 'project',
        name: 'Project',
        x: 450,
        y: 280,
        radius: 500,
        worktrees: [
          {
            id: 'worktree',
            worktreeId: 'worktree',
            executionHostId: 'local',
            name: 'Worktree',
            workspaceKind: 'worktree',
            x: 450,
            y: 280,
            radius: 460,
            agents,
            statusCounts: {
              working: agentCount,
              blocked: 0,
              waiting: 0,
              done: 0,
              'done-seen': 0,
              idle: 0
            },
            quiet: false
          }
        ],
        agentCount
      }
    ],
    width: 900,
    height: 560,
    topologyKey: key
  }
}

function metadataRefresh(source: AgentMapLayout): AgentMapLayout {
  return {
    ...source,
    projects: source.projects.map((project) => ({
      ...project,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        agents: worktree.agents.map((agent) => ({
          ...agent,
          card: { ...agent.card, stateChangedAt: agent.card.stateChangedAt + 1 },
          durationMinutes: agent.durationMinutes + 1
        }))
      }))
    }))
  }
}

function withProjectCount(source: AgentMapLayout, projectCount: number): AgentMapLayout {
  return {
    ...source,
    projects: Array.from({ length: projectCount }, (_, index) => {
      const project = source.projects[0]
      return {
        ...project,
        id: `${project.id}-${index}`,
        worktrees: project.worktrees.map((worktree) => ({
          ...worktree,
          id: `${worktree.id}-${index}`
        }))
      }
    })
  }
}

function changeFirstWorktreePriority(source: AgentMapLayout): AgentMapLayout {
  return {
    ...source,
    projects: source.projects.map((project, projectIndex) => ({
      ...project,
      worktrees: project.worktrees.map((worktree, worktreeIndex) =>
        projectIndex === 0 && worktreeIndex === 0
          ? {
              ...worktree,
              statusCounts: { ...worktree.statusCounts, blocked: 1, working: 0 }
            }
          : worktree
      )
    }))
  }
}

describe('agent map fit geometry cache', () => {
  beforeEach(() => labelPlacementCall.mockClear())

  it('reuses the 1,000-card fit across metadata-only layout refreshes', () => {
    const initial = layout(1_000, 'metadata-refresh-benchmark')
    const baseWidth = agentMapBaseWidth(initial, 480, 360, true, null)
    const fitCalls = labelPlacementCall.mock.calls.length

    expect(fitCalls).toBeGreaterThan(1)
    expect(agentMapBaseWidth(metadataRefresh(initial), 480, 360, true, null)).toBe(baseWidth)
    expect(labelPlacementCall).toHaveBeenCalledTimes(fitCalls)
  })

  it.each([
    [
      'topology',
      (source: AgentMapLayout) => ({ ...source, topologyKey: `${source.topologyKey}:2` })
    ],
    [
      'agent label',
      (source: AgentMapLayout) => ({
        ...source,
        projects: source.projects.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) => ({
            ...worktree,
            agents: worktree.agents.map((agent, index) =>
              index === 0
                ? {
                    ...agent,
                    card: { ...agent.card, orchestrationDisplayName: 'Renamed agent' }
                  }
                : agent
            )
          }))
        }))
      })
    ],
    [
      'project label',
      (source: AgentMapLayout) => ({
        ...source,
        projects: source.projects.map((project) => ({ ...project, name: 'Renamed project' }))
      })
    ],
    [
      'worktree label',
      (source: AgentMapLayout) => ({
        ...source,
        projects: source.projects.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) => ({
            ...worktree,
            name: 'Renamed worktree'
          }))
        }))
      })
    ],
    [
      'quiet state',
      (source: AgentMapLayout) => ({
        ...source,
        projects: source.projects.map((project) => ({
          ...project,
          worktrees: project.worktrees.map((worktree) => ({ ...worktree, quiet: true }))
        }))
      })
    ]
  ])('invalidates when %s changes', (_name, mutate) => {
    const initial = layout(8, `invalidation-${_name}`)
    agentMapBaseWidth(initial, 480, 360, true, null)
    const fitCalls = labelPlacementCall.mock.calls.length

    agentMapBaseWidth(mutate(initial), 480, 360, true, null)

    expect(labelPlacementCall.mock.calls.length).toBeGreaterThan(fitCalls)
  })

  it.each([
    ['canvas width', 481, 360, true, null],
    ['canvas height', 480, 361, true, null],
    ['aggregation', 480, 360, false, null],
    ['selection', 480, 360, true, 'pane-0']
  ])('invalidates when %s changes', (_name, width, height, allowAggregation, selectedPaneKey) => {
    const initial = layout(8, `input-invalidation-${_name}`)
    agentMapBaseWidth(initial, 480, 360, true, null)
    const fitCalls = labelPlacementCall.mock.calls.length

    agentMapBaseWidth(initial, width, height, allowAggregation, selectedPaneKey)

    expect(labelPlacementCall.mock.calls.length).toBeGreaterThan(fitCalls)
  })

  it.each([
    [PRIORITY_WORKTREE_LABEL_PROJECT_LIMIT, true],
    [PRIORITY_WORKTREE_LABEL_PROJECT_LIMIT + 1, false]
  ])(
    'tracks worktree priority for %s projects only when labels use it',
    (projectCount, invalidates) => {
      const initial = withProjectCount(layout(1, `priority-boundary-${projectCount}`), projectCount)
      agentMapBaseWidth(initial, 480, 360, true, null)
      const fitCalls = labelPlacementCall.mock.calls.length

      agentMapBaseWidth(changeFirstWorktreePriority(initial), 480, 360, true, null)

      expect(labelPlacementCall.mock.calls.length > fitCalls).toBe(invalidates)
    }
  )
})
