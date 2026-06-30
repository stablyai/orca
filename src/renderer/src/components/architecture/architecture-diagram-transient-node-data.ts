import type {
  ArchitectureDiagramModel,
  ArchitectureDiagramNode
} from './architecture-diagram-types'

export function addTransientNodeData(
  nodes: ArchitectureDiagramNode[],
  {
    allNodes,
    groups,
    changedNodeIds,
    driftedNodeIds
  }: {
    allNodes: ArchitectureDiagramNode[]
    groups: ArchitectureDiagramModel['groups']
    changedNodeIds: Set<string>
    driftedNodeIds: Set<string>
  }
): ArchitectureDiagramNode[] {
  const groupNameByNodeId = new Map<string, string>()
  for (const group of groups ?? []) {
    for (const memberId of group.memberIds) {
      groupNameByNodeId.set(memberId, group.name)
    }
  }
  const childNodesByParentId = new Map<string, ArchitectureDiagramNode[]>()
  for (const node of allNodes) {
    if (!node.parentId) {
      continue
    }
    const children = childNodesByParentId.get(node.parentId) ?? []
    children.push(node)
    childNodesByParentId.set(node.parentId, children)
  }

  return nodes.map((node) => {
    const groupName = groupNameByNodeId.get(node.id)
    const changed = changedNodeIds.has(node.id)
    const drifted = driftedNodeIds.has(node.id)
    const children = childNodesByParentId.get(node.id) ?? []
    const operations = children
      .filter((child) => child.data.kind === 'operation')
      .map((child) => ({ id: child.id, name: child.data.name, status: child.data.status }))
    const processes = children
      .filter((child) => child.data.kind === 'process')
      .map((child) => ({ id: child.id, name: child.data.name, status: child.data.status }))
    const models = children
      .filter((child) => child.data.kind === 'model')
      .map((child) => ({ id: child.id, name: child.data.name, status: child.data.status }))
    if (
      !groupName &&
      !changed &&
      !drifted &&
      children.length === 0 &&
      operations.length === 0 &&
      processes.length === 0 &&
      models.length === 0
    ) {
      return node
    }
    return {
      ...node,
      data: {
        ...node.data,
        ...(groupName ? { _groupName: groupName } : {}),
        ...(changed ? { _changed: true } : {}),
        ...(drifted ? { _drifted: true } : {}),
        ...(children.length > 0 ? { _hasChildren: true } : {}),
        ...(operations.length > 0 ? { _operations: operations } : {}),
        ...(processes.length > 0 ? { _processes: processes } : {}),
        ...(models.length > 0 ? { _models: models } : {})
      }
    }
  })
}
