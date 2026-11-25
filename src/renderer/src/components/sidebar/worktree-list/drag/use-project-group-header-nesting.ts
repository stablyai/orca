import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { ProjectGroupHeaderNesting } from './project-group-header-nesting-drop'
import type { ProjectHeaderGroupMove } from './project-header-group-move'
import { canMoveProjectGroupOnHost, moveProjectGroupToParent } from './project-group-parent-move'

export function useProjectGroupHeaderNesting(args: {
  groupMove: ProjectHeaderGroupMove | undefined
  projectGroups: readonly ProjectGroup[]
  projectGroupOwnerHostIdByGroupId: ReadonlyMap<string, ExecutionHostId | null>
  rootProjectHeaderKeys: readonly string[] | undefined
  onCommitRootProjectOrder: (
    visibleKeys: readonly string[],
    draggedKey: string,
    dropIndex: number
  ) => void
  onScrollIntent: () => void
}): ProjectGroupHeaderNesting | undefined {
  const {
    groupMove,
    projectGroups,
    projectGroupOwnerHostIdByGroupId: ownerHostIds,
    rootProjectHeaderKeys,
    onCommitRootProjectOrder,
    onScrollIntent
  } = args
  return useMemo(() => {
    if (!groupMove) {
      return undefined
    }
    return {
      rows: groupMove.rows,
      ancestorsByRowIndex: groupMove.ancestorsByRowIndex,
      rootProjectHeaderKeys,
      getHostId: (groupId) => ownerHostIds.get(groupId) ?? undefined,
      // Why: groups are host-owned, so a group can only nest under a group on its own host.
      canMove: (groupId, parentGroupId) => {
        const hostId = ownerHostIds.get(groupId)
        return Boolean(
          hostId &&
          (parentGroupId === null || ownerHostIds.get(parentGroupId) === hostId) &&
          canMoveProjectGroupOnHost(projectGroups, hostId, groupId, parentGroupId)
        )
      },
      onCommitParent: (groupId, drop) => {
        const hostId = ownerHostIds.get(groupId)
        if (!hostId) {
          return
        }
        onScrollIntent()
        void moveProjectGroupToParent(groupId, drop.parentGroupId, hostId).then((moved) => {
          if (moved && drop.rootOrder) {
            onCommitRootProjectOrder(
              drop.rootOrder.visibleKeys,
              `group:${groupId}`,
              drop.rootOrder.dropIndex
            )
          }
        })
      }
    }
  }, [
    groupMove,
    onCommitRootProjectOrder,
    onScrollIntent,
    ownerHostIds,
    projectGroups,
    rootProjectHeaderKeys
  ])
}
