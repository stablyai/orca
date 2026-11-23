import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { canMoveProjectGroup } from '../../../../../../shared/project/groups/project-group-nesting'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'

export function getSameHostProjectGroups(
  projectGroups: readonly ProjectGroup[],
  hostId: ExecutionHostId
): ProjectGroup[] {
  return projectGroups.filter((group) => getRepoExecutionHostId(group) === hostId)
}

/** Whether a group may move under parentGroupId (null: top level) on its own host. */
export function canMoveProjectGroupOnHost(
  projectGroups: readonly ProjectGroup[],
  hostId: ExecutionHostId,
  groupId: string,
  parentGroupId: string | null
): boolean {
  return canMoveProjectGroup(
    getSameHostProjectGroups(projectGroups, hostId),
    groupId,
    parentGroupId
  )
}

export async function moveProjectGroupToParent(
  groupId: string,
  parentGroupId: string | null,
  hostId: ExecutionHostId
): Promise<boolean> {
  const moved = await useAppStore
    .getState()
    .updateProjectGroup(groupId, { parentGroupId }, { hostId })
  if (!moved) {
    toast.error(
      translate('auto.components.sidebar.WorktreeList.groupMoveFailed', 'Failed to move group'),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.groupMoveFailedDesc',
          "Orca could not confirm the move with the group's host. Recheck the group after reconnecting."
        )
      }
    )
  }
  return Boolean(moved)
}
