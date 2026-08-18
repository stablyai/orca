import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  AGENT_MAP_AGENT_LABEL_NODE_GAP,
  agentMapAgentLabelMetrics
} from './agent-map-agent-label-metrics'

export const AGENT_MAP_LINEAGE_HORIZONTAL_GAP = 8
export const AGENT_MAP_LINEAGE_VERTICAL_GAP = 8

export type AgentMapLineagePosition = {
  card: DashboardCard
  x: number
  y: number
  labelWidth: number
  labelHeight: number
}

export function agentMapLineageCellWidth(
  card: DashboardCard,
  nodeRadius: number,
  labelScale: number
): number {
  return Math.max(nodeRadius * 2, agentMapAgentLabelMetrics(card).width * labelScale)
}

export function positionAgentMapLineageRows(
  agents: { card: DashboardCard; x: number; depth: number }[],
  nodeRadius: number,
  labelScale: number
): AgentMapLineagePosition[] {
  const maxDepth = Math.max(0, ...agents.map((agent) => agent.depth))
  const rowLabelHeights = Array.from({ length: maxDepth + 1 }, () => 0)
  for (const agent of agents) {
    rowLabelHeights[agent.depth] = Math.max(
      rowLabelHeights[agent.depth],
      agentMapAgentLabelMetrics(agent.card).height * labelScale
    )
  }
  const rowY = [0]
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    rowY[depth] =
      rowY[depth - 1] +
      nodeRadius * 2 +
      AGENT_MAP_AGENT_LABEL_NODE_GAP * labelScale +
      rowLabelHeights[depth - 1] +
      AGENT_MAP_LINEAGE_VERTICAL_GAP
  }
  return agents.map(({ card, x, depth }) => {
    const metrics = agentMapAgentLabelMetrics(card)
    return {
      card,
      x,
      y: rowY[depth],
      labelWidth: metrics.width * labelScale,
      labelHeight: metrics.height * labelScale
    }
  })
}

export function agentMapLineageGridPositions(
  cards: DashboardCard[],
  nodeRadius: number,
  labelScale: number,
  depthOffset = 0
): AgentMapLineagePosition[] {
  const columns = Math.ceil(Math.sqrt(cards.length))
  const rows: DashboardCard[][] = []
  for (let index = 0; index < cards.length; index += columns) {
    rows.push(cards.slice(index, index + columns))
  }
  const columnWidth = Math.max(
    ...cards.map((card) => agentMapLineageCellWidth(card, nodeRadius, labelScale))
  )
  const positions: { card: DashboardCard; x: number; depth: number }[] = []
  for (const [rowIndex, row] of rows.entries()) {
    const width = (row.length - 1) * (columnWidth + AGENT_MAP_LINEAGE_HORIZONTAL_GAP)
    for (const [columnIndex, card] of row.entries()) {
      positions.push({
        card,
        x: columnIndex * (columnWidth + AGENT_MAP_LINEAGE_HORIZONTAL_GAP) - width / 2,
        depth: rowIndex + depthOffset
      })
    }
  }
  return positionAgentMapLineageRows(positions, nodeRadius, labelScale)
}
