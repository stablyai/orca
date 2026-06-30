import type {
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureGroup
} from './architecture-diagram-types'

const NODE_W = 180
const NODE_H = 160

export type VisibleGroupBubble = {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  memberCount: number
  depth: number
}

function removeMembersFromOtherGroups(
  groups: ArchitectureGroup[],
  memberIds: Set<string>
): ArchitectureGroup[] {
  return groups
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((memberId) => !memberIds.has(memberId))
    }))
    .filter((group) => group.memberIds.length > 0)
}

export function createGroupFromSelectedNodes(
  model: ArchitectureDiagramModel,
  group: Pick<ArchitectureGroup, 'id' | 'name' | 'memberIds'>
): ArchitectureDiagramModel {
  const memberIds = [...new Set(group.memberIds)].filter((memberId) =>
    model.nodes.some((node) => node.id === memberId)
  )
  if (memberIds.length === 0) {
    return model
  }
  const memberSet = new Set(memberIds)
  return {
    ...model,
    groups: [
      ...removeMembersFromOtherGroups(model.groups ?? [], memberSet),
      {
        id: group.id,
        name: group.name.trim() || 'New group',
        memberIds
      }
    ]
  }
}

export function addMembersToGroupInModel(
  model: ArchitectureDiagramModel,
  groupId: string,
  memberIds: string[]
): ArchitectureDiagramModel {
  const existingGroup = (model.groups ?? []).find((group) => group.id === groupId)
  if (!existingGroup) {
    return model
  }
  const validMemberIds = memberIds.filter((memberId) =>
    model.nodes.some((node) => node.id === memberId)
  )
  if (validMemberIds.length === 0) {
    return model
  }
  const memberSet = new Set(validMemberIds)
  const cleanedGroups = removeMembersFromOtherGroups(
    (model.groups ?? []).filter((group) => group.id !== groupId),
    memberSet
  )
  return {
    ...model,
    groups: [
      ...cleanedGroups,
      {
        ...existingGroup,
        memberIds: [...new Set([...existingGroup.memberIds, ...validMemberIds])]
      }
    ]
  }
}

export function getVisibleGroupBubbles(
  model: ArchitectureDiagramModel,
  visibleNodes: ArchitectureDiagramNode[]
): VisibleGroupBubble[] {
  const visibleById = new Map(visibleNodes.map((node) => [node.id, node]))
  const groups = model.groups ?? []
  const groupById = new Map(groups.map((group) => [group.id, group]))

  const depthForGroup = (groupId: string): number => {
    let depth = 0
    let current = groupById.get(groupId)?.parentGroupId
    while (current) {
      depth++
      current = groupById.get(current)?.parentGroupId
    }
    return depth
  }

  return groups.flatMap((group) => {
    const members = group.memberIds
      .map((memberId) => visibleById.get(memberId))
      .filter((node): node is ArchitectureDiagramNode => !!node)
    if (members.length === 0) {
      return []
    }
    const minX = Math.min(...members.map((node) => node.position?.x ?? 0))
    const minY = Math.min(...members.map((node) => node.position?.y ?? 0))
    const maxX = Math.max(...members.map((node) => (node.position?.x ?? 0) + NODE_W))
    const maxY = Math.max(...members.map((node) => (node.position?.y ?? 0) + NODE_H))
    const padding = 30 + depthForGroup(group.id) * 10
    return [
      {
        id: group.id,
        name: group.name,
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
        memberCount: members.length,
        depth: depthForGroup(group.id)
      }
    ]
  })
}
