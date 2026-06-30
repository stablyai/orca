import type {
  ArchitectureDiagramLink,
  ArchitectureDiagramNode
} from '../architecture-diagram-types'

const NODE_W = 180
const NODE_H = 160
const CONGESTION_PENALTY = 220 ** 2
const AXIS_PENALTY = 60 ** 2
const CORNER_HALF_WINDOW_DEG = 15

type HandleId =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

type HandleAssignment = {
  sourceHandle: HandleId
  targetHandle: HandleId
}

type NodeBox = {
  id: string
  position?: { x: number; y: number }
  measured?: unknown
  style?: unknown
}

function measuredSize(node: NodeBox): { width: number; height: number } {
  const measured = node.measured as { width?: number; height?: number } | undefined
  const style = node.style as { width?: unknown; height?: unknown } | undefined
  const styleWidth = typeof style?.width === 'number' ? style.width : undefined
  const styleHeight = typeof style?.height === 'number' ? style.height : undefined
  return {
    width: measured?.width ?? styleWidth ?? NODE_W,
    height: measured?.height ?? styleHeight ?? NODE_H
  }
}

function positionOf(node: NodeBox): { x: number; y: number } {
  return node.position ?? { x: 0, y: 0 }
}

function centerOf(node: NodeBox): { x: number; y: number } {
  const { width, height } = measuredSize(node)
  const position = positionOf(node)
  return { x: position.x + width / 2, y: position.y + height / 2 }
}

function getHandlePositions(node: NodeBox): Record<HandleId, { x: number; y: number }> {
  const { width, height } = measuredSize(node)
  const { x, y } = positionOf(node)
  return {
    top: { x: x + width / 2, y },
    bottom: { x: x + width / 2, y: y + height },
    left: { x, y: y + height / 2 },
    right: { x: x + width, y: y + height / 2 },
    'top-left': { x, y },
    'top-right': { x: x + width, y },
    'bottom-left': { x, y: y + height },
    'bottom-right': { x: x + width, y: y + height }
  }
}

function diagonalCornerPair(dx: number, dy: number): [HandleId, HandleId] | null {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  const within = (target: number) => {
    let delta = Math.abs(angle - target)
    if (delta > 180) {
      delta = 360 - delta
    }
    return delta <= CORNER_HALF_WINDOW_DEG
  }

  if (within(45)) {
    return ['bottom-right', 'top-left']
  }
  if (within(135)) {
    return ['bottom-left', 'top-right']
  }
  if (within(-45)) {
    return ['top-right', 'bottom-left']
  }
  if (within(-135)) {
    return ['top-left', 'bottom-right']
  }
  return null
}

function axisMisalignment(handle: HandleId, dx: number, dy: number): number {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 40 && ay < 40) {
    return 0
  }

  const maxAxis = Math.max(ax, ay)
  const ratio = maxAxis === 0 ? 0 : Math.abs(ax - ay) / maxAxis
  if (ratio < 0.3) {
    return 0
  }

  if (ay > ax) {
    return handle === 'left' || handle === 'right' ? ratio : 0
  }
  return handle === 'top' || handle === 'bottom' ? ratio : 0
}

export function assignAllHandles(
  nodes: readonly ArchitectureDiagramNode[],
  edges: readonly Pick<ArchitectureDiagramLink, 'id' | 'source' | 'target'>[]
): Map<string, HandleAssignment> {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const result = new Map<string, HandleAssignment>()
  const usage = new Map<string, number>()

  const usageKey = (nodeId: string, handle: HandleId) => `${nodeId}:${handle}`
  const getUsage = (nodeId: string, handle: HandleId) => usage.get(usageKey(nodeId, handle)) ?? 0
  const addUsage = (nodeId: string, handle: HandleId) => {
    const key = usageKey(nodeId, handle)
    usage.set(key, (usage.get(key) ?? 0) + 1)
  }

  const edgeKey = (source: string, target: string) => `${source}::${target}`
  const edgeSet = new Set(edges.map((edge) => edgeKey(edge.source, edge.target)))
  const processedBiPairs = new Map<string, HandleAssignment>()
  const sideHandles: HandleId[] = ['top', 'bottom', 'left', 'right']

  const sortedEdges = [...edges]
    .map((edge) => {
      const source = nodeMap.get(edge.source)
      const target = nodeMap.get(edge.target)
      if (!source || !target) {
        return { edge, distance: Infinity }
      }
      const sourceCenter = centerOf(source)
      const targetCenter = centerOf(target)
      return {
        edge,
        distance: (targetCenter.x - sourceCenter.x) ** 2 + (targetCenter.y - sourceCenter.y) ** 2
      }
    })
    .sort((left, right) => left.distance - right.distance)

  for (const { edge } of sortedEdges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) {
      continue
    }

    const reverseKey = edgeKey(edge.target, edge.source)
    const isBidirectional = edgeSet.has(reverseKey)
    const reverseHandles = processedBiPairs.get(reverseKey)
    if (isBidirectional && reverseHandles) {
      const swapped = {
        sourceHandle: reverseHandles.targetHandle,
        targetHandle: reverseHandles.sourceHandle
      }
      result.set(edge.id, swapped)
      addUsage(edge.source, swapped.sourceHandle)
      addUsage(edge.target, swapped.targetHandle)
      continue
    }

    const sourceHandles = getHandlePositions(source)
    const targetHandles = getHandlePositions(target)
    const sourceCenter = centerOf(source)
    const targetCenter = centerOf(target)
    const dx = targetCenter.x - sourceCenter.x
    const dy = targetCenter.y - sourceCenter.y
    const cornerPair = diagonalCornerPair(dx, dy)
    const sourceCandidates = cornerPair ? [...sideHandles, cornerPair[0]] : sideHandles
    const targetCandidates = cornerPair ? [...sideHandles, cornerPair[1]] : sideHandles

    let best: HandleAssignment = { sourceHandle: 'right', targetHandle: 'left' }
    let bestCost = Infinity
    for (const sourceHandle of sourceCandidates) {
      const sourcePosition = sourceHandles[sourceHandle]
      const sourcePenalty = getUsage(edge.source, sourceHandle) * CONGESTION_PENALTY
      const sourceAxisPenalty = axisMisalignment(sourceHandle, dx, dy) * AXIS_PENALTY
      for (const targetHandle of targetCandidates) {
        const targetPosition = targetHandles[targetHandle]
        const targetPenalty = getUsage(edge.target, targetHandle) * CONGESTION_PENALTY
        const targetAxisPenalty = axisMisalignment(targetHandle, dx, dy) * AXIS_PENALTY
        const cost =
          (sourcePosition.x - targetPosition.x) ** 2 +
          (sourcePosition.y - targetPosition.y) ** 2 +
          sourcePenalty +
          targetPenalty +
          sourceAxisPenalty +
          targetAxisPenalty
        if (cost < bestCost) {
          bestCost = cost
          best = { sourceHandle, targetHandle }
        }
      }
    }

    result.set(edge.id, best)
    addUsage(edge.source, best.sourceHandle)
    addUsage(edge.target, best.targetHandle)
    if (isBidirectional) {
      processedBiPairs.set(edgeKey(edge.source, edge.target), best)
    }
  }

  return result
}
