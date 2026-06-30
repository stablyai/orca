import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramLink,
  ArchitectureDiagramModel
} from './architecture-diagram-types'
import { collectDescendantIds } from './architecture-diagram-node-model'

export type ExternalArchitectureEdge = ArchitectureDiagramLink & {
  externalNodeName: string
  externalNodeKind: ArchitectureDiagramKind
  direction: 'out' | 'in'
}

export type ArchitectureNodeContext = {
  descendants: ArchitectureDiagramModel['nodes']
  internalEdges: ArchitectureDiagramLink[]
  externalEdges: ExternalArchitectureEdge[]
  groups: NonNullable<ArchitectureDiagramModel['groups']>
  sourceMap: NonNullable<ArchitectureDiagramModel['sourceMap']>
  boundaries: NonNullable<ArchitectureDiagramModel['boundaries']>
}

export function getNodeContextForModel(
  model: ArchitectureDiagramModel,
  nodeId: string | null
): ArchitectureNodeContext {
  if (!nodeId) {
    return {
      descendants: [],
      internalEdges: [],
      externalEdges: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    }
  }

  const subtreeIds = collectDescendantIds(model.nodes, [nodeId])
  const descendants = model.nodes.filter((node) => subtreeIds.has(node.id) && node.id !== nodeId)
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
  const internalEdges: ArchitectureDiagramLink[] = []
  const externalEdges: ExternalArchitectureEdge[] = []

  for (const edge of model.links) {
    const sourceIn = subtreeIds.has(edge.source)
    const targetIn = subtreeIds.has(edge.target)
    if (sourceIn && targetIn) {
      internalEdges.push(edge)
      continue
    }
    if (!sourceIn && !targetIn) {
      continue
    }
    const externalNode = nodeById.get(sourceIn ? edge.target : edge.source)
    if (!externalNode) {
      continue
    }
    externalEdges.push({
      ...edge,
      externalNodeName: externalNode.data.name,
      externalNodeKind: externalNode.data.kind,
      direction: sourceIn ? 'out' : 'in'
    })
  }

  const sourceMap: NonNullable<ArchitectureDiagramModel['sourceMap']> = {}
  for (const [id, locations] of Object.entries(model.sourceMap ?? {})) {
    if (subtreeIds.has(id)) {
      sourceMap[id] = locations
    }
  }

  const boundaries: NonNullable<ArchitectureDiagramModel['boundaries']> = {}
  for (const [id, sources] of Object.entries(model.boundaries ?? {})) {
    if (subtreeIds.has(id)) {
      boundaries[id] = sources
    }
  }

  const groups = (model.groups ?? []).filter((group) =>
    group.memberIds.some((memberId) => subtreeIds.has(memberId))
  )

  return {
    descendants,
    internalEdges,
    externalEdges,
    groups,
    sourceMap,
    boundaries
  }
}
