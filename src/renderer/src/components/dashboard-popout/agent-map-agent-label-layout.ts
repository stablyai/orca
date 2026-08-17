import {
  AGENT_MAP_AGENT_LABEL_NODE_GAP,
  agentMapAgentLabelMetrics
} from './agent-map-agent-label-metrics'
import type { AgentMapAgentNode } from './agent-map-layout'
import {
  addAgentMapLabelBox,
  agentMapLabelGridCollides,
  type AgentMapLabelBox,
  type AgentMapLabelGrid
} from './agent-map-label-spatial-grid'

export {
  AGENT_MAP_AGENT_LABEL_FRAME_WIDTH,
  AGENT_MAP_AGENT_LABEL_NODE_GAP
} from './agent-map-agent-label-metrics'

export type AgentMapAgentLabelBounds = AgentMapLabelBox

export type AgentMapAgentLabelPlacement = {
  x: number
  y: number
  width: number
  height: number
  scale: number
  bounds: AgentMapAgentLabelBounds
}

export type AgentMapAgentLabelPlacementOptions = {
  mapScale: number
  viewportHeight: number
  selectedPaneKey?: string | null
}

function compareAgents(a: AgentMapAgentNode, b: AgentMapAgentNode): number {
  return a.card.paneKey < b.card.paneKey ? -1 : a.card.paneKey > b.card.paneKey ? 1 : 0
}

function placementsAtScale(
  agents: readonly AgentMapAgentNode[],
  labelScale: number,
  obstacles: readonly AgentMapLabelBox[]
): { placements: Map<string, AgentMapAgentLabelPlacement>; collision: boolean } {
  const placements = new Map<string, AgentMapAgentLabelPlacement>()
  const nodeGrid: AgentMapLabelGrid = new Map()
  const labelGrid: AgentMapLabelGrid = new Map()
  for (const obstacle of obstacles) {
    addAgentMapLabelBox(labelGrid, obstacle)
  }
  for (const agent of agents) {
    addAgentMapLabelBox(nodeGrid, {
      left: agent.x - agent.radius,
      right: agent.x + agent.radius,
      top: agent.y - agent.radius,
      bottom: agent.y + agent.radius
    })
  }
  let collision = false
  for (const agent of agents.toSorted(compareAgents)) {
    const metrics = agentMapAgentLabelMetrics(agent.card)
    const x = -metrics.width / 2
    const y = agent.radius / labelScale + AGENT_MAP_AGENT_LABEL_NODE_GAP
    const bounds = {
      left: agent.x + x * labelScale,
      right: agent.x + (x + metrics.width) * labelScale,
      top: agent.y + y * labelScale,
      bottom: agent.y + (y + metrics.height) * labelScale
    }
    collision ||=
      agentMapLabelGridCollides(nodeGrid, bounds) || agentMapLabelGridCollides(labelGrid, bounds)
    addAgentMapLabelBox(labelGrid, bounds)
    placements.set(agent.card.paneKey, { x, y, ...metrics, scale: labelScale, bounds })
  }
  return { placements, collision }
}

export function agentMapAgentLabelPlacements(
  agents: readonly AgentMapAgentNode[],
  labelScale: number,
  obstacles: readonly AgentMapLabelBox[] = [],
  _options?: AgentMapAgentLabelPlacementOptions
): ReadonlyMap<string, AgentMapAgentLabelPlacement> {
  const desired = placementsAtScale(agents, labelScale, obstacles)
  if (!desired.collision || labelScale <= 1) {
    return desired.placements
  }
  let fitting = placementsAtScale(agents, 1, obstacles)
  let minimum = 1
  let maximum = labelScale
  for (let step = 0; step < 12; step += 1) {
    const candidate = (minimum + maximum) / 2
    const result = placementsAtScale(agents, candidate, obstacles)
    if (result.collision) {
      maximum = candidate
    } else {
      minimum = candidate
      fitting = result
    }
  }
  return fitting.placements
}

export function agentMapAgentLabelBounds(
  placements: ReadonlyMap<string, AgentMapAgentLabelPlacement>
): AgentMapAgentLabelBounds | null {
  if (placements.size === 0) {
    return null
  }
  const bounds = [...placements.values()].map((placement) => placement.bounds)
  return {
    left: Math.min(...bounds.map((box) => box.left)),
    right: Math.max(...bounds.map((box) => box.right)),
    top: Math.min(...bounds.map((box) => box.top)),
    bottom: Math.max(...bounds.map((box) => box.bottom))
  }
}
