// Tidy-tree layout for the agent map: the root sits top-center, sub-agents fan out
// below their spawner, leaves get sequential horizontal slots and a parent is the
// mean of its children. Pure — the same (map, width) always yields the same points.

import type { AgentMap, AgentMapNodeId } from './agent-session-map-model'

export type AgentMapNodePosition = { x: number; y: number }

export type AgentMapLayoutEdge = {
  fromId: AgentMapNodeId
  toId: AgentMapNodeId
  from: AgentMapNodePosition
  to: AgentMapNodePosition
  /** Rendered box heights at each end, so edge paths stop at the real border. */
  fromHeight: number
  toHeight: number
}

export type AgentMapLayout = {
  positions: Map<AgentMapNodeId, AgentMapNodePosition>
  edges: AgentMapLayoutEdge[]
  width: number
  height: number
}

export type AgentMapLayoutOptions = {
  /** Vertical distance between tree levels. */
  levelHeight?: number
  /** Horizontal distance between sibling leaf slots. */
  nodeGap?: number
  /** Inset from the canvas edges, on top of half a node. */
  padding?: number
  /** Node box size; positions are centers, so half of each inset the usable area. */
  nodeWidth?: number
  nodeHeight?: number
  /** Extra row a node with tool calls grows by, for its chip line. 0 = no chips. */
  chipRowHeight?: number
}

const DEFAULTS = { levelHeight: 120, nodeGap: 176, padding: 48, nodeWidth: 168, nodeHeight: 56 }

/** Parent → children, from the map's edges. Every non-root node has exactly one parent. */
function childrenByParent(map: AgentMap): Map<AgentMapNodeId, AgentMapNodeId[]> {
  const children = new Map<AgentMapNodeId, AgentMapNodeId[]>()
  for (const edge of map.edges) {
    const list = children.get(edge.from)
    if (list) {
      list.push(edge.to)
    } else {
      children.set(edge.from, [edge.to])
    }
  }
  return children
}

/** Depth of each node from the root; a cycle or orphan is clamped to the root's depth. */
function depthByNode(
  map: AgentMap,
  children: Map<AgentMapNodeId, AgentMapNodeId[]>
): Map<AgentMapNodeId, number> {
  const depth = new Map<AgentMapNodeId, number>()
  const stack: [AgentMapNodeId, number][] = [[map.rootId, 0]]
  depth.set(map.rootId, 0)
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) {
      break
    }
    const [id, d] = entry
    for (const child of children.get(id) ?? []) {
      if (depth.has(child)) {
        continue
      }
      depth.set(child, d + 1)
      stack.push([child, d + 1])
    }
  }
  // Any node the walk never reached (a parent cycle) anchors at the root level.
  for (const node of map.nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0)
    }
  }
  return depth
}

/** Post-order x: a leaf takes the next slot, a parent is the mean of its children. */
function xByNode(
  map: AgentMap,
  children: Map<AgentMapNodeId, AgentMapNodeId[]>,
  slotWidth: number
): Map<AgentMapNodeId, number> {
  const x = new Map<AgentMapNodeId, number>()
  let nextSlot = 0
  const visited = new Set<AgentMapNodeId>()

  const place = (id: AgentMapNodeId): number => {
    const existing = x.get(id)
    if (visited.has(id) && existing !== undefined) {
      return existing
    }
    visited.add(id)
    const kids = children.get(id) ?? []
    if (kids.length === 0) {
      const slot = nextSlot
      nextSlot += 1
      x.set(id, slot * slotWidth)
      return slot * slotWidth
    }
    const childXs = kids.map((child) => place(child))
    const mean = childXs.reduce((sum, value) => sum + value, 0) / childXs.length
    x.set(id, mean)
    return mean
  }

  place(map.rootId)
  // Orphans the root walk missed (a parent cycle) get their own trailing slots.
  for (const node of map.nodes) {
    if (!visited.has(node.id)) {
      const slot = nextSlot
      nextSlot += 1
      x.set(node.id, slot * slotWidth)
    }
  }
  return x
}

export function layoutAgentMap(
  map: AgentMap,
  width: number,
  options: AgentMapLayoutOptions = {}
): AgentMapLayout {
  const {
    levelHeight,
    nodeGap,
    padding,
    nodeWidth,
    nodeHeight,
    chipRowHeight = 20
  } = {
    ...DEFAULTS,
    ...options
  }
  const children = childrenByParent(map)
  const depth = depthByNode(map, children)
  const rawX = xByNode(map, children, nodeGap)
  // A node with tool calls grows a chip line under its box; rows share the tallest band.
  const heightByNode = new Map<AgentMapNodeId, number>()
  let maxNodeHeight = nodeHeight
  for (const node of map.nodes) {
    const h = node.toolCalls.length > 0 ? nodeHeight + chipRowHeight : nodeHeight
    heightByNode.set(node.id, h)
    maxNodeHeight = Math.max(maxNodeHeight, h)
  }

  const xs = [...rawX.values()]
  const minX = xs.length > 0 ? Math.min(...xs) : 0
  const maxX = xs.length > 0 ? Math.max(...xs) : 0
  const span = maxX - minX
  // Positions are node centers, so the usable band is inset by half a node on each side.
  const insetX = padding + nodeWidth / 2
  // Never scale below 1: a wide tree keeps its natural spacing and the canvas grows
  // instead, so the surface scrolls rather than overlapping nodes.
  const canvasWidth = Math.max(width, insetX * 2 + span)
  const available = Math.max(1, canvasWidth - insetX * 2)
  // Collapse to the center when there is a single node; otherwise scale to fit.
  const scale = span === 0 ? 0 : available / span
  const center = canvasWidth / 2
  const insetY = padding + maxNodeHeight / 2

  const positions = new Map<AgentMapNodeId, AgentMapNodePosition>()
  let maxDepth = 0
  for (const node of map.nodes) {
    const d = depth.get(node.id) ?? 0
    maxDepth = Math.max(maxDepth, d)
    const raw = rawX.get(node.id) ?? 0
    const x = span === 0 ? center : insetX + (raw - minX) * scale
    positions.set(node.id, { x, y: insetY + d * levelHeight })
  }

  const edges: AgentMapLayoutEdge[] = []
  for (const edge of map.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from && to) {
      edges.push({
        fromId: edge.from,
        toId: edge.to,
        from,
        to,
        fromHeight: heightByNode.get(edge.from) ?? nodeHeight,
        toHeight: heightByNode.get(edge.to) ?? nodeHeight
      })
    }
  }

  const height = padding * 2 + maxNodeHeight + maxDepth * levelHeight
  return { positions, edges, width: canvasWidth, height }
}
