import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramLink,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode
} from './architecture-diagram-types'
import { currentParentIdFromPath } from './architecture-diagram-node-model'
import { addTransientNodeData } from './architecture-diagram-transient-node-data'

const NODE_W = 180
const NODE_H = 160

export type VisibleArchitectureView = {
  currentParentId: string | undefined
  currentParentKind: ArchitectureDiagramKind | undefined
  levelPrefix: string
  visibleNodes: ArchitectureDiagramNode[]
  visibleEdges: ArchitectureDiagramLink[]
  refNodeIds: Set<string>
}

export type VisibleArchitectureViewInput = {
  model: ArchitectureDiagramModel
  expandedPath: string[]
  changedNodeIds?: Set<string>
  driftedNodeIds?: Set<string>
}

export type NodePositionChangeLike = {
  id?: string
  type: string
  position?: { x: number; y: number }
  [key: string]: unknown
}

export function applyNodePositionChangesToModel(
  model: ArchitectureDiagramModel,
  changes: readonly NodePositionChangeLike[],
  refNodeIds: ReadonlySet<string>,
  currentParentId?: string
): ArchitectureDiagramModel | null {
  const positions = new Map<string, { x: number; y: number }>()
  const refPositions = new Map<string, { x: number; y: number }>()
  for (const change of changes) {
    if (change.type !== 'position' || !change.id) {
      continue
    }
    if (!change.position) {
      continue
    }
    const { x, y } = change.position
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }
    if (refNodeIds.has(change.id)) {
      if (currentParentId) {
        refPositions.set(`${currentParentId}/${change.id}`, { x, y })
      }
      continue
    }
    positions.set(change.id, { x, y })
  }

  if (positions.size === 0 && refPositions.size === 0) {
    return null
  }

  let changed = false
  const nodes = model.nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position) {
      return node
    }
    if (node.position?.x === position.x && node.position.y === position.y) {
      return node
    }
    changed = true
    return { ...node, position }
  })

  let nextRefPositions = model.refPositions ?? {}
  if (refPositions.size > 0) {
    nextRefPositions = { ...nextRefPositions }
    for (const [key, position] of refPositions) {
      const current = nextRefPositions[key]
      if (!current || current.x !== position.x || current.y !== position.y) {
        nextRefPositions[key] = position
        changed = true
      }
    }
  }

  return changed ? { ...model, nodes, refPositions: nextRefPositions } : null
}

export function getVisibleArchitectureView({
  model,
  expandedPath,
  changedNodeIds = new Set(),
  driftedNodeIds = new Set()
}: VisibleArchitectureViewInput): VisibleArchitectureView {
  const currentParentId = currentParentIdFromPath(expandedPath)
  const currentParent = currentParentId
    ? model.nodes.find((node) => node.id === currentParentId)
    : undefined
  const currentParentKind = currentParent?.data.kind
  const levelPrefix = currentParentId ?? 'root'

  const childNodes = model.nodes
    .filter((node) => (node.parentId ?? undefined) === currentParentId)
    .map((node) => ({ ...node, parentId: undefined }))

  const childIds = new Set(childNodes.map((node) => node.id))
  const referenceNodes = currentParentId
    ? createReferenceNodes(model, currentParentId, childNodes, childIds)
    : []
  const visibleNodes = addTransientNodeData([...childNodes, ...referenceNodes], {
    allNodes: model.nodes,
    groups: model.groups ?? [],
    changedNodeIds,
    driftedNodeIds
  })

  const visibleIds = new Set(visibleNodes.map((node) => node.id))
  const isCodeLevel = currentParentKind === 'component'
  const visibleEdges = isCodeLevel
    ? []
    : model.links.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
  const refNodeIds = new Set(referenceNodes.map((node) => node.id))

  return {
    currentParentId,
    currentParentKind,
    levelPrefix,
    visibleNodes,
    visibleEdges,
    refNodeIds
  }
}

function createReferenceNodes(
  model: ArchitectureDiagramModel,
  currentParentId: string,
  childNodes: ArchitectureDiagramNode[],
  childIds: Set<string>
): ArchitectureDiagramNode[] {
  const refMap = new Map<string, { direction: 'in' | 'out'; label: string; method?: string }[]>()
  for (const edge of model.links) {
    const sourceIsParent = edge.source === currentParentId
    const targetIsParent = edge.target === currentParentId
    if (!sourceIsParent && !targetIsParent) {
      continue
    }
    const otherId = sourceIsParent ? edge.target : edge.source
    if (childIds.has(otherId)) {
      continue
    }
    const relationships = refMap.get(otherId) ?? []
    relationships.push({
      direction: sourceIsParent ? 'out' : 'in',
      label: edge.data?.label ?? '',
      method: edge.data?.method
    })
    refMap.set(otherId, relationships)
  }

  const bounds = boundsForNodes(childNodes)
  const inRefs: string[] = []
  const outRefs: string[] = []
  for (const [id, relationships] of refMap) {
    const original = model.nodes.find((node) => node.id === id)
    if (!original) {
      continue
    }
    const direction = relationships[0]?.direction ?? 'out'
    if (direction === 'in') {
      inRefs.push(id)
    } else {
      outRefs.push(id)
    }
  }

  const makeRef = (
    id: string,
    index: number,
    total: number,
    y: number
  ): ArchitectureDiagramNode | null => {
    const original = model.nodes.find((node) => node.id === id)
    const relationships = refMap.get(id)
    if (!original || !relationships) {
      return null
    }
    const spacing = NODE_W + 70
    const totalWidth = (total - 1) * spacing
    const autoPosition = {
      x: (bounds.minX + bounds.maxX) / 2 - totalWidth / 2 + index * spacing,
      y
    }
    const position = model.refPositions?.[`${currentParentId}/${id}`] ?? autoPosition
    return {
      ...original,
      parentId: undefined,
      position,
      data: {
        ...original.data,
        _reference: true,
        _relationships: relationships
      }
    }
  }

  const refs: ArchitectureDiagramNode[] = []
  for (let index = 0; index < inRefs.length; index++) {
    const ref = makeRef(inRefs[index], index, inRefs.length, bounds.minY - NODE_H - 120)
    if (ref) {
      refs.push(ref)
    }
  }
  for (let index = 0; index < outRefs.length; index++) {
    const ref = makeRef(outRefs[index], index, outRefs.length, bounds.maxY + NODE_H + 120)
    if (ref) {
      refs.push(ref)
    }
  }
  return refs
}

function boundsForNodes(nodes: ArchitectureDiagramNode[]): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  if (nodes.length === 0) {
    return { minX: 100, maxX: 100, minY: 100, maxY: 100 }
  }
  const xs = nodes.map((node) => node.position?.x ?? 0)
  const ys = nodes.map((node) => node.position?.y ?? 0)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  }
}
