import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  AGENT_MAP_AGENT_LABEL_NODE_GAP,
  agentMapAgentLabelMetrics
} from './agent-map-agent-label-metrics'
import {
  AGENT_MAP_LINEAGE_HORIZONTAL_GAP,
  AGENT_MAP_LINEAGE_VERTICAL_GAP,
  agentMapLineageCellWidth,
  agentMapLineageGridPositions,
  positionAgentMapLineageRows,
  type AgentMapLineagePosition
} from './agent-map-lineage-grid'
import { packAgentMapWorktrees } from './agent-map-worktree-packing'

const FAMILY_PADDING = 8
const WORKTREE_PADDING = 6
const COMPACT_FANOUT_THRESHOLD = 12
const MAX_EXACT_LINEAGE_AGENTS = 256

export type { AgentMapLineagePosition } from './agent-map-lineage-grid'

type AgentMapAgentFamily = {
  id: string
  x: number
  y: number
  radius: number
  agents: AgentMapLineagePosition[]
}

type AgentMapSubtree = {
  width: number
  agents: { card: DashboardCard; x: number; depth: number }[]
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encloseFamily(
  id: string,
  agents: AgentMapLineagePosition[],
  nodeRadius: number,
  labelScale: number
): AgentMapAgentFamily {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const agent of agents) {
    left = Math.min(left, agent.x - Math.max(nodeRadius, agent.labelWidth / 2))
    right = Math.max(right, agent.x + Math.max(nodeRadius, agent.labelWidth / 2))
    top = Math.min(top, agent.y - nodeRadius)
    bottom = Math.max(
      bottom,
      agent.y + nodeRadius + AGENT_MAP_AGENT_LABEL_NODE_GAP * labelScale + agent.labelHeight
    )
  }
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  let radius = 0
  for (const agent of agents) {
    agent.x -= centerX
    agent.y -= centerY
    const halfWidth = Math.max(nodeRadius, agent.labelWidth / 2)
    const agentBottom = nodeRadius + AGENT_MAP_AGENT_LABEL_NODE_GAP * labelScale + agent.labelHeight
    const farthestX = Math.max(Math.abs(agent.x - halfWidth), Math.abs(agent.x + halfWidth))
    const farthestY = Math.max(Math.abs(agent.y - nodeRadius), Math.abs(agent.y + agentBottom))
    radius = Math.max(radius, Math.hypot(farthestX, farthestY))
  }
  return { id, x: 0, y: 0, radius: radius + FAMILY_PADDING, agents }
}

function buildCompactFanoutFamily(
  root: DashboardCard,
  children: DashboardCard[],
  nodeRadius: number,
  labelScale: number,
  emitted: Set<string>
): AgentMapAgentFamily {
  emitted.add(root.paneKey)
  children.forEach((child) => emitted.add(child.paneKey))
  const rootMetrics = agentMapAgentLabelMetrics(root)
  const childPositions = agentMapLineageGridPositions(children, nodeRadius, labelScale, 1)
  return encloseFamily(
    root.paneKey,
    [
      {
        card: root,
        x: 0,
        y: 0,
        labelWidth: rootMetrics.width * labelScale,
        labelHeight: rootMetrics.height * labelScale
      },
      ...childPositions.map((agent) => ({
        ...agent,
        y: agent.y + rootMetrics.height * labelScale
      }))
    ],
    nodeRadius,
    labelScale
  )
}

function buildFamily(
  root: DashboardCard,
  childrenByParent: ReadonlyMap<string, DashboardCard[]>,
  nodeRadius: number,
  labelScale: number,
  emitted: Set<string>
): AgentMapAgentFamily {
  const rootChildren = (childrenByParent.get(root.paneKey) ?? []).filter(
    (child) => !emitted.has(child.paneKey)
  )
  if (
    rootChildren.length >= COMPACT_FANOUT_THRESHOLD &&
    rootChildren.every((child) => (childrenByParent.get(child.paneKey) ?? []).length === 0)
  ) {
    return buildCompactFanoutFamily(root, rootChildren, nodeRadius, labelScale, emitted)
  }

  const buildSubtree = (
    card: DashboardCard,
    depth: number,
    ancestors: ReadonlySet<string>
  ): AgentMapSubtree => {
    if (ancestors.has(card.paneKey) || emitted.has(card.paneKey)) {
      return { width: agentMapLineageCellWidth(card, nodeRadius, labelScale), agents: [] }
    }
    emitted.add(card.paneKey)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(card.paneKey)
    const children = (childrenByParent.get(card.paneKey) ?? []).filter(
      (child) => !nextAncestors.has(child.paneKey) && !emitted.has(child.paneKey)
    )
    const childTrees = children.map((child) => buildSubtree(child, depth + 1, nextAncestors))
    const childrenWidth =
      childTrees.reduce((total, child) => total + child.width, 0) +
      Math.max(0, childTrees.length - 1) * AGENT_MAP_LINEAGE_HORIZONTAL_GAP
    const width = Math.max(agentMapLineageCellWidth(card, nodeRadius, labelScale), childrenWidth)
    const agents: AgentMapSubtree['agents'] = [{ card, x: 0, depth }]
    let cursor = -childrenWidth / 2
    for (const child of childTrees) {
      const center = cursor + child.width / 2
      agents.push(...child.agents.map((agent) => ({ ...agent, x: agent.x + center })))
      cursor += child.width + AGENT_MAP_LINEAGE_HORIZONTAL_GAP
    }
    return { width, agents }
  }

  const subtree = buildSubtree(root, 0, new Set())
  return encloseFamily(
    root.paneKey,
    positionAgentMapLineageRows(subtree.agents, nodeRadius, labelScale),
    nodeRadius,
    labelScale
  )
}

function layoutBoundedLineage(
  sorted: DashboardCard[],
  childrenByParent: ReadonlyMap<string, DashboardCard[]>,
  childPaneKeys: ReadonlySet<string>,
  nodeRadius: number,
  labelScale: number
): { agents: AgentMapLineagePosition[]; radius: number } {
  const levels: DashboardCard[][] = []
  const emitted = new Set<string>()
  const roots = sorted.filter((card) => !childPaneKeys.has(card.paneKey))
  for (const seed of [...roots, ...sorted]) {
    if (emitted.has(seed.paneKey)) {
      continue
    }
    const stack = [{ card: seed, depth: 0 }]
    while (stack.length > 0) {
      const entry = stack.pop()!
      if (emitted.has(entry.card.paneKey)) {
        continue
      }
      emitted.add(entry.card.paneKey)
      ;(levels[entry.depth] ??= []).push(entry.card)
      const children = childrenByParent.get(entry.card.paneKey) ?? []
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!emitted.has(children[index].paneKey)) {
          stack.push({ card: children[index], depth: entry.depth + 1 })
        }
      }
    }
  }
  const positioned: AgentMapLineagePosition[] = []
  let previousBottom = Number.NEGATIVE_INFINITY
  for (const level of levels) {
    const grid = agentMapLineageGridPositions(level, nodeRadius, labelScale)
    const top = Math.min(...grid.map((agent) => agent.y - nodeRadius))
    const bottom = Math.max(
      ...grid.map(
        (agent) =>
          agent.y + nodeRadius + AGENT_MAP_AGENT_LABEL_NODE_GAP * labelScale + agent.labelHeight
      )
    )
    const offsetY = Number.isFinite(previousBottom)
      ? previousBottom + AGENT_MAP_LINEAGE_VERTICAL_GAP - top
      : 0
    positioned.push(...grid.map((agent) => ({ ...agent, y: agent.y + offsetY })))
    previousBottom = bottom + offsetY
  }
  const family = encloseFamily(sorted[0].paneKey, positioned, nodeRadius, labelScale)
  family.agents.sort((a, b) => compareStable(a.card.paneKey, b.card.paneKey))
  return { agents: family.agents, radius: Math.max(52, family.radius + WORKTREE_PADDING) }
}

export function layoutAgentMapLineage(
  cards: DashboardCard[],
  nodeRadius: number,
  labelScale = 1
): { agents: AgentMapLineagePosition[]; radius: number } | null {
  const sorted = [...cards].sort((a, b) => compareStable(a.paneKey, b.paneKey))
  if (sorted.length === 0) {
    return null
  }
  const cardsByPaneKey = new Map(sorted.map((card) => [card.paneKey, card]))
  const childrenByParent = new Map<string, DashboardCard[]>()
  const childPaneKeys = new Set<string>()

  for (const card of sorted) {
    const parentPaneKey = card.parentPaneKey
    if (!parentPaneKey || parentPaneKey === card.paneKey || !cardsByPaneKey.has(parentPaneKey)) {
      continue
    }
    childPaneKeys.add(card.paneKey)
    childrenByParent.set(parentPaneKey, [...(childrenByParent.get(parentPaneKey) ?? []), card])
  }
  if (childPaneKeys.size === 0) {
    const family = encloseFamily(
      sorted[0].paneKey,
      agentMapLineageGridPositions(sorted, nodeRadius, labelScale),
      nodeRadius,
      labelScale
    )
    return { agents: family.agents, radius: Math.max(52, family.radius + WORKTREE_PADDING) }
  }
  if (sorted.length > MAX_EXACT_LINEAGE_AGENTS) {
    return layoutBoundedLineage(sorted, childrenByParent, childPaneKeys, nodeRadius, labelScale)
  }

  const emitted = new Set<string>()
  const roots = sorted.filter((card) => !childPaneKeys.has(card.paneKey))
  const families: AgentMapAgentFamily[] = []
  for (const root of roots) {
    if (!emitted.has(root.paneKey)) {
      families.push(buildFamily(root, childrenByParent, nodeRadius, labelScale, emitted))
    }
  }
  for (const card of sorted) {
    if (!emitted.has(card.paneKey)) {
      families.push(buildFamily(card, childrenByParent, nodeRadius, labelScale, emitted))
    }
  }
  const packed = packAgentMapWorktrees(families)
  return {
    agents: packed
      .flatMap((family) =>
        family.agents.map((agent) => ({ ...agent, x: family.x + agent.x, y: family.y + agent.y }))
      )
      .sort((a, b) => compareStable(a.card.paneKey, b.card.paneKey)),
    radius: Math.max(
      52,
      ...packed.map((family) => Math.hypot(family.x, family.y) + family.radius + WORKTREE_PADDING)
    )
  }
}
