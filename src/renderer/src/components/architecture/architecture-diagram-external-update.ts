import type {
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureDiagramNodeData
} from './architecture-diagram-types'
import { isExpandableKind } from './architecture-diagram-node-model'

export type ExternalModelUpdateSummary = {
  model: ArchitectureDiagramModel
  changedNodeIds: Set<string>
  nodeDiffs: Map<string, ArchitectureDiagramNodeData>
  expandedPath: string[]
}

function stripTransientNodeData(data: ArchitectureDiagramNodeData): ArchitectureDiagramNodeData {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !key.startsWith('_'))
  ) as ArchitectureDiagramNodeData
}

function nodeChanged(
  previous: ArchitectureDiagramNode,
  incoming: ArchitectureDiagramNode
): boolean {
  return (
    previous.parentId !== incoming.parentId ||
    previous.type !== incoming.type ||
    JSON.stringify(stripTransientNodeData(previous.data)) !==
      JSON.stringify(stripTransientNodeData(incoming.data))
  )
}

function preserveUsefulRuntimeNodeState(
  previous: ArchitectureDiagramNode | undefined,
  incoming: ArchitectureDiagramNode
): ArchitectureDiagramNode {
  if (!previous) {
    return incoming
  }
  if (incoming.data._needsLayout && !previous.data._needsLayout && previous.position) {
    const { _needsLayout: _unused, ...cleanData } = incoming.data
    void _unused
    return {
      ...incoming,
      position: previous.position,
      selected: previous.selected,
      measured: previous.measured,
      data: cleanData as ArchitectureDiagramNodeData
    }
  }
  return {
    ...incoming,
    selected: previous.selected,
    measured: previous.measured
  }
}

function pathToNodeParent(model: ArchitectureDiagramModel, parentId: string): string[] {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
  const path: string[] = []
  let current: string | undefined = parentId
  while (current) {
    path.unshift(current)
    current = nodeById.get(current)?.parentId
  }
  return path
}

function followPathForChangedParents(
  model: ArchitectureDiagramModel,
  changedParents: Map<string, number>,
  currentPath: string[],
  followExternalChanges: boolean
): string[] {
  if (!followExternalChanges || changedParents.size === 0) {
    return reconcileExpandedPath(model, currentPath)
  }

  const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
  let bestParentId = ''
  let bestDepth = Number.POSITIVE_INFINITY
  let bestCount = 0

  for (const [parentId, count] of changedParents) {
    if (!parentId) {
      continue
    }
    let depth = 0
    let current: string | undefined = parentId
    while (current) {
      depth++
      current = nodeById.get(current)?.parentId
    }
    if (depth < bestDepth || (depth === bestDepth && count > bestCount)) {
      bestParentId = parentId
      bestDepth = depth
      bestCount = count
    }
  }

  if (!bestParentId) {
    return reconcileExpandedPath(model, currentPath)
  }

  const bestParent = nodeById.get(bestParentId)
  if (bestParent?.data.kind === 'component' && bestParent.parentId) {
    bestParentId = bestParent.parentId
  }
  return reconcileExpandedPath(model, pathToNodeParent(model, bestParentId))
}

export function analyzeExternalModelUpdate({
  previous,
  incoming,
  expandedPath,
  followExternalChanges
}: {
  previous: ArchitectureDiagramModel
  incoming: ArchitectureDiagramModel
  expandedPath: string[]
  followExternalChanges: boolean
}): ExternalModelUpdateSummary {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]))
  const incomingById = new Map(incoming.nodes.map((node) => [node.id, node]))
  const changedNodeIds = new Set<string>()
  const nodeDiffs = new Map<string, ArchitectureDiagramNodeData>()
  const changedParents = new Map<string, number>()
  const bumpParent = (parentId: string | undefined) => {
    const key = parentId ?? ''
    changedParents.set(key, (changedParents.get(key) ?? 0) + 1)
  }

  for (const node of incoming.nodes) {
    const previousNode = previousById.get(node.id)
    if (!previousNode) {
      changedNodeIds.add(node.id)
      if (node.parentId) {
        changedNodeIds.add(node.parentId)
      }
      bumpParent(node.parentId)
      continue
    }
    if (nodeChanged(previousNode, node)) {
      changedNodeIds.add(node.id)
      if (node.parentId) {
        changedNodeIds.add(node.parentId)
      }
      nodeDiffs.set(node.id, stripTransientNodeData(previousNode.data))
      bumpParent(node.parentId)
    }
  }

  for (const previousNode of previous.nodes) {
    if (incomingById.has(previousNode.id)) {
      continue
    }
    if (previousNode.parentId) {
      changedNodeIds.add(previousNode.parentId)
    }
    bumpParent(previousNode.parentId)
  }

  const previousEdgeById = new Map(previous.links.map((edge) => [edge.id, edge]))
  for (const edge of incoming.links) {
    const previousEdge = previousEdgeById.get(edge.id)
    if (
      !previousEdge ||
      previousEdge.source !== edge.source ||
      previousEdge.target !== edge.target ||
      JSON.stringify(previousEdge.data ?? {}) !== JSON.stringify(edge.data ?? {})
    ) {
      changedNodeIds.add(edge.source)
      changedNodeIds.add(edge.target)
      bumpParent(incomingById.get(edge.source)?.parentId)
      bumpParent(incomingById.get(edge.target)?.parentId)
    }
  }
  const incomingEdgeIds = new Set(incoming.links.map((edge) => edge.id))
  for (const previousEdge of previous.links) {
    if (incomingEdgeIds.has(previousEdge.id)) {
      continue
    }
    changedNodeIds.add(previousEdge.source)
    changedNodeIds.add(previousEdge.target)
    bumpParent(previousById.get(previousEdge.source)?.parentId)
    bumpParent(previousById.get(previousEdge.target)?.parentId)
  }

  const model: ArchitectureDiagramModel = {
    ...incoming,
    nodes: incoming.nodes.map((node) =>
      preserveUsefulRuntimeNodeState(previousById.get(node.id), node)
    )
  }

  return {
    model,
    changedNodeIds,
    nodeDiffs,
    expandedPath: followPathForChangedParents(
      model,
      changedParents,
      expandedPath,
      followExternalChanges
    )
  }
}

export function reconcileExpandedPath(
  model: ArchitectureDiagramModel,
  expandedPath: string[]
): string[] {
  const nodeIds = new Set(model.nodes.map((node) => node.id))
  if (expandedPath.length > 0) {
    return expandedPath.every((nodeId) => nodeIds.has(nodeId)) ? expandedPath : []
  }

  const rootNodes = model.nodes.filter((node) => !node.parentId)
  if (rootNodes.length !== 1) {
    return []
  }

  const [rootNode] = rootNodes
  if (!isExpandableKind(rootNode.data.kind)) {
    return []
  }

  return model.nodes.some((node) => node.parentId === rootNode.id) ? [rootNode.id] : []
}
