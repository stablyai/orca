import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import {
  canCreateProjectGroupUnder,
  canMoveProjectGroup
} from '../../../../../../shared/project/groups/project-group-nesting'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  getSameHostProjectGroups,
  moveProjectGroupToParent
} from '../drag/project-group-parent-move'

export function ProjectGroupNestingMenuItems({
  groupId,
  hostId,
  projectGroups,
  onCreateSubgroup
}: {
  groupId: string
  hostId: ExecutionHostId
  projectGroups: readonly ProjectGroup[]
  onCreateSubgroup: (parentGroupId: string, hostId: ExecutionHostId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const hostGroups = getSameHostProjectGroups(projectGroups, hostId)
  const group = hostGroups.find((candidate) => candidate.id === groupId)
  const moveTargets = hostGroups.filter(
    (candidate) =>
      candidate.id !== group?.parentGroupId &&
      canMoveProjectGroup(hostGroups, groupId, candidate.id)
  )
  const canMoveToTopLevel = Boolean(group?.parentGroupId)
  return (
    <>
      <DropdownMenuItem
        disabled={!canCreateProjectGroupUnder(hostGroups, groupId)}
        onSelect={() => onCreateSubgroup(groupId, hostId)}
      >
        {t('auto.components.sidebar.WorktreeList.newSubgroup', 'New subgroup…')}
      </DropdownMenuItem>
      {canMoveToTopLevel || moveTargets.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t('auto.components.sidebar.WorktreeList.moveGroupTo', 'Move group to')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {canMoveToTopLevel ? (
              <DropdownMenuItem
                onSelect={() => void moveProjectGroupToParent(groupId, null, hostId)}
              >
                {t('auto.components.sidebar.WorktreeList.groupTopLevel', 'Top level')}
              </DropdownMenuItem>
            ) : null}
            {moveTargets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                onSelect={() => void moveProjectGroupToParent(groupId, target.id, hostId)}
              >
                {target.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
    </>
  )
}
