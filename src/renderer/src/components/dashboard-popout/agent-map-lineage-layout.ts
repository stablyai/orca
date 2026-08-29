import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { packAgentMapWorktrees } from './agent-map-worktree-packing'

const HORIZONTAL_GAP = 54
const VERTICAL_GAP = 58
const FAMILY_PADDING = 8
const WORKTREE_PADDING = 6
const COMPACT_FANOUT_THRESHOLD = 12
const MAX_EXACT_LINEAGE_AGENTS = 256

export type AgentMapLineagePosition = {
  card: DashboardCard
  x: number
  y: number
}

type AgentMapAgentFamily = {
  id: string
  x: number
  y: number
  radius: number
  agents: AgentMapLineagePosition[]
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encloseFamily(
  id: string,
  agents: AgentMapLineagePosition[],
  nodeRadius: number
): AgentMapAgentFamily {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const agent of agents) {
    left = Math.min(left, agent.x - nodeRadius)
    right = Math.max(right, agent.x + nodeRadius)
    top = Math.min(top, agent.y - nodeRadius)
    bottom = Math.max(bottom, agent.y + nodeRadius)
  }
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  let radius = 0
  for (const agent of agents) {
    agent.x -= centerX
    agent.y -= centerY
    radius = Math.max(radius, Math.hypot(agent.x, agent.y) + nodeRadius + FAMILY_PADDING)
  }
  return { id, x: 0, y: 0, radius, agents }
}

function buildCompactFanoutFamily(
  root: DashboardCard,
  children: DashboardCard[],
  nodeRadius: number,
  emitted: Set<string>
): AgentMapAgentFamily {
  const columns = Math.ceil(Math.sqrt(children.length))
  const width = (Math.min(columns, children.length) - 1) * HORIZONTAL_GAP
  const agents: AgentMapLineagePosition[] = [{ card: root, x: 0, y: 0 }]
  emitted.add(root.paneKey)
  for (const [index, child] of children.entries()) {
    emitted.add(child.paneKey)
    agents.push({
      card: child,
      x: (index % columns) * HORIZONTAL_GAP - width / 2,
      y: (Math.floor(index / columns) + 1) * VERTICAL_GAP
    })
  }
  return encloseFamily(root.paneKey, agents, nodeRadius)
}

function buildFamily(
  root: DashboardCard,
  childrenByParent: ReadonlyMap<string, DashboardCard[]>,
  nodeRadius: number,
  emitted: Set<string>
): AgentMapAgentFamily {
  const agents: AgentMapLineagePosition[] = []
  let leafIndex = 0
  const rootChildren = (childrenByParent.get(root.paneKey) ?? []).filter(
    (child) => !emitted.has(child.paneKey)
  )
  if (
    rootChildren.length >= COMPACT_FANOUT_THRESHOLD &&
    rootChildren.every((child) => (childrenByParent.get(child.paneKey) ?? []).length === 0)
  ) {
    return buildCompactFanoutFamily(root, rootChildren, nodeRadius, emitted)
  }

  const placeSubtree = (
    card: DashboardCard,
    depth: number,
    ancestors: ReadonlySet<string>
  ): number => {
    if (ancestors.has(card.paneKey) || emitted.has(card.paneKey)) {
      return leafIndex++ * HORIZONTAL_GAP
    }
    emitted.add(card.paneKey)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(card.paneKey)
    const children = (childrenByParent.get(card.paneKey) ?? []).filter(
      (child) => !nextAncestors.has(child.paneKey) && !emitted.has(child.paneKey)
    )
    const childXs = children.map((child) => placeSubtree(child, depth + 1, nextAncestors))
    const x =
      childXs.length > 0
        ? (Math.min(...childXs) + Math.max(...childXs)) / 2
        : leafIndex++ * HORIZONTAL_GAP
    agents.push({ card, x, y: depth * VERTICAL_GAP })
    return x
  }

  placeSubtree(root, 0, new Set())
  return encloseFamily(root.paneKey, agents, nodeRadius)
}

function layoutBoundedLineage(
  sorted: DashboardCard[],
  childrenByParent: ReadonlyMap<string, DashboardCard[]>,
  childPaneKeys: ReadonlySet<string>,
  nodeRadius: number
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
      const level = levels[entry.depth] ?? []
      levels[entry.depth] = level
      level.push(entry.card)
      const children = childrenByParent.get(entry.card.paneKey) ?? []
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!emitted.has(children[index].paneKey)) {
          stack.push({ card: children[index], depth: entry.depth + 1 })
        }
      }
    }
  }

  const agents: AgentMapLineagePosition[] = []
  let rowIndex = 0
  for (const level of levels) {
    const columns = Math.ceil(Math.sqrt(level.length))
    for (let rowStart = 0; rowStart < level.length; rowStart += columns) {
      const row = level.slice(rowStart, rowStart + columns)
      const width = (row.length - 1) * HORIZONTAL_GAP
      for (const [index, card] of row.entries()) {
        agents.push({ card, x: index * HORIZONTAL_GAP - width / 2, y: rowIndex * VERTICAL_GAP })
      }
      rowIndex += 1
    }
  }
  const family = encloseFamily(sorted[0].paneKey, agents, nodeRadius)
  family.agents.sort((a, b) => compareStable(a.card.paneKey, b.card.paneKey))
  return { agents: family.agents, radius: Math.max(52, family.radius + WORKTREE_PADDING) }
}

export function layoutAgentMapLineage(
  cards: DashboardCard[],
  nodeRadius: number
): { agents: AgentMapLineagePosition[]; radius: number } | null {
  const sorted = [...cards].sort((a, b) => compareStable(a.paneKey, b.paneKey))
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
    return null
  }
  if (sorted.length > MAX_EXACT_LINEAGE_AGENTS) {
    return layoutBoundedLineage(sorted, childrenByParent, childPaneKeys, nodeRadius)
  }

  const emitted = new Set<string>()
  const roots = sorted.filter((card) => !childPaneKeys.has(card.paneKey))
  const families: AgentMapAgentFamily[] = []
  for (const root of roots) {
    if (!emitted.has(root.paneKey)) {
      families.push(buildFamily(root, childrenByParent, nodeRadius, emitted))
    }
  }
  for (const card of sorted) {
    if (!emitted.has(card.paneKey)) {
      families.push(buildFamily(card, childrenByParent, nodeRadius, emitted))
    }
  }
  const packed = packAgentMapWorktrees(families)
  return {
    agents: packed
      .flatMap((family) =>
        family.agents.map((agent) => ({
          ...agent,
          x: family.x + agent.x,
          y: family.y + agent.y
        }))
      )
      .sort((a, b) => compareStable(a.card.paneKey, b.card.paneKey)),
    radius: Math.max(
      52,
      ...packed.map((family) => Math.hypot(family.x, family.y) + family.radius + WORKTREE_PADDING)
    )
  }
}
