import type {
  ArchitectureDiagramKind,
  ArchitectureDiagramModel,
  ArchitectureDiagramNode
} from './architecture-diagram-types'

export function currentParentIdFromPath(expandedPath: string[]): string | undefined {
  return expandedPath.at(-1)
}

export function isExpandableKind(kind: ArchitectureDiagramKind): boolean {
  return kind === 'system' || kind === 'container' || kind === 'component'
}

export function nextKindForParent(
  parent?: ArchitectureDiagramNode | null
): ArchitectureDiagramKind {
  if (!parent) {
    return 'system'
  }
  if (parent.data.kind === 'system') {
    return 'container'
  }
  if (parent.data.kind === 'container') {
    return 'component'
  }
  return 'operation'
}

export function nodeTypeForKind(kind: ArchitectureDiagramKind): ArchitectureDiagramNode['type'] {
  if (kind === 'operation' || kind === 'process' || kind === 'model') {
    return kind
  }
  return 'architecture'
}

export function defaultNodePosition(
  kind: ArchitectureDiagramKind,
  index: number
): { x: number; y: number } {
  const y = kind === 'system' ? 80 : kind === 'container' ? 230 : kind === 'component' ? 380 : 520
  return { x: 80 + (index % 4) * 250, y }
}

export function createNodeForParent(
  model: ArchitectureDiagramModel,
  parent: ArchitectureDiagramNode | null,
  kindOverride?: ArchitectureDiagramKind
): ArchitectureDiagramNode {
  const kind = kindOverride ?? nextKindForParent(parent)
  const sameKindCount = model.nodes.filter((node) => node.data.kind === kind).length
  const id = `node-${Date.now().toString(36)}-${sameKindCount + 1}`
  return {
    id,
    type: nodeTypeForKind(kind),
    parentId: parent?.id,
    position: defaultNodePosition(kind, sameKindCount),
    data: {
      name: `${kind[0].toUpperCase()}${kind.slice(1)} ${sameKindCount + 1}`,
      description: '',
      kind,
      status:
        kind === 'person' || (kind === 'system' && parent?.data.external) ? undefined : 'proposed',
      contract: { expect: [], ask: [], never: [] },
      notes: []
    }
  }
}

export function collectDescendantIds(
  nodes: ArchitectureDiagramNode[],
  seedIds: Iterable<string>
): Set<string> {
  const ids = new Set(seedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        changed = true
      }
    }
  }
  return ids
}

export function deleteNodesFromModel(
  model: ArchitectureDiagramModel,
  nodeIds: string[]
): ArchitectureDiagramModel {
  const toDelete = collectDescendantIds(model.nodes, nodeIds)
  const sourceMap = { ...model.sourceMap }
  const boundaries = { ...model.boundaries }
  for (const id of toDelete) {
    delete sourceMap[id]
    delete boundaries[id]
  }

  const groups = (model.groups ?? [])
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((memberId) => !toDelete.has(memberId))
    }))
    .filter((group) => group.memberIds.length > 0)

  const remainingGroupIds = new Set(groups.map((group) => group.id))
  const normalizedGroups = groups.map((group) =>
    group.parentGroupId && !remainingGroupIds.has(group.parentGroupId)
      ? { ...group, parentGroupId: undefined }
      : group
  )

  return {
    ...model,
    nodes: model.nodes.filter((node) => !toDelete.has(node.id)),
    links: model.links.filter((link) => !toDelete.has(link.source) && !toDelete.has(link.target)),
    sourceMap,
    boundaries,
    groups: normalizedGroups
  }
}

export function deleteEdgesFromModel(
  model: ArchitectureDiagramModel,
  edgeIds: string[]
): ArchitectureDiagramModel {
  const ids = new Set(edgeIds)
  if (ids.size === 0) {
    return model
  }
  return {
    ...model,
    links: model.links.filter((link) => !ids.has(link.id))
  }
}

export function deleteReferenceEdgesFromModel(
  model: ArchitectureDiagramModel,
  currentParentId: string | undefined,
  referenceNodeIds: string[]
): ArchitectureDiagramModel {
  const ids = new Set(referenceNodeIds)
  if (!currentParentId || ids.size === 0) {
    return model
  }
  return {
    ...model,
    links: model.links.filter(
      (link) =>
        !(
          (link.source === currentParentId && ids.has(link.target)) ||
          (link.target === currentParentId && ids.has(link.source))
        )
    )
  }
}

export function updateEdgeDataInModel(
  model: ArchitectureDiagramModel,
  edgeId: string,
  patch: { label?: string; method?: string }
): ArchitectureDiagramModel {
  let changed = false
  const links = model.links.map((edge) => {
    if (edge.id !== edgeId) {
      return edge
    }
    const currentData = edge.data ?? { label: '' }
    const data = { ...currentData }
    if (patch.label !== undefined) {
      data.label = patch.label
    }
    if (patch.method !== undefined) {
      if (patch.method.trim()) {
        data.method = patch.method.trim()
      } else {
        delete data.method
      }
    }
    changed = true
    return { ...edge, data }
  })
  return changed ? { ...model, links } : model
}
