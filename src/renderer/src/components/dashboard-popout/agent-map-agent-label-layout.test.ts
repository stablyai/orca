import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { AgentMapAgentNode } from './agent-map-layout'
import { layoutAgentMapLineage } from './agent-map-lineage-layout'
import {
  AGENT_MAP_AGENT_LABEL_FRAME_WIDTH,
  AGENT_MAP_AGENT_LABEL_NODE_GAP,
  agentMapAgentLabelPlacements,
  type AgentMapAgentLabelBounds
} from './agent-map-agent-label-layout'

function agent(
  paneKey: string,
  x: number,
  y: number,
  parentPaneKey?: string,
  name?: string
): AgentMapAgentNode {
  return {
    card: {
      paneKey,
      parentPaneKey,
      agentType: 'codex',
      orchestrationDisplayName: name
    } as DashboardCard,
    x,
    y,
    radius: 20,
    durationMinutes: 1,
    status: 'working'
  }
}

function overlaps(a: AgentMapAgentLabelBounds, b: AgentMapAgentLabelBounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function nodeBounds(item: AgentMapAgentNode): AgentMapAgentLabelBounds {
  return {
    left: item.x - item.radius,
    right: item.x + item.radius,
    top: item.y - item.radius,
    bottom: item.y + item.radius
  }
}

function fanout(childCount: number): AgentMapAgentNode[] {
  const width = (childCount - 1) * 54
  return [
    agent('parent', 0, 0),
    ...Array.from({ length: childCount }, (_, index) =>
      agent(`child-${index}`, index * 54 - width / 2, 58, 'parent')
    )
  ]
}

describe('agentMapAgentLabelPlacements', () => {
  it('centers an unobstructed single label below its node', () => {
    const item = agent('only', 10, 20)
    const placement = agentMapAgentLabelPlacements([item], 2).get('only')!

    expect(placement.width).toBe(AGENT_MAP_AGENT_LABEL_FRAME_WIDTH)
    expect(placement.x).toBe(-placement.width / 2)
    expect(placement.y).toBe(item.radius / 2 + AGENT_MAP_AGENT_LABEL_NODE_GAP)
    expect(placement).not.toHaveProperty('leader')
  })

  it('models whitespace wrapping for wide glyphs', () => {
    const placement = agentMapAgentLabelPlacements(
      [agent('wide', 0, 0, undefined, 'WWWW WWWW')],
      1
    ).get('wide')!

    expect(placement.width).toBe(AGENT_MAP_AGENT_LABEL_FRAME_WIDTH)
    expect(placement.height).toBeGreaterThanOrEqual(32)
  })

  it('widens a maximum-length name and caps it at twelve visible lines', () => {
    const placement = agentMapAgentLabelPlacements(
      [agent('long', 0, 0, undefined, 'W'.repeat(1_024))],
      1
    ).get('long')!

    expect(placement.width).toBeGreaterThan(AGENT_MAP_AGENT_LABEL_FRAME_WIDTH)
    expect(placement.height).toBe(162)
    expect(placement.bounds.right - placement.bounds.left).toBe(placement.width)
    expect(placement.x).toBe(-placement.width / 2)
  })

  it.each([5, 12, 19, 120])('keeps %s lineage cells attached and collision-free', (agentCount) => {
    const cards = [
      { paneKey: 'parent', agentType: 'codex', orchestrationDisplayName: 'Coordinator' },
      ...Array.from({ length: agentCount - 1 }, (_, index) => ({
        paneKey: `child-${index}`,
        parentPaneKey: 'parent',
        agentType: 'codex',
        orchestrationDisplayName: `Worker ${index + 1}`
      }))
    ] as DashboardCard[]
    const lineage = layoutAgentMapLineage(cards, 20)!
    const agents = lineage.agents.map(
      ({ card, x, y }): AgentMapAgentNode => ({
        card,
        x,
        y,
        radius: 20,
        durationMinutes: 1,
        status: 'working'
      })
    )
    const placements = agentMapAgentLabelPlacements(agents, 1)
    const labels = [...placements.values()].map((placement) => placement.bounds)
    const nodes = agents.map(nodeBounds)

    expect(labels).toHaveLength(agents.length)
    for (const [index, agent] of agents.entries()) {
      const placement = placements.get(agent.card.paneKey)!
      expect(agent.x + (placement.x + placement.width / 2)).toBe(agent.x)
      expect(placement.bounds.top).toBeGreaterThan(agent.y + agent.radius)
      expect(
        nodes.some((node, nodeIndex) => nodeIndex !== index && overlaps(placement.bounds, node))
      ).toBe(false)
      expect(labels.slice(index + 1).some((other) => overlaps(placement.bounds, other))).toBe(false)
      expect(placement).not.toHaveProperty('leader')
    }
  })

  it('lays out unrelated agents as collision-free cells', () => {
    const cards = Array.from({ length: 19 }, (_, index) => ({
      paneKey: `agent-${index}`,
      agentType: 'codex',
      orchestrationDisplayName: `Independent worker ${index + 1}`
    })) as DashboardCard[]
    const lineage = layoutAgentMapLineage(cards, 20)!
    const agents = lineage.agents.map(
      ({ card, x, y }): AgentMapAgentNode => ({
        card,
        x,
        y,
        radius: 20,
        durationMinutes: 1,
        status: 'working'
      })
    )
    const placements = [...agentMapAgentLabelPlacements(agents, 1).values()]

    expect(placements).toHaveLength(cards.length)
    for (const [index, placement] of placements.entries()) {
      expect(
        placements.slice(index + 1).some((other) => overlaps(placement.bounds, other.bounds))
      ).toBe(false)
    }
  })

  it('keeps placements deterministic without detaching labels', () => {
    const agents = fanout(4)
    const first = agentMapAgentLabelPlacements(agents, 1)
    const second = agentMapAgentLabelPlacements(agents.toReversed(), 1)

    expect([...first]).toEqual([...second])
    for (const [paneKey, placement] of first) {
      const item = agents.find((agent) => agent.card.paneKey === paneKey)!
      expect(item.x + placement.x + placement.width / 2).toBe(item.x)
      expect(placement).not.toHaveProperty('leader')
    }
  })
})
