import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  agentMapAgentLabelBounds,
  agentMapAgentLabelPlacements
} from './agent-map-agent-label-layout'
import { agentMapAgentLabelScale } from './agent-map-agent-label-metrics'
import type { AgentMapAgentNode, AgentMapLayout } from './agent-map-layout'
import { MAX_ZOOM, agentFocusViewport, agentMapBaseWidth } from './agent-map-canvas-zoom'
import { agentMapProjectLabelBoxes } from './agent-map-label-declutter'

function agent(paneKey: string, x: number, y: number, parentPaneKey?: string): AgentMapAgentNode {
  return {
    card: { paneKey, parentPaneKey } as DashboardCard,
    x,
    y,
    radius: 20,
    durationMinutes: 1,
    status: 'working'
  }
}

function layoutWithFanout(childCount: number, spacing = 54): AgentMapLayout {
  const width = (childCount - 1) * spacing
  const agents = [
    agent('parent', 450, 250),
    ...Array.from({ length: childCount }, (_, index) =>
      agent(`child-${index}`, 450 + index * spacing - width / 2, 308, 'parent')
    )
  ]
  return {
    projects: [
      {
        id: 'project',
        name: 'Project',
        x: 450,
        y: 280,
        radius: 230,
        worktrees: [
          {
            id: 'worktree',
            worktreeId: 'worktree',
            executionHostId: 'local',
            name: 'Worktree',
            workspaceKind: 'worktree',
            x: 450,
            y: 280,
            radius: 190,
            agents,
            statusCounts: {
              working: agents.length,
              blocked: 0,
              waiting: 0,
              done: 0,
              'done-seen': 0,
              idle: 0
            },
            quiet: false
          }
        ],
        agentCount: agents.length
      }
    ],
    width: 900,
    height: 560,
    topologyKey: 'test'
  }
}

function expectLabelsFit(layout: AgentMapLayout, canvasWidth: number, canvasHeight: number): void {
  const baseWidth = agentMapBaseWidth(layout, canvasWidth, canvasHeight, false, null)
  const mapScale = canvasWidth / baseWidth
  const projectLabelScale = Math.max(1, 1 / mapScale)
  const agentLabelScale = agentMapAgentLabelScale(mapScale)
  const agents = layout.projects[0].worktrees[0].agents
  const projectBoxes = agentMapProjectLabelBoxes(layout, projectLabelScale, mapScale)
  const bounds = agentMapAgentLabelBounds(
    agentMapAgentLabelPlacements(agents, agentLabelScale, projectBoxes)
  )!
  const baseHeight = baseWidth / (canvasWidth / canvasHeight)
  const viewLeft = layout.width / 2 - baseWidth / 2
  const viewTop = layout.height / 2 - baseHeight / 2

  expect((bounds.left - viewLeft) * mapScale).toBeGreaterThanOrEqual(0)
  expect((bounds.right - viewLeft) * mapScale).toBeLessThanOrEqual(canvasWidth)
  expect((bounds.top - viewTop) * mapScale).toBeGreaterThanOrEqual(0)
  expect((bounds.bottom - viewTop) * mapScale).toBeLessThanOrEqual(canvasHeight)
}

describe('agentMapBaseWidth', () => {
  it('fits actual seven-child cell bounds inside the canvas', () => {
    expectLabelsFit(layoutWithFanout(7), 1_200, 800)
  })

  it('fits a maximum-length agent name by widening its wrapped frame', () => {
    const layout = layoutWithFanout(1)
    layout.projects[0].worktrees[0].agents[0].card = {
      ...layout.projects[0].worktrees[0].agents[0].card,
      agentType: 'codex',
      orchestrationDisplayName: 'W'.repeat(1_024)
    } as DashboardCard

    expectLabelsFit(layout, 480, 360)
  })

  it('does not let a long project name inflate the fitted map width past its frame', () => {
    const frameFillingName = layoutWithFanout(7)
    frameFillingName.projects[0].name = 'x'.repeat(100)
    const longName = layoutWithFanout(7)
    longName.projects[0].name = 'x'.repeat(1_024)

    expect(agentMapBaseWidth(longName, 480, 360, false, null)).toBe(
      agentMapBaseWidth(frameFillingName, 480, 360, false, null)
    )
  })

  it('finds an intermediate fitting scale for non-monotonic label bounds', () => {
    expectLabelsFit(layoutWithFanout(7, 45), 400, 300)
  })

  it('fits twelve attached child cells on a narrow canvas', () => {
    expectLabelsFit(layoutWithFanout(12), 480, 360)
  })

  it('fits nineteen attached agent cells on a narrow canvas', () => {
    expectLabelsFit(layoutWithFanout(18), 480, 360)
  })

  it('keeps a selected label near enough to fit with its node', () => {
    const layout = layoutWithFanout(32)
    const width = 480
    const height = 360
    const selected = layout.projects[0].worktrees[0].agents[6]
    const baseWidth = agentMapBaseWidth(layout, width, height, false, selected.card.paneKey)
    const target = agentFocusViewport(layout, selected, baseWidth, width, height, false)
    const mapScale = (width * target.zoom) / baseWidth
    const projectLabelScale = Math.max(1, 1 / mapScale)
    const agentLabelScale = agentMapAgentLabelScale(mapScale)
    const placements = agentMapAgentLabelPlacements(
      layout.projects[0].worktrees[0].agents,
      agentLabelScale,
      agentMapProjectLabelBoxes(layout, projectLabelScale, mapScale)
    )
    const placement = placements.get(selected.card.paneKey)!
    const screenLeft = (placement.bounds.left - target.center.x) * mapScale + width / 2
    const screenRight = (placement.bounds.right - target.center.x) * mapScale + width / 2
    const screenTop = (placement.bounds.top - target.center.y) * mapScale + height / 2
    const screenBottom = (placement.bounds.bottom - target.center.y) * mapScale + height / 2

    expect(placement).not.toHaveProperty('leader')
    expect(placement.x + placement.width / 2).toBe(0)
    expect(screenLeft).toBeGreaterThanOrEqual(0)
    expect(screenRight).toBeLessThanOrEqual(width)
    expect(screenTop).toBeGreaterThanOrEqual(0)
    expect(screenBottom).toBeLessThanOrEqual(height)
    expect(
      (selected.x - selected.radius - target.center.x) * mapScale + width / 2
    ).toBeGreaterThanOrEqual(0)
    expect(
      (selected.x + selected.radius - target.center.x) * mapScale + width / 2
    ).toBeLessThanOrEqual(width)
    expect(
      (selected.y - selected.radius - target.center.y) * mapScale + height / 2
    ).toBeGreaterThanOrEqual(0)
    expect(
      (selected.y + selected.radius - target.center.y) * mapScale + height / 2
    ).toBeLessThanOrEqual(height)
  })

  it('returns a bounded best-effort fit for physically impossible fleets', () => {
    const baseWidth = agentMapBaseWidth(layoutWithFanout(119), 480, 360, false, null)

    expect(baseWidth).not.toBe(900)
    expect(baseWidth).toBeLessThanOrEqual(900 * MAX_ZOOM)
    expect(Number.isFinite(baseWidth)).toBe(true)
  })

  it('ignores quiet agents hidden by zoom-one aggregation', () => {
    const layout = layoutWithFanout(23)
    const worktree = layout.projects[0].worktrees[0]
    worktree.quiet = true
    worktree.statusCounts = {
      working: 0,
      blocked: 0,
      waiting: 0,
      done: 24,
      'done-seen': 0,
      idle: 0
    }

    expect(agentMapBaseWidth(layout, 1_200, 800, true, null)).toBe(900)
  })

  it.each([
    [0, 0],
    [200, 400]
  ])('stays finite for a narrow %sx%s canvas', (width, height) => {
    const baseWidth = agentMapBaseWidth(layoutWithFanout(7), width, height)
    expect(baseWidth).toBeGreaterThan(0)
    expect(Number.isFinite(baseWidth)).toBe(true)
  })
})
