import type {
  ArchitectureDiagramLink,
  ArchitectureDiagramNode
} from '../architecture-diagram-types'

const NODE_W = 180
const NODE_H = 160
const MAGNET_OFFSET = 80

export type BundleInfo = {
  route: { x: number; y: number }[]
  hubHandle: string
  hubIsSource: boolean
}

function measuredSize(node: ArchitectureDiagramNode): { width: number; height: number } {
  const measured = node.measured as { width?: number; height?: number } | undefined
  return {
    width: measured?.width ?? NODE_W,
    height: measured?.height ?? NODE_H
  }
}

function nodeCenter(node: ArchitectureDiagramNode): { x: number; y: number } {
  const position = node.position ?? { x: 0, y: 0 }
  const { width, height } = measuredSize(node)
  return { x: position.x + width / 2, y: position.y + height / 2 }
}

function magnetIndex(angle: number): number {
  const deg = (angle * 180) / Math.PI
  if (deg >= -120 && deg < -60) {
    return 0
  }
  if (deg >= -30 && deg < 30) {
    return 1
  }
  if (deg >= 60 && deg < 120) {
    return 2
  }
  if (deg >= 150 || deg < -150) {
    return 3
  }
  return -1
}

const MAGNET_DIRECTIONS = [
  { dx: 0, dy: -1, handle: 'top' },
  { dx: 1, dy: 0, handle: 'right' },
  { dx: 0, dy: 1, handle: 'bottom' },
  { dx: -1, dy: 0, handle: 'left' }
]

export function computeEdgeBundles(
  edges: readonly Pick<ArchitectureDiagramLink, 'id' | 'source' | 'target'>[],
  nodes: readonly ArchitectureDiagramNode[]
): Map<string, BundleInfo> {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const nodeEdges = new Map<string, Pick<ArchitectureDiagramLink, 'id' | 'source' | 'target'>[]>()
  const result = new Map<string, BundleInfo>()

  for (const edge of edges) {
    const sourceEdges = nodeEdges.get(edge.source) ?? []
    sourceEdges.push(edge)
    nodeEdges.set(edge.source, sourceEdges)

    const targetEdges = nodeEdges.get(edge.target) ?? []
    targetEdges.push(edge)
    nodeEdges.set(edge.target, targetEdges)
  }

  for (const [hubId, hubEdges] of nodeEdges) {
    if (hubEdges.length < 3) {
      continue
    }

    const hub = nodeMap.get(hubId)
    if (!hub) {
      continue
    }

    const hubCenter = nodeCenter(hub)
    const hubSize = measuredSize(hub)
    const buckets: {
      edge: Pick<ArchitectureDiagramLink, 'id' | 'source' | 'target'>
      hubIsSource: boolean
    }[][] = [[], [], [], []]

    for (const edge of hubEdges) {
      if (result.has(edge.id)) {
        continue
      }
      const hubIsSource = edge.source === hubId
      const other = nodeMap.get(hubIsSource ? edge.target : edge.source)
      if (!other) {
        continue
      }
      const otherCenter = nodeCenter(other)
      const index = magnetIndex(
        Math.atan2(otherCenter.y - hubCenter.y, otherCenter.x - hubCenter.x)
      )
      if (index >= 0) {
        buckets[index].push({ edge, hubIsSource })
      }
    }

    for (let index = 0; index < buckets.length; index++) {
      const bucket = buckets[index]
      if (bucket.length < 2) {
        continue
      }
      const magnet = MAGNET_DIRECTIONS[index]
      const routePoint = {
        x: hubCenter.x + magnet.dx * (hubSize.width / 2 + MAGNET_OFFSET),
        y: hubCenter.y + magnet.dy * (hubSize.height / 2 + MAGNET_OFFSET)
      }
      for (const { edge, hubIsSource } of bucket) {
        result.set(edge.id, {
          route: [routePoint],
          hubHandle: magnet.handle,
          hubIsSource
        })
      }
    }
  }

  return result
}
