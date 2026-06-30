import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import type {
  ArchitectureDiagramLink,
  ArchitectureDiagramNode,
  ArchitectureStatus
} from '../architecture-diagram-types'
import { computeEdgeBundles } from './edge-bundling'
import { assignAllHandles } from './edge-routing'

const NODE_W = 180
const NODE_H = 160
const GRID_X = 220
const GRID_Y = 192
const SNAP = 20

const STATUS_PRIORITY: Record<ArchitectureStatus, number> = {
  proposed: 4,
  implemented: 3,
  vagrant: 2,
  verified: 1
}

type LayoutOptions = {
  codeLevel: boolean
  fullRelayout?: boolean
}

export type RoutedArchitectureLink = ArchitectureDiagramLink & {
  sourceHandle?: string
  targetHandle?: string
}

type SimNode = SimulationNodeDatum & {
  id: string
  width: number
  height: number
  pinned: boolean
}

type SimLink = SimulationLinkDatum<SimNode>

function nodeSize(node: ArchitectureDiagramNode): { width: number; height: number } {
  const measured = node.measured as { width?: number; height?: number } | undefined
  return {
    width: measured?.width ?? NODE_W,
    height: measured?.height ?? NODE_H
  }
}

function snap(value: number): number {
  return Math.round(value / SNAP) * SNAP
}

function isReference(node: ArchitectureDiagramNode): boolean {
  return !!node.data._reference
}

function gridLayout(nodes: readonly ArchitectureDiagramNode[]): ArchitectureDiagramNode[] {
  const normalNodes = nodes.filter((node) => !isReference(node))
  const referenceNodes = nodes.filter(isReference)
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(normalNodes.length))))

  return [
    ...normalNodes.map((node, index) => ({
      ...node,
      position: {
        x: (index % cols) * GRID_X,
        y: Math.floor(index / cols) * GRID_Y
      }
    })),
    ...referenceNodes
  ]
}

function forceRectCollide(padding: number) {
  let nodes: SimNode[] = []
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const left = nodes[i]
        const right = nodes[j]
        const dx = (right.x ?? 0) - (left.x ?? 0)
        const dy = (right.y ?? 0) - (left.y ?? 0)
        const overlapX = (left.width + right.width) / 2 + padding - Math.abs(dx)
        const overlapY = (left.height + right.height) / 2 + padding - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) {
          continue
        }
        if (overlapX < overlapY) {
          const shift = (dx >= 0 ? 1 : -1) * (overlapX / 2)
          if (!left.pinned) {
            left.x = (left.x ?? 0) - shift
          }
          if (!right.pinned) {
            right.x = (right.x ?? 0) + shift
          }
        } else {
          const shift = (dy >= 0 ? 1 : -1) * (overlapY / 2)
          if (!left.pinned) {
            left.y = (left.y ?? 0) - shift
          }
          if (!right.pinned) {
            right.y = (right.y ?? 0) + shift
          }
        }
      }
    }
  }
  force.initialize = (nextNodes: SimNode[]) => {
    nodes = nextNodes
  }
  return force
}

function graphLayout(
  nodes: readonly ArchitectureDiagramNode[],
  edges: readonly ArchitectureDiagramLink[],
  fullRelayout: boolean
): ArchitectureDiagramNode[] {
  const normalNodes = nodes.filter((node) => !isReference(node))
  const referenceNodes = nodes.filter(isReference)
  if (normalNodes.length === 0) {
    return [...referenceNodes]
  }

  const nodeIds = new Set(normalNodes.map((node) => node.id))
  const graphEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  const initialGrid = gridLayout(normalNodes)
  const simNodes: SimNode[] = normalNodes.map((node, index) => {
    const { width, height } = nodeSize(node)
    const fallback = initialGrid[index]?.position ?? { x: index * GRID_X, y: 0 }
    const position = fullRelayout ? fallback : (node.position ?? fallback)
    const pinned = !fullRelayout && !node.data._needsLayout
    return {
      id: node.id,
      x: position.x + width / 2,
      y: position.y + height / 2,
      width,
      height,
      pinned,
      ...(pinned ? { fx: position.x + width / 2, fy: position.y + height / 2 } : {})
    }
  })

  const simNodeById = new Map(simNodes.map((node) => [node.id, node]))
  const simLinks: SimLink[] = graphEdges.map((edge) => ({
    source: edge.source,
    target: edge.target
  }))

  forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((node) => node.id)
        .distance(300)
        .strength(0.28)
    )
    .force('charge', forceManyBody<SimNode>().strength(-900).distanceMax(900))
    .force('collide', forceRectCollide(56))
    .force(
      'x',
      forceX<SimNode>()
        .x((node) => node.x ?? 0)
        .strength(0.04)
    )
    .force(
      'y',
      forceY<SimNode>()
        .y((node) => node.y ?? 0)
        .strength(0.04)
    )
    .stop()
    .tick(fullRelayout ? 220 : 140)

  return [
    ...normalNodes.map((node) => {
      const simNode = simNodeById.get(node.id)
      if (!simNode) {
        return node
      }
      return {
        ...node,
        position: {
          x: snap((simNode.x ?? 0) - simNode.width / 2),
          y: snap((simNode.y ?? 0) - simNode.height / 2)
        },
        data: {
          ...node.data,
          _needsLayout: undefined
        }
      }
    }),
    ...referenceNodes
  ]
}

export function autoLayoutVisibleNodes(
  nodes: readonly ArchitectureDiagramNode[],
  edges: readonly ArchitectureDiagramLink[],
  options: LayoutOptions
): ArchitectureDiagramNode[] {
  if (options.codeLevel) {
    return gridLayout(nodes)
  }
  return graphLayout(nodes, edges, !!options.fullRelayout)
}

function statusForNode(node: ArchitectureDiagramNode | undefined): ArchitectureStatus | undefined {
  if (!node) {
    return undefined
  }
  if (node.data.kind === 'person' || (node.data.kind === 'system' && node.data.external)) {
    return undefined
  }
  return node.data.status
}

function inferEdgeStatus(
  nodesById: Map<string, ArchitectureDiagramNode>,
  edge: ArchitectureDiagramLink
): ArchitectureStatus | undefined {
  const sourceStatus = statusForNode(nodesById.get(edge.source))
  const targetStatus = statusForNode(nodesById.get(edge.target))
  if (sourceStatus && targetStatus) {
    return STATUS_PRIORITY[sourceStatus] >= STATUS_PRIORITY[targetStatus]
      ? sourceStatus
      : targetStatus
  }
  return sourceStatus ?? targetStatus
}

export function decorateEdgesForRouting(
  nodes: readonly ArchitectureDiagramNode[],
  edges: readonly ArchitectureDiagramLink[]
): RoutedArchitectureLink[] {
  const handles = assignAllHandles(nodes, edges)
  const bundles = computeEdgeBundles(edges, nodes)
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const edgeKeys = new Set(edges.map((edge) => `${edge.source}::${edge.target}`))

  return edges.map((edge) => {
    const handle = handles.get(edge.id)
    const bundle = bundles.get(edge.id)
    const isBidirectional = edgeKeys.has(`${edge.target}::${edge.source}`)
    const sourceHandle = bundle?.hubIsSource ? bundle.hubHandle : handle?.sourceHandle
    const targetHandle = bundle && !bundle.hubIsSource ? bundle.hubHandle : handle?.targetHandle
    return {
      ...edge,
      sourceHandle,
      targetHandle,
      data: {
        label: '',
        ...edge.data,
        ...(bundle ? { _route: bundle.route } : {}),
        ...(isBidirectional ? { _biPair: true } : {}),
        _status: inferEdgeStatus(nodesById, edge)
      }
    }
  })
}
